# bot-health-monitor

Monorepo containing two pieces:

- **`monitor/`** — Python script + GHA workflow. Runs every 15 min, queries both bots' Supabase projects, pings Discord on issues.
- **`dashboard/`** — Next.js 15 app deployed to Vercel. Brutalist mission-control UI showing live health status of both bots.

```
bot-health-monitor/
├── .github/workflows/
│   └── health_check.yaml     # GHA cron — runs monitor/health_check.py every 15 min
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
2. In this repo: Settings → Secrets and variables → Actions → add the secrets:
   - `CRYPTO_SUPABASE_URL`
   - `CRYPTO_SUPABASE_ANON_KEY`
   - `STOCK_SUPABASE_URL`
   - `STOCK_SUPABASE_ANON_KEY`
   - `HEALTH_WEBHOOK_URL`
   - `GH_PAT_BOT_RESTART` *(optional — only required if you opt-in to auto-restart by setting `restart_enabled=True` on a `BotConfig` in `health_check.py`. Disabled by default.)*
3. Actions → Bot Health Monitor → Run workflow (manual trigger to test)

> **Auto-restart and stuck-run cleanup are OFF by default.** They are gated behind explicit per-bot flags (`restart_enabled`, `cleanup_stuck_enabled`) on each `BotConfig` and additionally require the right credentials. Do not enable them without understanding the risk: a financial trading bot being auto-restarted during an incident can cause wrong-state issues.

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

#### ⚠ Env var prefixes — read before adding them

**Only the `NEXT_PUBLIC_*` names in `.env.local.example` may carry that
prefix.** Those are Supabase *anon* keys, gated by RLS, and are safe in the
browser.

These three are read **server-side only** and MUST be added **without** the
prefix:

| Variable | Why |
|---|---|
| `LEAGUE_SUPABASE_URL` | paired with the service key below |
| `LEAGUE_SUPABASE_SERVICE_KEY` | **service-role key — bypasses all RLS** |
| `LEAGUE_APPROVAL_TOKEN` | approves real-money orders |

Next.js **inlines every `NEXT_PUBLIC_*` value into the JavaScript bundle at
build time.** Prefixing the service key would publish full read/write access
to the League database to anyone who opens the page and searches the sources
tab; prefixing the approval token would let any visitor approve live orders.

There is **no error and no visible difference** from a correct deploy — the
dashboard works fine either way. That is precisely what makes this dangerous,
so it is called out here rather than left to be inferred.

(Corrected 2026-07-25. This section previously read "Each env var must be
`NEXT_PUBLIC_*` since they're used client-side" — true when the repo only had
the two anon-key bots, false and hazardous since the League page landed.
`.env.local.example:33-42` has always said the opposite.)

Also note: because these are build-time values, adding or changing one in
Vercel does **not** take effect until you redeploy.

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