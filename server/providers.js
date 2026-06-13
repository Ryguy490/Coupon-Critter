// Weather data providers.
//
// Per the project spec the app pulls from multiple sources and merges them
// (the hand-drawn notes list NWS, IBM/Dual-Doppler, WRAL, Weather Channel,
// AccuWeather, Snow.com). Of those, the sources that expose an open API and
// were specified for this build are:
//   - NWS              (api.weather.gov)            - no key
//   - Open-Meteo       (api.open-meteo.com)         - no key
//   - WeatherAPI.com   (api.weatherapi.com)         - key
//   - Pirate Weather   (api.pirateweather.net)      - key
//   - NCEI / RainViewer / NHC / Drought Monitor for radar, storms, drought
//
// Open-Meteo is used as the backbone (most complete free time series) and the
// others enrich / cross-check it. The numbers shown in the notebook mock-ups
// are placeholders only; everything here is live data.

const WEATHERAPI_KEY = process.env.WEATHERAPI_KEY || '6c167a50ff574618987180912261306';
const PIRATE_WEATHER_KEY = process.env.PIRATE_WEATHER_KEY || 'r7yOLHkOseKaqzJUOVHKSlSt0UlEPNSN';

const UA = 'WeatherWatcher/1.0 (weather web app)';

async function getJSON(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeout || 12000),
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

// Run a list of provider promises, keep the ones that resolve.
async function settleAll(jobs) {
  const out = {};
  const results = await Promise.allSettled(jobs.map((j) => j.fn()));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') out[jobs[i].name] = r.value;
    else console.warn(`[provider] ${jobs[i].name} failed:`, r.reason?.message || r.reason);
  });
  return out;
}

/* --------------------------------- geocoding -------------------------------- */

export async function geocode(name) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=8&language=en&format=json`;
  const data = await getJSON(url);
  return (data.results || []).map((r) => ({
    name: r.name,
    admin1: r.admin1,
    country: r.country,
    countryCode: r.country_code,
    lat: r.latitude,
    lon: r.longitude,
    label: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
  }));
}

export async function reverseGeocode(lat, lon) {
  try {
    const data = await getJSON(
      `https://api.weatherapi.com/v1/search.json?key=${WEATHERAPI_KEY}&q=${lat},${lon}`
    );
    if (Array.isArray(data) && data[0]) {
      const r = data[0];
      return { name: r.name, label: [r.name, r.region, r.country].filter(Boolean).join(', '), lat, lon };
    }
  } catch (_) {}
  return { name: 'Selected location', label: `${(+lat).toFixed(3)}, ${(+lon).toFixed(3)}`, lat, lon };
}

/* ------------------------------ individual feeds ---------------------------- */

async function fetchOpenMeteo(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: 'auto',
    current:
      'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,showers,snowfall,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,uv_index,is_day,pressure_msl,visibility',
    hourly:
      'temperature_2m,apparent_temperature,precipitation_probability,precipitation,rain,showers,snowfall,snow_depth,weather_code,wind_speed_10m,wind_direction_10m,uv_index,relative_humidity_2m',
    daily:
      'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,sunrise,sunset,uv_index_max,precipitation_sum,rain_sum,showers_sum,snowfall_sum,precipitation_probability_max,wind_speed_10m_max,wind_direction_10m_dominant',
    past_days: 2,
    forecast_days: 7,
  });
  return getJSON(`https://api.open-meteo.com/v1/forecast?${params}`);
}

async function fetchWeatherAPI(lat, lon) {
  return getJSON(
    `https://api.weatherapi.com/v1/forecast.json?key=${WEATHERAPI_KEY}&q=${lat},${lon}&days=7&aqi=yes&alerts=yes`
  );
}

async function fetchPirate(lat, lon) {
  return getJSON(
    `https://api.pirateweather.net/forecast/${PIRATE_WEATHER_KEY}/${lat},${lon}?units=us&extend=hourly`
  );
}

// NWS: resolve grid point then pull the text forecast + observation station.
async function fetchNWS(lat, lon) {
  const point = await getJSON(`https://api.weather.gov/points/${(+lat).toFixed(4)},${(+lon).toFixed(4)}`);
  const props = point.properties || {};
  const out = { point: props };
  const jobs = [];
  if (props.forecast) jobs.push({ name: 'forecast', fn: () => getJSON(props.forecast) });
  if (props.forecastHourly) jobs.push({ name: 'hourly', fn: () => getJSON(props.forecastHourly) });
  const extra = await settleAll(jobs);
  out.forecast = extra.forecast?.properties?.periods || [];
  out.hourly = extra.hourly?.properties?.periods || [];
  out.relativeLocation = props.relativeLocation?.properties || null;
  return out;
}

/* -------------------------------- WMO mapping ------------------------------- */

const WMO = {
  0: ['Clear sky', '01'], 1: ['Mainly clear', '02'], 2: ['Partly cloudy', '03'], 3: ['Overcast', '04'],
  45: ['Fog', '50'], 48: ['Depositing rime fog', '50'],
  51: ['Light drizzle', '09'], 53: ['Drizzle', '09'], 55: ['Dense drizzle', '09'],
  56: ['Freezing drizzle', '13'], 57: ['Freezing drizzle', '13'],
  61: ['Light rain', '10'], 63: ['Rain', '10'], 65: ['Heavy rain', '10'],
  66: ['Freezing rain', '13'], 67: ['Freezing rain', '13'],
  71: ['Light snow', '13'], 73: ['Snow', '13'], 75: ['Heavy snow', '13'], 77: ['Snow grains', '13'],
  80: ['Rain showers', '09'], 81: ['Rain showers', '09'], 82: ['Violent rain showers', '09'],
  85: ['Snow showers', '13'], 86: ['Heavy snow showers', '13'],
  95: ['Thunderstorm', '11'], 96: ['Thunderstorm w/ hail', '11'], 99: ['Severe thunderstorm', '11'],
};

export function describeCode(code) {
  const e = WMO[code];
  return e ? { text: e[0], icon: e[1] } : { text: 'Unknown', icon: '03' };
}

const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function degToCompass(deg) {
  if (deg == null) return '';
  return DIRS[Math.round(deg / 22.5) % 16];
}

/* ------------------------------- aggregation -------------------------------- */

export async function aggregateWeather(lat, lon) {
  const feeds = await settleAll([
    { name: 'openmeteo', fn: () => fetchOpenMeteo(lat, lon) },
    { name: 'weatherapi', fn: () => fetchWeatherAPI(lat, lon) },
    { name: 'pirate', fn: () => fetchPirate(lat, lon) },
    { name: 'nws', fn: () => fetchNWS(lat, lon) },
  ]);

  const sources = Object.keys(feeds).map((k) =>
    ({ openmeteo: 'Open-Meteo', weatherapi: 'WeatherAPI.com', pirate: 'Pirate Weather', nws: 'NWS' }[k])
  );

  const om = feeds.openmeteo;
  const wa = feeds.weatherapi;
  const pw = feeds.pirate;
  const nws = feeds.nws;

  /* ---- current conditions (cross-checked / averaged) ---- */
  const tempSamples = [];
  const humiditySamples = [];
  if (om?.current) {
    tempSamples.push(om.current.temperature_2m);
    humiditySamples.push(om.current.relative_humidity_2m);
  }
  if (wa?.current) {
    tempSamples.push(wa.current.temp_f);
    humiditySamples.push(wa.current.humidity);
  }
  if (pw?.currently) {
    tempSamples.push(pw.currently.temperature);
    humiditySamples.push(pw.currently.humidity != null ? pw.currently.humidity * 100 : null);
  }
  const avg = (a) => {
    const v = a.filter((x) => typeof x === 'number' && !Number.isNaN(x));
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  };

  const omCode = om?.current?.weather_code;
  const desc = omCode != null ? describeCode(omCode) : { text: wa?.current?.condition?.text || 'Conditions', icon: '03' };

  const current = {
    temp: round(avg(tempSamples)),
    feelsLike: round(om?.current?.apparent_temperature ?? wa?.current?.feelslike_f ?? pw?.currently?.apparentTemperature),
    humidity: round(avg(humiditySamples)),
    condition: wa?.current?.condition?.text || pw?.currently?.summary || desc.text,
    icon: desc.icon,
    isDay: om?.current?.is_day ?? wa?.current?.is_day ?? 1,
    windSpeed: round(om?.current?.wind_speed_10m ?? wa?.current?.wind_mph ?? pw?.currently?.windSpeed),
    windDir: degToCompass(om?.current?.wind_direction_10m ?? wa?.current?.wind_degree),
    windGust: round(om?.current?.wind_gusts_10m ?? wa?.current?.gust_mph),
    uv: round(om?.current?.uv_index ?? wa?.current?.uv ?? pw?.currently?.uvIndex),
    pressure: round(om?.current?.pressure_msl ?? wa?.current?.pressure_mb),
    visibility: round(om?.current?.visibility ? om.current.visibility / 1609 : wa?.current?.vis_miles),
    aqi: wa?.current?.air_quality?.['us-epa-index'] ?? null,
    precip: round(om?.current?.precipitation ?? wa?.current?.precip_in ?? 0, 2),
    snow: round(om?.current?.snowfall ?? 0, 2),
  };

  /* ---- hourly (next 48h) from Open-Meteo, starting at the current hour ---- */
  const hourly = [];
  if (om?.hourly?.time) {
    const h = om.hourly;
    const nowIso = new Date().toISOString().slice(0, 13); // yyyy-mm-ddTHH
    let start = h.time.findIndex((t) => t.slice(0, 13) >= nowIso);
    if (start < 0) start = 0;
    for (let i = start; i < Math.min(start + 48, h.time.length); i++) {
      const d = describeCode(h.weather_code[i]);
      hourly.push({
        time: h.time[i],
        temp: round(h.temperature_2m[i]),
        feelsLike: round(h.apparent_temperature[i]),
        condition: d.text,
        icon: d.icon,
        precipProb: h.precipitation_probability?.[i] ?? null,
        precip: round(h.precipitation?.[i], 2),
        rain: round(h.rain?.[i], 2),
        snowfall: round(h.snowfall?.[i], 2),
        snowDepth: round(h.snow_depth?.[i], 2),
        wind: round(h.wind_speed_10m?.[i]),
        windDir: degToCompass(h.wind_direction_10m?.[i]),
        uv: round(h.uv_index?.[i]),
        humidity: round(h.relative_humidity_2m?.[i]),
      });
    }
  }

  /* ---- daily (7 day) ---- */
  const daily = [];
  if (om?.daily?.time) {
    const d = om.daily;
    const todayIso = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < d.time.length; i++) {
      if (d.time[i] < todayIso) continue; // skip past_days padding
      const desc = describeCode(d.weather_code[i]);
      // pair with the matching WeatherAPI / NWS narrative if available
      const waDay = wa?.forecast?.forecastday?.find((x) => x.date === d.time[i]);
      daily.push({
        date: d.time[i],
        high: round(d.temperature_2m_max[i]),
        low: round(d.temperature_2m_min[i]),
        condition: waDay?.day?.condition?.text || desc.text,
        icon: desc.icon,
        precipSum: round(d.precipitation_sum?.[i], 2),
        rainSum: round(d.rain_sum?.[i], 2),
        snowSum: round(d.snowfall_sum?.[i], 2),
        precipProb: d.precipitation_probability_max?.[i] ?? waDay?.day?.daily_chance_of_rain ?? null,
        uvMax: round(d.uv_index_max?.[i]),
        windMax: round(d.wind_speed_10m_max?.[i]),
        windDir: degToCompass(d.wind_direction_10m_dominant?.[i]),
        sunrise: d.sunrise?.[i],
        sunset: d.sunset?.[i],
      });
    }
  }

  /* ---- precipitation totals over trailing windows (1/3/6/12/24/48h) ---- */
  const precipWindows = computePrecipWindows(om);

  /* ---- narratives (used by the AI summary features) ---- */
  const narratives = {
    nwsForecast: (nws?.forecast || []).slice(0, 6).map((p) => `${p.name}: ${p.detailedForecast}`),
    pirateSummary: pw?.daily?.summary || pw?.hourly?.summary || null,
    location: nws?.relativeLocation
      ? `${nws.relativeLocation.city}, ${nws.relativeLocation.state}`
      : wa?.location
      ? `${wa.location.name}, ${wa.location.region}`
      : null,
  };

  return {
    coords: { lat: +lat, lon: +lon },
    timezone: om?.timezone || wa?.location?.tz_id || 'UTC',
    location: narratives.location,
    sources,
    current,
    hourly,
    daily,
    precipWindows,
    narratives,
    updatedAt: new Date().toISOString(),
  };
}

function computePrecipWindows(om) {
  const result = {};
  const windows = [1, 3, 6, 12, 24, 48];
  if (!om?.hourly?.time) return result;
  const h = om.hourly;
  const nowIso = new Date().toISOString().slice(0, 13);
  let now = h.time.findIndex((t) => t.slice(0, 13) >= nowIso);
  if (now < 0) now = h.time.length - 1;
  for (const w of windows) {
    let total = 0;
    let snow = 0;
    for (let i = Math.max(0, now - w); i < now; i++) {
      total += h.precipitation?.[i] || 0;
      snow += h.snowfall?.[i] || 0;
    }
    result[w] = { precip: round(total, 2), snow: round(snow, 2) };
  }
  return result;
}

function round(v, p = 0) {
  if (v == null || Number.isNaN(v)) return null;
  const f = Math.pow(10, p);
  return Math.round(v * f) / f;
}

/* --------------------------------- alerts ---------------------------------- */

export async function getAlerts(lat, lon) {
  const out = [];
  // NWS active alerts (US) — primary source for severe weather warnings.
  try {
    const data = await getJSON(`https://api.weather.gov/alerts/active?point=${(+lat).toFixed(4)},${(+lon).toFixed(4)}`);
    for (const f of data.features || []) {
      const p = f.properties;
      out.push({
        id: p.id,
        source: 'NWS',
        event: p.event,
        severity: p.severity,
        urgency: p.urgency,
        certainty: p.certainty,
        headline: p.headline,
        description: p.description,
        instruction: p.instruction,
        area: p.areaDesc,
        sent: p.sent,
        effective: p.effective,
        expires: p.expires,
      });
    }
  } catch (e) {
    console.warn('[alerts] NWS failed:', e.message);
  }
  // WeatherAPI alerts as a secondary source / for non-US points.
  try {
    const data = await getJSON(
      `https://api.weatherapi.com/v1/forecast.json?key=${WEATHERAPI_KEY}&q=${lat},${lon}&days=1&alerts=yes`
    );
    for (const a of data?.alerts?.alert || []) {
      if (out.some((o) => o.headline === a.headline)) continue;
      out.push({
        id: a.id || `${a.event}-${a.effective}`,
        source: 'Weather Channel / WeatherAPI',
        event: a.event,
        severity: a.severity,
        urgency: a.urgency,
        certainty: a.certainty,
        headline: a.headline,
        description: a.desc,
        instruction: a.instruction,
        area: a.areas,
        sent: a.effective,
        effective: a.effective,
        expires: a.expires,
      });
    }
  } catch (e) {
    console.warn('[alerts] WeatherAPI failed:', e.message);
  }
  return out;
}

/* ------------------------------- hurricanes -------------------------------- */

export async function getActiveStorms() {
  try {
    const data = await getJSON('https://www.nhc.noaa.gov/CurrentStorms.json');
    return (data.activeStorms || []).map((s) => ({
      id: s.id,
      name: s.name,
      classification: s.classification,
      intensity: s.intensity,
      pressure: s.pressure,
      basin: s.binNumber,
      lat: parseFloat(s.latitudeNumeric ?? s.latitude),
      lon: parseFloat(s.longitudeNumeric ?? s.longitude),
      movement: s.movementDir ? `${s.movementDir} at ${s.movementSpeed} mph` : null,
      lastUpdate: s.lastUpdate,
      publicAdvisory: s.publicAdvisory?.url || null,
      forecastGraphics: s.forecastGraphics?.url || null,
      track: s.forecastTrack?.kmzFile || null,
    }));
  } catch (e) {
    console.warn('[storms] NHC failed:', e.message);
    return [];
  }
}

/* --------------------------------- drought --------------------------------- */

export async function getDroughtData(lat, lon) {
  const out = { category: 'None', categoryLabel: CATEGORY_LABELS.None, dm: -1, releaseDate: null, precip: null };

  // U.S. Drought Monitor — current conditions, point-in-polygon via ArcGIS.
  // The DM field is the drought class (0=D0 ... 4=D4). A point inside a D3 area
  // also falls inside the D0..D2 polygons, so we take the max DM of the most
  // recent release.
  try {
    const geom = encodeURIComponent(JSON.stringify({ x: +lon, y: +lat }));
    const url =
      `https://services5.arcgis.com/0OTVzJS4K09zlixn/arcgis/rest/services/USDM_current/FeatureServer/0/query` +
      `?geometry=${geom}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects` +
      `&outFields=DM,MapDate,ReleaseDate&returnGeometry=false&f=json`;
    const data = await getJSON(url);
    const feats = (data.features || []).map((f) => f.attributes);
    if (feats.length) {
      const latestRelease = Math.max(...feats.map((f) => f.ReleaseDate || 0));
      const current = feats.filter((f) => f.ReleaseDate === latestRelease);
      const maxDM = Math.max(...current.map((f) => (typeof f.DM === 'number' ? f.DM : -1)));
      out.dm = maxDM;
      out.category = dmToCategory(maxDM);
      out.categoryLabel = CATEGORY_LABELS[out.category];
      out.releaseDate = latestRelease ? new Date(latestRelease).toISOString().slice(0, 10) : null;
    }
  } catch (e) {
    console.warn('[drought] USDM failed:', e.message);
  }

  // Trailing precipitation (90 days) from Open-Meteo archive-style forecast.
  try {
    const params = new URLSearchParams({
      latitude: lat,
      longitude: lon,
      daily: 'precipitation_sum',
      precipitation_unit: 'inch',
      timezone: 'auto',
      past_days: 92,
      forecast_days: 1,
    });
    const om = await getJSON(`https://api.open-meteo.com/v1/forecast?${params}`);
    const sums = om?.daily?.precipitation_sum || [];
    out.precip = {
      last30: round(sums.slice(-31, -1).reduce((s, x) => s + (x || 0), 0), 2),
      last90: round(sums.slice(0, -1).reduce((s, x) => s + (x || 0), 0), 2),
      recent: (om?.daily?.time || []).slice(-7).map((t, i) => ({
        date: t,
        precip: round(sums[sums.length - 7 + i], 2),
      })),
    };
  } catch (e) {
    console.warn('[drought] precip failed:', e.message);
  }

  return out;
}

const CATEGORY_LABELS = {
  None: 'No drought',
  D0: 'D0 – Abnormally Dry',
  D1: 'D1 – Moderate Drought',
  D2: 'D2 – Severe Drought',
  D3: 'D3 – Extreme Drought',
  D4: 'D4 – Exceptional Drought',
};
function dmToCategory(dm) {
  return ['D0', 'D1', 'D2', 'D3', 'D4'][dm] || 'None';
}

export { round };
