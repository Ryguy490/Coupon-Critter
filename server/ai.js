// AI integration — used ONLY where the spec calls for it:
//   1. Home: a brief overview of the current large-scale weather pattern.
//   2. Daily: a per-day summary of the NWS / Weather Channel / WRAL outlooks.
//   3. Drought: a plain-language drought summary ("...google search or ai if possible").
//
// Everything else in the app is plain data, no AI. If no ANTHROPIC_API_KEY is
// configured the endpoints degrade gracefully and the UI falls back to the raw
// provider narratives.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

let client = null;
function getClient() {
  if (client) return client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  client = new Anthropic({ apiKey: key });
  return client;
}

export function aiAvailable() {
  return !!process.env.ANTHROPIC_API_KEY;
}

async function summarize(system, prompt, maxTokens = 320) {
  const anthropic = getClient();
  if (!anthropic) return { available: false, text: null };
  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return { available: true, text };
  } catch (e) {
    console.warn('[ai] request failed:', e.message);
    return { available: true, text: null, error: e.message };
  }
}

// 1. Current large-scale weather pattern overview (home screen).
export function patternOverview(data) {
  const c = data.current || {};
  const nws = (data.narratives?.nwsForecast || []).slice(0, 3).join('\n');
  const prompt = [
    `Location: ${data.location || `${data.coords.lat}, ${data.coords.lon}`}.`,
    `Current: ${c.temp}°F (feels ${c.feelsLike}°F), ${c.condition}, humidity ${c.humidity}%, wind ${c.windSpeed} mph ${c.windDir}.`,
    data.narratives?.pirateSummary ? `Near-term: ${data.narratives.pirateSummary}` : '',
    nws ? `Official outlook:\n${nws}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return summarize(
    'You are a meteorologist writing for a Weather Channel style app. In 2-3 sentences, describe the current LARGE-SCALE weather pattern affecting this location (fronts, systems, air masses). If nothing notable is happening, say so plainly and describe the prevailing conditions. No preamble, no markdown.',
    prompt,
    220
  );
}

// 2. Per-day summary (daily tab).
export function dailySummary(day, location, nwsPeriods) {
  const periodsText = (nwsPeriods || []).join('\n');
  const prompt = [
    `Location: ${location || 'this area'}. Date: ${day.date}.`,
    `Data: high ${day.high}°F / low ${day.low}°F, ${day.condition}, precip chance ${day.precipProb ?? 'n/a'}%, precip total ${day.precipSum ?? 0} in, snow ${day.snowSum ?? 0} in, max UV ${day.uvMax ?? 'n/a'}, wind to ${day.windMax ?? 'n/a'} mph ${day.windDir || ''}.`,
    periodsText ? `Official forecasts (NWS / Weather Channel / WRAL style):\n${periodsText}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return summarize(
    'You write daily forecast summaries for a weather app, blending the styles of the Weather Channel, WRAL, and the NWS. Write ONE concise paragraph (2-4 sentences) summarizing the day: temperatures, sky/precip, and anything notable. Plain prose, no markdown, no preamble.',
    prompt,
    260
  );
}

// 3. Drought summary (drought tab).
export function droughtSummary(drought, location, precip) {
  const prompt = [
    `Location: ${location || 'this area'}.`,
    drought.categoryLabel ? `U.S. Drought Monitor category: ${drought.categoryLabel}${drought.releaseDate ? ` (as of ${drought.releaseDate})` : ''}.` : 'Drought category: not available.',
    precip ? `Precipitation: ${precip.last30 ?? '?'} in over the last 30 days, ${precip.last90 ?? '?'} in over the last 90 days.` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return summarize(
    'You summarize local drought conditions for a weather app. In 2-3 sentences explain the current drought status, what it means for residents (water restrictions, fire risk, lawns/agriculture), and the recent precipitation trend. Plain prose, no markdown, no preamble.',
    prompt,
    240
  );
}
