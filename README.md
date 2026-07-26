# bot-health-monitor

Monorepo containing two pieces:

- **`monitor/`** — Python script + GHA workflow. Runs every 15 min, queries the
  Stock and Crypto Supabase projects, pings Discord on issues. Deliberately
  hosted on GitHub Actions rather than Fly: if Fly goes down, the thing that
  tells you Fly went down should not be on Fly.
- **`dashboard/`** — Next.js 15 app on Vercel. Two pages:
  - `/` — **Health**: Stock + Crypto, from their own Supabase projects.
  - `/league` — **League**: the Trading Bot League control plane (registry,
    approvals queue, positions, exposures, trades, expenses), from a third
    Supabase project.

```
bot-health-monitor/
├── .github/workflows/
│   └── health_check.yaml     # GHA cron — runs monitor/health_check.py every 15 min
├── monitor/
│   ├── health_check.py       # the Python check + Discord pinger
│   └── requirements.txt
└── dashboard/                # Vercel-deployed Next.js app
    ├── app/
    │   ├── page.jsx              # / — Health
    │   ├── league/page.jsx       # /league — League
    │   ├── layout.jsx
    │   ├── globals.css
    │   └── api/approvals/[id]/   # server-side approve/reject (service-role key)
    ├── components/
    │   ├── HealthDashboard.jsx
    │   ├── LeagueDashboard.jsx
    │   └── HeaderClock.jsx
    ├── lib/supabaseLeague.js
    ├── package.json
    ├── .eslintrc.json
    ├── .env.local.example
    └── next.config.js
```

> **Audit note.** `AUDIT_2026-07-25.md` in this directory records a full
> read-only sweep of the repo, what was fixed, and what remains open. Worth
> reading before making changes — several of the findings were cases of a
> surface confidently reporting something untrue rather than anything
> throwing an error.

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

### `/` — Health (Stock + Crypto)

- **Aggregate status sentence** — e.g. "All systems are operational."
  Bots that are unconfigured are excluded from this verdict; "I can't see it"
  is not the same as "it's broken."
- **Per-bot panels** — status, last run age, errors in last 6h, stuck runs
- **Run history** and an **aggregate error log**

Health is judged against **each bot's own schedule**, not the clock:
`expectedMinutes` per bot, plus an `activeUtcWindowMin` covering the bot's
cron window, plus market-hours suppression for the stock bot. All three are
needed — using market hours alone produced a false "Down" every trading
morning, because the NYSE opens at 13:30 UTC while the stock bot's first run
is 14:17.

### `/league` — Trading Bot League

- **Bot registry** grouped by mode (live / paper / research / other), with
  staleness scaled to each bot's observed cadence
- **Pending approvals** with Approve/Reject (server-side, see below)
- **Open positions + exposures donut** — live only; paper and
  unconfirmed positions are shown as separate subtotals rather than folded
  into the headline
- **Net P&L and expenses** — live and paper P&L kept separate, phantom
  trades excluded
- **Signals**, **research scores**, **recent runs**, **recent trades**

Auto-refreshes every 60 seconds **while the tab is visible**, and refetches
immediately on refocus.

## Approvals endpoint

`PATCH /api/approvals/<id>` runs server-side and holds the service-role key.
Auth is a shared operator token in `LEAGUE_APPROVAL_TOKEN`, entered once per
session in the UI and compared in constant time. Only `pending` rows can be
decided, so a double-click cannot double-approve.

## Alerting

Discord alerts fire on state transitions with a 6-hour cooldown per bot.

**Set `HEALTH_DEADMAN_URL`** to a check URL from healthchecks.io / Better
Stack / Cronitor. Alerting is push-on-bad, so every failure mode of the
monitor itself — a disabled GHA schedule, a missing webhook secret, an
uncaught exception — presents as silence, which is indistinguishable from
all-clear. The dead-man's switch inverts that: you get told when a ping
*fails to arrive*.

**Known gap:** the monitor covers Stock and Crypto only. The League bots
(ETF rotation, short watchlist, bond research, agent research) have no
Discord coverage — their health lives in `bot_status.last_heartbeat_at`
rather than a `bot_runs` table, so `BotConfig` does not yet generalise to
them.

## Adding a third bot

In `monitor/health_check.py`: append a new `BotConfig` to `BOTS`.
In `dashboard/components/HealthDashboard.jsx`: append a new entry to the `BOTS` array.

Both expect: `bot_runs` table with a "started_at"-equivalent column and `status` column, `bot_errors` table with a "created_at"-equivalent column. Schema column names are configurable per bot.

## Notes

- The dashboard reads Supabase directly from the browser via anon key. Anyone with the dashboard URL can read your bot run history. If that's a concern, password-protect on Vercel or keep the URL private.
- The monitor uses anon keys too (read-only via RLS).
- `status_state.json` in the monitor is persisted via GHA cache between runs to track last-known-status per bot. If the cache is ever lost, worst case is one duplicate Discord ping.