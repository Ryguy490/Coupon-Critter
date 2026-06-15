/* Weather Watcher — front-end application logic. */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  lat: null,
  lon: null,
  label: 'Loading…',
  weather: null,
  alerts: [],
  storms: null,
  drought: null,
  activeNav: 'home',
  knownStormAlertIds: new Set(),
  maps: {},
  radar: { frames: [], idx: 0, layer: null, timer: null, playing: false },
};

const DEFAULT_LOC = { lat: 35.7796, lon: -78.6382, label: 'Raleigh, North Carolina' }; // WRAL country, matches the notes

/* ------------------------------- helpers ------------------------------- */

function iconUrl(code, isDay = 1) {
  const suffix = isDay ? 'd' : 'n';
  return `https://openweathermap.org/img/wn/${(code || '03')}${suffix}@2x.png`;
}
function fmtHour(iso) {
  const d = new Date(iso);
  let h = d.getHours();
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}${ap}`;
}
function fmtDow(iso) {
  return new Date(iso + (iso.length === 10 ? 'T12:00' : '')).toLocaleDateString(undefined, { weekday: 'short' });
}
function fmtDate(iso) {
  return new Date(iso + (iso.length === 10 ? 'T12:00' : '')).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}
async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
}
async function postJSON(url, body) {
  return getJSON(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

/* ------------------------------- bootstrap ----------------------------- */

window.addEventListener('DOMContentLoaded', init);

async function init() {
  wireUI();
  await resolveInitialLocation();
  await loadEverything();
  // poll alerts every 60s (drives the emergency siren + notifications)
  setInterval(() => { refreshAlerts(false); checkFavoriteAlerts(); }, 60000);
}

async function resolveInitialLocation() {
  const saved = localStorage.getItem('ww_loc');
  if (saved) {
    try { const o = JSON.parse(saved); Object.assign(state, o); return; } catch (_) {}
  }
  // try browser geolocation, fall back to default
  const got = await new Promise((res) => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(
      (p) => res({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => res(null),
      { timeout: 6000 }
    );
  });
  if (got) {
    state.lat = got.lat; state.lon = got.lon;
    try { const r = await getJSON(`/api/reverse?lat=${got.lat}&lon=${got.lon}`); state.label = r.label; } catch (_) { state.label = 'Your location'; }
  } else {
    Object.assign(state, DEFAULT_LOC);
  }
}

function persistLocation() {
  localStorage.setItem('ww_loc', JSON.stringify({ lat: state.lat, lon: state.lon, label: state.label }));
}

/* ------------------------------- favorites ----------------------------- */
function getFavs() { try { return JSON.parse(localStorage.getItem('ww_favs') || '[]'); } catch (_) { return []; } }
function setFavs(f) { localStorage.setItem('ww_favs', JSON.stringify(f)); }
function favKey(lat, lon) { return `${(+lat).toFixed(2)},${(+lon).toFixed(2)}`; }
function isFav(lat, lon) { return getFavs().some((f) => favKey(f.lat, f.lon) === favKey(lat, lon)); }
function toggleFav(lat, lon, label) {
  let f = getFavs();
  const k = favKey(lat, lon);
  if (f.some((x) => favKey(x.lat, x.lon) === k)) f = f.filter((x) => favKey(x.lat, x.lon) !== k);
  else f.unshift({ lat: +lat, lon: +lon, label });
  setFavs(f);
  updateFavBtn();
}
function updateFavBtn() {
  const btn = $('#favBtn');
  if (!btn || state.lat == null) return;
  const fav = isFav(state.lat, state.lon);
  btn.innerHTML = fav ? '&#9829;' : '&#9825;'; // filled vs outline heart
  btn.classList.toggle('on', fav);
  btn.title = fav ? 'Remove favorite' : 'Save as favorite';
}

/* ------------------------------ notifications -------------------------- */
function requestNotifyPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    try { Notification.requestPermission(); } catch (_) {}
  }
}
function notifyUser(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification(title, { body: body || '', icon: 'assets/logo.svg', tag: title }); } catch (_) {}
}
// Watch favorited places (current location is handled in handleEmergency).
async function checkFavoriteAlerts() {
  for (const f of getFavs()) {
    if (favKey(f.lat, f.lon) === favKey(state.lat, state.lon)) continue;
    try {
      const list = await getJSON(`/api/alerts?lat=${f.lat}&lon=${f.lon}`);
      const emer = list.filter((a) => ['Extreme', 'Severe'].includes(a.severity) && /Warning/i.test(a.event));
      for (const a of emer) {
        const id = 'fav:' + a.id;
        if (state.knownStormAlertIds.has(id)) continue;
        state.knownStormAlertIds.add(id);
        notifyUser(`${a.event} — ${f.label}`, a.headline || '');
        if ($('#sirenEnabled').checked) playSiren();
      }
    } catch (_) {}
  }
}

async function loadEverything(refresh = false) {
  $('#locLabel').textContent = state.label;
  $('#menuLoc').textContent = state.label;
  persistLocation();
  await Promise.all([loadWeather(refresh), refreshAlerts(refresh)]);
  updateFavBtn();
  // re-render whatever tab is active so it shows fresh data
  renderActiveView();
  // keep favorites' alerts monitored for notifications
  checkFavoriteAlerts();
}

/* ------------------------------- weather ------------------------------- */

async function loadWeather(refresh) {
  try {
    const w = await getJSON(`/api/weather?lat=${state.lat}&lon=${state.lon}${refresh ? '&refresh=1' : ''}`);
    state.weather = w;
    if (w.location) { state.label = w.location; $('#locLabel').textContent = w.location; $('#menuLoc').textContent = w.location; }
  } catch (e) {
    console.error('weather load failed', e);
  }
}

/* ------------------------------- rendering ----------------------------- */

function renderActiveView() {
  switch (state.activeNav) {
    case 'home': renderHome(); break;
    case 'radar': renderRadar(); break;
    case 'snow': renderSnow(); break;
    case 'hurricanes': renderHurricanes(); break;
    case 'severe': renderSevere(); break;
    case 'drought': renderDrought(); break;
  }
}

/* ----- HOME ----- */
function renderHome() {
  const w = state.weather;
  if (!w) return;
  const c = w.current;
  $('#curIcon').src = iconUrl(c.icon, c.isDay);
  $('#curTemp').textContent = c.temp ?? '--';
  $('#curCond').textContent = c.condition || '—';
  $('#curHumidity').textContent = `Humidity ${c.humidity ?? '--'}%`;
  const upcoming = [];
  if (c.windSpeed != null) upcoming.push(`Wind ${c.windSpeed} mph ${c.windDir}`);
  if (c.windGust) upcoming.push(`gusts ${c.windGust} mph`);
  const nextRain = (w.hourly || []).find((h) => (h.precipProb ?? 0) >= 40);
  if (nextRain) upcoming.push(`${nextRain.precipProb}% precip ${fmtHour(nextRain.time)}`);
  else upcoming.push('No precipitation expected soon');
  $('#curUpcoming').textContent = upcoming.join(' · ');

  renderPrecipWindow();
  renderIntensity();
  renderHourly();
  renderDaily();
  renderPattern();
}

function renderPrecipWindow() {
  const w = state.weather; if (!w) return;
  const sel = $('#precipWindow').value;
  const pw = (w.precipWindows || {})[sel] || { precip: 0, snow: 0 };
  let html = `<b>${pw.precip ?? 0} in</b> of precipitation over the last ${sel} hour${sel === '1' ? '' : 's'}`;
  if (pw.snow) html += `<br>Includes <b>${pw.snow} in</b> of snow`;
  $('#precipReadout').innerHTML = html;
}

// Weather Channel-style precipitation intensity timeline. Always shows the
// next 12 hours; when no precipitation is expected the bars are greyed out but
// the timeline (with hour labels) still shows.
function renderIntensity() {
  const w = state.weather; if (!w) return;
  const next = (w.hourly || []).slice(0, 12);
  const anyPrecip = next.some((h) => (h.precip || 0) > 0);
  // scale to a sensible ceiling so light rain still reads as "light"
  const max = Math.max(0.3, ...next.map((h) => h.precip || 0));
  const tier = (p) => (p <= 0 ? 'none' : p < 0.1 ? 'light' : p < 0.3 ? 'mod' : 'heavy');
  const step = Math.ceil(next.length / 6);

  $('#intensityGuide').innerHTML = next
    .map((h, i) => {
      const p = h.precip || 0;
      const cls = anyPrecip ? tier(p) : 'none';
      // greyed timeline: uniform low bars when nothing is coming
      const pct = anyPrecip ? Math.max(6, Math.round((p / max) * 100)) : 30;
      const label = i % step === 0 ? `<span>${fmtHour(h.time)}</span>` : '';
      return `<div class="ig-bar ${cls}" style="height:${pct}%" title="${fmtHour(h.time)} · ${p} in">${label}</div>`;
    })
    .join('');

  const status = $('#intensityStatus');
  if (status) {
    status.textContent = anyPrecip
      ? 'Precipitation intensity over the next 12 hours.'
      : 'No precipitation expected in the next 12 hours.';
    status.classList.toggle('muted', !anyPrecip);
  }
}

function renderHourly() {
  const w = state.weather; if (!w) return;
  let lastDay = '';
  const rows = [];
  for (const h of w.hourly || []) {
    const day = new Date(h.time).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    if (day !== lastDay) { rows.push(`<div class="hour-day">${day}</div>`); lastDay = day; }
    rows.push(`
      <div class="hour-row">
        <span class="h-time">${fmtHour(h.time)}</span>
        <img src="${iconUrl(h.icon, isDayHour(h.time, w))}" alt="" />
        <span class="h-temp">${h.temp ?? '--'}°</span>
        <span class="h-wind">${h.wind != null ? h.wind + ' ' + h.windDir : '—'}</span>
        <span class="h-pp">${h.precipProb ?? 0}%</span>
        <span class="h-amt">${(h.snowfall ? h.snowfall + '" sn' : (h.precip ?? 0) + ' in')}</span>
      </div>`);
  }
  $('#hourlyTable').innerHTML = rows.join('') || '<div class="loading">No hourly data.</div>';
}
function isDayHour(iso, w) {
  const h = new Date(iso).getHours();
  return h >= 6 && h < 20 ? 1 : 0;
}

function renderDaily() {
  const w = state.weather; if (!w || !w.daily?.length) return;
  const today = w.daily[0];
  $('#dailyCurrent').innerHTML = `
    <img src="${iconUrl(today.icon)}" alt="" />
    <div>
      <div class="dc-temps"><b>${today.high}°</b> / ${today.low}°F</div>
      <div class="dc-cond">${today.condition}</div>
    </div>`;
  $('#dailyStrip').innerHTML = w.daily
    .map((d, i) => `
      <button class="day-chip ${i === (state.selectedDay ?? 0) ? 'active' : ''}" data-day="${i}">
        <div class="dch-dow">${i === 0 ? 'Today' : fmtDow(d.date)}</div>
        <img src="${iconUrl(d.icon)}" alt="" />
        <div class="dch-hi">${d.high}°</div>
        <div class="dch-lo">${d.low}°</div>
      </button>`)
    .join('');
  $$('#dailyStrip .day-chip').forEach((b) => b.addEventListener('click', () => selectDay(+b.dataset.day)));
  selectDay(state.selectedDay ?? 0);
}

function selectDay(i) {
  state.selectedDay = i;
  const w = state.weather; const d = w.daily[i];
  $$('#dailyStrip .day-chip').forEach((b) => b.classList.toggle('active', +b.dataset.day === i));
  $('#dailyDetailTitle').textContent = `${i === 0 ? 'Today' : fmtDate(d.date)}`;
  $('#dailyDetailStats').innerHTML = `
    <span><b>${d.high}°</b> high</span><span><b>${d.low}°</b> low</span>
    <span>Precip <b>${d.precipProb ?? 0}%</b></span><span>Total <b>${d.precipSum ?? 0} in</b></span>
    ${d.snowSum ? `<span>Snow <b>${d.snowSum} in</b></span>` : ''}
    <span>UV <b>${d.uvMax ?? '—'}</b></span><span>Wind <b>${d.windMax ?? '—'} mph</b> ${d.windDir || ''}</span>`;
  loadDailySummary(d, i);
}

/* ----- Weather Pattern card -----
   Posts ONLY official National Weather Service statements — never our own text.
   If there is an active NWS alert, it shows the hazard and the official alert
   wording; otherwise it shows the official NWS forecast statement. */
function renderPattern() {
  const titleEl = $('#patternTitle');
  const bodyEl = $('#patternText');
  const srcEl = $('#patternSource');
  const w = state.weather;

  // only genuine NWS-issued alerts (not third-party feeds)
  const nwsAlerts = (state.alerts || []).filter((a) => a.source === 'NWS');
  const hz = detectHazard(nwsAlerts);

  if (hz.kind === 'alert') {
    titleEl.textContent = hz.title;
    bodyEl.textContent = hz.body;
    srcEl.textContent = `National Weather Service${hz.alert.expires ? ' · in effect until ' + new Date(hz.alert.expires).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}`;
    return;
  }

  // no active alert -> official NWS forecast statement
  const periods = w?.narratives?.nwsForecast || [];
  if (periods.length) {
    const first = periods[0];
    const colon = first.indexOf(':');
    titleEl.textContent = colon > 0 ? first.slice(0, colon).trim() : 'Forecast';
    bodyEl.textContent = colon > 0 ? first.slice(colon + 1).trim() : first;
    srcEl.textContent = 'National Weather Service forecast';
  } else {
    titleEl.textContent = 'Weather Pattern';
    bodyEl.textContent = 'No National Weather Service statement is available for this location.';
    srcEl.textContent = '';
  }
}

// Pick the most significant active hazard from a list of NWS alerts.
function detectHazard(alerts) {
  const pick = (re) => alerts.find((a) => re.test(a.event || ''));
  const order = [
    [/tornado/i, 'Tornado'],
    [/hurricane|tropical storm|tropical depression/i, 'Tropical System'],
    [/flash flood/i, 'Flash Flood'],
    [/flood/i, 'Flood'],
    [/severe thunderstorm/i, 'Severe Thunderstorms'],
    [/blizzard|winter storm|ice storm|winter weather|snow|freez/i, 'Winter Weather'],
    [/excessive heat|heat/i, 'Extreme Heat'],
    [/(high wind|wind advisory|gale|hurricane force wind)/i, 'High Wind'],
    [/fire|red flag/i, 'Fire Weather'],
    [/freeze|frost/i, 'Cold'],
  ];
  for (const [re, label] of order) {
    const a = pick(re);
    if (a) return { kind: 'alert', title: label, body: cleanDesc(a), alert: a };
  }
  return { kind: 'none' };
}

// Trim an official alert into a short overview (first few sentences).
function cleanDesc(a) {
  const raw = (a.description || a.headline || '').replace(/\s+/g, ' ').trim();
  if (!raw) return a.event;
  const sentences = raw.split(/(?<=[.!?])\s+/).slice(0, 4).join(' ');
  return sentences.length > 420 ? sentences.slice(0, 417) + '…' : sentences;
}

async function loadDailySummary(d, i) {
  const el = $('#dailyDetailSummary');
  el.innerHTML = 'Summarizing the day… <span class="ai-badge">AI</span>';
  try {
    const r = await postJSON('/api/ai/daily', {
      day: d,
      location: state.weather?.location,
      nwsPeriods: state.weather?.narratives?.nwsForecast,
    });
    el.innerHTML = (r.text || dailyFallback(d)) + ' <span class="ai-badge">AI</span>';
  } catch (_) { el.innerHTML = dailyFallback(d) + ' <span class="ai-badge">AI</span>'; }
}
function dailyFallback(d) {
  return `${d.condition} with a high of ${d.high}°F and a low of ${d.low}°F. ${d.precipProb ? d.precipProb + '% chance of precipitation.' : 'Dry conditions expected.'}`;
}

function key() { return `${state.lat?.toFixed(2)},${state.lon?.toFixed(2)}`; }

/* ----- RADAR ----- */
const RADAR_LEGEND = [
  ['#7fa8c9', 'Fog'], ['#39d353', 'Rain'], ['#f2e74b', 'Storms'], ['#5aa9ff', 'Snow'],
  ['#ff9ad5', 'Ice'], ['#b388ff', 'Wintry mix'], ['#e53935', 'Hurricane warning'],
  ['#ff7043', 'Tornado'], ['#fdd835', 'Flood'], ['#9575cd', 'Other'],
];

function renderRadar() {
  $('#radarLegend').innerHTML = RADAR_LEGEND
    .map(([c, l]) => `<div class="legend-item"><span class="legend-swatch" style="background:${c}"></span>${l}</div>`)
    .join('');
  if (!state.maps.radar) initRadarMap();
  else state.maps.radar.setView([state.lat, state.lon], state.maps.radar.getZoom());
  setTimeout(() => state.maps.radar?.invalidateSize(), 60);
  renderGraph();
}

async function initRadarMap() {
  const map = L.map('radarMap', { zoomControl: false, attributionControl: false }).setView([state.lat, state.lon], 7);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 12 }).addTo(map);
  state.maps.radar = map;
  state.warningsLayer = L.layerGroup().addTo(map);
  state.stormsLayer = L.layerGroup();

  // forecast precipitation layer (Environment Canada GeoMet HRDPS, hourly, free)
  state.radar.geoLayer = L.tileLayer.wms('https://geo.weather.gc.ca/geomet?', {
    layers: 'HRDPS.CONTINENTAL_PR', format: 'image/png', transparent: true,
    version: '1.3.0', opacity: 0.6, zIndex: 5,
  });

  $('#lyrWarnings').addEventListener('change', (e) => e.target.checked ? state.warningsLayer.addTo(map) : state.warningsLayer.remove());
  $('#lyrStorms').addEventListener('change', (e) => e.target.checked ? drawStormTracks() : state.stormsLayer.remove());
  $('#lyrPin').addEventListener('change', (e) => {
    if (e.target.checked) {
      state.pinMarker = L.marker([state.lat, state.lon], { draggable: true }).addTo(map);
      state.pinMarker.on('dragend', () => {
        const ll = state.pinMarker.getLatLng();
        setLocation(ll.lat, ll.lng, `Pin: ${ll.lat.toFixed(2)}, ${ll.lng.toFixed(2)}`);
      });
    } else if (state.pinMarker) { state.pinMarker.remove(); state.pinMarker = null; }
  });

  $('#radarSlider').addEventListener('input', (e) => showRadarFrame(+e.target.value));
  $('#radarPlay').addEventListener('click', toggleRadarPlay);

  await loadRadarFrames();
  drawWarnings();
}

async function loadRadarFrames() {
  const slider = $('#radarSlider');
  const frames = [];

  // 1) RainViewer — real observed radar (last ~2h + short nowcast)
  try {
    const data = await getJSON('https://api.rainviewer.com/public/weather-maps.json');
    state.radar.host = data.host;
    for (const f of [...(data.radar?.past || []), ...(data.radar?.nowcast || [])]) {
      frames.push({ type: 'radar', time: f.time, path: f.path });
    }
  } catch (e) { /* radar may be momentarily unavailable */ }

  // 2) GeoMet HRDPS — forecast precipitation, hourly out to +24h
  try {
    const range = await geometTimeRange();
    if (range) {
      const nowMs = Date.now();
      const limit = nowMs + 24 * 3600e3;
      let t = Math.ceil(nowMs / 3600e3) * 3600e3; // next top of hour
      t = Math.max(t, range.start);
      for (; t <= Math.min(limit, range.end); t += 3600e3) {
        frames.push({ type: 'forecast', time: Math.floor(t / 1000), iso: new Date(t).toISOString().replace('.000', '') });
      }
    }
  } catch (e) { /* forecast layer optional */ }

  frames.sort((a, b) => a.time - b.time);
  state.radar.frames = frames;
  if (!frames.length) { $('#radarTime').textContent = 'Radar unavailable'; return; }

  const nowS = Date.now() / 1000;
  let idx = frames.findIndex((f) => f.time >= nowS);
  if (idx < 0) idx = frames.length - 1;
  state.radar.idx = idx;
  slider.max = frames.length - 1;
  slider.value = idx;
  showRadarFrame(idx);
}

// Read the HRDPS precipitation layer's valid time window from GeoMet capabilities.
async function geometTimeRange() {
  const res = await fetch('https://geo.weather.gc.ca/geomet?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities&LAYER=HRDPS.CONTINENTAL_PR');
  const txt = await res.text();
  const m = txt.match(/name="time"[^>]*>\s*([0-9T:Z-]+)\/([0-9T:Z-]+)/i);
  if (!m) return null;
  return { start: Date.parse(m[1]), end: Date.parse(m[2]) };
}

function showRadarFrame(i) {
  const r = state.radar; const map = state.maps.radar;
  if (!r.frames[i] || !map) return;
  r.idx = i;
  const f = r.frames[i];

  if (f.type === 'forecast') {
    if (r.layer && map.hasLayer(r.layer)) map.removeLayer(r.layer);
    if (!map.hasLayer(r.geoLayer)) r.geoLayer.addTo(map);
    r.geoLayer.setParams({ time: f.iso });
  } else {
    if (r.geoLayer && map.hasLayer(r.geoLayer)) map.removeLayer(r.geoLayer);
    const url = `${r.host}${f.path}/256/{z}/{x}/{y}/4/1_1.png`; // scheme 4 = light rain green
    if (r.layer) { r.layer.setUrl(url); if (!map.hasLayer(r.layer)) r.layer.addTo(map); }
    else r.layer = L.tileLayer(url, { opacity: 0.8, zIndex: 5 }).addTo(map);
  }

  const d = new Date(f.time * 1000);
  const now = Date.now() / 1000;
  const when = d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  $('#radarTime').textContent = f.time > now ? `${when} · forecast` : when;
  $('#radarSlider').value = i;
}

function toggleRadarPlay() {
  const r = state.radar;
  r.playing = !r.playing;
  $('#radarPlay').innerHTML = r.playing ? '&#10073;&#10073;' : '&#9654;';
  if (r.playing) {
    r.timer = setInterval(() => {
      let n = r.idx + 1; if (n > r.frames.length - 1) n = 0;
      showRadarFrame(n);
    }, 600);
  } else clearInterval(r.timer);
}

async function drawWarnings() {
  if (!state.warningsLayer) return;
  state.warningsLayer.clearLayers();
  for (const a of state.alerts) {
    if (!a.area) continue;
    // mark the alert center with a colored circle (polygon geometry not always present)
    L.circleMarker([state.lat, state.lon], {
      radius: 10, color: a.severity === 'Extreme' || a.severity === 'Severe' ? '#e53935' : '#fdd835',
      fillOpacity: 0.4,
    }).bindPopup(`<b>${a.event}</b><br>${a.area}`).addTo(state.warningsLayer);
    break; // single representative marker; full list lives in Severe tab
  }
}

async function drawStormTracks() {
  const map = state.maps.radar;
  state.stormsLayer.clearLayers().addTo(map);
  const storms = await ensureStorms();
  for (const s of storms) {
    if (Number.isNaN(s.lat) || Number.isNaN(s.lon)) continue;
    L.marker([s.lat, s.lon]).bindPopup(`<b>${s.name}</b><br>${s.classification} · ${s.intensity} kt`).addTo(state.stormsLayer);
  }
}

/* ----- precip graph + breakdown ----- */
function renderGraph() {
  const w = state.weather; if (!w) return;
  const range = +$('#graphRange').value;
  const hrs = (w.hourly || []).slice(0, range);
  drawPrecipChart(hrs);
  // breakdown: came (past windows), coming (next), on-ground (depth/sum)
  const pw = w.precipWindows || {};
  const next = hrs;
  const sum = (arr, k) => arr.reduce((s, h) => s + (h[k] || 0), 0);
  const breakdown = {
    snow: { came: pw['6']?.snow ?? 0, coming: r2(sum(next, 'snowfall')), ground: r2(next.at(-1)?.snowDepth ?? next[0]?.snowDepth ?? 0) },
    rain: { came: r2((pw['6']?.precip ?? 0) - (pw['6']?.snow ?? 0)), coming: r2(sum(next, 'rain')) },
    mix: { came: 0, coming: r2(sum(next.filter((h) => /sleet|freezing|mix/i.test(h.condition)), 'precip')) },
    ice: { came: 0, coming: r2(sum(next.filter((h) => /ice|freezing/i.test(h.condition)), 'precip')) },
  };
  fillBreakdown('snow', [['Came', breakdown.snow.came + ' in'], ['Coming', breakdown.snow.coming + ' in'], ['On ground', breakdown.snow.ground + ' in']]);
  fillBreakdown('rain', [['Came', breakdown.rain.came + ' in'], ['Coming', breakdown.rain.coming + ' in']]);
  fillBreakdown('mix', [['Coming', breakdown.mix.coming + ' in']]);
  fillBreakdown('ice', [['Coming', breakdown.ice.coming + ' in']]);
}
function r2(v) { return Math.round((v || 0) * 100) / 100; }
function fillBreakdown(type, rows) {
  const el = $(`.pb-card[data-type="${type}"] .pb-rows`);
  if (el) el.innerHTML = rows.map(([k, v]) => `${k} <b>${v}</b>`).join('<br>');
}

function drawPrecipChart(hrs) {
  const cv = $('#precipChart');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = 200;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  if (!hrs.length) return;
  const pad = { l: 34, r: 8, t: 12, b: 22 };
  const max = Math.max(0.1, ...hrs.map((h) => h.precip || 0));
  const x = (i) => pad.l + (i / (hrs.length - 1)) * (W - pad.l - pad.r);
  const y = (v) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  // grid + y labels
  ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.fillStyle = '#aebfdc'; ctx.font = '11px sans-serif';
  for (let g = 0; g <= 3; g++) {
    const val = (max * g) / 3; const yy = y(val);
    ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke();
    ctx.fillText(val.toFixed(1) + 'in', 2, yy + 3);
  }
  // x labels (every few)
  const step = Math.ceil(hrs.length / 6);
  hrs.forEach((h, i) => { if (i % step === 0) ctx.fillText(fmtHour(h.time), x(i) - 8, H - 6); });
  // area fill
  ctx.beginPath(); ctx.moveTo(x(0), y(0));
  hrs.forEach((h, i) => ctx.lineTo(x(i), y(h.precip || 0)));
  ctx.lineTo(x(hrs.length - 1), y(0)); ctx.closePath();
  const grad = ctx.createLinearGradient(0, pad.t, 0, H);
  grad.addColorStop(0, 'rgba(88,192,255,.55)'); grad.addColorStop(1, 'rgba(88,192,255,.05)');
  ctx.fillStyle = grad; ctx.fill();
  // line
  ctx.beginPath(); hrs.forEach((h, i) => i ? ctx.lineTo(x(i), y(h.precip || 0)) : ctx.moveTo(x(i), y(h.precip || 0)));
  ctx.strokeStyle = '#58c0ff'; ctx.lineWidth = 2; ctx.stroke();
}

/* ----- SNOW ----- */
function renderSnow() {
  const w = state.weather; if (!w) return;
  const snowDays = w.daily.filter((d) => (d.snowSum || 0) > 0);
  const total = r2(w.daily.reduce((s, d) => s + (d.snowSum || 0), 0));
  $('#snowSummary').textContent = total > 0
    ? `${total} in of snow expected over the next 7 days${snowDays.length ? `, mainly ${snowDays.map((d) => fmtDow(d.date)).join(', ')}.` : '.'}`
    : 'No measurable snowfall is expected in the next 7 days.';
  $('#snowStrip').innerHTML = w.daily.map((d) => `
    <div class="day-chip">
      <div class="dch-dow">${fmtDow(d.date)}</div>
      <img src="${iconUrl(d.icon)}" alt="" />
      <div class="dch-hi">${d.snowSum || 0}"</div>
      <div class="dch-lo">${d.low}°</div>
    </div>`).join('');
  if (!state.maps.snow) {
    const map = L.map('snowMap', { zoomControl: false, attributionControl: false }).setView([state.lat, state.lon], 6);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 12 }).addTo(map);
    // Open-Meteo snow depth overlay via NWS/RainViewer snow isn't tiled; show marker + radar snow frame
    if (state.radar.host) {
      const radarFrames = state.radar.frames.filter((f) => f.type === 'radar');
      const f = radarFrames[radarFrames.length - 1];
      if (f) L.tileLayer(`${state.radar.host}${f.path}/256/{z}/{x}/{y}/4/1_1.png`, { opacity: 0.6 }).addTo(map);
    }
    L.marker([state.lat, state.lon]).addTo(map);
    state.maps.snow = map;
  }
  setTimeout(() => state.maps.snow?.invalidateSize(), 60);
}

/* ----- HURRICANES ----- */
async function ensureStorms() {
  if (state.storms) return state.storms;
  try { state.storms = await getJSON('/api/storms'); } catch (_) { state.storms = []; }
  return state.storms;
}
async function renderHurricanes() {
  const storms = await ensureStorms();
  $('#stormList').innerHTML = storms.length
    ? storms.map((s) => `
      <div class="storm-card">
        <span class="sc-cat">${classifyIcon(s.classification)}</span>
        <div style="flex:1">
          <div class="sc-name">${s.name} <span class="sev-tag">${s.classification}</span></div>
          <div class="sc-meta">${s.intensity ? s.intensity + ' kt' : ''} ${s.pressure ? '· ' + s.pressure + ' mb' : ''} ${s.movement ? '· ' + s.movement : ''}</div>
          ${s.forecastGraphics ? `<a href="${s.forecastGraphics}" target="_blank" rel="noopener">NHC forecast cone &rarr;</a>` : ''}
        </div>
      </div>`).join('')
    : '<div class="empty-state">No active tropical systems right now. The official NOAA maps below show the latest tropical outlook.</div>';
  // the maps themselves are NOAA's official interactive maps (iframes); see wireUI for basin switching
}
function classifyIcon(c = '') {
  if (/hurricane/i.test(c)) return '🌀';
  if (/tropical storm/i.test(c)) return '🌧️';
  if (/depression/i.test(c)) return '💨';
  return '🌀';
}

/* ----- SEVERE ----- */
function renderSevere() {
  const list = state.alerts;
  const filterSel = $('#alertFilter');
  const events = [...new Set(list.map((a) => a.event))];
  const cur = filterSel.value;
  filterSel.innerHTML = '<option value="all">All events</option>' + events.map((e) => `<option value="${e}">${e}</option>`).join('');
  filterSel.value = events.includes(cur) ? cur : 'all';
  filterSel.onchange = renderSevere;

  const shown = filterSel.value === 'all' ? list : list.filter((a) => a.event === filterSel.value);
  $('#alertList').innerHTML = shown.length
    ? shown.map((a, i) => `
      <div class="alert-card sev-${a.severity}" data-i="${i}">
        <div class="ac-event">${severityIcon(a.severity)} ${a.event} ${a.severity ? `<span class="sev-tag">${a.severity}</span>` : ''}</div>
        <div class="ac-area">${a.area || ''} · ${a.source}${a.expires ? ' · until ' + new Date(a.expires).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}</div>
        <div class="ac-toggle">Details</div>
        <div class="ac-desc">${(a.description || a.headline || '').replace(/\n/g, '<br>')}${a.instruction ? '<br><br><b>Instructions:</b> ' + a.instruction.replace(/\n/g, '<br>') : ''}</div>
      </div>`).join('')
    : '<div class="empty-state">No active watches or warnings for this area. Stay safe! 🌤️</div>';
  $$('#alertList .alert-card').forEach((el) => el.querySelector('.ac-toggle').addEventListener('click', () => el.classList.toggle('open')));
}
function severityIcon(_s) { return '⚠️'; }

/* ----- DROUGHT ----- */
async function renderDrought() {
  const w = state.weather;
  if (!state.drought) {
    try { state.drought = await getJSON(`/api/drought?lat=${state.lat}&lon=${state.lon}`); } catch (_) { state.drought = {}; }
  }
  const d = state.drought;
  $('#droughtLevel').textContent = d.categoryLabel || 'No drought designation';
  // meter: None=0, D0..D4 -> 20..100%
  const pct = d.dm != null && d.dm >= 0 ? ((d.dm + 1) / 5) * 100 : 0;
  $('#droughtMeterFill').style.width = pct + '%';

  if (d.precip) {
    $('#droughtPrecip').innerHTML = `
      Last 30 days: <b>${d.precip.last30 ?? '—'} in</b><br>
      Last 90 days: <b>${d.precip.last90 ?? '—'} in</b><br>
      <div style="margin-top:8px;color:var(--text-dim);font-size:13px">Recent daily:</div>
      ${(d.precip.recent || []).map((r) => `${fmtDow(r.date)} ${r.precip} in`).join(' · ')}`;
  } else {
    $('#droughtPrecip').textContent = 'Precipitation history unavailable.';
  }

  if (!state.maps.drought) {
    const map = L.map('droughtMap', { zoomControl: false, attributionControl: false }).setView([state.lat, state.lon], 6);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 10 }).addTo(map);
    // U.S. Drought Monitor polygons (official), shaded yellow -> red by category
    state.droughtGeo = L.geoJSON(null, { style: droughtStyle }).addTo(map);
    L.circleMarker([state.lat, state.lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#1a73e8', fillOpacity: 1 }).addTo(map);
    map.on('moveend', () => loadDroughtPolygons(map));
    state.maps.drought = map;
    loadDroughtPolygons(map);
  } else {
    state.maps.drought.setView([state.lat, state.lon], state.maps.drought.getZoom());
  }
  setTimeout(() => state.maps.drought?.invalidateSize(), 60);

  // drought summary
  const el = $('#droughtSummary');
  el.textContent = 'Assessing local drought conditions…';
  try {
    const r = await postJSON('/api/ai/drought', { drought: d, location: w?.location, precip: d.precip });
    el.textContent = r.text || droughtFallback(d);
  } catch (_) { el.textContent = droughtFallback(d); }
}
// D0..D4 shading (yellow -> dark red), matching the U.S. Drought Monitor.
const DM_COLORS = ['#ffff00', '#fcd37f', '#ffaa00', '#e60000', '#730000'];
function droughtStyle(f) {
  const c = DM_COLORS[f.properties.DM] || '#888';
  return { color: c, weight: 1, fillColor: c, fillOpacity: 0.45 };
}
async function loadDroughtPolygons(map) {
  if (!state.droughtGeo) return;
  try {
    const b = map.getBounds();
    const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
    const url =
      'https://services5.arcgis.com/0OTVzJS4K09zlixn/arcgis/rest/services/USDM_current/FeatureServer/0/query' +
      `?where=DM%3E%3D0&geometry=${encodeURIComponent(bbox)}&geometryType=esriGeometryEnvelope&inSR=4326` +
      '&spatialRel=esriSpatialRelIntersects&outFields=DM&returnGeometry=true&f=geojson&outSR=4326' +
      '&maxAllowableOffset=0.02&geometryPrecision=3';
    const gj = await getJSON(url);
    state.droughtGeo.clearLayers();
    if (gj.features?.length) state.droughtGeo.addData(gj);
  } catch (e) { console.warn('drought polygons failed', e); }
}

function droughtFallback(d) {
  if (!d.categoryLabel || d.category === 'None') return 'No drought is currently designated for this area by the U.S. Drought Monitor.';
  return `Current status: ${d.categoryLabel}. Recent precipitation has been ${d.precip?.last30 ?? '?'} in over 30 days.`;
}

/* ------------------------------- alerts/siren -------------------------- */
async function refreshAlerts(refresh) {
  try {
    const list = await getJSON(`/api/alerts?lat=${state.lat}&lon=${state.lon}${refresh ? '&refresh=1' : ''}`);
    state.alerts = list;
    handleEmergency(list);
    if (state.activeNav === 'severe') renderSevere();
    if (state.warningsLayer) drawWarnings();
  } catch (e) { console.warn('alerts failed', e); }
}

function handleEmergency(list) {
  const emergencies = list.filter((a) => ['Extreme', 'Severe'].includes(a.severity) && /Warning/i.test(a.event));
  const banner = $('#alertBanner');
  if (emergencies.length) {
    const top = emergencies[0];
    $('#alertBannerText').textContent = `${top.event} — ${top.area || ''}`;
    banner.classList.remove('hidden');
    // play siren + notify once per new emergency id (respecting the siren toggle)
    const newOnes = emergencies.filter((a) => !state.knownStormAlertIds.has(a.id));
    if (newOnes.length && $('#sirenEnabled').checked) playSiren();
    newOnes.forEach((a) => notifyUser(`${a.event} — ${state.label}`, a.headline || ''));
    emergencies.forEach((a) => state.knownStormAlertIds.add(a.id));
  } else {
    banner.classList.add('hidden');
  }
}

function playSiren() {
  const s = $('#siren');
  s.currentTime = 0;
  s.play().catch(() => {/* needs a user gesture first; banner remains visible */});
}
function stopSiren() { const s = $('#siren'); s.pause(); s.currentTime = 0; }

/* --------------------------------- UI wiring --------------------------- */
function wireUI() {
  // bottom nav
  $$('.navbtn').forEach((b) => b.addEventListener('click', () => switchNav(b.dataset.nav)));
  // subtabs
  $$('.subtabs').forEach((group) => {
    group.querySelectorAll('.subtab').forEach((tab) => tab.addEventListener('click', () => {
      group.querySelectorAll('.subtab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const view = group.closest('.view');
      view.querySelectorAll('.subview').forEach((sv) => sv.classList.toggle('hidden', sv.dataset.sub !== tab.dataset.sub));
      if (tab.dataset.sub === 'map' || tab.dataset.sub === 'graph') renderRadar();
    }));
  });

  $('#precipWindow').addEventListener('change', renderPrecipWindow);
  $('#graphRange').addEventListener('change', renderGraph);
  $('#refreshBtn').addEventListener('click', doRefresh);

  // search
  const si = $('#searchInput');
  let t;
  si.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => doSearch(si.value), 280); });
  si.addEventListener('focus', () => doSearch(si.value));
  document.addEventListener('click', (e) => { if (!e.target.closest('.search-wrap')) $('#searchResults').classList.add('hidden'); });

  // favorite the current place
  $('#favBtn').addEventListener('click', () => { if (state.lat != null) toggleFav(state.lat, state.lon, state.label); });

  // hurricanes: switch between NOAA's three official basin maps
  $$('.subtabs[data-group="hurricanes"] .subtab').forEach((tab) => tab.addEventListener('click', () => {
    const basin = tab.dataset.basin;
    $('#nhcFrame').src = `https://www.nhc.noaa.gov/?${basin}`;
    $('#nhcOpen').href = `https://www.nhc.noaa.gov/?${basin}`;
  }));

  // menu
  $('#menuBtn').addEventListener('click', () => toggleMenu(true));
  $('#overlay').addEventListener('click', () => { toggleMenu(false); closeAbout(); });
  $$('#sideMenu .menu-item').forEach((b) => b.addEventListener('click', () => menuAction(b.dataset.act)));
  $('#infoBtn').addEventListener('click', openAbout);
  $('#aboutClose').addEventListener('click', closeAbout);
  $('#silenceBtn').addEventListener('click', () => { stopSiren(); });

  // a user gesture unlocks audio for later siren playback
  document.addEventListener('click', unlockAudioOnce, { once: true });

  setupPullToRefresh();

  // health -> AI availability note
  getJSON('/api/health').then((h) => {
    $('#aboutAi').textContent = h.ai
      ? 'AI summaries (weather pattern, daily outlook, drought) are powered by Claude.'
      : 'AI summaries fall back to provider narratives until an Anthropic API key is configured on the server.';
  }).catch(() => {});
}

function unlockAudioOnce() {
  const s = $('#siren');
  s.play().then(() => { s.pause(); s.currentTime = 0; }).catch(() => {});
  requestNotifyPermission();
}

function switchNav(nav) {
  state.activeNav = nav;
  $$('.navbtn').forEach((b) => b.classList.toggle('active', b.dataset.nav === nav));
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.dataset.view !== nav));
  renderActiveView();
}

async function doSearch(q) {
  q = (q || '').trim();
  const box = $('#searchResults');
  let results = [];
  if (q) { try { results = await getJSON(`/api/geocode?q=${encodeURIComponent(q)}`); } catch (_) {} }
  renderSearchList(box, q, getFavs(), results);
}

function renderSearchList(box, q, favs, results) {
  box.classList.remove('hidden');
  // favorites first (all when no query, else those that match) — they "pop up near the top"
  const favShown = q ? favs.filter((f) => f.label.toLowerCase().includes(q.toLowerCase())) : favs;
  const others = results.filter((r) => !favShown.some((f) => favKey(f.lat, f.lon) === favKey(r.lat, r.lon)));
  let html = '';
  if (favShown.length) {
    html += '<div class="sr-section">Favorites</div>' + favShown.map((f) => srItem(f.lat, f.lon, f.label, true)).join('');
  }
  if (others.length) {
    if (favShown.length) html += '<div class="sr-section">Search results</div>';
    html += others.map((r) => srItem(r.lat, r.lon, r.label, isFav(r.lat, r.lon))).join('');
  }
  if (!html) html = q ? '<div class="sr-empty">No matches</div>' : '<div class="sr-empty">Search for a town, or tap the ♥ to save favorites.</div>';
  box.innerHTML = html;

  $$('.sr-item', box).forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('.sr-heart')) return;
    setLocation(+el.dataset.lat, +el.dataset.lon, el.dataset.label);
    box.classList.add('hidden'); $('#searchInput').value = '';
  }));
  $$('.sr-heart', box).forEach((el) => el.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFav(+el.dataset.lat, +el.dataset.lon, el.dataset.label);
    doSearch($('#searchInput').value);
  }));
}

function srItem(lat, lon, label, fav) {
  const safe = String(label).replace(/"/g, '&quot;');
  return `<div class="sr-item" data-lat="${lat}" data-lon="${lon}" data-label="${safe}">
    <span class="sr-label">${label}</span>
    <button class="sr-heart ${fav ? 'on' : ''}" data-lat="${lat}" data-lon="${lon}" data-label="${safe}" title="${fav ? 'Remove favorite' : 'Add favorite'}">${fav ? '&#9829;' : '&#9825;'}</button>
  </div>`;
}

function setLocation(lat, lon, label) {
  state.lat = lat; state.lon = lon; state.label = label;
  state.drought = null; state.selectedDay = 0;
  state._patternFor = null; state._patternAI = null; state._droughtFor = null; state._droughtText = null;
  // reset maps tied to the old location so they recenter
  for (const k of ['snow', 'drought']) { if (state.maps[k]) { state.maps[k].remove(); delete state.maps[k]; } }
  if (state.maps.radar) state.maps.radar.setView([lat, lon], state.maps.radar.getZoom());
  loadEverything(true);
}

function doRefresh() {
  const btn = $('#refreshBtn'); btn.style.transform = 'rotate(360deg)'; btn.style.transition = 'transform .6s';
  setTimeout(() => { btn.style.transform = ''; btn.style.transition = ''; }, 600);
  state.drought = null; state.storms = null;
  state._patternFor = null; state._patternAI = null; state._droughtFor = null; state._droughtText = null;
  loadEverything(true);
}

function toggleMenu(open) {
  $('#sideMenu').classList.toggle('hidden', !open);
  $('#overlay').classList.toggle('hidden', !open && $('#aboutModal').classList.contains('hidden'));
}
function menuAction(act) {
  if (act === 'refresh') { doRefresh(); toggleMenu(false); }
  else if (act === 'about') { toggleMenu(false); openAbout(); }
  else if (act === 'locate') { useMyLocation(); toggleMenu(false); }
}
function useMyLocation() {
  if (!navigator.geolocation) { alert('Geolocation is not supported by this browser.'); return; }
  $('#locLabel').textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(
    async (p) => {
      let label = 'Your location';
      try { const r = await getJSON(`/api/reverse?lat=${p.coords.latitude}&lon=${p.coords.longitude}`); label = r.label; } catch (_) {}
      setLocation(p.coords.latitude, p.coords.longitude, label);
    },
    (err) => {
      $('#locLabel').textContent = state.label;
      const msg = err.code === 1
        ? 'Location access was denied. Allow location for this site in your browser settings, then try again.'
        : err.code === 3
        ? 'Getting your location timed out. Please try again.'
        : 'Could not get your location. Please search for your town instead.';
      alert(msg);
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}
function openAbout() { $('#aboutModal').classList.remove('hidden'); $('#overlay').classList.remove('hidden'); }
function closeAbout() { $('#aboutModal').classList.add('hidden'); if ($('#sideMenu').classList.contains('hidden')) $('#overlay').classList.add('hidden'); }

/* pull-to-refresh (swipe down to refresh, per the notes) */
function setupPullToRefresh() {
  let startY = 0, pulling = false;
  const ptr = $('#ptr');
  window.addEventListener('touchstart', (e) => { if (window.scrollY <= 0) { startY = e.touches[0].clientY; pulling = true; } }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 60) ptr.classList.add('show'); else ptr.classList.remove('show');
  }, { passive: true });
  window.addEventListener('touchend', (e) => {
    if (pulling && ptr.classList.contains('show')) { ptr.classList.remove('show'); doRefresh(); }
    pulling = false;
  });
}
