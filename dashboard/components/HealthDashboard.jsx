"use client";

import { useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

// Thresholds kept in sync with monitor/health_check.py.
const ERRORS_6H_DEGRADED = 2;
const ERRORS_6H_DOWN     = 5;
const STUCK_RUN_MINUTES  = 60;

const BOTS = [
  {
    id:   "crypto",
    name: "Crypto",
    repoUrl: process.env.NEXT_PUBLIC_CRYPTO_REPO_URL || "",
    dashboardUrl: process.env.NEXT_PUBLIC_CRYPTO_DASHBOARD_URL || "",
    supabaseUrl: process.env.NEXT_PUBLIC_CRYPTO_SUPABASE_URL,
    supabaseKey: process.env.NEXT_PUBLIC_CRYPTO_SUPABASE_ANON_KEY,
    cols: { runStarted: "started_at", runEnded: "ended_at", errorTs: "created_at" },
    expectedMinutes: 45,    // 15-min cadence + buffer
    cadence: "every 15 minutes",
    marketHoursOnly: false,
    // Cron "7,22,37,52 * * * *" — genuinely 24/7, no active window.
    activeUtcWindowMin: null,
  },
  {
    id:   "stock",
    name: "Stock",
    repoUrl: process.env.NEXT_PUBLIC_STOCK_REPO_URL || "",
    dashboardUrl: process.env.NEXT_PUBLIC_STOCK_DASHBOARD_URL || "",
    supabaseUrl: process.env.NEXT_PUBLIC_STOCK_SUPABASE_URL,
    supabaseKey: process.env.NEXT_PUBLIC_STOCK_SUPABASE_ANON_KEY,
    cols: { runStarted: "start_time",  runEnded: "end_time",  errorTs: "timestamp" },
    expectedMinutes: 90,    // hourly cadence + buffer
    cadence: "every hour, market hours",
    marketHoursOnly: true,
    // Cron "17 14-20 * * 1-5" — first fire 14:17 UTC, last 20:17 UTC.
    //
    // Expressed in MINUTES, not hours (corrected 2026-07-25). The first
    // attempt used [14, 21] at hour granularity, so the window opened at
    // 14:00 while the bot does not run until 14:17. The monitor polls at
    // :08/:23/:38/:53, so the 14:08 check still saw yesterday's 20:17 run
    // (~1071 min, vs expectedMinutes * 2 = 180) and reported "Down" —
    // then "Recovered" at 14:23. That reduced the daily false alert from
    // 47 minutes to 17 rather than removing it.
    //
    // marketHoursOnly alone cannot cover this: the NYSE opens 13:30 UTC in
    // EDT, well before this bot's first run. Lateness has to be judged
    // against the bot's OWN schedule.
    activeUtcWindowMin: [14 * 60 + 17, 20 * 60 + 17],
  },
];

// Supabase clients, built ONCE at module scope.
//
// These used to be constructed inside the 60-second poll. Every
// `createClient` spins up a fresh GoTrueClient which — with
// autoRefreshToken defaulting to true — registers a ~30s setInterval and a
// `visibilitychange` listener that nothing ever removes. Two bots x once a
// minute meant a tab left open all day accumulated roughly 2,880 orphaned
// timers and listeners.
//
// The URL and key are build-time-inlined constants that never change, so
// the client is trivially hoistable.
const CLIENTS = Object.fromEntries(
  BOTS.filter(b => b.supabaseUrl && b.supabaseKey)
      .map(b => [b.id, createClient(b.supabaseUrl, b.supabaseKey)])
);

// Grace after the first scheduled run before we expect a row to exist.
// Covers cron jitter plus the bot's own runtime.
const FIRST_RUN_GRACE_MIN = 10;

/** True when `bot` is inside its scheduled operating window (UTC).
 *
 *  Opens at first-run + grace (nothing can be late before the first run has
 *  had a chance to land) and closes at last-run + expectedMinutes (after
 *  which the bot is legitimately done for the day). */
const inActiveWindow = (bot) => {
  if (!bot.activeUtcWindowMin) return true;   // 24/7 bot
  const [startMin, endMin] = bot.activeUtcWindowMin;
  const now = new Date();
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  return nowMin >= startMin + FIRST_RUN_GRACE_MIN
      && nowMin <= endMin + bot.expectedMinutes;
};

/** Human-readable window, for the idle card's reason line. */
const windowLabel = (bot) => {
  const [s, e] = bot.activeUtcWindowMin;
  const fmt = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return `${fmt(s + FIRST_RUN_GRACE_MIN)}–${fmt(e + bot.expectedMinutes)} UTC`;
};

// NYSE full-day closures. Must mirror monitor/health_check.py.
//
// MAINTENANCE: this list only covers the years listed below. When the
// calendar rolls past them the set silently stops matching, holidays are
// treated as ordinary trading days, and the dashboard starts reporting
// "Down" on Christmas. `holidayDataIsStale()` surfaces that instead of
// letting it degrade quietly — see the console warning it emits.
const NYSE_HOLIDAYS_ISO = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03",
  "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07",
  "2026-11-26", "2026-12-25",
]);

// NYSE 1:00pm ET early closes — value is minutes past midnight ET.
// Mirrors NYSE_EARLY_CLOSE in monitor/health_check.py. Without these both
// surfaces treated 13:00–16:00 ET on these days as a live session while the
// exchange was shut.
const NYSE_EARLY_CLOSE_ISO = {
  "2026-11-27": 13 * 60,  // day after Thanksgiving
  "2026-12-24": 13 * 60,  // Christmas Eve
};

/** Years the holiday tables actually cover, derived from the data itself
 *  so it cannot drift out of sync with the entries above. */
const HOLIDAY_YEARS = new Set([
  ...[...NYSE_HOLIDAYS_ISO].map(d => d.slice(0, 4)),
  ...Object.keys(NYSE_EARLY_CLOSE_ISO).map(d => d.slice(0, 4)),
]);

/** True when the current year has no holiday coverage. */
const holidayDataIsStale = () => {
  const nowYear = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric",
  }).format(new Date());
  return !HOLIDAY_YEARS.has(nowYear);
};

if (typeof window !== "undefined" && holidayDataIsStale()) {
  // Deliberately loud. The failure mode is subtle (false "Down" on market
  // holidays) and there is no other signal that the table expired.
  console.warn(
    "[HealthDashboard] NYSE_HOLIDAYS_ISO covers " +
    `${[...HOLIDAY_YEARS].sort().join(", ")} but it is now a later year. ` +
    "Market holidays will be treated as normal trading days and bots may " +
    "show a false 'Down'. Update the list here AND in monitor/health_check.py."
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

const fmtAgo = (ms) => {
  if (ms == null) return "—";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m === 1) return "1 minute ago";
  if (m < 60) return `${m} minutes ago`;
  const h = Math.floor(m / 60);
  if (h === 1) return "1 hour ago";
  if (h < 24) return `${h} hours ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 day ago" : `${d} days ago`;
};

const fmtTime = (iso) => iso ? new Date(iso).toISOString().slice(11, 19) : "--:--:--";
const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
};

// NYSE 9:30–16:00 America/New_York, Mon–Fri, excluding NYSE_HOLIDAYS_ISO.
// Uses Intl so DST is handled correctly — avoids the union-of-EST/EDT bug
// that flagged false "down" on edge UTC hours.
const inMarketHours = () => {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now).reduce((acc, p) => (acc[p.type] = p.value, acc), {});

  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  const isoDate = `${parts.year}-${parts.month}-${parts.day}`;
  if (NYSE_HOLIDAYS_ISO.has(isoDate)) return false;

  // Intl returns "24" for midnight in en-US 24h — normalise.
  const hour = parts.hour === "24" ? 0 : parseInt(parts.hour, 10);
  const min  = parseInt(parts.minute, 10);
  const total = hour * 60 + min;
  // Honour 1pm early closes; default to the 16:00 regular close.
  const closeMin = NYSE_EARLY_CLOSE_ISO[isoDate] ?? 16 * 60;
  return total >= 9 * 60 + 30 && total <= closeMin;
};

function deriveStatus(bot, runs, errors, payload = {}) {
  const reasons = [];

  // "I cannot see this bot" is NOT "this bot is down" (fixed 2026-07-25).
  // Missing env vars previously fell through to the `minSince == null`
  // branch and rendered "Down — No runs on record", which also turned the
  // page headline red. Because NEXT_PUBLIC_* values are inlined at BUILD
  // time, a Vercel deploy that omitted one variable produced a dashboard
  // confidently claiming your live trading bot was down.
  if (payload.configured === false) {
    return {
      status: "idle",
      label: "Not configured",
      reasons: ["Supabase URL/key not set for this bot at build time. " +
                "Add them in Vercel and redeploy — NEXT_PUBLIC_* values are " +
                "baked in at build."],
      lastRun: null,
      msSinceRun: null,
      errors6h: 0,
      stuckCount: 0,
      unknown: true,
    };
  }

  if (bot.marketHoursOnly && !inMarketHours()) {
    return {
      status: "idle",
      label: "Idle",
      reasons: ["Market closed."],
      lastRun: runs[0] || null,
      msSinceRun: null,
      errors6h: 0,
      stuckCount: 0,
    };
  }

  // Outside the bot's own cron window there is nothing to be late for.
  // Checked separately from market hours because the two do NOT coincide:
  // the NYSE opens at 13:30 UTC while the stock bot's first run is 14:17,
  // and that 47-minute gap produced a false "Down" every trading morning.
  if (!inActiveWindow(bot)) {
    return {
      status: "idle",
      label: "Idle",
      reasons: [`Outside scheduled window (${windowLabel(bot)}).`],
      lastRun: runs[0] || null,
      msSinceRun: null,
      errors6h: 0,
      stuckCount: 0,
    };
  }

  const lastRun = runs[0] || null;
  const lastTs  = lastRun?.[bot.cols.runStarted] || null;
  const msSince = lastTs ? Date.now() - new Date(lastTs).getTime() : null;
  const minSince = msSince != null ? msSince / 60000 : null;

  let status = "ok";
  let label  = "Healthy";

  if (minSince == null) {
    status = "bad"; label = "Down";
    reasons.push("No runs on record.");
  } else if (minSince > bot.expectedMinutes * 2) {
    status = "bad"; label = "Down";
    reasons.push(`Last run ${Math.floor(minSince)} minutes ago.`);
  } else if (minSince > bot.expectedMinutes) {
    status = "warn"; label = "Degraded";
    reasons.push(`Last run ${Math.floor(minSince)} minutes ago.`);
  }

  const sixHrAgo = Date.now() - 6 * 3600 * 1000;
  const recentErrors = errors.filter(e => new Date(e[bot.cols.errorTs]).getTime() >= sixHrAgo);
  const errCount = recentErrors.length;

  if (errCount >= ERRORS_6H_DOWN) {
    status = "bad"; label = "Down";
    reasons.push(`${errCount} errors in the last six hours.`);
  } else if (errCount >= ERRORS_6H_DEGRADED && status === "ok") {
    status = "warn"; label = "Degraded";
    reasons.push(`${errCount} error${errCount > 1 ? "s" : ""} in the last six hours.`);
  }

  // Server-side count across the WHOLE table (see fetchAll). Falls back to
  // scanning the fetched rows only if that query failed, which at least
  // catches recent stuck runs rather than reporting none.
  const stuckThreshold = Date.now() - STUCK_RUN_MINUTES * 60 * 1000;
  const stuckCount = payload.stuckCount != null
    ? payload.stuckCount
    : runs.filter(r => r.status === "running" &&
        new Date(r[bot.cols.runStarted]).getTime() < stuckThreshold).length;

  if (stuckCount > 0) {
    status = "bad"; label = "Down";
    reasons.push(`${stuckCount} cycle${stuckCount > 1 ? "s" : ""} running over ${STUCK_RUN_MINUTES} minutes.`);
  }

  // FAIL CLOSED on telemetry failure, matching monitor/health_check.py's
  // "if a sub-query failed silently, don't claim healthy" rule. A failed
  // bot_errors query yields errors: [] -> errCount 0 -> the error
  // thresholds above are skipped entirely, so without this the card reads
  // "Healthy · All checks passing · Errors 6h: 0" when nothing was measured.
  if ((payload.runsErr || payload.errorsErr || payload.stuckErr) && status === "ok") {
    status = "warn";
    label  = "Degraded";
    reasons.push("Telemetry query failed — health could not be confirmed.");
  }
  if (payload.errorsErr) {
    reasons.push("Error count unavailable (query failed).");
  }
  if (payload.stuckErr) {
    reasons.push("Stuck-run count unavailable (query failed).");
  }

  if (reasons.length === 0) reasons.push("All checks passing.");

  return {
    status, label,
    reasons,
    lastRun,
    msSinceRun: msSince,
    errors6h: errCount,
    stuckCount,
  };
}

const STATUS_VAR = {
  ok:   "var(--ok)",
  warn: "var(--warn)",
  bad:  "var(--bad)",
  idle: "var(--idle)",
};

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────────────────────────

export default function HealthDashboard() {
  const [data, setData]       = useState({});
  const [loading, setLoading] = useState(true);
  const [lastFetch, setLastFetch] = useState(null);

  const fetchAll = async () => {
    const result = {};
    for (const bot of BOTS) {
      const sb = CLIENTS[bot.id];
      if (!sb) {
        // Distinct from an error: we cannot see this bot, which is NOT the
        // same as the bot being down. See deriveStatus.
        result[bot.id] = {
          runs: [], errors: [], err: null,
          configured: false, runsErr: null, errorsErr: null,
        };
        continue;
      }
      try {
        // Stuck runs get their OWN server-side count (fixed 2026-07-25).
        // Previously this was derived by filtering the 50 rows already
        // fetched for display, while monitor/health_check.py counts across
        // the whole table with count="exact". A run that hung four days ago
        // and was never closed out sits below the 50-row horizon: Discord
        // said Down, the dashboard said Healthy, and there was no way to
        // reconcile them from the UI.
        const stuckCutoff = new Date(Date.now() - STUCK_RUN_MINUTES * 60000).toISOString();
        const [r, e, st] = await Promise.all([
          sb.from("bot_runs").select("*").order(bot.cols.runStarted, { ascending: false }).limit(50),
          sb.from("bot_errors").select("*").order(bot.cols.errorTs, { ascending: false }).limit(20),
          sb.from("bot_runs")
            .select("id", { count: "exact", head: true })
            .eq("status", "running")
            .lt(bot.cols.runStarted, stuckCutoff),
        ]);
        // Track the two query failures SEPARATELY. Previously both collapsed
        // into one `err` string and, more importantly, a failed bot_errors
        // query produced `errors: []` which deriveStatus read as
        // "zero errors" — rendering "Healthy · All checks passing" when the
        // truth was "unknown". monitor/health_check.py has always failed
        // closed here; the dashboard did not.
        result[bot.id] = {
          runs:   r.data || [],
          errors: e.data || [],
          runsErr:   r.error?.message || null,
          errorsErr: e.error?.message || null,
          // null (not 0) when the count query failed — 0 would assert
          // "no stuck runs" on no evidence.
          stuckCount: st.error ? null : (st.count ?? 0),
          stuckErr:   st.error?.message || null,
          err: r.error?.message || e.error?.message || st.error?.message || null,
          configured: true,
        };
      } catch (err) {
        const msg = String(err.message || err);
        result[bot.id] = {
          runs: [], errors: [], err: msg,
          runsErr: msg, errorsErr: msg, configured: true,
        };
      }
    }
    setData(result);
    setLoading(false);
    setLastFetch(new Date());
  };

  useEffect(() => {
    fetchAll();
    // Poll only while the tab is visible. A backgrounded tab was issuing
    // 1,440 Supabase round-trips a day per dashboard for data nobody was
    // looking at. Refetch immediately on re-focus so the page is never
    // stale when you actually return to it.
    const id = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        fetchAll();
      }
    }, 60000);
    const onVisible = () => {
      if (document.visibilityState === "visible") fetchAll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (loading) {
    return (
      <main style={{ padding: "var(--s-9) var(--s-7)", textAlign: "left", maxWidth: 720 }}>
        <div style={{ fontSize: 13, color: "var(--ink-3)" }} className="pulse-soft">Loading.</div>
      </main>
    );
  }

  const statuses = BOTS.map(bot => ({
    bot,
    payload: data[bot.id] || { runs: [], errors: [] },
    status:  deriveStatus(
      bot,
      data[bot.id]?.runs || [],
      data[bot.id]?.errors || [],
      data[bot.id] || {},
    ),
  }));

  // Unconfigured bots are excluded from the headline — "I can't see it"
  // should not colour the aggregate verdict for the bots we CAN see.
  const visible = statuses.filter(s => !s.status.unknown);

  const overall = visible.some(s => s.status.status === "bad") ? "bad"
                : visible.some(s => s.status.status === "warn") ? "warn"
                : statuses.every(s => s.status.status === "idle") ? "idle"
                : "ok";

  const overallSentence = {
    ok:   "All systems are operational.",
    warn: "Some systems are degraded.",
    bad:  "A system requires attention.",
    idle: "All systems are idle.",
  }[overall];

  return (
    <main style={{ padding: "var(--s-7) var(--s-7) 0", maxWidth: 1100 }}>

      {/* ============================================================
          HEADLINE
         ============================================================ */}
      <section style={{
        paddingBottom: "var(--s-8)",
        marginBottom: "var(--s-8)",
        borderBottom: "1px solid var(--rule)",
      }} className="fade-up">
        <Eyebrow>Status as of {lastFetch ? fmtTime(lastFetch.toISOString()) : "—"}</Eyebrow>
        <h1 style={{
          fontSize: "clamp(2.25rem, 5vw, 3.5rem)",
          fontWeight: 700,
          letterSpacing: "-0.025em",
          lineHeight: 1.05,
          marginTop: "var(--s-3)",
          color: "var(--ink)",
          maxWidth: 920,
        }}>
          {overallSentence}
        </h1>
      </section>

      {/* ============================================================
          BOTS — long list, full width, generous space between
         ============================================================ */}
      <section style={{ marginBottom: "var(--s-8)" }}>
        <SectionHeader>Bots</SectionHeader>
        {statuses.map((s, i) => (
          <BotRow key={s.bot.id} {...s} isLast={i === statuses.length - 1} />
        ))}
      </section>

      {/* ============================================================
          RECENT ACTIVITY — typographic table
         ============================================================ */}
      <section style={{ marginBottom: "var(--s-8)" }}>
        <SectionHeader>Recent activity</SectionHeader>
        <ActivityTable statuses={statuses} />
      </section>

      {/* ============================================================
          INCIDENTS — only renders if there are any
         ============================================================ */}
      <IncidentsSection statuses={statuses} />

    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────

function Eyebrow({ children }) {
  return (
    <div style={{
      fontSize: 11,
      letterSpacing: "0.08em",
      textTransform: "uppercase",
      color: "var(--ink-4)",
      fontFamily: "var(--mono)",
      fontWeight: 500,
    }}>
      {children}
    </div>
  );
}

function SectionHeader({ children, count }) {
  return (
    <div style={{
      display: "flex",
      alignItems: "baseline",
      justifyContent: "space-between",
      paddingBottom: "var(--s-3)",
      marginBottom: "var(--s-5)",
      borderBottom: "1px solid var(--rule)",
    }}>
      <h2 style={{
        fontSize: 13,
        fontWeight: 600,
        letterSpacing: "-0.005em",
        color: "var(--ink)",
      }}>
        {children}
      </h2>
      {count != null && (
        <span style={{
          fontSize: 11,
          color: "var(--ink-4)",
          fontFamily: "var(--mono)",
        }}>
          {count}
        </span>
      )}
    </div>
  );
}

function StatusDot({ status, size = 8 }) {
  return (
    <span style={{
      display: "inline-block",
      width: size, height: size,
      borderRadius: "50%",
      background: STATUS_VAR[status],
      flexShrink: 0,
    }} />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  BOT ROW — one bot, full-width, status + name + reasons + stats + links
// ─────────────────────────────────────────────────────────────────────────────

function BotRow({ bot, status, payload, isLast }) {
  const hasError = payload.err;

  return (
    <div className="stack-sm" style={{
      display: "grid",
      gridTemplateColumns: "minmax(220px, 1.4fr) 2fr auto",
      gap: "var(--s-7)",
      padding: "var(--s-6) 0",
      borderBottom: isLast ? "none" : "1px solid var(--rule)",
      alignItems: "start",
    }}>
      {/* LEFT: name + status */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)", marginBottom: "var(--s-2)" }}>
          <StatusDot status={status.status} size={10} />
          <span style={{
            fontSize: 13,
            fontFamily: "var(--mono)",
            color: "var(--ink-3)",
            letterSpacing: "0.02em",
          }}>
            {status.label}
          </span>
        </div>
        <div style={{
          fontSize: 28,
          fontWeight: 600,
          letterSpacing: "-0.02em",
          color: "var(--ink)",
          lineHeight: 1.1,
        }}>
          {bot.name}
        </div>
        <div style={{
          fontSize: 12,
          color: "var(--ink-4)",
          marginTop: "var(--s-1)",
        }}>
          Runs {bot.cadence}.
        </div>
      </div>

      {/* MIDDLE: reasons + stats */}
      <div>
        <div style={{
          fontSize: 14,
          color: "var(--ink-2)",
          lineHeight: 1.5,
          marginBottom: "var(--s-5)",
        }}>
          {status.reasons.map((r, i) => (
            <div key={i} style={{ marginBottom: i < status.reasons.length - 1 ? 4 : 0 }}>
              {r}
            </div>
          ))}
        </div>

        {/* Stats — typographic, no boxes */}
        <div className="stack-sm" style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: "var(--s-5)",
          paddingTop: "var(--s-4)",
          borderTop: "1px solid var(--rule)",
        }}>
          <Stat label="Last run"  value={status.lastRun ? fmtAgo(status.msSinceRun) : "Never"} />
          <Stat label="Errors 6h" value={String(status.errors6h)} alarm={status.errors6h > 0} />
          <Stat label="Stuck"     value={String(status.stuckCount)}  alarm={status.stuckCount > 0} />
          <Stat label="Window"    value={`${bot.expectedMinutes}m`} />
        </div>

        {hasError && (
          <div style={{
            marginTop: "var(--s-4)",
            paddingTop: "var(--s-3)",
            borderTop: "1px solid var(--rule)",
            fontSize: 11,
            color: "var(--bad)",
            fontFamily: "var(--mono)",
          }}>
            Telemetry error: {String(payload.err).slice(0, 100)}
          </div>
        )}
      </div>

      {/* RIGHT: links — minimal, vertical */}
      <div style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--s-3)",
        alignItems: "flex-end",
        textAlign: "right",
      }}>
        {bot.dashboardUrl && (
          <a href={bot.dashboardUrl} target="_blank" rel="noopener noreferrer" className="tnav"
             style={{ fontSize: 13 }}>
            Dashboard →
          </a>
        )}
        {bot.repoUrl && (
          <a href={bot.repoUrl} target="_blank" rel="noopener noreferrer" className="tnav"
             style={{ fontSize: 13 }}>
            Source ↗
          </a>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, alarm }) {
  return (
    <div>
      <div style={{
        fontSize: 11,
        color: "var(--ink-4)",
        letterSpacing: "0.02em",
        marginBottom: 2,
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 16,
        fontFamily: "var(--mono)",
        fontWeight: 500,
        color: alarm ? "var(--bad)" : "var(--ink)",
      }} className="tabular">
        {value}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  RECENT ACTIVITY — unified table across both bots
// ─────────────────────────────────────────────────────────────────────────────

function ActivityTable({ statuses }) {
  const allRuns = statuses.flatMap(s =>
    (s.payload.runs || []).slice(0, 10).map(r => ({
      ...r,
      _bot: s.bot,
      _ts:  r[s.bot.cols.runStarted],
    }))
  ).sort((a, b) => new Date(b._ts) - new Date(a._ts)).slice(0, 18);

  if (allRuns.length === 0) {
    return (
      <div style={{ fontSize: 13, color: "var(--ink-4)", padding: "var(--s-4) 0" }}>
        No activity recorded.
      </div>
    );
  }

  return (
    <div>
      {/* Column header row */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "80px 100px 1fr 100px",
        gap: "var(--s-4)",
        padding: "0 0 var(--s-3)",
        borderBottom: "1px solid var(--rule)",
        fontSize: 11,
        color: "var(--ink-4)",
        letterSpacing: "0.02em",
      }}>
        <span>Date</span>
        <span>Bot</span>
        <span>Status</span>
        <span style={{ textAlign: "right" }}>Elapsed</span>
      </div>

      {/* Rows */}
      {allRuns.map((r, i) => {
        const status = (r.status || "unknown").toLowerCase();
        const dotStatus =
          status === "completed" ? "ok"   :
          status === "running"   ? "warn" :
          status === "error"     ? "bad"  :
                                   "idle";
        return (
          <div key={i} style={{
            display: "grid",
            gridTemplateColumns: "80px 100px 1fr 100px",
            gap: "var(--s-4)",
            padding: "var(--s-3) 0",
            borderBottom: i < allRuns.length - 1 ? "1px solid var(--rule)" : "none",
            alignItems: "center",
            fontSize: 13,
          }}>
            <span style={{ fontFamily: "var(--mono)", color: "var(--ink-3)", fontSize: 12 }} className="tabular">
              {fmtDate(r._ts)} {fmtTime(r._ts).slice(0, 5)}
            </span>
            <span style={{ color: "var(--ink-2)", fontWeight: 500 }}>
              {r._bot.name}
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: "var(--s-2)", color: "var(--ink-2)" }}>
              <StatusDot status={dotStatus} size={6} />
              <span style={{ textTransform: "lowercase" }}>{status}</span>
            </span>
            <span style={{
              fontFamily: "var(--mono)",
              color: "var(--ink-4)",
              textAlign: "right",
              fontSize: 12,
            }} className="tabular">
              {fmtAgo(Date.now() - new Date(r._ts).getTime())}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  INCIDENTS — only renders if errors exist
// ─────────────────────────────────────────────────────────────────────────────

function IncidentsSection({ statuses }) {
  const allErrors = statuses.flatMap(s =>
    (s.payload.errors || []).slice(0, 10).map(e => ({
      ...e,
      _bot: s.bot,
      _ts: e[s.bot.cols.errorTs],
    }))
  ).sort((a, b) => new Date(b._ts) - new Date(a._ts)).slice(0, 12);

  if (allErrors.length === 0) {
    return (
      <section>
        <SectionHeader count={0}>Incidents</SectionHeader>
        <div style={{
          fontSize: 14,
          color: "var(--ink-3)",
          padding: "var(--s-5) 0",
        }}>
          No incidents in recent history.
        </div>
      </section>
    );
  }

  return (
    <section>
      <SectionHeader count={allErrors.length}>Incidents</SectionHeader>
      {allErrors.map((e, i) => {
        const errMessage = e.message || e.error || "(no message)";
        const context = e.context || e.stage || e.error_type || "";
        return (
          <div key={i} style={{
            display: "grid",
            gridTemplateColumns: "80px 100px 1fr",
            gap: "var(--s-4)",
            padding: "var(--s-4) 0",
            borderBottom: i < allErrors.length - 1 ? "1px solid var(--rule)" : "none",
            alignItems: "start",
            fontSize: 13,
          }}>
            <span style={{ fontFamily: "var(--mono)", color: "var(--ink-3)", fontSize: 12 }} className="tabular">
              {fmtDate(e._ts)} {fmtTime(e._ts).slice(0, 5)}
            </span>
            <span style={{ color: "var(--bad)", fontWeight: 500 }}>
              {e._bot.name}
            </span>
            <div style={{ color: "var(--ink-2)", lineHeight: 1.5 }}>
              {context && (
                <span style={{ color: "var(--ink-4)", fontFamily: "var(--mono)", fontSize: 12, marginRight: 8 }}>
                  {context}
                </span>
              )}
              <span>{String(errMessage).slice(0, 240)}</span>
            </div>
          </div>
        );
      })}
    </section>
  );
}