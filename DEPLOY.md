# Deploying Weather Watcher to Render

This repo ships a `render.yaml` Blueprint, so deploying is a connect-the-repo
step — no build settings to fill in.

## Steps

1. Go to **https://render.com** and sign up / log in (you can use "Sign in with
   GitHub").
2. Click **New +** → **Blueprint**.
3. Select this repository
   (`https-CouponCritter-smart-coupon-finder`) and the branch
   **`claude/emergency-alerts-webapp-cy9l1l`**
   (or `main` once it's merged).
4. Render detects `render.yaml` and shows a service called **weather-watcher**.
   Click **Apply**.
5. Wait for the first build (`npm install` → `npm start`). When it's live,
   Render gives you a URL like `https://weather-watcher-xxxx.onrender.com`.

That's it — the weather data, radar, hurricanes, severe-weather alerts (siren),
and drought all work out of the box.

## Optional: turn on the AI summaries

The home weather-pattern overview, daily summaries, and drought summary use the
Claude API. To enable them:

1. In the Render dashboard open the **weather-watcher** service → **Environment**.
2. Add an environment variable **`ANTHROPIC_API_KEY`** with your Anthropic key.
3. Save — Render redeploys automatically.

Without the key the app still runs and those sections fall back to the raw
NWS / Pirate Weather narratives.

## Notes

- The provider API keys are already set in `render.yaml`, so nothing else is
  required.
- Render's **free** web service spins down after ~15 minutes of inactivity, so
  the first request after idle takes a few seconds to wake up. Upgrade the plan
  if you want it always-on.
- `autoDeploy` is on: every push to the connected branch redeploys.
