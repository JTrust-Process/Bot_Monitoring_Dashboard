# Bot Health Monitor

Watches the crypto bot and stock bot. If either stops running, throws errors, or has a stuck cycle, it pings Discord. De-duplicates alerts so a stuck bot doesn't spam your channel.

Runs on GitHub Actions every 30 minutes. Free, no infra.

---

## What it checks per bot

| Check | Threshold |
|---|---|
| Last run too old | Crypto > 30 min · Stock > 90 min |
| Errors in last 6h | ≥ 1 = degraded · ≥ 3 = down |
| Stuck `running` row | Older than 30 min = down |

Stock bot is only checked during market hours (Mon-Fri 13:30-21:00 UTC). Outside those hours its status shows as `muted` and no alerts fire.

## Alert behavior

| Transition | Discord ping? |
|---|---|
| 🟢 → 🟡 / 🔴 | Yes, immediately |
| 🟡 / 🔴 → 🟢 | Yes, "recovered" message |
| Stays 🟡 / 🔴 | At most once per 6 hours |
| `muted` | Never alerts |

## Setup

### 1. Push to a new repo

```bash
git init
git add .
git commit -m "initial health monitor"
gh repo create bot-health-monitor --private --push --source=.
```

### 2. Get your Supabase anon keys

You need the **anon key** (NOT the service role key). Find it at:
- Supabase project → Settings → API → Project API keys → `anon public`

Anon keys are safe to commit only if your tables have RLS enabled. Even though we're not committing them (they go in GitHub Secrets), use anon over service role since this monitor only reads.

### 3. Create a Discord webhook

1. Discord server → channel for health alerts → Edit Channel → Integrations → Webhooks → New Webhook
2. Copy the webhook URL
3. (Suggestion: name the channel `#bot-health` and the webhook `Health Monitor`)

### 4. Add GitHub Secrets

Repo settings → Secrets and variables → Actions → New repository secret. Add five:

| Secret | Value |
|---|---|
| `CRYPTO_SUPABASE_URL` | `https://yourproject.supabase.co` (crypto project) |
| `CRYPTO_SUPABASE_ANON_KEY` | anon key from crypto project |
| `STOCK_SUPABASE_URL` | `https://yourproject.supabase.co` (stock project) |
| `STOCK_SUPABASE_ANON_KEY` | anon key from stock project |
| `HEALTH_WEBHOOK_URL` | Discord webhook URL |

### 5. Trigger first run

Either wait 30 min for the cron, or trigger manually:
- Repo → Actions → Bot Health Monitor → Run workflow

You should see something like:
```
🟢 Crypto: healthy · last run 12m ago · errors_6h=0 · stuck=0
⚪ Stock:  muted    · last run — ago · errors_6h=0 · stuck=0
    └── outside market hours — checks suppressed
```

If both are healthy, no Discord ping fires (correct — no news is good news).

## Local testing

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# fill in .env with real values
export $(cat .env | xargs)
python health_check.py
```

## Tuning thresholds

All in `health_check.py` near the top:

```python
COOLDOWN_HOURS = 6   # max alert frequency for stuck bad state
```

```python
BotConfig(
    name="Crypto",
    expected_minutes=30,    # threshold for "no run" alerts
    market_hours_only=False,
)
```

Bump `expected_minutes` if you get false-positive alerts during occasional GHA latency.

## Adding a third bot

Append another `BotConfig` to the `BOTS` list in `health_check.py`, add the matching env vars to `.env.example` and the workflow YAML.

## What this monitor doesn't do

- Doesn't check that trades are *good*, only that the bot is *running*. P&L analysis happens in the trading dashboards.
- Doesn't check Public/brokerage API health directly. If Public's API dies, the bot will log errors → which this monitor will see → and alert. So it works indirectly.
- Doesn't restart the bot. Just notifies you. Restarting is manual (re-trigger the workflow or push a fix).

## Status state file

`status_state.json` is persisted via GHA cache between runs. It tracks the last-seen status per bot and the last alert timestamp. This is what enables the de-dup logic. If the cache is ever lost, worst case is one duplicate alert.