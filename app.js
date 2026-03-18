/**
 * app.js — Metro Porto Live Tracker
 * Mostra a posição estimada dos metros do Porto num mapa interactivo.
 * Utiliza a API GraphQL pública do Porto Digital (OTP / OpenTripPlanner).
 *
 * Sem frameworks, sem build step — HTML + JS puro.
 */

// ── Configuração ────────────────────────────────────────────────────────────

/** Endpoint GraphQL público do Porto Digital / OTP */
const GRAPHQL_URL = 'https://otp.services.porto.digital/otp/routers/default/index/graphql';

/** Intervalo de actualização automática (milissegundos) */
const REFRESH_INTERVAL_MS = 30_000;

/** Número máximo de tentativas em caso de erro 5xx ou falha de rede */
const GRAPHQL_MAX_RETRIES = 2;

/** Atraso base entre tentativas (ms); dobra a cada retry */
const GRAPHQL_RETRY_DELAY_MS = 1500;

/** Tempo máximo de espera por uma resposta da API (ms) antes de abortar */
const GRAPHQL_FETCH_TIMEOUT_MS = 30_000;

/** Número máximo de pedidos de pattern do metro em simultâneo */
const GRAPHQL_MAX_CONCURRENT = 4;

/** Prefixo de log para todas as mensagens da aplicação */
const LOG_PREFIX = '[MetroPorto]';

/** Chave de armazenamento localStorage para as rotas/paragens */
const CACHE_KEY_ROUTES = 'metroPorto_routes_v1';

/** Tempo de vida da cache de rotas (24 horas em ms) */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Segundos num dia (usado na normalização de stoptimes que cruzam a meia-noite) */
const SECONDS_PER_DAY = 86400;

/** Segundos numa hora */
const SECONDS_PER_HOUR = 3600;

/** Cor dos marcadores e polylines STCP (laranja-avermelhado) */
const BUS_COLOR = '#e85d04';

/** Número máximo de rotas STCP a processar por ciclo */
const MAX_BUS_ROUTES = 30;

/** Pausa entre pedidos de pattern STCP para não sobrecarregar a API (ms) */
const BUS_PATTERN_DELAY_MS = 50;

/** Endpoint da API move-me.mobi para dados de próximas partidas */
const MOVEME_BASE_URL = 'https://move-me.mobi';

/** Chave de acesso à API move-me.mobi */
const MOVEME_API_KEY = 'C00Z8SHC8WSS0-MN';

/** Nome do operador Metro do Porto na API move-me.mobi */
const MOVEME_METRO_OPERATOR = 'METRO DO PORTO';

/** Tempo médio estimado entre paragens consecutivas do Metro do Porto (segundos) */
const MOVEME_AVG_INTER_STOP_SEC = 150;

/**
 * Cores oficiais das linhas do Metro do Porto.
 * Chave = shortName da rota (ex: "A", "B", …)
 */
const LINE_COLORS = {
  A: '#005b9a',
  B: '#0093d0',
  C: '#00a650',
  D: '#ffdd00',
  E: '#be1e2d',
  F: '#f7941d',
};

/** Cor do texto dos badges (maioria claro, linha D necessita de texto escuro) */
const LINE_TEXT_COLORS = {
  A: '#fff',
  B: '#fff',
  C: '#fff',
  D: '#1a1a1a',
  E: '#fff',
  F: '#fff',
};

/** Nome completo das linhas */
const LINE_LONG_NAMES = {
  A: 'Linha A — Matosinhos',
  B: 'Linha B — Via Póvoa',
  C: 'Linha C — ISMAI / Fórum',
  D: 'Linha D — João de Deus',
  E: 'Linha E — Aeroporto',
  F: 'Linha F — Gondomar',
};

// ── Estado da aplicação ─────────────────────────────────────────────────────

/** Instância do mapa MapLibre GL */
let map;

/** Marcadores activos no mapa (comboios) — Map<tripId, marker> */
const trainMarkers = new Map();

/** Marcadores activos no mapa (autocarros STCP) — Map<tripId, {marker, popup, el}> */
const busMarkers = new Map();

/** Marcadores das paragens no mapa */
const stopMarkers = [];

/** IDs das camadas MapLibre do metro (para toggle) */
const metroLayerIds = [];

/** IDs das camadas MapLibre do STCP (para toggle) */
const busLayerIds = [];

/** Visibilidade actual da camada metro */
let metroVisible = true;

/** Visibilidade actual da camada STCP */
let busVisible = true;

/** Popup actualmente aberto */
let activePopup = null;

/** ID do timeout de auto-refresh */
let refreshTimeout = null;

/** Flag para evitar actualizações concorrentes */
let isLoading = false;

// ── Utilitários ─────────────────────────────────────────────────────────────

/**
 * Devolve os segundos decorridos desde meia-noite (hora local).
 * @returns {number}
 */
function secondsSinceMidnight() {
  const now = new Date();
  return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
}

/**
 * Formata um número de segundos desde meia-noite como "HH:MM".
 * Aceita valores > SECONDS_PER_DAY (dia seguinte).
 * @param {number} secs
 * @returns {string}
 */
function secsToHHMM(secs) {
  const s = secs % SECONDS_PER_DAY;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Executa uma query GraphQL via POST, com retentativas automáticas
 * em caso de erro de servidor (5xx) ou falha de rede.
 * Suporta variáveis GraphQL para evitar interpolação directa de strings.
 * @param {string} query
 * @param {object} [variables={}]
 * @returns {Promise<object>}
 */
async function graphql(query, variables = {}) {
  let lastError;

  for (let attempt = 0; attempt <= GRAPHQL_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GRAPHQL_FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(
          `${LOG_PREFIX} API devolveu HTTP ${res.status}`,
          { url: GRAPHQL_URL, status: res.status, body: body.slice(0, 500) },
        );
        throw new Error(`HTTP ${res.status}`);
      }

      const json = await res.json();
      if (json.errors) {
        console.error(`${LOG_PREFIX} Erros GraphQL:`, json.errors);
        throw new Error(json.errors.map(e => e.message).join('; '));
      }
      return json.data;
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err;

      const isTimeout = err.name === 'AbortError';
      // Tentar novamente apenas em erros de servidor (5xx), timeout ou erros de rede (TypeError)
      const isRetryable = isTimeout || /^HTTP 5\d\d$/.test(err.message) || err instanceof TypeError;

      if (isTimeout) {
        console.warn(`${LOG_PREFIX} Pedido timeout após ${GRAPHQL_FETCH_TIMEOUT_MS}ms (tentativa ${attempt + 1}/${GRAPHQL_MAX_RETRIES + 1})`);
        lastError = new Error(`Timeout após ${GRAPHQL_FETCH_TIMEOUT_MS / 1000}s`);
      } else {
        console.warn(`${LOG_PREFIX} Erro na tentativa ${attempt + 1}/${GRAPHQL_MAX_RETRIES + 1}:`, err.message);
      }

      if (attempt < GRAPHQL_MAX_RETRIES && isRetryable) {
        const waitMs = GRAPHQL_RETRY_DELAY_MS * (attempt + 1);
        console.info(`${LOG_PREFIX} A tentar novamente em ${waitMs}ms…`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      break;
    }
  }

  throw lastError;
}

/**
 * Executa um array de funções assíncronas com um limite de concorrência.
 * Substitui Promise.allSettled directo para evitar sobrecarregar a API.
 * @param {Array<() => Promise<any>>} tasks  Funções a executar
 * @param {number} concurrency              Número máximo de tarefas em paralelo
 * @returns {Promise<PromiseSettledResult[]>}
 */
async function runConcurrent(tasks, concurrency) {
  const results = new Array(tasks.length);
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < tasks.length) {
      const idx = nextIdx++;
      try {
        results[idx] = { status: 'fulfilled', value: await tasks[idx]() };
      } catch (reason) {
        results[idx] = { status: 'rejected', reason };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

// ── Cache persistente (localStorage) ────────────────────────────────────────

/**
 * Lê as rotas/paragens da cache persistente (localStorage).
 * Devolve null se não existir cache ou se estiver expirada.
 * @returns {Array|null}
 */
function loadRoutesFromCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY_ROUTES);
    if (!raw) return null;
    const { data, timestamp } = JSON.parse(raw);
    if (Date.now() - timestamp > CACHE_TTL_MS) {
      localStorage.removeItem(CACHE_KEY_ROUTES);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * Guarda as rotas/paragens na cache persistente (localStorage).
 * @param {Array} routes
 */
function saveRoutesToCache(routes) {
  try {
    localStorage.setItem(CACHE_KEY_ROUTES, JSON.stringify({
      data: routes,
      timestamp: Date.now(),
    }));
  } catch {
    // Ignorar erros de armazenamento (ex: modo privado, quota excedida)
  }
}

/**
 * Lê as rotas da cache persistente sem verificar a data de expiração.
 * Usado como fallback quando a API está indisponível.
 * @returns {Array|null}
 */
function loadStaleRoutesFromCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY_ROUTES);
    if (!raw) return null;
    const { data } = JSON.parse(raw);
    return data || null;
  } catch {
    return null;
  }
}

// ── Queries GraphQL ─────────────────────────────────────────────────────────

/**
 * Obtém todas as rotas de metro e os respectivos padrões (patterns) com paragens.
 * O filtro por modo é feito no cliente para evitar dependência do argumento
 * `transportModes` do servidor OTP, que tem variado entre versões.
 * @returns {Promise<Array>}
 */
async function fetchRoutesAndPatterns() {
  const data = await graphql(`{
    routes {
      id
      shortName
      longName
      mode
      patterns {
        id
        headsign
        directionId
        patternGeometry {
          points
        }
        stops {
          id
          name
          lat
          lon
        }
      }
    }
  }`);
  return data.routes.filter(r => r.mode === 'SUBWAY');
}

/**
 * Obtém todas as trips de um padrão com os respectivos stoptimes.
 * Usa variáveis GraphQL em vez de interpolação directa para maior segurança.
 * @param {string} patternId
 * @returns {Promise<object|null>}
 */
async function fetchPatternTrips(patternId) {
  const data = await graphql(
    `query PatternTrips($id: String!) {
      pattern(id: $id) {
        trips {
          id
          tripHeadsign
          stoptimes {
            stop {
              id
              name
              lat
              lon
            }
            scheduledArrival
            scheduledDeparture
            realtimeArrival
            realtimeDeparture
            realtime
          }
        }
      }
    }`,
    { id: patternId },
  );
  return data.pattern;
}

/**
 * Pausa a execução durante `ms` milissegundos.
 * Usada entre pedidos de pattern STCP para não sobrecarregar a API.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Obtém as rotas de autocarro STCP e os respectivos padrões com paragens.
 * O filtro por modo é feito no cliente (ver fetchRoutesAndPatterns).
 * @returns {Promise<Array>}
 */
async function fetchBusRoutes() {
  const data = await graphql(`{
    routes {
      id
      shortName
      longName
      mode
      patterns {
        id
        headsign
        directionId
        stops {
          id
          name
          lat
          lon
        }
      }
    }
  }`);
  return data.routes.filter(r => r.mode === 'BUS');
}

// ── Geometria de rota ────────────────────────────────────────────────────────
// Adaptado de https://github.com/Cabeda/porto-realtime/blob/main/lib/simulate.ts

/** Velocidade média estimada do Metro do Porto entre paragens (m/s ≈ 18 km/h) */
const METRO_SPEED_MPS = 5.0;

/**
 * Distância em metros entre dois pontos geográficos (fórmula de Haversine).
 */
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Rumo em graus (0–360) de A → B.
 */
function bearingDeg(lat1, lon1, lat2, lon2) {
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos((lat2 * Math.PI) / 180);
  const x =
    Math.cos((lat1 * Math.PI) / 180) * Math.sin((lat2 * Math.PI) / 180) -
    Math.sin((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Descodifica uma polyline codificada no formato Google/OTP (precisão 1e-5).
 * Devolve array de [lat, lon] em graus decimais.
 * @param {string} encoded
 * @returns {Array<[number, number]>}
 */
function decodePolyline(encoded) {
  const coords = [];
  let index = 0, lat = 0, lon = 0;
  while (index < encoded.length) {
    let shift = 0, result = 0, byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift  += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    shift = 0; result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift  += 5;
    } while (byte >= 0x20);
    lon += (result & 1) ? ~(result >> 1) : (result >> 1);

    coords.push([lat / 1e5, lon / 1e5]);
  }
  return coords;
}

/**
 * Calcula o array de distâncias cumulativas (em metros) ao longo de uma polyline.
 * @param {Array<[number, number]>} coords  Array de [lat, lon]
 * @returns {number[]}
 */
function buildCumDist(coords) {
  const cumDist = [0];
  for (let i = 1; i < coords.length; i++) {
    cumDist.push(
      cumDist[i - 1] + haversineM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1])
    );
  }
  return cumDist;
}

/**
 * Projecta uma paragem (lat, lon) na polyline mais próxima e devolve a
 * distância cumulativa (metros) ao longo da rota nesse ponto.
 * Usa aproximação de terra-plana para o produto interno (adequada para <50 km).
 * @param {number} stopLat
 * @param {number} stopLon
 * @param {Array<[number, number]>} coords
 * @param {number[]} cumDist
 * @returns {number}
 */
function projectStopOnRoute(stopLat, stopLon, coords, cumDist) {
  const LAT_M = 111_320;
  let bestDist = Infinity;
  let bestCumDist = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    const [lat1, lon1] = coords[i];
    const [lat2, lon2] = coords[i + 1];
    const cosLat = Math.cos((lat1 * Math.PI) / 180);
    const LON_M = LAT_M * cosLat;

    const bx = (lat2 - lat1) * LAT_M;
    const by = (lon2 - lon1) * LON_M;
    const px = (stopLat - lat1) * LAT_M;
    const py = (stopLon - lon1) * LON_M;

    const segLenSq = bx * bx + by * by;
    const t = segLenSq > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / segLenSq)) : 0;

    const closestLat = lat1 + t * (lat2 - lat1);
    const closestLon = lon1 + t * (lon2 - lon1);
    const d = haversineM(stopLat, stopLon, closestLat, closestLon);

    if (d < bestDist) {
      bestDist = d;
      bestCumDist = cumDist[i] + t * (cumDist[i + 1] - cumDist[i]);
    }
  }
  return bestCumDist;
}

/**
 * Dado um array de coords + distâncias cumulativas e uma distância-alvo,
 * devolve {lat, lon, heading} interpolando ao longo da polyline.
 * @param {Array<[number, number]>} coords
 * @param {number[]} cumDist
 * @param {number} targetDist  metros desde o início
 * @returns {{lat: number, lon: number, heading: number}}
 */
function positionOnRoute(coords, cumDist, targetDist) {
  const n = coords.length;
  if (targetDist <= 0) {
    return { lat: coords[0][0], lon: coords[0][1], heading: bearingDeg(coords[0][0], coords[0][1], coords[1][0], coords[1][1]) };
  }
  if (targetDist >= cumDist[n - 1]) {
    return { lat: coords[n - 1][0], lon: coords[n - 1][1], heading: bearingDeg(coords[n - 2][0], coords[n - 2][1], coords[n - 1][0], coords[n - 1][1]) };
  }
  // Binary search for the segment containing targetDist
  let lo = 0, hi = n - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cumDist[mid] <= targetDist) lo = mid; else hi = mid;
  }
  const segLen = cumDist[hi] - cumDist[lo];
  const t = segLen > 0 ? (targetDist - cumDist[lo]) / segLen : 0;
  const [lat1, lon1] = coords[lo];
  const [lat2, lon2] = coords[hi];
  return {
    lat: lat1 + (lat2 - lat1) * t,
    lon: lon1 + (lon2 - lon1) * t,
    heading: bearingDeg(lat1, lon1, lat2, lon2),
  };
}

// ── API move-me.mobi ─────────────────────────────────────────────────────────

/**
 * Extrai o identificador numérico de uma paragem a partir do ID GTFS do OTP.
 * Ex: "portopt:169223" → "169223", "1:169223" → "169223"
 * @param {string} otpId
 * @returns {string}
 */
function otpStopNumericId(otpId) {
  return otpId.split(':').pop();
}

/**
 * Obtém as próximas partidas para uma paragem do Metro do Porto via move-me.mobi.
 * @param {string} numericStopId  ID numérico da paragem (ex: "169223")
 * @returns {Promise<Array>}  Array de objectos de partida
 */
async function fetchStopDepartures(numericStopId) {
  const operator = encodeURIComponent(MOVEME_METRO_OPERATOR);
  const url = `${MOVEME_BASE_URL}/stop/${operator}/${numericStopId}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GRAPHQL_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'apikey': MOVEME_API_KEY,
        'Accept': '*/*',
        'Content-Type': 'application/json; charset=utf-8',
        'Referer': 'https://move-me.mobi/next-departures',
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

/**
 * Determina qual das direcções do move-me.mobi (1 ou 2) corresponde ao sentido
 * do pattern OTP, comparando os valores de `order` da primeira e última paragem.
 * A direcção correcta é aquela em que `order` da primeira paragem < `order` da última.
 * @param {Array}  patternStops  Paragens do pattern OTP (ordenadas)
 * @param {Map}    stopDepsMap   Mapa numericId → Array<departure>
 * @returns {number|null}  1, 2 ou null se não for possível determinar
 */
function detectPatternDirection(patternStops, stopDepsMap) {
  if (patternStops.length < 2) return null;

  const firstId = otpStopNumericId(patternStops[0].id);
  const lastId  = otpStopNumericId(patternStops[patternStops.length - 1].id);

  const firstDeps = stopDepsMap.get(firstId) || [];
  const lastDeps  = stopDepsMap.get(lastId)  || [];

  for (const dir of [1, 2]) {
    const firstOrders = firstDeps.filter(d => d.direction === dir).map(d => d.order);
    const lastOrders  = lastDeps.filter(d => d.direction === dir).map(d => d.order);

    if (!firstOrders.length || !lastOrders.length) continue;

    const avgFirst = firstOrders.reduce((a, b) => a + b, 0) / firstOrders.length;
    const avgLast  = lastOrders.reduce((a, b) => a + b, 0) / lastOrders.length;

    if (avgFirst < avgLast) return dir;
  }
  return null; // não foi possível determinar; incluir todas as direcções
}

/**
 * Obtém dados de viagens para um pattern do Metro usando a API move-me.mobi.
 * Substitui fetchPatternTrips para as rotas do metro.
 *
 * Se o pattern tiver `patternGeometry.points` (polyline OTP), usa geometria real
 * para calcular a posição exacta do comboio na via (método de Cabeda/porto-realtime).
 * Caso contrário, recorre à interpolação linear entre paragens (fallback).
 *
 * Algoritmo geométrico:
 *  1. Descodifica a polyline da rota e projecta cada paragem nela.
 *  2. Obtém partidas move-me.mobi para todas as paragens.
 *  3. Para cada trip: calcula posição actual = cumDist(nextStop) − duration × speed.
 *  4. Devolve `directPos` com lat/lon/heading exactos + metadados para o popup.
 *
 * @param {object} pattern  Pattern do OTP (com array stops e patternGeometry opcional)
 * @returns {Promise<object>}  { trips: [{id, tripHeadsign, stoptimes?, directPos?}] }
 */
async function fetchPatternTripsMoveMe(pattern) {
  const nowSec = secondsSinceMidnight();

  // ── Preparar geometria da rota (se disponível) ────────────────────────────
  let coords        = null;
  let cumDist       = null;
  let stopCumDists  = null; // Map<stopId, cumDist em metros>

  if (pattern.patternGeometry?.points) {
    try {
      coords = decodePolyline(pattern.patternGeometry.points);
      if (coords.length >= 2) {
        cumDist      = buildCumDist(coords);
        stopCumDists = new Map();
        for (const stop of pattern.stops) {
          stopCumDists.set(stop.id, projectStopOnRoute(stop.lat, stop.lon, coords, cumDist));
        }
      }
    } catch (geoErr) {
      console.warn(`${LOG_PREFIX} Erro ao processar geometria do pattern ${pattern.id}:`, geoErr.message);
      coords = null; cumDist = null; stopCumDists = null;
    }
  }

  // ── 1. Obter partidas para todas as paragens do pattern em paralelo ────────
  const stopResults = await runConcurrent(
    pattern.stops.map(stop => async () => {
      const numId = otpStopNumericId(stop.id);
      const deps  = await fetchStopDepartures(numId).catch(() => []);
      return { stop, deps: Array.isArray(deps) ? deps : [] };
    }),
    GRAPHQL_MAX_CONCURRENT,
  );

  const stopDepsMap = new Map();
  const fulfilled   = [];
  for (const result of stopResults) {
    if (result.status !== 'fulfilled') continue;
    const { stop, deps } = result.value;
    fulfilled.push({ stop, deps });
    stopDepsMap.set(otpStopNumericId(stop.id), deps);
  }

  // ── 2. Detectar direcção move-me que corresponde a este pattern OTP ────────
  const direction = detectPatternDirection(pattern.stops, stopDepsMap);

  // ── 3. Agrupar partidas por tripId ─────────────────────────────────────────
  const tripMap = new Map(); // tripId → { headsign, entries[] }

  for (const { stop, deps } of fulfilled) {
    const filtered = direction != null ? deps.filter(d => d.direction === direction) : deps;
    for (const dep of filtered) {
      const key = String(dep.tripId);
      if (!tripMap.has(key)) tripMap.set(key, { headsign: dep.destination, entries: [] });
      tripMap.get(key).entries.push({
        order:       dep.order,
        stop,
        arrivalSec:  nowSec + dep.duration * 60,
        durationSec: dep.duration * 60,
        isRT:        dep.isRT,
      });
    }
  }

  // ── 4. Construir trips ─────────────────────────────────────────────────────
  const trips = [];

  for (const [tripId, tripData] of tripMap) {
    tripData.entries.sort((a, b) => a.order - b.order);
    const upcoming = tripData.entries.filter(e => e.arrivalSec > nowSec);
    if (!upcoming.length) continue;

    // ── Abordagem geométrica (polyline disponível) ───────────────────────────
    if (coords && cumDist && stopCumDists) {
      const nextEntry  = upcoming[0];
      const nextStop   = nextEntry.stop;
      const nextCumD   = stopCumDists.get(nextStop.id) ?? 0;
      const nextDurSec = nextEntry.durationSec;

      // Estimar velocidade: se tivermos 2 paragens consecutivas usamos dados reais
      let speedMps = METRO_SPEED_MPS;
      if (upcoming.length >= 2) {
        const e2  = upcoming[1];
        const cd2 = stopCumDists.get(e2.stop.id) ?? nextCumD;
        const dt  = e2.durationSec - nextDurSec;
        if (dt > 0 && cd2 > nextCumD) speedMps = (cd2 - nextCumD) / dt;
      }

      // Posição actual do comboio ao longo da polyline da rota
      const trainCumD = Math.max(0, nextCumD - nextDurSec * speedMps);
      const pos       = positionOnRoute(coords, cumDist, trainCumD);

      // Paragem anterior para o campo fromStop e a barra de progresso
      const prevIdx  = Math.max(0, nextEntry.order - 2);
      const prevStop = pattern.stops[prevIdx] || pattern.stops[0];
      const prevCumD = stopCumDists.get(prevStop.id) ??
                       Math.max(0, nextCumD - MOVEME_AVG_INTER_STOP_SEC * speedMps);

      const segLen   = Math.max(1, nextCumD - prevCumD);
      const fraction = Math.min(1, Math.max(0, (trainCumD - prevCumD) / segLen));

      trips.push({
        id:           tripId,
        tripHeadsign: tripData.headsign,
        stoptimes:    [],           // não usado quando directPos está definido
        directPos: {
          lat:         pos.lat,
          lon:         pos.lon,
          heading:     pos.heading,
          fraction,
          fromStop:    prevStop.name,
          toStop:      nextStop.name,
          arrivesInSec: Math.round(nextDurSec),
          arrivalTime: secsToHHMM(nextEntry.arrivalSec),
          realtime:    nextEntry.isRT,
        },
      });
      continue;
    }

    // ── Fallback: interpolação linear stop-a-stop (sem polyline) ─────────────
    const stoptimes = upcoming.map(e => ({
      stop:               { id: e.stop.id, name: e.stop.name, lat: e.stop.lat, lon: e.stop.lon },
      scheduledArrival:   e.arrivalSec,
      scheduledDeparture: e.arrivalSec,
      realtimeArrival:    e.arrivalSec,
      realtimeDeparture:  e.arrivalSec,
      realtime:           e.isRT,
    }));

    const firstEntry = upcoming[0];
    if (firstEntry.order > 1) {
      let interStopSec = MOVEME_AVG_INTER_STOP_SEC;
      if (upcoming.length >= 2) {
        const timeSpan  = upcoming[upcoming.length - 1].arrivalSec - upcoming[0].arrivalSec;
        const orderSpan = upcoming[upcoming.length - 1].order     - upcoming[0].order;
        if (orderSpan > 0) interStopSec = Math.max(30, timeSpan / orderSpan);
      }
      const prevIdx  = Math.max(0, firstEntry.order - 2);
      const prevStop = pattern.stops[prevIdx] || pattern.stops[0];
      const prevArr  = stoptimes[0].scheduledArrival - interStopSec;
      stoptimes.unshift({
        stop:               { id: prevStop.id, name: prevStop.name, lat: prevStop.lat, lon: prevStop.lon },
        scheduledArrival:   prevArr,
        scheduledDeparture: prevArr,
        realtimeArrival:    prevArr,
        realtimeDeparture:  prevArr,
        realtime:           stoptimes[0].realtime,
      });
    }

    if (stoptimes.length >= 2) {
      trips.push({ id: tripId, tripHeadsign: tripData.headsign, stoptimes });
    }
  }

  return { trips };
}


/**
 * Calcula a posição estimada de um comboio entre duas paragens,
 * com base no tempo actual e nos stoptimes da viagem.
 *
 * Tratamento de meia-noite: stoptimes podem exceder SECONDS_PER_DAY (viagens que
 * começam antes e terminam depois da meia-noite).
 *
 * @param {Array}  stoptimes  Lista de stoptimes da trip
 * @param {number} nowSec     Segundos desde meia-noite (hora local)
 * @returns {object|null}  Objecto com lat, lon e metadados, ou null se a trip não estiver activa
 */
function estimateTripPosition(stoptimes, nowSec) {
  for (let i = 0; i < stoptimes.length - 1; i++) {
    const curr = stoptimes[i];
    const next = stoptimes[i + 1];

    // Usar tempos em tempo-real se disponíveis, caso contrário usar os programados
    let dep = curr.realtimeDeparture ?? curr.scheduledDeparture;
    let arr = next.realtimeArrival   ?? next.scheduledArrival;

    // Normalizar para o domínio de "segundos desde meia-noite".
    // Stoptimes podem ultrapassar SECONDS_PER_DAY para viagens da noite; se nowSec
    // for pequeno (início do dia) e o stoptime for muito grande, ajustamos.
    let depNorm = dep;
    let arrNorm = arr;

    // Se o segmento cruzar a meia-noite (dep > SECONDS_PER_DAY)
    // ajustamos nowSec para o mesmo domínio
    const nowAdj = (dep > SECONDS_PER_DAY && nowSec < SECONDS_PER_HOUR) ? nowSec + SECONDS_PER_DAY : nowSec;

    if (depNorm <= nowAdj && nowAdj <= arrNorm) {
      const duration = arrNorm - depNorm;
      const fraction = duration > 0 ? Math.min(1, Math.max(0, (nowAdj - depNorm) / duration)) : 0;

      // Interpolação linear entre as coordenadas das duas paragens
      const lat = curr.stop.lat + (next.stop.lat - curr.stop.lat) * fraction;
      const lon = curr.stop.lon + (next.stop.lon - curr.stop.lon) * fraction;

      return {
        lat,
        lon,
        fraction,
        fromStop: curr.stop.name,
        toStop:   next.stop.name,
        arrivesInSec: Math.max(0, arrNorm - nowAdj),
        arrivalTime: secsToHHMM(arr),
        realtime: curr.realtime || false,
      };
    }
  }
  return null; // viagem não está activa agora
}

// ── Mapa ─────────────────────────────────────────────────────────────────────

/**
 * Inicializa o mapa MapLibre GL centrado no Porto.
 */
function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/dark',
    center: [-8.6291, 41.1579], // [lon, lat]
    zoom: 13,
    attributionControl: true,
  });

  map.addControl(new maplibregl.NavigationControl(), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
}

/**
 * Desenha as linhas do metro no mapa como polylines coloridas.
 * Chamado depois do mapa carregar os tiles base.
 * @param {Array} routes  Lista de rotas da API
 */
function drawLines(routes) {
  routes.forEach(route => {
    const color = LINE_COLORS[route.shortName] || '#888';

    route.patterns.forEach(pattern => {
      const coords = pattern.stops.map(s => [s.lon, s.lat]);
      if (coords.length < 2) return;

      const sourceId = `line-${route.shortName}-${pattern.id}`;
      const layerId  = `layer-${route.shortName}-${pattern.id}`;

      // Evitar adicionar a mesma fonte duas vezes se o refresh for chamado
      if (map.getSource(sourceId)) return;

      map.addSource(sourceId, {
        type: 'geojson',
        data: {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords },
        },
      });

      map.addLayer({
        id: layerId,
        type: 'line',
        source: sourceId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': color,
          'line-width': 3,
          'line-opacity': 0.85,
        },
      });

      // Registar o ID da camada para o toggle do metro
      metroLayerIds.push(layerId);
    });
  });
}

/**
 * Adiciona marcadores pequenos (círculos cinzentos) para cada paragem.
 * @param {Array} routes
 */
function drawStops(routes) {
  // Colectar paragens únicas
  const seen = new Set();
  const stops = [];

  routes.forEach(route => {
    route.patterns.forEach(pattern => {
      pattern.stops.forEach(stop => {
        if (!seen.has(stop.id)) {
          seen.add(stop.id);
          stops.push(stop);
        }
      });
    });
  });

  stops.forEach(stop => {
    // Criar elemento DOM para o marcador
    const el = document.createElement('div');
    el.style.cssText = [
      'width:8px', 'height:8px', 'border-radius:50%',
      'background:#778899', 'border:1.5px solid #aabbcc',
      'cursor:pointer',
    ].join(';');

    // Tooltip com o nome da paragem ao passar o rato
    const marker = new maplibregl.Marker({ element: el })
      .setLngLat([stop.lon, stop.lat])
      .addTo(map);

    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 10,
      className: 'stop-tooltip-popup',
    }).setHTML(`<span class="stop-tooltip">${stop.name}</span>`);

    el.addEventListener('mouseenter', () => {
      popup.setLngLat([stop.lon, stop.lat]).addTo(map);
    });
    el.addEventListener('mouseleave', () => {
      popup.remove();
    });

    stopMarkers.push(marker);
  });
}

/**
 * Cria ou actualiza um marcador de comboio no mapa.
 * @param {string} tripId     ID único da trip
 * @param {object} pos        Objecto de posição (lat, lon, …)
 * @param {string} lineName   Nome curto da linha (ex: "A")
 * @param {string} headsign   Destino/cabeçalho do comboio
 * @param {string} longName   Nome completo da linha
 */
function upsertTrainMarker(tripId, pos, lineName, headsign, longName) {
  const color     = LINE_COLORS[lineName]     || '#888';
  const textColor = LINE_TEXT_COLORS[lineName] || '#fff';

  // Criar elemento DOM do marcador
  const el = document.createElement('div');
  el.style.cssText = [
    `background:${color}`,
    'width:22px', 'height:22px', 'border-radius:50%',
    `border:2.5px solid ${textColor === '#fff' ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.3)'}`,
    'cursor:pointer',
    'display:flex', 'align-items:center', 'justify-content:center',
    `color:${textColor}`, 'font-size:9px', 'font-weight:800',
    'box-shadow:0 2px 8px rgba(0,0,0,0.6)',
    'transition:transform 0.3s ease',
    // Animação de pulsar para sinalizar tempo-real
    pos.realtime ? 'animation:pulse 2s infinite' : '',
  ].join(';');
  el.textContent = lineName;
  el.title = `Linha ${lineName} → ${headsign}`;

  // Conteúdo do popup ao clicar no marcador
  const progressPct = Math.round(pos.fraction * 100);
  const popupHtml = `
    <div class="popup-line">
      <div class="popup-line-badge" style="background:${color};color:${textColor};">${lineName}</div>
      <span class="popup-line-name">Linha ${lineName}</span>
    </div>
    <p class="popup-headsign">→ ${headsign}</p>
    <p class="popup-stops">
      <strong>${pos.fromStop}</strong> → <strong>${pos.toStop}</strong>
    </p>
    <div class="popup-progress-bar-wrap">
      <div class="popup-progress-bar" style="width:${progressPct}%;background:${color};"></div>
    </div>
    <p class="popup-info">
      Progresso: ${progressPct}%<br>
      Chegada estimada às ${pos.arrivalTime} (~${pos.arrivesInSec}s)<br>
      ${pos.realtime ? '🟢 Tempo real' : '🔵 Programado'}
    </p>
  `;

  if (trainMarkers.has(tripId)) {
    // Actualizar posição e popup do marcador existente
    const existing = trainMarkers.get(tripId);
    existing.marker.setLngLat([pos.lon, pos.lat]);
    existing.popup.setHTML(popupHtml);
    // Actualizar elemento visual
    existing.el.style.cssText = el.style.cssText;
    existing.el.textContent = lineName;
  } else {
    // Criar novo marcador
    const popup = new maplibregl.Popup({ offset: 14, closeButton: true })
      .setHTML(popupHtml);

    const marker = new maplibregl.Marker({ element: el })
      .setLngLat([pos.lon, pos.lat])
      .setPopup(popup)
      .addTo(map);

    el.addEventListener('click', () => {
      if (activePopup && activePopup !== popup) activePopup.remove();
      activePopup = popup;
    });

    trainMarkers.set(tripId, { marker, popup, el });
  }
}

/**
 * Remove marcadores de trips que já não estão activas.
 * @param {Set<string>} activeTripIds
 */
function removeStaleMarkers(activeTripIds) {
  for (const [tripId, { marker }] of trainMarkers) {
    if (!activeTripIds.has(tripId)) {
      marker.remove();
      trainMarkers.delete(tripId);
    }
  }
}

/**
 * Desenha as polylines das rotas STCP no mapa.
 * Linhas finas e semitransparentes para não obscurecer o metro.
 * @param {Array} routes  Lista de rotas STCP
 */
function drawBusLines(routes) {
  routes.forEach(route => {
    route.patterns.forEach(pattern => {
      const coords = pattern.stops.map(s => [s.lon, s.lat]);
      if (coords.length < 2) return;

      const sourceId = `bus-src-${pattern.id}`;
      const layerId  = `bus-lyr-${pattern.id}`;

      if (map.getSource(sourceId)) return;

      map.addSource(sourceId, {
        type: 'geojson',
        data: {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords },
        },
      });

      map.addLayer({
        id: layerId,
        type: 'line',
        source: sourceId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': BUS_COLOR,
          'line-width': 1.5,
          'line-opacity': 0.3,
        },
      });

      // Registar o ID da camada para o toggle STCP
      busLayerIds.push(layerId);
    });
  });
}

/**
 * Cria ou actualiza um marcador de autocarro STCP no mapa.
 * Os marcadores são quadrados (para distinguir dos círculos do metro).
 *
 * @param {string} tripId    ID único da trip (com prefixo "bus-")
 * @param {object} pos       Objecto de posição (lat, lon, fraction, …)
 * @param {string} lineName  Número da linha STCP (shortName)
 * @param {string} headsign  Destino/cabeçalho
 * @param {string} fromStop  Primeira paragem da rota
 * @param {string} toStop    Última paragem da rota
 */
function upsertBusMarker(tripId, pos, lineName, headsign, fromStop, toStop) {
  // Marcador quadrado (distinto dos círculos redondos dos metros)
  const el = document.createElement('div');
  el.style.cssText = [
    `background:${BUS_COLOR}`,
    'width:18px', 'height:18px', 'border-radius:3px',
    'border:2px solid rgba(255,255,255,0.4)',
    'cursor:pointer',
    'display:flex', 'align-items:center', 'justify-content:center',
    'color:#fff', 'font-size:7px', 'font-weight:800',
    'box-shadow:0 2px 6px rgba(0,0,0,0.5)',
    'overflow:hidden', 'white-space:nowrap',
  ].join(';');
  // Mostrar número da linha (máx. 4 caracteres para linhas STCP tipo "200")
  el.textContent = lineName.slice(0, 4);
  el.title = `STCP ${lineName} → ${headsign}`;

  const progressPct = Math.round(pos.fraction * 100);
  const arrivalStr  = pos.arrivesInSec < 60
    ? '< 1 min'
    : `~${Math.round(pos.arrivesInSec / 60)} min`;

  const popupHtml = `
    <div class="popup-line">
      <div class="popup-line-badge" style="background:${BUS_COLOR};color:#fff;border-radius:3px;">🚌</div>
      <span class="popup-line-name">STCP — Linha ${lineName}</span>
    </div>
    <p class="popup-headsign">→ ${headsign}</p>
    <p class="popup-stops">
      <strong>${fromStop}</strong> → <strong>${toStop}</strong>
    </p>
    <p class="popup-stops" style="font-size:0.73rem;color:#8a9aaa;">
      ↳ ${pos.fromStop} → ${pos.toStop}
    </p>
    <div class="popup-progress-bar-wrap">
      <div class="popup-progress-bar" style="width:${progressPct}%;background:${BUS_COLOR};"></div>
    </div>
    <p class="popup-info">
      Progresso: ${progressPct}%<br>
      Chegada à próxima paragem: ${arrivalStr}
    </p>
  `;

  if (busMarkers.has(tripId)) {
    // Actualizar posição e conteúdo do marcador existente
    const existing = busMarkers.get(tripId);
    existing.marker.setLngLat([pos.lon, pos.lat]);
    existing.popup.setHTML(popupHtml);
    existing.el.style.cssText = el.style.cssText;
    existing.el.textContent = el.textContent;
  } else {
    // Criar novo marcador
    const popup = new maplibregl.Popup({ offset: 12, closeButton: true })
      .setHTML(popupHtml);

    const marker = new maplibregl.Marker({ element: el })
      .setLngLat([pos.lon, pos.lat])
      .setPopup(popup)
      .addTo(map);

    el.addEventListener('click', () => {
      if (activePopup && activePopup !== popup) activePopup.remove();
      activePopup = popup;
    });

    // Respeitar a visibilidade actual da camada STCP
    if (!busVisible) {
      marker.getElement().style.display = 'none';
    }

    busMarkers.set(tripId, { marker, popup, el });
  }
}

/**
 * Remove marcadores de autocarros de trips que já não estão activas.
 * @param {Set<string>} activeBusTripIds
 */
function removeStaleBusMarkers(activeBusTripIds) {
  for (const [tripId, { marker }] of busMarkers) {
    if (!activeBusTripIds.has(tripId)) {
      marker.remove();
      busMarkers.delete(tripId);
    }
  }
}

// ── Sidebar ──────────────────────────────────────────────────────────────────

/**
 * Renderiza a legenda das linhas na sidebar.
 */
function renderLegend() {
  const legendEl = document.getElementById('legend');
  legendEl.innerHTML = '';
  Object.entries(LINE_COLORS).forEach(([line, color]) => {
    const name = LINE_LONG_NAMES[line] || `Linha ${line}`;
    legendEl.insertAdjacentHTML('beforeend', `
      <div class="legend-item">
        <div class="legend-dot" style="background:${color};"></div>
        <span class="legend-text">${name}</span>
      </div>
    `);
  });
}

/**
 * Actualiza a contagem de comboios activos por linha na sidebar.
 * @param {object} countsByLine  { A: 3, B: 1, … }
 */
function updateActiveTrainCounts(countsByLine) {
  const el = document.getElementById('active-trains');
  el.innerHTML = '';

  Object.entries(LINE_COLORS).forEach(([line, color]) => {
    const count     = countsByLine[line] || 0;
    const textColor = LINE_TEXT_COLORS[line] || '#fff';
    const name      = LINE_LONG_NAMES[line] || `Linha ${line}`;

    el.insertAdjacentHTML('beforeend', `
      <div class="line-count">
        <div class="line-badge" style="background:${color};color:${textColor};">${line}</div>
        <span class="line-label">${name}</span>
        <span class="count-badge ${count > 0 ? 'active' : ''}">${count}</span>
      </div>
    `);
  });
}

/**
 * Actualiza o texto "Última actualização" na sidebar.
 */
function updateLastUpdated() {
  const el = document.getElementById('last-updated');
  el.textContent = `Actualizado: ${new Date().toLocaleTimeString('pt-PT')}`;
}

/**
 * Actualiza a secção STCP na sidebar com o total de autocarros activos
 * e as 5 linhas mais activas.
 * @param {object} countsByLine  { "200": 3, "201": 1, … }
 */
function updateActiveBusStats(countsByLine) {
  const el = document.getElementById('active-buses');
  if (!el) return;
  el.innerHTML = '';

  const total = Object.values(countsByLine).reduce((a, b) => a + b, 0);

  if (total === 0) {
    el.insertAdjacentHTML('beforeend', '<p class="no-vehicles">Sem autocarros activos</p>');
    return;
  }

  // Total de autocarros activos
  el.insertAdjacentHTML('beforeend', `
    <div class="line-count">
      <div class="line-badge" style="background:${BUS_COLOR};color:#fff;border-radius:4px;font-size:0.7rem;">🚌</div>
      <span class="line-label">Total STCP</span>
      <span class="count-badge active">${total}</span>
    </div>
  `);

  // Top 5 linhas mais activas (decrescente)
  const top5 = Object.entries(countsByLine)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  top5.forEach(([line, count]) => {
    el.insertAdjacentHTML('beforeend', `
      <div class="line-count">
        <div class="line-badge" style="background:${BUS_COLOR};color:#fff;border-radius:4px;font-size:0.7rem;">${line}</div>
        <span class="line-label">Linha ${line}</span>
        <span class="count-badge active">${count}</span>
      </div>
    `);
  });
}

/**
 * Alterna a visibilidade da camada do Metro (linhas, paragens e comboios).
 */
function toggleMetroLayer() {
  metroVisible = !metroVisible;

  // Toggle das polylines do metro
  metroLayerIds.forEach(id => {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', metroVisible ? 'visible' : 'none');
    }
  });

  // Toggle dos marcadores de comboios
  trainMarkers.forEach(({ marker }) => {
    marker.getElement().style.display = metroVisible ? '' : 'none';
  });

  // Toggle dos marcadores de paragens
  stopMarkers.forEach(m => {
    m.getElement().style.display = metroVisible ? '' : 'none';
  });

  // Actualizar estado visual do botão
  document.getElementById('toggle-metro').classList.toggle('off', !metroVisible);
}

/**
 * Alterna a visibilidade da camada STCP (polylines e marcadores de autocarros).
 */
function toggleBusLayer() {
  busVisible = !busVisible;

  // Toggle das polylines STCP
  busLayerIds.forEach(id => {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', busVisible ? 'visible' : 'none');
    }
  });

  // Toggle dos marcadores de autocarros
  busMarkers.forEach(({ marker }) => {
    marker.getElement().style.display = busVisible ? '' : 'none';
  });

  // Actualizar estado visual do botão
  document.getElementById('toggle-stcp').classList.toggle('off', !busVisible);
}

// ── Controlo do UI ───────────────────────────────────────────────────────────

function showLoading(msg = 'A carregar dados do Metro do Porto…') {
  document.getElementById('loading-text').textContent = msg;
  document.getElementById('loading-overlay').classList.remove('hidden');
}

function hideLoading() {
  document.getElementById('loading-overlay').classList.add('hidden');
}

function showError(msg, autoDismiss = true) {
  const banner = document.getElementById('error-banner');
  document.getElementById('error-message').textContent = msg;
  banner.classList.remove('hidden');
  if (autoDismiss) {
    setTimeout(() => banner.classList.add('hidden'), 8000);
  }
}

// ── Ciclo principal ──────────────────────────────────────────────────────────

/**
 * Variável global que guarda os dados das rotas/paragens para não os
 * re-pedir em cada actualização (apenas os trips é que mudam frequentemente).
 */
let cachedRoutes    = null;
let linesDrawn      = false;

/** Cache das rotas STCP (as primeiras MAX_BUS_ROUTES por shortName) */
let cachedBusRoutes = null;

/** Flag para garantir que as polylines STCP são desenhadas apenas uma vez */
let busLinesDrawn   = false;

/**
 * Carrega as rotas e posições estimadas dos autocarros STCP.
 * Limita-se às primeiras MAX_BUS_ROUTES rotas (ordenadas por shortName).
 * Os pedidos de pattern são feitos sequencialmente com uma pequena pausa
 * entre cada um para não sobrecarregar a API.
 */
async function loadSTCPBuses() {
  // ── 1. Rotas STCP (cache após primeira chamada) ──────────────────────────
  if (!cachedBusRoutes) {
    showLoading('A carregar rotas STCP…');
    const allBusRoutes = await fetchBusRoutes();

    // Ordenar por shortName (numérico) e limitar às primeiras MAX_BUS_ROUTES
    allBusRoutes.sort((a, b) =>
      a.shortName.localeCompare(b.shortName, 'pt', { numeric: true })
    );
    cachedBusRoutes = allBusRoutes.slice(0, MAX_BUS_ROUTES);
  }

  // ── 2. Desenhar polylines das rotas STCP (apenas uma vez) ───────────────
  if (!busLinesDrawn) {
    drawBusLines(cachedBusRoutes);
    busLinesDrawn = true;
    hideLoading();
  }

  // ── 3. Calcular posições estimadas por trip activa ───────────────────────
  const nowSec          = secondsSinceMidnight();
  const activeBusTripIds = new Set();
  const countsByLine    = {};

  for (const route of cachedBusRoutes) {
    for (const pattern of route.patterns) {
      try {
        const patternData = await fetchPatternTrips(pattern.id);
        if (!patternData) continue;

        const lineName = route.shortName;
        if (!countsByLine[lineName]) countsByLine[lineName] = 0;

        // Paragens extremas do pattern (origem e destino da rota)
        const fromStop = pattern.stops?.[0]?.name || '—';
        const toStop   = pattern.stops?.[pattern.stops.length - 1]?.name || '—';

        patternData.trips.forEach(trip => {
          if (!trip.stoptimes || trip.stoptimes.length < 2) return;

          const pos = estimateTripPosition(trip.stoptimes, nowSec);
          if (!pos) return; // trip não está activa agora

          // Prefixo "bus-" para evitar colisões com IDs de trips do metro
          const tripId  = `bus-${trip.id}`;
          const headsign = trip.tripHeadsign || pattern.headsign || '—';

          activeBusTripIds.add(tripId);
          countsByLine[lineName]++;

          upsertBusMarker(tripId, pos, lineName, headsign, fromStop, toStop);
        });
      } catch (err) {
        console.warn(`${LOG_PREFIX} [STCP] Erro ao carregar pattern ${pattern.id}:`, err);
      }

      // Pequena pausa após cada pedido para não sobrecarregar a API
      await delay(BUS_PATTERN_DELAY_MS);
    }
  }

  // ── 4. Remover marcadores de trips que terminaram ────────────────────────
  removeStaleBusMarkers(activeBusTripIds);

  // ── 5. Actualizar secção STCP na sidebar ─────────────────────────────────
  updateActiveBusStats(countsByLine);
}


async function loadAndRender() {
  if (isLoading) return;
  isLoading = true;

  const refreshBtn = document.getElementById('refresh-btn');
  refreshBtn.disabled = true;

  try {
    // ── 1. Rotas e padrões (cache localStorage → API → cache stale) ─────────
    if (!cachedRoutes) {
      // Tentar primeiro a cache persistente (válida por 24h)
      cachedRoutes = loadRoutesFromCache();

      if (!cachedRoutes) {
        showLoading('A carregar rotas e paragens…');
        try {
          cachedRoutes = await fetchRoutesAndPatterns();
          saveRoutesToCache(cachedRoutes);
        } catch (fetchErr) {
          // API falhou; tentar usar dados antigos da cache como fallback
          const stale = loadStaleRoutesFromCache();
          if (stale) {
            cachedRoutes = stale;
            console.warn(`${LOG_PREFIX} API indisponível; a usar cache expirada para rotas.`);
            showError('API temporariamente indisponível. A mostrar rotas em cache.', false);
          } else {
            // Sem cache alguma — não é possível continuar
            throw fetchErr;
          }
        }
      }
    }

    // ── 2. Desenhar linhas e paragens apenas uma vez ─────────────────────────
    if (!linesDrawn) {
      drawLines(cachedRoutes);
      drawStops(cachedRoutes);
      renderLegend();
      linesDrawn = true;
    }

    showLoading('A calcular posições dos comboios…');

    // ── 3. Calcular posições estimadas para cada trip activa ─────────────────
    const nowSec        = secondsSinceMidnight();
    const activeTripIds = new Set();
    const countsByLine  = {};

    // Processar os patterns de todas as linhas com limite de concorrência
    // para não sobrecarregar a API com demasiados pedidos em simultâneo.
    const patternFetches = cachedRoutes.flatMap(route =>
      route.patterns.map(pattern => ({ route, pattern }))
    );

    const results = await runConcurrent(
      patternFetches.map(({ pattern }) => async () => {
        try {
          return await fetchPatternTripsMoveMe(pattern);
        } catch (err) {
          console.warn(`${LOG_PREFIX} move-me.mobi falhou para pattern ${pattern.id}, a usar OTP:`, err.message);
          return fetchPatternTrips(pattern.id);
        }
      }),
      GRAPHQL_MAX_CONCURRENT,
    );

    let failedCount = 0;
    results.forEach((result, idx) => {
      if (result.status !== 'fulfilled' || !result.value) {
        failedCount++;
        if (result.status === 'rejected') {
          console.warn(
            `${LOG_PREFIX} Falha no pattern ${patternFetches[idx].pattern.id}:`,
            result.reason,
          );
        }
        return;
      }

      const { route, pattern } = patternFetches[idx];
      const patternData = result.value;
      const lineName    = route.shortName;

      if (!countsByLine[lineName]) countsByLine[lineName] = 0;

      patternData.trips.forEach(trip => {
        // directPos: calculado pela abordagem geométrica (move-me.mobi + polyline)
        // estimateTripPosition: fallback para OTP stoptimes
        const pos = trip.directPos ||
          (trip.stoptimes?.length >= 2 ? estimateTripPosition(trip.stoptimes, nowSec) : null);
        if (!pos) return; // trip não está activa agora

        const tripId   = trip.id;
        const headsign = trip.tripHeadsign || pattern.headsign || '—';

        activeTripIds.add(tripId);
        countsByLine[lineName]++;

        upsertTrainMarker(tripId, pos, lineName, headsign, route.longName);
      });
    });

    if (failedCount > 0) {
      console.warn(`${LOG_PREFIX} ${failedCount}/${results.length} patterns falharam.`);
    }
    if (failedCount === results.length && results.length > 0) {
      showError('Não foi possível obter posições em tempo real. A tentar novamente em breve…', false);
    }

    // ── 4. Remover marcadores de trips que terminaram ────────────────────────
    removeStaleMarkers(activeTripIds);

    // ── 5. Actualizar sidebar do metro ───────────────────────────────────────
    updateActiveTrainCounts(countsByLine);
    updateLastUpdated();
    hideLoading();

    // ── 6. Carregar dados STCP em segundo plano ──────────────────────────────
    //      (sem bloquear a UI — usa o mesmo ciclo de actualização)
    await loadSTCPBuses();

  } catch (err) {
    console.error(`${LOG_PREFIX} Erro ao carregar dados:`, err);
    showError(`Erro ao carregar dados: ${err.message}`, false);
  } finally {
    hideLoading();
    isLoading = false;
    refreshBtn.disabled = false;

    // Agendar próxima actualização automática
    clearTimeout(refreshTimeout);
    refreshTimeout = setTimeout(loadAndRender, REFRESH_INTERVAL_MS);
  }
}

// ── Inicialização ────────────────────────────────────────────────────────────

/**
 * Adiciona estilos de animação de pulsar ao <head> (para marcadores em tempo-real).
 */
function injectPulseAnimation() {
  const style = document.createElement('style');
  style.textContent = `
    @keyframes pulse {
      0%   { box-shadow: 0 0 0 0 rgba(255,255,255,0.5); }
      70%  { box-shadow: 0 0 0 8px rgba(255,255,255,0); }
      100% { box-shadow: 0 0 0 0 rgba(255,255,255,0); }
    }
  `;
  document.head.appendChild(style);
}

/**
 * Configura o botão de toggle da sidebar para mobile.
 */
function setupSidebarToggle() {
  const btn     = document.getElementById('toggle-sidebar');
  const sidebar = document.getElementById('sidebar');

  btn.addEventListener('click', () => {
    sidebar.classList.toggle('open');
  });

  // Fechar sidebar ao clicar no mapa (mobile)
  document.getElementById('map').addEventListener('click', () => {
    if (window.innerWidth <= 640) {
      sidebar.classList.remove('open');
    }
  });
}

/**
 * Ponto de entrada da aplicação.
 */
function init() {
  injectPulseAnimation();
  setupSidebarToggle();

  // Botão de retry no banner de erro
  document.getElementById('error-retry-btn').addEventListener('click', () => {
    document.getElementById('error-banner').classList.add('hidden');
    clearTimeout(refreshTimeout);
    loadAndRender();
  });

  // Botão de refresh manual
  document.getElementById('refresh-btn').addEventListener('click', () => {
    clearTimeout(refreshTimeout);
    loadAndRender();
  });

  // Botões de toggle de camadas
  document.getElementById('toggle-metro').addEventListener('click', toggleMetroLayer);
  document.getElementById('toggle-stcp').addEventListener('click', toggleBusLayer);

  // Inicializar mapa
  initMap();

  // Aguardar que o mapa carregue antes de desenhar dados
  map.on('load', () => {
    loadAndRender();
  });

  // Lidar com erro de carregamento do mapa
  map.on('error', (e) => {
    console.warn('[MapLibre]', e);
  });
}

// Iniciar quando o DOM estiver pronto
document.addEventListener('DOMContentLoaded', init);
