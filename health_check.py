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
    ),
    BotConfig(
        name="Stock",
        supabase_url_env="STOCK_SUPABASE_URL",
        supabase_key_env="STOCK_SUPABASE_ANON_KEY",
        expected_minutes=90,    # hourly cadence + buffer
        market_hours_only=True,
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
        runs = sb.table("bot_runs").select("started_at, status").order(
            "started_at", desc=True
        ).limit(1).execute()
        if runs.data and isinstance(runs.data, list) and isinstance(runs.data[0], dict):
            ts = runs.data[0].get("started_at")
            if isinstance(ts, str):
                last_run_dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                minutes_since = (now_utc - last_run_dt).total_seconds() / 60.0
    except Exception as e:
        reasons.append(f"bot_runs query failed: {e}")

    # Stuck runs: status=running for > 30 min
    stuck_count = 0
    try:
        stuck_threshold = (now_utc - timedelta(minutes=30)).isoformat()
        stuck = sb.table("bot_runs").select("id, started_at").eq(
            "status", "running"
        ).lt("started_at", stuck_threshold).execute()
        stuck_count = len(stuck.data) if stuck.data else 0
    except Exception as e:
        reasons.append(f"stuck-runs query failed: {e}")

    # Errors in last 6h
    errors_6h = 0
    try:
        since = (now_utc - timedelta(hours=6)).isoformat()
        errs = sb.table("bot_errors").select("id").gte("created_at", since).execute()
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


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> int:
    now_utc = datetime.now(timezone.utc)
    webhook = os.getenv("HEALTH_WEBHOOK_URL", "")

    state    = load_status_state()
    statuses = []

    for cfg in BOTS:
        s = check_bot(cfg, now_utc)
        statuses.append(s)
        emoji = STATUS_EMOJI.get(s.status, "❓")
        ms = f"{s.minutes_since_run:.0f}m" if s.minutes_since_run is not None else "—"
        print(f"{emoji} {s.name}: {s.status} · last run {ms} ago · errors_6h={s.errors_6h} · stuck={s.stuck_runs}")
        if s.reasons:
            for r in s.reasons:
                print(f"    └── {r}")

    # Decide alerts
    alerts:    list[BotStatus] = []
    recoveries: list[BotStatus] = []
    new_state = dict(state)

    for s in statuses:
        prev = state.get(s.name, {})
        should_send, event = should_alert(prev, s, now_utc)

        # Update state regardless of whether we ping
        new_state[s.name] = {
            "status": s.status,
            "last_alert_at": prev.get("last_alert_at"),
        }

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

    save_status_state(new_state)

    # Exit non-zero if any bot is down — useful for visible GHA red-X status
    if any(s.status == "down" for s in statuses):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())