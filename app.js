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

/** Marcadores das paragens no mapa */
const stopMarkers = [];

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
let cachedRoutes = null;
let linesDrawn   = false;

/**
 * Carrega todos os dados do Metro do Porto, calcula posições estimadas
 * e actualiza o mapa.
 */
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

    // ── 5. Actualizar sidebar ────────────────────────────────────────────────
    updateActiveTrainCounts(countsByLine);
    updateLastUpdated();

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
