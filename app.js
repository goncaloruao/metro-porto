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
 * Executa uma query GraphQL via POST.
 * @param {string} query
 * @returns {Promise<object>}
 */
async function graphql(query) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map(e => e.message).join('; '));
  return json.data;
}

// ── Queries GraphQL ─────────────────────────────────────────────────────────

/**
 * Obtém todas as rotas de metro e os respectivos padrões (patterns) com paragens.
 * @returns {Promise<Array>}
 */
async function fetchRoutesAndPatterns() {
  const data = await graphql(`{
    routes(transportModes: [{transportMode: SUBWAY}]) {
      id
      shortName
      longName
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
  return data.routes;
}

/**
 * Obtém todas as trips de um padrão com os respectivos stoptimes.
 * @param {string} patternId
 * @returns {Promise<object|null>}
 */
async function fetchPatternTrips(patternId) {
  // Escapar barras invertidas e aspas no ID para evitar quebrar a query GraphQL
  const safeId = patternId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const data = await graphql(`{
    pattern(id: "${safeId}") {
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
  }`);
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
 * @returns {Promise<Array>}
 */
async function fetchBusRoutes() {
  const data = await graphql(`{
    routes(transportModes: [{transportMode: BUS}]) {
      id
      shortName
      longName
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
  return data.routes;
}

// ── Lógica de interpolação ──────────────────────────────────────────────────

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
    ? '&lt; 1 min'
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

function showError(msg) {
  const banner = document.getElementById('error-banner');
  document.getElementById('error-message').textContent = msg;
  banner.classList.remove('hidden');
  setTimeout(() => banner.classList.add('hidden'), 8000);
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
        console.warn(`[STCP] Erro ao carregar pattern ${pattern.id}:`, err);
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
    // ── 1. Rotas e padrões (cache após primeira chamada) ────────────────────
    if (!cachedRoutes) {
      showLoading('A carregar rotas e paragens…');
      cachedRoutes = await fetchRoutesAndPatterns();
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

    // Processar os patterns de todas as linhas em paralelo (Promise.allSettled)
    const patternFetches = cachedRoutes.flatMap(route =>
      route.patterns.map(pattern => ({
        route,
        pattern,
        promise: fetchPatternTrips(pattern.id),
      }))
    );

    const results = await Promise.allSettled(
      patternFetches.map(({ promise }) => promise)
    );

    results.forEach((result, idx) => {
      if (result.status !== 'fulfilled' || !result.value) return;

      const { route, pattern } = patternFetches[idx];
      const patternData = result.value;
      const lineName    = route.shortName;

      if (!countsByLine[lineName]) countsByLine[lineName] = 0;

      patternData.trips.forEach(trip => {
        if (!trip.stoptimes || trip.stoptimes.length < 2) return;

        const pos = estimateTripPosition(trip.stoptimes, nowSec);
        if (!pos) return; // trip não está activa agora

        const tripId   = trip.id;
        const headsign = trip.tripHeadsign || pattern.headsign || '—';

        activeTripIds.add(tripId);
        countsByLine[lineName]++;

        upsertTrainMarker(tripId, pos, lineName, headsign, route.longName);
      });
    });

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
    console.error('[MetroPorto] Erro ao carregar dados:', err);
    showError(`Erro ao carregar dados: ${err.message}`);
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
