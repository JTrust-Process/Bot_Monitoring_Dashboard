"""
bot-health-monitor / health_check.py

Reads run/error data from both bots' Supabase projects and pings Discord
when a bot is down or degraded. De-duplicates alerts so a stuck bot doesn't
spam every 30 minutes.

State:
  status_state.json — persisted via GHA cache; remembers last-known status
                      per bot so we only ping on transitions and at most
                      every COOLDOWN_HOURS while still in a bad state.

Run cadence:
  This workflow runs every 30 minutes.
  Crypto bot expected cadence: every 15 min, 24/7
  Stock bot expected cadence: every 1 hour, market hours only (Mon-Fri 13:30-21:00 UTC)
"""

import json
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, time, timedelta, timezone
from typing import Optional

import requests
from supabase import create_client


# ── Config ────────────────────────────────────────────────────────────────────

STATE_FILE     = "status_state.json"
COOLDOWN_HOURS = 6  # max alert frequency while bot stays in same bad state

# ── Recovery rate limits ────────────────────────────────────────────────
MIN_MINUTES_BETWEEN_RESTARTS = 60      # min gap between auto-restarts per bot
PANIC_RESTART_THRESHOLD       = 3       # restarts in 24h that triggers panic mode
PANIC_WINDOW_HOURS            = 24

# Stock market hours (Mon-Fri 9:30am-4:00pm ET = 13:30-20:00 UTC during EST,
# 14:30-21:00 UTC during EDT). We use 13:30-21:00 UTC to cover both with margin.
MARKET_OPEN_UTC  = time(13, 30)
MARKET_CLOSE_UTC = time(21, 0)


@dataclass
class BotConfig:
    name:                  str    # e.g. "Crypto" / "Stock"
    supabase_url_env:      str    # env var holding the URL
    supabase_key_env:      str    # env var holding the anon key
    expected_minutes:      int    # max minutes between runs before "down"
    market_hours_only:     bool   # if True, suppress alerts outside market hours
    # Schema differences between bots — column names vary
    runs_started_col:      str = "started_at"   # bot_runs: when did the run start
    errors_ts_col:         str = "created_at"   # bot_errors: when was error logged
    # ── Recovery configuration ──
    bot_repo_owner:        str = ""             # GitHub owner of the bot's repo
    bot_repo_name:         str = ""             # repo name with the workflow
    bot_workflow_file:     str = ""             # workflow filename, e.g. "crypto_bot.yml"
    restart_enabled:       bool = False         # require explicit opt-in
    # ── Optional: Trade activity tracking ──
    trades_table:          Optional[str] = None # e.g. "crypto_trades", or None to skip
    trades_ts_col:         str = "created_at"
    low_activity_days:     int = 7              # alert if no trades in this window

@dataclass
class BotStatus:
    name:                  str
    status:                str                     # "healthy" | "degraded" | "down" | "muted"
    last_run:              Optional[datetime]
    minutes_since_run:     Optional[float]
    errors_6h:             int
    stuck_runs:            int
    reasons:               list[str] = field(default_factory=list)


BOTS = [
    BotConfig(
        name="Crypto",
        supabase_url_env="CRYPTO_SUPABASE_URL",
        supabase_key_env="CRYPTO_SUPABASE_ANON_KEY",
        expected_minutes=30,    # 15-min cadence + buffer
        market_hours_only=False,
        # Crypto bot uses default schema: started_at / created_at
        bot_repo_owner="JTrust-Process",       
        bot_repo_name="Crypto_Trading_Bot",    
        bot_workflow_file="crypto_bot.yaml",   
        restart_enabled=True,
        trades_table="crypto_trades",
        trades_ts_col="created_at",
    ),
    BotConfig(
        name="Stock",
        supabase_url_env="STOCK_SUPABASE_URL",
        supabase_key_env="STOCK_SUPABASE_ANON_KEY",
        expected_minutes=90,    # hourly cadence + buffer
        market_hours_only=True,
        # Stock bot has different column names
        runs_started_col="start_time",
        errors_ts_col="timestamp",
        bot_repo_owner="JTrust-Process",       
        bot_repo_name="Trading-Bot-Project",    
        bot_workflow_file="trading-bot.yml",     
        restart_enabled=True,
        trades_table="trades",
        trades_ts_col="timestamp",
    ),
]


# ── Status state persistence ──────────────────────────────────────────────────

def load_status_state() -> dict:
    if not os.path.exists(STATE_FILE):
        return {}
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def save_status_state(state: dict) -> None:
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


# ── Market hours check ────────────────────────────────────────────────────────

def in_market_hours(now_utc: datetime) -> bool:
    """Mon-Fri 13:30-21:00 UTC. Weekends and off-hours = closed."""
    if now_utc.weekday() >= 5:  # 5=Sat, 6=Sun
        return False
    t = now_utc.time()
    return MARKET_OPEN_UTC <= t <= MARKET_CLOSE_UTC


# ── Per-bot check ─────────────────────────────────────────────────────────────

def check_bot(cfg: BotConfig, now_utc: datetime) -> BotStatus:
    url = os.getenv(cfg.supabase_url_env)
    key = os.getenv(cfg.supabase_key_env)

    if not url or not key:
        return BotStatus(
            name=cfg.name, status="down",
            last_run=None, minutes_since_run=None,
            errors_6h=0, stuck_runs=0,
            reasons=[f"missing env: {cfg.supabase_url_env} / {cfg.supabase_key_env}"],
        )

    sb = create_client(url, key)

    # If outside market hours and bot is market-hours-only, mute the check
    if cfg.market_hours_only and not in_market_hours(now_utc):
        return BotStatus(
            name=cfg.name, status="muted",
            last_run=None, minutes_since_run=None,
            errors_6h=0, stuck_runs=0,
            reasons=["outside market hours — checks suppressed"],
        )

    reasons: list[str] = []

    # Last completed/started run
    last_run_dt: Optional[datetime] = None
    minutes_since: Optional[float]  = None
    try:
        runs = sb.table("bot_runs").select(f"{cfg.runs_started_col}, status").order(
            cfg.runs_started_col, desc=True
        ).limit(1).execute()
        if runs.data and isinstance(runs.data, list) and isinstance(runs.data[0], dict):
            ts = runs.data[0].get(cfg.runs_started_col)
            if isinstance(ts, str):
                last_run_dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                minutes_since = (now_utc - last_run_dt).total_seconds() / 60.0
    except Exception as e:
        reasons.append(f"bot_runs query failed: {e}")

    # Stuck runs: status=running for > 30 min
    stuck_count = 0
    try:
        stuck_threshold = (now_utc - timedelta(minutes=30)).isoformat()
        stuck = sb.table("bot_runs").select(f"id, {cfg.runs_started_col}").eq(
            "status", "running"
        ).lt(cfg.runs_started_col, stuck_threshold).execute()
        stuck_count = len(stuck.data) if stuck.data else 0
    except Exception as e:
        reasons.append(f"stuck-runs query failed: {e}")

    # Errors in last 6h
    errors_6h = 0
    try:
        since = (now_utc - timedelta(hours=6)).isoformat()
        errs = sb.table("bot_errors").select("id").gte(cfg.errors_ts_col, since).execute()
        errors_6h = len(errs.data) if errs.data else 0
    except Exception as e:
        reasons.append(f"bot_errors query failed: {e}")

    # Determine status
    status = "healthy"

    if minutes_since is None:
        status = "down"
        reasons.append("no run history found")
    elif minutes_since > cfg.expected_minutes * 2:
        status = "down"
        reasons.append(f"last run {minutes_since:.0f} min ago (expected ≤{cfg.expected_minutes})")
    elif minutes_since > cfg.expected_minutes:
        status = "degraded"
        reasons.append(f"last run {minutes_since:.0f} min ago (expected ≤{cfg.expected_minutes})")

    if errors_6h >= 3:
        status = "down"
        reasons.append(f"{errors_6h} errors in last 6h")
    elif errors_6h >= 1 and status == "healthy":
        status = "degraded"
        reasons.append(f"{errors_6h} errors in last 6h")

    if stuck_count > 0:
        status = "down"
        reasons.append(f"{stuck_count} stuck run(s) > 30 min old")

    return BotStatus(
        name=cfg.name, status=status,
        last_run=last_run_dt, minutes_since_run=minutes_since,
        errors_6h=errors_6h, stuck_runs=stuck_count,
        reasons=reasons,
    )


# ── Discord ───────────────────────────────────────────────────────────────────

STATUS_EMOJI = {
    "healthy":  "🟢",
    "degraded": "🟡",
    "down":     "🔴",
    "muted":    "⚪",
}
STATUS_COLOR = {
    "healthy":  0x1a6b3c,
    "degraded": 0x92600a,
    "down":     0xc8391a,
    "muted":    0x7a7670,
    "recovered": 0x1a6b3c,
}


def send_discord_alert(webhook: str, statuses: list[BotStatus], event: str) -> None:
    """
    event: "alert" | "recovered"
    """
    if not webhook:
        print("[discord] No webhook configured — skipping send")
        return

    title = "🚨 Bot Health Alert" if event == "alert" else "✅ Bot Recovered"
    color = STATUS_COLOR["down"] if event == "alert" else STATUS_COLOR["recovered"]

    fields = []
    for s in statuses:
        emoji  = STATUS_EMOJI.get(s.status, "❓")
        if s.last_run:
            run_str = s.last_run.strftime("%b %d %H:%M UTC")
            ago     = f"{s.minutes_since_run:.0f}m ago"
        else:
            run_str = "never"
            ago     = "—"
        value = (
            f"**Status:** {emoji} {s.status.upper()}\n"
            f"**Last run:** {run_str} ({ago})\n"
            f"**Errors (6h):** {s.errors_6h}\n"
            f"**Stuck runs:** {s.stuck_runs}\n"
            f"**Notes:** {' · '.join(s.reasons) if s.reasons else 'none'}"
        )
        fields.append({"name": s.name + " Bot", "value": value, "inline": False})

    embed = {
        "title": title,
        "color": color,
        "fields": fields,
        "footer": {"text": f"Bot Health Monitor · {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}"},
    }

    try:
        resp = requests.post(webhook, json={"embeds": [embed]}, timeout=10)
        if resp.status_code not in (200, 204):
            print(f"[discord] Webhook returned {resp.status_code}: {resp.text[:200]}")
        else:
            print(f"[discord] {event} alert sent")
    except Exception as e:
        print(f"[discord] Send failed: {e}")


# ── De-dup decision logic ─────────────────────────────────────────────────────

def should_alert(prev: dict, current: BotStatus, now_utc: datetime) -> tuple[bool, str]:
    """
    Returns (should_send, event_type).
    event_type: "alert" | "recovered" | ""
    """
    prev_status        = prev.get("status", "healthy")
    prev_last_alert_iso = prev.get("last_alert_at")

    # Never alert on muted state
    if current.status == "muted":
        return False, ""

    # Recovery: was bad, now healthy
    if prev_status in ("degraded", "down") and current.status == "healthy":
        return True, "recovered"

    # New bad state: was healthy, now bad
    if prev_status == "healthy" and current.status in ("degraded", "down"):
        return True, "alert"

    # Stayed bad: only alert again if cooldown has passed
    if current.status in ("degraded", "down") and prev_status in ("degraded", "down"):
        if not prev_last_alert_iso:
            return True, "alert"
        try:
            last_alert = datetime.fromisoformat(prev_last_alert_iso)
            hours_since = (now_utc - last_alert).total_seconds() / 3600
            if hours_since >= COOLDOWN_HOURS:
                return True, "alert"
        except Exception:
            return True, "alert"

    return False, ""


# ── Recovery actions ──────────────────────────────────────────────────────────

def trigger_workflow_dispatch(cfg: BotConfig, pat: str) -> tuple[bool, str]:
    """
    Triggers a manual workflow run via GitHub API.
    Returns (success, message).
    """
    if not (cfg.bot_repo_owner and cfg.bot_repo_name and cfg.bot_workflow_file):
        return False, "missing repo/workflow configuration"

    url = f"https://api.github.com/repos/{cfg.bot_repo_owner}/{cfg.bot_repo_name}/actions/workflows/{cfg.bot_workflow_file}/dispatches"
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {pat}",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    body = {"ref": "main"}

    try:
        resp = requests.post(url, json=body, headers=headers, timeout=15)
        if resp.status_code == 204:
            return True, "workflow_dispatch accepted"
        return False, f"GitHub API returned {resp.status_code}: {resp.text[:200]}"
    except Exception as e:
        return False, f"API request failed: {e}"


def mark_stuck_runs_abandoned(cfg: BotConfig) -> tuple[int, str]:
    """
    Updates stuck `running` rows older than 30 min to `error` status,
    so the bot's concurrency guard doesn't think a run is in flight.
    Returns (rows_marked, message).
    """
    url = os.getenv(cfg.supabase_url_env)
    key = os.getenv(cfg.supabase_key_env)
    if not url or not key:
        return 0, "no supabase creds"

    sb = create_client(url, key)
    threshold = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()

    try:
        # Find stuck runs first (so we can count them and log)
        stuck = sb.table("bot_runs").select("id").eq(
            "status", "running"
        ).lt(cfg.runs_started_col, threshold).execute()
        count = len(stuck.data) if stuck.data else 0

        if count == 0:
            return 0, "no stuck runs to clean"

        # Mark them abandoned
        sb.table("bot_runs").update({
            "status": "error",
            "notes":  "marked abandoned by health monitor (stuck > 30 min)",
        }).eq("status", "running").lt(cfg.runs_started_col, threshold).execute()

        return count, f"marked {count} stuck run(s) as abandoned"
    except Exception as e:
        return 0, f"cleanup failed: {e}"


def check_low_activity(cfg: BotConfig, now_utc: datetime) -> Optional[int]:
    """
    Returns days since last trade (None if trade table not configured or query fails).
    Used for option-B alerts (long-running strategy producing no trades).
    """
    if not cfg.trades_table:
        return None
    url = os.getenv(cfg.supabase_url_env)
    key = os.getenv(cfg.supabase_key_env)
    if not url or not key:
        return None

    sb = create_client(url, key)
    try:
        resp = sb.table(cfg.trades_table).select(cfg.trades_ts_col).order(
            cfg.trades_ts_col, desc=True
        ).limit(1).execute()
        if not (resp.data and isinstance(resp.data, list) and isinstance(resp.data[0], dict)):
            return None
        ts = resp.data[0].get(cfg.trades_ts_col)
        if not isinstance(ts, str):
            return None
        last_trade = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return int((now_utc - last_trade).total_seconds() / 86400)
    except Exception:
        return None


def should_attempt_restart(prev: dict, current: BotStatus, now_utc: datetime, cfg: BotConfig) -> tuple[bool, str]:
    """
    Decides whether the monitor should auto-restart this bot right now.
    Returns (should_restart, reason).
    """
    if not cfg.restart_enabled:
        return False, "restart not enabled for this bot"

    # Only restart for "down" — never for degraded or muted
    if current.status != "down":
        return False, f"status is {current.status}, not 'down'"

    # Don't restart if it's the "no trades for a week" reason — that's not a restart problem
    if current.minutes_since_run is not None and current.minutes_since_run < cfg.expected_minutes * 2:
        return False, "down due to errors, not stale runs — restart won't help"

    # Panic mode check
    if prev.get("panic_mode"):
        return False, "PANIC MODE: too many recent restarts, manual intervention required"

    # Rate limit
    last_restart_iso = prev.get("last_restart_at")
    if last_restart_iso:
        try:
            last_restart = datetime.fromisoformat(last_restart_iso)
            mins_since = (now_utc - last_restart).total_seconds() / 60
            if mins_since < MIN_MINUTES_BETWEEN_RESTARTS:
                return False, f"last restart was {mins_since:.0f} min ago (min gap {MIN_MINUTES_BETWEEN_RESTARTS})"
        except Exception:
            pass  # if parse fails, allow restart

    return True, "down + outside cooldown"


def record_restart(state_entry: dict, now_utc: datetime) -> dict:
    """
    Updates state to record that we just attempted a restart.
    Trims old restart timestamps to keep only the panic window worth.
    """
    history = state_entry.get("restart_history", [])
    history.append(now_utc.isoformat())

    # Keep only restarts within panic window
    cutoff = now_utc - timedelta(hours=PANIC_WINDOW_HOURS)
    history = [t for t in history if datetime.fromisoformat(t) >= cutoff]

    state_entry["last_restart_at"] = now_utc.isoformat()
    state_entry["restart_history"] = history
    state_entry["restart_count_24h"] = len(history)

    # Engage panic mode if we hit threshold
    if len(history) >= PANIC_RESTART_THRESHOLD:
        state_entry["panic_mode"] = True

    return state_entry


def send_recovery_notice(webhook: str, bot_name: str, action: str, detail: str) -> None:
    """One-line Discord notice for recovery actions."""
    if not webhook:
        return
    embed = {
        "title": f"🔧 Recovery Action: {bot_name}",
        "description": f"**{action}**\n{detail}",
        "color": 0x4f46e5,  # indigo to distinguish from alerts
        "footer": {"text": f"Bot Health Monitor · {datetime.now(timezone.utc).strftime('%H:%M UTC')}"},
    }
    try:
        requests.post(webhook, json={"embeds": [embed]}, timeout=10)
    except Exception as e:
        print(f"[discord] recovery notice failed: {e}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> int:
    now_utc = datetime.now(timezone.utc)
    webhook = os.getenv("HEALTH_WEBHOOK_URL", "")
    pat     = os.getenv("GH_PAT_BOT_RESTART", "")

    state    = load_status_state()
    statuses = []
    bot_cfgs = {}  # name -> cfg, for recovery lookup

    for cfg in BOTS:
        bot_cfgs[cfg.name] = cfg
        s = check_bot(cfg, now_utc)
        statuses.append(s)
        emoji = STATUS_EMOJI.get(s.status, "❓")
        ms = f"{s.minutes_since_run:.0f}m" if s.minutes_since_run is not None else "—"
        print(f"{emoji} {s.name}: {s.status} · last run {ms} ago · errors_6h={s.errors_6h} · stuck={s.stuck_runs}")
        if s.reasons:
            for r in s.reasons:
                print(f"    └── {r}")

    # Decide alerts and recoveries
    alerts:     list[BotStatus] = []
    recoveries: list[BotStatus] = []
    new_state = dict(state)

    for s in statuses:
        prev = state.get(s.name, {})
        should_send, event = should_alert(prev, s, now_utc)

        # Preserve recovery state (last_restart_at, restart_history, panic_mode)
        # Don't blow these away — they need to persist across runs
        new_state[s.name] = dict(prev)
        new_state[s.name]["status"] = s.status

        if should_send:
            if event == "alert":
                alerts.append(s)
                new_state[s.name]["last_alert_at"] = now_utc.isoformat()
            elif event == "recovered":
                recoveries.append(s)
                new_state[s.name]["last_alert_at"] = None

    # Send pings (one Discord embed per event type, batched)
    if alerts:
        send_discord_alert(webhook, alerts, "alert")
    if recoveries:
        send_discord_alert(webhook, recoveries, "recovered")

    # ── RECOVERY ACTIONS ────────────────────────────────────────────────
    for s in statuses:
        cfg  = bot_cfgs[s.name]
        prev = new_state.get(s.name, {})

        # ─── 1. Mark stuck runs as abandoned (always safe, no PAT needed)
        if s.stuck_runs > 0:
            count, msg = mark_stuck_runs_abandoned(cfg)
            print(f"[recovery] {s.name}: {msg}")
            if count > 0:
                send_recovery_notice(webhook, s.name, "Stuck runs abandoned", msg)

        # ─── 2. Auto-restart if conditions warrant it
        should_restart, restart_reason = should_attempt_restart(prev, s, now_utc, cfg)

        if should_restart:
            if not pat:
                print(f"[recovery] {s.name}: would restart but GH_PAT_BOT_RESTART not set")
                send_recovery_notice(webhook, s.name, "Restart skipped",
                                     "PAT not configured — set GH_PAT_BOT_RESTART secret to enable")
            else:
                print(f"[recovery] {s.name}: triggering workflow_dispatch ({restart_reason})")
                ok, msg = trigger_workflow_dispatch(cfg, pat)
                if ok:
                    new_state[s.name] = record_restart(new_state[s.name], now_utc)
                    panic = new_state[s.name].get("panic_mode", False)
                    detail = f"Restart #{new_state[s.name]['restart_count_24h']} in last 24h"
                    if panic:
                        detail += " · ⚠ PANIC MODE engaged — auto-restart now disabled until manual reset"
                    send_recovery_notice(webhook, s.name, "Auto-restart triggered", detail)
                else:
                    print(f"[recovery] {s.name}: restart FAILED — {msg}")
                    send_recovery_notice(webhook, s.name, "Restart failed", msg)
        else:
            if cfg.restart_enabled and s.status == "down":
                print(f"[recovery] {s.name}: not restarting — {restart_reason}")

        # ─── 3. Low-activity check (Option B: alert only, no auto-action)
        days_since = check_low_activity(cfg, now_utc)
        if days_since is not None and days_since >= cfg.low_activity_days:
            # Dedup: only fire this once per low-activity episode
            last_low = prev.get("last_low_activity_alert")
            already_alerted = False
            if last_low:
                try:
                    last_dt = datetime.fromisoformat(last_low)
                    already_alerted = (now_utc - last_dt).total_seconds() / 86400 < cfg.low_activity_days
                except Exception:
                    pass
            if not already_alerted:
                send_recovery_notice(
                    webhook, s.name, "Low trade activity",
                    f"No trades in {days_since} days. Strategy filters may be suppressing signals — "
                    f"this is informational, no auto-action taken."
                )
                new_state[s.name]["last_low_activity_alert"] = now_utc.isoformat()

    save_status_state(new_state)

    # Exit non-zero if any bot is down — useful for visible GHA red-X status
    if any(s.status == "down" for s in statuses):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())