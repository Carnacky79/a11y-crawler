# A11y Monitor — Crawler Microservice

Express + Puppeteer + axe-core service that crawls a site, runs WCAG 2.1 AA analysis on each page, and posts results back to the Supabase `scan-callback` edge function.

## Endpoints

- `GET  /health` — healthcheck
- `POST /scan`   — body: `{ scanId, url, maxPages, respectRobots, callbackUrl, callbackSecret }`. Returns 202 immediately and runs the crawl async.
- `GET  /scan/:id` — in-memory status for a running scan (best-effort).

## Deploy on Railway

1. Push this `crawler-service` folder to a new GitHub repo (or use Railway's GitHub integration on a subdirectory).
2. On Railway: **New Project → Deploy from GitHub repo**.
3. Railway auto-detects Node and runs `npm install && npm start`.
4. Set environment variables (Settings → Variables):
   - `PORT` — Railway sets this automatically.
   - `PUPPETEER_CACHE_DIR=/app/.cache/puppeteer` (recommended)
5. Add a Build command override if Chromium isn't downloading: `npm install && npx puppeteer browsers install chrome`.
6. After first deploy, copy the public URL (e.g. `https://a11y-monitor-crawler.up.railway.app`).
7. Open the **A11y Monitor** app → **Settings** → paste the URL → Save.

## Local dev

```bash
cd crawler-service
npm install
npm start
# service on http://localhost:3000
```

## How it talks back to Supabase

The Supabase `start-scan` function passes a `callbackUrl` and `callbackSecret`. The crawler sends one POST per event:

- `{ type: "started", scanId, axeVersion }`
- `{ type: "progress", scanId, currentUrl, pagesTotal }`
- `{ type: "page", scanId, url, title, status, axeRaw }`
- `{ type: "completed", scanId }` or `{ type: "failed", scanId, error }`

Each request includes header `x-callback-secret: <secret>`.