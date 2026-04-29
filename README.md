# bot-health-monitor

Monorepo containing two pieces:

- **`monitor/`** — Python script + GHA workflow. Runs every 30 min, queries both bots' Supabase projects, pings Discord on issues.
- **`dashboard/`** — Next.js 15 app deployed to Vercel. Brutalist mission-control UI showing live health status of both bots.

```
bot-health-monitor/
├── .github/workflows/
│   └── health_check.yml      # GHA cron — runs monitor/health_check.py every 30 min
├── monitor/
│   ├── health_check.py       # the Python check + Discord pinger
│   ├── requirements.txt
│   └── .env.example
└── dashboard/                # Vercel-deployed Next.js app
    ├── app/
    ├── components/
    ├── package.json
    ├── .env.local.example
    └── next.config.js
```

---

## Quickstart

### Monitor (Python + GHA)

Runs in this repo automatically. Setup is just secrets:

1. Create a Discord channel for health alerts → add a webhook → copy URL
2. In this repo: Settings → Secrets and variables → Actions → add five secrets:
   - `CRYPTO_SUPABASE_URL`
   - `CRYPTO_SUPABASE_ANON_KEY`
   - `STOCK_SUPABASE_URL`
   - `STOCK_SUPABASE_ANON_KEY`
   - `HEALTH_WEBHOOK_URL`
3. Actions → Bot Health Monitor → Run workflow (manual trigger to test)

See `monitor/README.md`-style notes inline in `health_check.py`.

### Dashboard (Next.js + Vercel)

```bash
cd dashboard
npm install
cp .env.local.example .env.local
# fill in .env.local with Supabase URLs + anon keys
npm run dev
# visit http://localhost:3000
```

### Deploy dashboard to Vercel

1. Push this repo to GitHub
2. vercel.com → Add New Project → import this repo
3. **IMPORTANT:** under "Configure Project," set **Root Directory** to `dashboard`
4. Add env vars (same names as `.env.local.example`)
5. Deploy

Each env var must be `NEXT_PUBLIC_*` since they're used client-side.

---

## What the dashboard shows

- **Aggregate status banner** — one big word: ALL.SYSTEMS.GO / DEGRADED.PERFORMANCE / ALERT.STATE
- **Per-bot panels** — status + key metrics (last run age, errors in last 6h, stuck runs)
- **Run history** — last 12 runs per bot with status + age
- **Aggregate error log** — last 15 errors across both bots, sorted newest first

Auto-refreshes every 60 seconds.

## Adding a third bot

In `monitor/health_check.py`: append a new `BotConfig` to `BOTS`.
In `dashboard/components/HealthDashboard.jsx`: append a new entry to the `BOTS` array.

Both expect: `bot_runs` table with a "started_at"-equivalent column and `status` column, `bot_errors` table with a "created_at"-equivalent column. Schema column names are configurable per bot.

## Notes

- The dashboard reads Supabase directly from the browser via anon key. Anyone with the dashboard URL can read your bot run history. If that's a concern, password-protect on Vercel or keep the URL private.
- The monitor uses anon keys too (read-only via RLS).
- `status_state.json` in the monitor is persisted via GHA cache between runs to track last-known-status per bot. If the cache is ever lost, worst case is one duplicate Discord ping.