// Weather Watcher — server.
// Serves the static front-end and proxies/aggregates the weather data providers
// (keeping API keys server-side) plus the three AI summary endpoints.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  geocode,
  reverseGeocode,
  aggregateWeather,
  getAlerts,
  getActiveStorms,
  getDroughtData,
} from './providers.js';
import { patternOverview, dailySummary, droughtSummary, aiAvailable } from './ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// simple in-memory cache to be kind to the upstream APIs
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

function asyncRoute(fn) {
  return (req, res) => fn(req, res).catch((e) => {
    console.error(`[${req.path}]`, e);
    res.status(502).json({ error: e.message || 'upstream error' });
  });
}

const num = (v) => {
  const n = parseFloat(v);
  if (Number.isNaN(n)) throw new Error('invalid coordinate');
  return n;
};

/* --------------------------------- routes ---------------------------------- */

app.get('/api/health', (_req, res) => res.json({ ok: true, ai: aiAvailable() }));

app.get('/api/geocode', asyncRoute(async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.json([]);
  res.json(await cached(`geo:${q.toLowerCase()}`, 6 * 3600e3, () => geocode(q)));
}));

app.get('/api/reverse', asyncRoute(async (req, res) => {
  res.json(await reverseGeocode(num(req.query.lat), num(req.query.lon)));
}));

app.get('/api/weather', asyncRoute(async (req, res) => {
  const lat = num(req.query.lat);
  const lon = num(req.query.lon);
  const fresh = req.query.refresh === '1';
  const key = `wx:${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (fresh) cache.delete(key);
  res.json(await cached(key, 5 * 60e3, () => aggregateWeather(lat, lon)));
}));

app.get('/api/alerts', asyncRoute(async (req, res) => {
  const lat = num(req.query.lat);
  const lon = num(req.query.lon);
  const fresh = req.query.refresh === '1';
  const key = `al:${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (fresh) cache.delete(key);
  res.json(await cached(key, 60e3, () => getAlerts(lat, lon)));
}));

app.get('/api/storms', asyncRoute(async (_req, res) => {
  res.json(await cached('storms', 10 * 60e3, () => getActiveStorms()));
}));

app.get('/api/drought', asyncRoute(async (req, res) => {
  const lat = num(req.query.lat);
  const lon = num(req.query.lon);
  res.json(await cached(`dr:${lat.toFixed(2)},${lon.toFixed(2)}`, 6 * 3600e3, () => getDroughtData(lat, lon)));
}));

/* ------------------------------ AI summaries ------------------------------- */

app.post('/api/ai/pattern', asyncRoute(async (req, res) => {
  res.json(await patternOverview(req.body || {}));
}));

app.post('/api/ai/daily', asyncRoute(async (req, res) => {
  const { day, location, nwsPeriods } = req.body || {};
  if (!day) return res.status(400).json({ error: 'missing day' });
  res.json(await dailySummary(day, location, nwsPeriods));
}));

app.post('/api/ai/drought', asyncRoute(async (req, res) => {
  const { drought, location, precip } = req.body || {};
  res.json(await droughtSummary(drought || {}, location, precip));
}));

/* ------------------------------- static app -------------------------------- */

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`Weather Watcher running on http://localhost:${PORT}  (AI: ${aiAvailable() ? 'on' : 'off'})`);
});
