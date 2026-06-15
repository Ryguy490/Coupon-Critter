# Weather Watcher

A clean, Weather Channel–style weather web app built to the hand-drawn
"Weather Watcher" spec. Dark blue background, simple white foreground, a subtle
liquid-glass UI, and an emergency siren for severe-weather warnings.

## Features (one tab per bottom-nav item)

- **Home** — current conditions (temp, humidity, upcoming wind/precip), an
  AI-written overview of the current large-scale weather pattern, precipitation
  totals over a selectable 1/3/6/12/24/48-hour window, and an intensity guide.
  Sub-tabs:
  - **Hourly** — next 48 hours (time, conditions, temp, wind, precip % and amount).
  - **Daily** — 7-day strip with a per-day AI summary blending the NWS / Weather
    Channel / WRAL outlooks.
- **Radar** — animated radar map (RainViewer) with a playback timeline, a full
  color legend, and toggleable layers (warnings, hurricane tracks, draggable
  pin). A **Graph** sub-view charts precipitation over time with a
  snow / rain / wintry-mix / ice breakdown (came / coming / on-ground).
- **Snow** — 7-day snowfall forecast and a snow map overlay.
- **Hurricanes** — live NOAA / National Hurricane Center active tropical systems
  plotted on an interactive map.
- **Severe weather** — active watches & warnings with an event filter. New
  Extreme/Severe **warnings trigger the emergency siren** and a red banner.
- **Drought** — current U.S. Drought Monitor category, a yellow→red drought map
  overlay, recent precipitation, and an AI drought summary.

Search any town up top, or use your location. Swipe down (or hit refresh) to
pull fresh data from every source.

## Data sources

The app aggregates and cross-checks several providers (the figures in the
original mock-ups were placeholders — everything here is live):

| Data | Sources |
|------|---------|
| Current / forecast / precipitation | NWS, Open-Meteo, WeatherAPI.com, Pirate Weather |
| Radar | RainViewer, NWS |
| Severe-weather warnings | NWS, Weather Channel (WeatherAPI) |
| Hurricanes / tropical | NOAA National Hurricane Center |
| Drought | U.S. Drought Monitor, Open-Meteo, AI |

API keys are kept server-side.

## AI

AI is used **only** where the spec calls for it, via the Claude API:

1. Home — current weather-pattern overview.
2. Daily — per-day forecast summary.
3. Drought — plain-language drought summary.

Without an `ANTHROPIC_API_KEY` the app stays fully functional and these
sections fall back to the raw provider narratives.

## Running

```bash
npm install
cp .env.example .env   # optional: add ANTHROPIC_API_KEY for AI summaries
npm start              # http://localhost:3000
```

Configuration (all optional — sane defaults baked in) lives in `.env`:
`PORT`, `WEATHERAPI_KEY`, `PIRATE_WEATHER_KEY`, `ANTHROPIC_API_KEY`,
`ANTHROPIC_MODEL`.

## Project layout

```
server/
  index.js       Express server: static hosting + API routes
  providers.js   Weather/alerts/storms/drought aggregation
  ai.js          Claude-powered summaries (the 3 specified spots)
public/
  index.html     App shell (6 tabs, header, side menu, about)
  styles.css     Dark-blue / liquid-glass theme
  app.js         Front-end logic, maps, charts, siren
  assets/        Siren mp3, logo
```
