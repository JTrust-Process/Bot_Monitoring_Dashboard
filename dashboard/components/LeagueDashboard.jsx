"use client";

import { useEffect, useState } from "react";
import { createLeagueClient, getLeagueSupabaseConfig } from "../lib/supabaseLeague";

// ─────────────────────────────────────────────────────────────────────────────
//  Config — thresholds for the health derivation. Mirrors what the existing
//  HealthDashboard does for the per-bot Supabase projects.
// ─────────────────────────────────────────────────────────────────────────────

const HEARTBEAT_DEGRADED_MIN = 30;   // no heartbeat in N min → degraded
const HEARTBEAT_DOWN_MIN     = 120;  // no heartbeat in N min → down
const RUNS_LIMIT             = 30;
const TRADES_LIMIT           = 30;
const SCORES_LIMIT           = 60;   // bot_research_scores — fetched, then dedup'd client-side
const SIGNALS_LIMIT          = 40;
const POSITIONS_LIMIT        = 80;   // open positions across all bots — generous
const APPROVALS_LIMIT        = 40;   // pending bot_approvals rows
const EXPENSES_LIMIT         = 200;  // bot_expenses rows — pull a year of monthly entries comfortably

// Modes that are NOT live → render with a less-loud accent.
const MODE_LABEL = {
  live:     "Live",
  paper:    "Paper",
  research: "Research",
  // Catch-all for registry rows whose `mode` is not one of the three above
  // (typo, null, or a value introduced later). Without a bucket these rows
  // rendered nowhere while still counting toward the headline.
  other:    "Other / unclassified",
};

const STATUS_VAR = {
  ok:   "var(--ok)",
  warn: "var(--warn)",
  bad:  "var(--bad)",
  idle: "var(--idle)",
};

// Map bot_status.health → dashboard status bucket
const HEALTH_BUCKET = {
  healthy:  "ok",
  degraded: "warn",
  down:     "bad",
  unknown:  "idle",
  muted:    "idle",
};

// ─────────────────────────────────────────────────────────────────────────────
//  Utilities
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

// Like fmtAgo but for a bare interval — no "ago" suffix. Used to describe a
// bot's observed run cadence, e.g. "runs about every 15 minutes".
const fmtDuration = (minutes) => {
  if (minutes == null) return "—";
  const m = Math.round(minutes);
  if (m < 1) return "under a minute";
  if (m === 1) return "1 minute";
  if (m < 60) return `${m} minutes`;
  const h = Math.round(m / 60);
  if (h === 1) return "1 hour";
  if (h < 24) return `${h} hours`;
  const d = Math.round(h / 24);
  return d === 1 ? "1 day" : `${d} days`;
};

const fmtTime = (iso) => (iso ? new Date(iso).toISOString().slice(11, 19) : "--:--:--");
const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${mm}/${dd} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

const fmtUsd = (n) => {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  const sign = v < 0 ? "−" : "";
  const abs = Math.abs(v);
  if (abs >= 1000) return `${sign}$${abs.toFixed(0)}`;
  return `${sign}$${abs.toFixed(2)}`;
};

// REMOVED 2026-07-25: `fmtPct` was dead code (no callers) and its logic was
// the guessing pattern this codebase keeps getting bitten by — it inferred
// whether the input was a fraction or an already-scaled percentage from its
// magnitude:
//
//     v * (Math.abs(v) > 1 ? 1 : 100)
//
// so a genuine 0.5% return supplied as `0.5` rendered as "50.00%". Deleted
// rather than fixed: if a percent formatter is needed again, take the unit
// as an explicit argument instead of divining it.

const durMs = (run) => {
  if (run.duration_ms != null) return Number(run.duration_ms);
  if (run.ended_at && run.started_at) {
    return new Date(run.ended_at).getTime() - new Date(run.started_at).getTime();
  }
  return null;
};

const fmtDur = (ms) => {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
};

// Pretty-print a bot_id like "stock_momentum_v1" or fall back to bot_name.
const displayName = (registry) => registry?.bot_name || registry?.bot_id || "—";

// ─────────────────────────────────────────────────────────────────────────────
//  Derived status per bot
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estimate a bot's normal run interval, in minutes, from its own history.
 *
 * WHY (fixed 2026-07-25): the staleness thresholds below used to be flat —
 * 30 min to "Degraded", 120 min to "Stale" — applied to every bot no matter
 * how often it actually runs. Daily bots were therefore permanently red:
 * bond_research_v1 fires once at 14:35 UTC, so it showed Degraded from 15:05
 * and Stale from 16:35, i.e. ~23 hours of every day, despite being perfectly
 * healthy. That trained us to ignore the health colours entirely.
 *
 * Deriving cadence from bot_runs rather than hardcoding a per-bot table keeps
 * the dashboard truthful when a schedule changes in agent_runner/scheduler.py
 * without anyone remembering to update the UI.
 *
 * Uses the MEDIAN gap between consecutive runs, which shrugs off the one
 * large gap you get across a weekend for weekday-only bots. Returns null when
 * there's too little history to say, in which case the caller falls back to
 * the flat defaults.
 */
function deriveCadenceMin(runsForBot) {
  if (!Array.isArray(runsForBot) || runsForBot.length < 3) return null;

  const times = runsForBot
    .map(r => (r.started_at ? new Date(r.started_at).getTime() : null))
    .filter(t => t != null)
    .sort((a, b) => b - a); // newest first
  if (times.length < 3) return null;

  const gaps = [];
  for (let i = 0; i < times.length - 1; i++) {
    const gapMin = (times[i] - times[i + 1]) / 60000;
    if (gapMin > 0) gaps.push(gapMin);
  }
  if (gaps.length < 2) return null;

  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median = gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
  return median > 0 ? median : null;
}

function deriveBotStatus(registryRow, statusRow, cadenceMin = null) {
  if (registryRow.status === "killed") {
    return { bucket: "bad", label: "Killed", reason: "Operator killed this bot." };
  }
  if (registryRow.status === "disabled") {
    return { bucket: "idle", label: "Disabled", reason: "Bot is disabled in registry." };
  }
  if (!statusRow) {
    return { bucket: "idle", label: "No heartbeat", reason: "Bot has not heartbeat yet." };
  }

  const lastHb = statusRow.last_heartbeat_at ? new Date(statusRow.last_heartbeat_at).getTime() : null;
  const ageMin = lastHb ? (Date.now() - lastHb) / 60000 : null;

  // Scale the staleness thresholds to how often this bot actually runs.
  //
  // ADDITIVE grace, not multiplicative (corrected 2026-07-25). The first
  // version used cadence * 2.5 and * 5, which is sane at 15 minutes
  // (37 / 75 min) and absurd at daily: a bot that died on Monday would read
  // "Healthy" until Wednesday afternoon and not go red until Saturday. That
  // over-corrected past the bug it was fixing — a broken bot looking healthy
  // for 2.5 days is worse than a healthy bot looking broken.
  //
  // This also aligns with the other two surfaces in the repo
  // (HealthDashboard.jsx and monitor/health_check.py), which both use
  // 1x expected -> degraded, 2x expected -> down. Three surfaces now answer
  // "how late is too late" the same way.
  //
  // Resulting behaviour: 15-min bot -> amber 35m, red 50m (close to the old
  // flat 30/120, so no regression at the frequent end). Daily bot -> amber
  // ~24h20m, red ~48h20m.
  const GRACE_MIN = 20;
  const degradedMin = cadenceMin
    ? cadenceMin + GRACE_MIN
    : HEARTBEAT_DEGRADED_MIN;
  const downMin = cadenceMin
    ? cadenceMin * 2 + GRACE_MIN
    : HEARTBEAT_DOWN_MIN;

  const cadenceNote = cadenceMin
    ? ` (runs about every ${fmtDuration(cadenceMin)})`
    : "";

  // Bucket from explicit health if available, then layer the age threshold on top.
  let bucket = HEALTH_BUCKET[statusRow.health] || "idle";
  let label = statusRow.health ? statusRow.health[0].toUpperCase() + statusRow.health.slice(1) : "Unknown";
  let reason = "—";

  if (ageMin == null) {
    bucket = "idle"; label = "No heartbeat"; reason = "Last heartbeat unknown.";
  } else if (ageMin > downMin) {
    bucket = "bad"; label = "Stale"; reason = `Last heartbeat ${Math.floor(ageMin)} minutes ago${cadenceNote}.`;
  } else if (ageMin > degradedMin) {
    if (bucket !== "bad") { bucket = "warn"; label = "Degraded"; reason = `Last heartbeat ${Math.floor(ageMin)} minutes ago${cadenceNote}.`; }
  } else if (statusRow.last_run_status === "failed" || statusRow.last_run_status === "timeout") {
    bucket = "bad"; label = "Last run failed"; reason = statusRow.last_error_msg || "Most recent run ended in failure.";
  } else if (statusRow.last_run_status === "warning") {
    bucket = bucket === "bad" ? "bad" : "warn"; label = "Warning"; reason = "Most recent run completed with warnings.";
  } else if (statusRow.last_run_status === "success") {
    // NOTE: this uses the HEARTBEAT timestamp to describe when the RUN
    // finished, which is only exact if the bot heartbeats once per run.
    // Worded as "Last heartbeat" to avoid overstating precision.
    bucket = "ok"; label = "Healthy"; reason = `Last run succeeded · heartbeat ${fmtAgo(Date.now() - lastHb)}.`;
  }

  // Never return a bare em-dash next to a status dot (fixed 2026-07-25).
  // Two paths could leave `reason` unset: health="down" combined with an age
  // between the degraded and down thresholds (the `bucket !== "bad"` guard
  // skips the assignment), and any last_run_status outside the four handled
  // values — null, "partial", "skipped". Both rendered as "Down. —", which
  // is the least useful possible thing to show for a bot that places orders.
  if (reason === "—") {
    const parts = [];
    if (statusRow.health) parts.push(`health=${statusRow.health}`);
    if (statusRow.last_run_status) parts.push(`last run=${statusRow.last_run_status}`);
    if (ageMin != null) parts.push(`heartbeat ${Math.floor(ageMin)}m ago`);
    reason = parts.length
      ? `${parts.join(", ")}.`
      : "No diagnostic detail reported by the bot.";
  }

  return { bucket, label, reason };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────────────────────────────────────

export default function LeagueDashboard() {
  const [loading, setLoading]     = useState(true);
  const [lastFetch, setLastFetch] = useState(null);
  const [fetchErr, setFetchErr]   = useState(null);

  const [registry, setRegistry]   = useState([]);
  const [statuses, setStatuses]   = useState([]);
  const [runs, setRuns]           = useState([]);
  const [trades, setTrades]       = useState([]);
  const [scores, setScores]       = useState([]);
  const [signals, setSignals]     = useState([]);
  const [positions, setPositions] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [expenses, setExpenses]   = useState([]);
  // bot_id -> observed cadence in minutes (null when not determinable).
  const [cadenceByBot, setCadenceByBot] = useState({});
  // Per-section query errors, so each section can say "I failed" rather than
  // "there is nothing here". See the setter in fetchAll.
  const [sectionErrs, setSectionErrs]   = useState({});

  const cfg = getLeagueSupabaseConfig();
  const configured = !!(cfg.url && cfg.key);

  const fetchAll = async () => {
    if (!configured) {
      setLoading(false);
      setFetchErr("LEAGUE Supabase env vars not set.");
      return;
    }
    const sb = createLeagueClient();
    try {
      const [reg, st, rn, tr, sc, sg, ps, ap, ex] = await Promise.all([
        sb.from("bot_registry").select("*").order("bot_id", { ascending: true }),
        sb.from("bot_status").select("*"),
        sb.from("bot_runs").select("*").order("started_at", { ascending: false }).limit(RUNS_LIMIT),
        sb.from("bot_trades").select("*").order("occurred_at", { ascending: false }).limit(TRADES_LIMIT),
        sb.from("bot_research_scores").select("*").order("scored_at", { ascending: false }).limit(SCORES_LIMIT),
        sb.from("bot_signals").select("*").order("generated_at", { ascending: false }).limit(SIGNALS_LIMIT),
        sb.from("bot_positions").select("*").eq("status", "open").order("entry_at", { ascending: false }).limit(POSITIONS_LIMIT),
        sb.from("bot_approvals").select("*").eq("status", "pending").order("requested_at", { ascending: false }).limit(APPROVALS_LIMIT),
        sb.from("bot_expenses").select("*").order("period", { ascending: false }).limit(EXPENSES_LIMIT),
      ]);
      setRegistry(reg.data || []);
      setStatuses(st.data || []);
      setRuns(rn.data || []);
      setTrades(tr.data || []);
      setScores(sc.data || []);
      setSignals(sg.data || []);
      setPositions(ps.data || []);
      setApprovals(ap.data || []);
      setExpenses(ex.data || []);

      // Per-section errors, not one collapsed string (fixed 2026-07-25).
      // Every setter above uses `|| []`, so a failed query is
      // indistinguishable from an empty table — and the sections then make
      // positive claims: "No pending approvals.", "No open positions across
      // the league." Only the FIRST error in the old `||` chain surfaced, so
      // if two queries failed you were told about one and the other section
      // simply lied. The approvals case is the sharp one: an order awaiting
      // human review rendered as "nothing to do".
      setSectionErrs({
        registry:  reg.error?.message || null,
        statuses:  st.error?.message  || null,
        runs:      rn.error?.message  || null,
        trades:    tr.error?.message  || null,
        scores:    sc.error?.message  || null,
        signals:   sg.error?.message  || null,
        positions: ps.error?.message  || null,
        approvals: ap.error?.message  || null,
        expenses:  ex.error?.message  || null,
      });
      setFetchErr(
        reg.error?.message || st.error?.message || rn.error?.message ||
        tr.error?.message  || sc.error?.message || sg.error?.message ||
        ps.error?.message  || ap.error?.message || ex.error?.message || null
      );

      // ── Per-bot cadence (H2 fix, 2026-07-25) ───────────────────────────
      // Cadence CANNOT be derived from the `runs` query above: that is a
      // single global `.limit(30)` allocated by recency, so one 15-minute
      // bot (96 rows/day) crowds out everything else and 30 rows spans only
      // ~7.5 hours. A daily bot such as bond_research_v1 never accumulates
      // the 3 rows deriveCadenceMin needs, so it returned null and the bot
      // fell back to the flat 30/120 thresholds — i.e. the fix silently
      // failed for exactly the bots it was written to rescue, and would have
      // regressed further as run volume grew.
      //
      // Two sources, in priority order:
      //   1. bot_registry.expected_cadence_minutes — registry truth. Does
      //      not exist yet; add it to the League schema and this starts
      //      being used automatically, no dashboard change required.
      //   2. Observation — one small query per bot, so a daily bot's history
      //      is never crowded out by a chatty one.
      const regRows = reg.data || [];
      const observed = await Promise.all(
        regRows.map(async (r) => {
          if (r.expected_cadence_minutes) return [r.bot_id, null]; // registry wins
          const { data } = await sb
            .from("bot_runs")
            .select("started_at")
            .eq("bot_id", r.bot_id)
            .order("started_at", { ascending: false })
            .limit(12);
          return [r.bot_id, deriveCadenceMin(data || [])];
        })
      );
      setCadenceByBot(Object.fromEntries(observed));
    } catch (err) {
      setFetchErr(String(err?.message || err));
    } finally {
      setLoading(false);
      setLastFetch(new Date());
    }
  };

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, 60000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <main style={{ padding: "var(--s-9) var(--s-7)", textAlign: "left", maxWidth: 720 }}>
        <div style={{ fontSize: 13, color: "var(--ink-3)" }} className="pulse-soft">Loading.</div>
      </main>
    );
  }

  // Map bot_id → status row for fast lookup.
  const statusByBot = Object.fromEntries(statuses.map(s => [s.bot_id, s]));
  const regByBot    = Object.fromEntries(registry.map(r => [r.bot_id, r]));

  // Group runs by bot so each bot's staleness thresholds can be scaled to
  // its own cadence rather than a one-size-fits-all 30/120 minutes.
  //
  // Cadence comes from `cadenceByBot` (registry column if present, else a
  // per-bot query) — NOT from the global `runs` array, which cannot supply
  // enough history for infrequent bots. See the fetchAll comment.
  const cadenceFor = (r) =>
    Number(r.expected_cadence_minutes) || cadenceByBot[r.bot_id] || null;

  // Derived per-bot rows
  const bots = registry.map(r => ({
    registry: r,
    status:   statusByBot[r.bot_id] || null,
    cadence:  cadenceFor(r),
    derived:  deriveBotStatus(r, statusByBot[r.bot_id], cadenceFor(r)),
  }));

  // Deliberately retired bots must not pin the headline red forever
  // (fixed 2026-07-25). `status === "killed"` maps to bucket "bad", and
  // `overall` went bad if ANY bot was bad — so one retired registry row
  // held the page at "A bot in the league requires attention." permanently.
  // That is the same permanent-false-alarm failure the cadence work was
  // meant to eliminate. The row still renders red (a killed bot SHOULD be
  // visibly killed); it just no longer votes on the aggregate.
  const RETIRED = new Set(["killed", "disabled"]);
  const active = bots.filter(b => !RETIRED.has(b.registry.status));
  const retiredCount = bots.length - active.length;

  // bot_id -> derived bot, for cross-referencing positions against the
  // health of the bot that owns them (see positionIsConfirmed).
  const botsById = Object.fromEntries(bots.map(b => [b.registry.bot_id, b]));

  const overall = active.length === 0 ? "idle"
                : active.some(b => b.derived.bucket === "bad")  ? "bad"
                : active.some(b => b.derived.bucket === "warn") ? "warn"
                : active.every(b => b.derived.bucket === "idle") ? "idle"
                : "ok";

  const retiredSuffix = retiredCount > 0
    ? ` (${retiredCount} retired, excluded)`
    : "";

  const overallSentence = {
    ok:   `${active.length} active bot${active.length === 1 ? "" : "s"}, all healthy${retiredSuffix}.`,
    warn: `${active.length} active bot${active.length === 1 ? "" : "s"}, some degraded${retiredSuffix}.`,
    bad:  "A bot in the league requires attention.",
    idle: active.length === 0
      ? (bots.length === 0 ? "No bots in registry yet." : "All bots retired.")
      : `All active bots idle${retiredSuffix}.`,
  }[overall];

  // Buckets for the dashboard's "live / paper / research" grouping.
  // `other` catches any mode outside the three known buckets — previously
  // such a row rendered NOWHERE while still counting toward the headline,
  // so the page could read "8 bots registered" above six visible rows, or
  // turn red for a bot with no card to click.
  const KNOWN_MODES = ["live", "paper", "research"];
  const byMode = {
    live:     bots.filter(b => b.registry.mode === "live"),
    paper:    bots.filter(b => b.registry.mode === "paper"),
    research: bots.filter(b => b.registry.mode === "research"),
    other:    bots.filter(b => !KNOWN_MODES.includes(b.registry.mode)),
  };

  return (
    <main style={{ padding: "var(--s-7) var(--s-7) 0", maxWidth: 1200 }}>

      {/* ============================================================
          HEADLINE
         ============================================================ */}
      <section style={{
        paddingBottom: "var(--s-8)",
        marginBottom: "var(--s-8)",
        borderBottom: "1px solid var(--rule)",
      }} className="fade-up">
        <Eyebrow>League status as of {lastFetch ? fmtTime(lastFetch.toISOString()) : "—"}</Eyebrow>
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
        {fetchErr && (
          <div style={{
            marginTop: "var(--s-4)",
            fontFamily: "var(--mono)",
            fontSize: 12,
            color: "var(--bad)",
          }}>
            Telemetry error: {fetchErr}
          </div>
        )}
        {!configured && (
          <div style={{
            marginTop: "var(--s-4)",
            fontFamily: "var(--mono)",
            fontSize: 12,
            color: "var(--ink-3)",
          }}>
            Set NEXT_PUBLIC_LEAGUE_SUPABASE_URL and NEXT_PUBLIC_LEAGUE_SUPABASE_ANON_KEY
            in .env.local (and Vercel project settings), then <strong>redeploy</strong>.
            NEXT_PUBLIC_* values are inlined at build time, so adding them in
            Vercel and reloading this page will not take effect on its own.
          </div>
        )}
      </section>

      {/* ============================================================
          PENDING APPROVALS — most actionable section, placed up top
         ============================================================ */}
      <ApprovalsSection
        approvals={approvals}
        regByBot={regByBot}
        onResolved={fetchAll}
        approvalsErr={sectionErrs.approvals}
      />

      {/* ============================================================
          BOTS — grouped by mode
         ============================================================ */}
      {/* "other" is included so a registry row with an unexpected mode —
          a typo, a null, or a value added later — still renders somewhere
          instead of silently disappearing while counting toward the
          headline. */}
      {["live", "paper", "research", "other"].map(mode => (
        byMode[mode].length === 0 ? null : (
          <section key={mode} style={{ marginBottom: "var(--s-8)" }}>
            <SectionHeader count={byMode[mode].length}>{MODE_LABEL[mode]}</SectionHeader>
            {byMode[mode].map((b, i) => (
              <BotRow key={b.registry.bot_id} bot={b} index={i} total={byMode[mode].length} />
            ))}
          </section>
        )
      ))}

      {/* ============================================================
          EXPENSES — running cost picture vs. trade P&L
         ============================================================ */}
      <section style={{ marginBottom: "var(--s-8)" }}>
        <SectionHeader count={expenses.length}>Net P&amp;L &amp; expenses</SectionHeader>
        <ExpensesPanel expenses={expenses} trades={trades} />
      </section>

      {/* ============================================================
          RECENT RUNS
         ============================================================ */}
      <section style={{ marginBottom: "var(--s-8)" }}>
        <SectionHeader count={runs.length}>Recent runs</SectionHeader>
        {sectionErrs.runs ? (
          <ErrorHint>Could not load runs: {sectionErrs.runs}</ErrorHint>
        ) : runs.length === 0 ? (
          <EmptyHint>No runs recorded yet. They'll appear after the next bot cycle.</EmptyHint>
        ) : (
          <Table
            cols={["Bot", "Started", "Status", "Duration", "Trades", "Errors"]}
            colAlign={["left", "left", "left", "right", "right", "right"]}
          >
            {runs.map(r => (
              <tr key={r.id}>
                <Td>{displayName(regByBot[r.bot_id])}</Td>
                <Td mono>{fmtDate(r.started_at)}</Td>
                <Td><RunStatusBadge status={r.status} /></Td>
                <Td mono align="right">{fmtDur(durMs(r))}</Td>
                <Td mono align="right">{r.trade_count ?? 0}</Td>
                <Td mono align="right" alarm={(r.error_count ?? 0) > 0}>
                  {r.error_count ?? 0}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      {/* ============================================================
          OPEN POSITIONS + EXPOSURES DONUT
         ============================================================ */}
      <section style={{ marginBottom: "var(--s-8)" }}>
        <SectionHeader count={positions.length}>Open positions</SectionHeader>
        {sectionErrs.positions ? (
          <ErrorHint>Could not load positions: {sectionErrs.positions}</ErrorHint>
        ) : positions.length === 0 ? (
          <EmptyHint>No open positions across the league.</EmptyHint>
        ) : (
          <>
            <ExposuresPanel positions={positions} botsById={botsById} />
            <Table
              cols={["Bot", "Symbol", "Class", "Direction", "Qty", "Entry", "Notional", "Opened", "Paper"]}
              colAlign={["left","left","left","left","right","right","right","left","left"]}
            >
              {positions.map(p => {
                const dir = (p.metadata && p.metadata.direction) || "long";
                const dirLabel = dir.toUpperCase();
                return (
                  <tr key={p.id}>
                    <Td>{displayName(regByBot[p.bot_id])}</Td>
                    <Td mono>{p.symbol}</Td>
                    <Td mono>{p.asset_class}</Td>
                    <Td><DirectionBadge direction={dirLabel === "SHORT" ? "SHORT" : "LONG"} /></Td>
                    <Td mono align="right">
                      {p.quantity != null ? Number(p.quantity).toFixed(6).replace(/\.?0+$/, "") : "—"}
                    </Td>
                    <Td mono align="right">{fmtUsd(p.entry_price)}</Td>
                    <Td mono align="right">{fmtUsd(p.amount_usd)}</Td>
                    <Td mono>{fmtDate(p.entry_at)}</Td>
                    <Td mono>{p.is_paper ? "paper" : "live"}</Td>
                  </tr>
                );
              })}
            </Table>
          </>
        )}
      </section>

      {/* ============================================================
          RESEARCH SCORES — most recent score per (bot, symbol)
         ============================================================ */}
      <section style={{ marginBottom: "var(--s-8)" }}>
        {(() => {
          // Dedup: keep the most-recent row per (bot_id, symbol). scores
          // arrives sorted desc by scored_at so the first occurrence wins.
          const seen = new Set();
          const latest = [];
          for (const s of scores) {
            const k = `${s.bot_id}|${s.symbol}`;
            if (seen.has(k)) continue;
            seen.add(k);
            latest.push(s);
          }
          return (
            <>
              <SectionHeader count={latest.length}>Research scores</SectionHeader>
              {latest.length === 0 ? (
                <EmptyHint>No research scores yet. Will populate once a research bot writes here.</EmptyHint>
              ) : (
                <Table
                  cols={["Bot", "Symbol", "Class", "Composite", "Classification", "Scored", "Notes"]}
                  colAlign={["left","left","left","right","left","left","left"]}
                >
                  {latest.map(s => (
                    <tr key={s.id}>
                      <Td>{displayName(regByBot[s.bot_id])}</Td>
                      <Td mono>{s.symbol}</Td>
                      <Td mono>{s.asset_class}</Td>
                      <Td mono align="right">
                        {s.score != null ? Number(s.score).toFixed(2) : "—"}
                      </Td>
                      <Td><ClassificationBadge classification={s.classification} /></Td>
                      <Td mono>{fmtDate(s.scored_at)}</Td>
                      <Td>{s.notes || "—"}</Td>
                    </tr>
                  ))}
                </Table>
              )}
            </>
          );
        })()}
      </section>

      {/* ============================================================
          SIGNALS — recent bot_signals rows across every bot
         ============================================================ */}
      <section style={{ marginBottom: "var(--s-8)" }}>
        <SectionHeader count={signals.length}>Signals</SectionHeader>
        {signals.length === 0 ? (
          <EmptyHint>No signals yet. Research / watchlist bots write here when they identify ideas.</EmptyHint>
        ) : (
          <Table
            cols={["Bot", "Time", "Type", "Symbol", "Direction", "Confidence", "Rationale"]}
            colAlign={["left","left","left","left","left","right","left"]}
          >
            {signals.map(s => (
              <tr key={s.id}>
                <Td>{displayName(regByBot[s.bot_id])}</Td>
                <Td mono>{fmtDate(s.generated_at)}</Td>
                <Td mono>{s.signal_type}</Td>
                <Td mono>{s.symbol || "—"}</Td>
                <Td><DirectionBadge direction={s.direction} /></Td>
                <Td mono align="right">
                  {s.confidence != null ? Number(s.confidence).toFixed(2) : "—"}
                </Td>
                <Td>{s.rationale || "—"}</Td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      {/* ============================================================
          RECENT TRADES
         ============================================================ */}
      <section style={{ marginBottom: "var(--s-8)" }}>
        <SectionHeader count={trades.length}>Recent trades</SectionHeader>
        {sectionErrs.trades ? (
          <ErrorHint>Could not load trades: {sectionErrs.trades}</ErrorHint>
        ) : trades.length === 0 ? (
          <EmptyHint>No trades mirrored into the League yet. (Stock + crypto only push here when they actually place an order.)</EmptyHint>
        ) : (
          <Table
            cols={["Bot", "Time", "Symbol", "Side", "Class", "Qty", "Price", "Amount", "PnL", "Paper"]}
            colAlign={["left","left","left","left","left","right","right","right","right","left"]}
          >
            {trades.map(t => (
              <tr key={t.id}>
                <Td>{displayName(regByBot[t.bot_id])}</Td>
                <Td mono>{fmtDate(t.occurred_at)}</Td>
                <Td mono>{t.symbol}</Td>
                <Td><SideBadge side={t.side} /></Td>
                <Td mono>{t.asset_class}</Td>
                <Td mono align="right">{t.quantity != null ? Number(t.quantity).toFixed(6).replace(/\.?0+$/, "") : "—"}</Td>
                <Td mono align="right">{fmtUsd(t.price)}</Td>
                <Td mono align="right">{fmtUsd(t.amount_usd)}</Td>
                <Td mono align="right" alarm={t.pnl_usd != null && Number(t.pnl_usd) < 0}>
                  {t.pnl_usd != null ? fmtUsd(t.pnl_usd) : "—"}
                </Td>
                <Td mono>{t.is_paper ? "paper" : "—"}</Td>
              </tr>
            ))}
          </Table>
        )}
      </section>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Component pieces — match HealthDashboard's typographic style
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
        letterSpacing: "-0.01em",
        color: "var(--ink)",
      }}>
        {children}
      </h2>
      {count != null && (
        <span style={{
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--ink-4)",
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

function ModeBadge({ mode }) {
  const colors = {
    live:     { bg: "var(--ink)",  fg: "var(--paper)" },
    paper:    { bg: "var(--ink-5)",fg: "var(--ink)" },
    research: { bg: "var(--paper-dim)", fg: "var(--ink-3)" },
  }[mode] || { bg: "var(--ink-5)", fg: "var(--ink)" };
  return (
    <span style={{
      fontFamily: "var(--mono)",
      fontSize: 10,
      letterSpacing: "0.06em",
      textTransform: "uppercase",
      padding: "2px 6px",
      background: colors.bg,
      color: colors.fg,
    }}>
      {mode}
    </span>
  );
}

function RunStatusBadge({ status }) {
  const color = ({
    success: "var(--ok)",
    warning: "var(--warn)",
    failed:  "var(--bad)",
    timeout: "var(--bad)",
    running: "var(--ink-3)",
  })[status] || "var(--ink-4)";
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      gap: "var(--s-2)",
      fontFamily: "var(--mono)",
      fontSize: 11,
      color,
    }}>
      <span style={{
        display: "inline-block",
        width: 6, height: 6, borderRadius: "50%",
        background: color,
      }} />
      {status || "—"}
    </span>
  );
}

// ── Pending approvals ───────────────────────────────────────────────────────
//
// The only section on the page with write actions. Approve / Reject go
// through /api/approvals/[id] (server-side), authenticated with a shared
// operator token stored in sessionStorage. The token never reaches the
// browser code paths that fetch Supabase — only the route handler reads
// the service-role key.

const TOKEN_STORAGE_KEY = "league_approval_token";

function ApprovalsSection({ approvals, regByBot, onResolved, approvalsErr = null }) {
  const [token, setTokenState] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  // Load token from sessionStorage on mount.
  useEffect(() => {
    try {
      const t = sessionStorage.getItem(TOKEN_STORAGE_KEY) || "";
      setTokenState(t);
      setTokenInput(t);
    } catch {
      // sessionStorage unavailable — fine, user re-enters per page load
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persistToken = (val) => {
    setTokenState(val);
    setTokenInput(val);
    try {
      if (val) sessionStorage.setItem(TOKEN_STORAGE_KEY, val);
      else sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {}
  };

  const decide = async (approvalId, status, note) => {
    setError(null);
    if (!token) {
      setError("Set an operator token first.");
      return;
    }
    setBusyId(approvalId);
    try {
      const resp = await fetch(`/api/approvals/${approvalId}`, {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify({ status, note: note || null }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) {
        setError(data.error || `HTTP ${resp.status}`);
        return;
      }
      // Optimistic UX: clear local then re-fetch.
      if (onResolved) onResolved();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section style={{ marginBottom: "var(--s-8)" }}>
      <SectionHeader count={approvals.length}>Pending approvals</SectionHeader>

      {/* Operator token row — always visible so it's obvious where to set it */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--s-3)",
        paddingBottom: "var(--s-3)",
        marginBottom: "var(--s-5)",
        borderBottom: "1px solid var(--rule)",
        fontSize: 12,
      }}>
        <span style={{
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--ink-4)",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
        }}>
          Operator token
        </span>
        <input
          type="password"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder={token ? "•••••• (set this session)" : "Paste LEAGUE_APPROVAL_TOKEN"}
          style={{
            fontFamily: "var(--mono)",
            fontSize: 12,
            padding: "4px 6px",
            border: "1px solid var(--rule)",
            background: "var(--paper)",
            color: "var(--ink)",
            flex: "0 1 280px",
            minWidth: 0,
          }}
        />
        <button
          type="button"
          onClick={() => persistToken(tokenInput.trim())}
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            padding: "4px 10px",
            border: "1px solid var(--ink)",
            background: "var(--ink)",
            color: "var(--paper)",
            cursor: "pointer",
          }}
        >
          Save
        </button>
        {token && (
          <button
            type="button"
            onClick={() => persistToken("")}
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11,
              padding: "4px 10px",
              border: "1px solid var(--rule)",
              background: "var(--paper)",
              color: "var(--ink-3)",
              cursor: "pointer",
            }}
          >
            Clear
          </button>
        )}
        <span style={{
          marginLeft: "auto",
          fontSize: 11,
          color: "var(--ink-4)",
          fontFamily: "var(--mono)",
        }}>
          {token ? "stored in sessionStorage" : "not set"}
        </span>
      </div>

      {error && (
        <div style={{
          padding: "var(--s-3)",
          marginBottom: "var(--s-4)",
          border: "1px solid var(--bad)",
          color: "var(--bad)",
          fontFamily: "var(--mono)",
          fontSize: 12,
        }}>
          {error}
        </div>
      )}

      {approvalsErr ? (
        <ErrorHint>
          Could not load approvals: {approvalsErr}. There may be pending
          actions awaiting review that are not shown here.
        </ErrorHint>
      ) : approvals.length === 0 ? (
        <EmptyHint>No pending approvals. Bots write here when they propose an action that requires human review.</EmptyHint>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
          {approvals.map(a => (
            <ApprovalCard
              key={a.id}
              approval={a}
              regByBot={regByBot}
              onApprove={(note) => decide(a.id, "approved", note)}
              onReject={(note)  => decide(a.id, "rejected", note)}
              busy={busyId === a.id}
              tokenSet={!!token}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ApprovalCard({ approval, regByBot, onApprove, onReject, busy, tokenSet }) {
  const [note, setNote] = useState("");
  const a = approval;
  const reg = regByBot[a.bot_id];
  const requestedMs = a.requested_at ? Date.now() - new Date(a.requested_at).getTime() : null;

  return (
    <div className="stack-sm" style={{
      padding: "var(--s-5)",
      border: "1px solid var(--ink-5)",
      display: "grid",
      gridTemplateColumns: "minmax(220px, 1fr) 2fr minmax(220px, auto)",
      gap: "var(--s-5)",
      alignItems: "start",
    }}>
      {/* LEFT: bot + action header */}
      <div>
        <div style={{ fontSize: 11, color: "var(--ink-4)", fontFamily: "var(--mono)",
                      letterSpacing: "0.04em", textTransform: "uppercase",
                      marginBottom: 2 }}>
          {a.bot_id}
        </div>
        <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>
          {reg?.bot_name || a.bot_id}
        </div>
        <div style={{ marginTop: "var(--s-2)", display: "flex", gap: "var(--s-3)",
                      alignItems: "center" }}>
          <span style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            padding: "2px 6px",
            background: "var(--ink)",
            color: "var(--paper)",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}>
            {a.action}
          </span>
          {a.symbol && (
            <span style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 500 }}>
              {a.symbol}
            </span>
          )}
        </div>
        <div style={{ marginTop: "var(--s-2)", fontSize: 11, color: "var(--ink-4)",
                      fontFamily: "var(--mono)" }}>
          requested {requestedMs != null ? fmtAgo(requestedMs) : "—"}
        </div>
      </div>

      {/* MIDDLE: payload preview */}
      <div>
        <div style={{ fontSize: 11, color: "var(--ink-4)", fontFamily: "var(--mono)",
                      letterSpacing: "0.04em", textTransform: "uppercase",
                      marginBottom: "var(--s-2)" }}>
          Proposed payload
        </div>
        <pre style={{
          fontFamily: "var(--mono)",
          fontSize: 11,
          padding: "var(--s-3)",
          background: "var(--paper-dim)",
          border: "1px solid var(--rule)",
          margin: 0,
          maxHeight: 180,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          color: "var(--ink-2)",
        }}>
{JSON.stringify(a.payload ?? {}, null, 2)}
        </pre>
        {a.signal_id && (
          <div style={{ marginTop: "var(--s-2)", fontSize: 11, color: "var(--ink-4)",
                        fontFamily: "var(--mono)" }}>
            signal: {a.signal_id}
          </div>
        )}
      </div>

      {/* RIGHT: decision controls */}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)", minWidth: 220 }}>
        <textarea
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note (visible in audit log)"
          style={{
            fontFamily: "var(--mono)",
            fontSize: 12,
            padding: "6px 8px",
            border: "1px solid var(--rule)",
            background: "var(--paper)",
            color: "var(--ink)",
            resize: "vertical",
          }}
        />
        <div style={{ display: "flex", gap: "var(--s-2)" }}>
          <button
            type="button"
            onClick={() => onApprove(note)}
            disabled={busy || !tokenSet}
            style={{
              flex: 1,
              fontFamily: "var(--mono)",
              fontSize: 12,
              padding: "8px 10px",
              border: "1px solid var(--ok)",
              background: busy ? "var(--paper-dim)" : "var(--ok)",
              color: busy ? "var(--ink-3)" : "var(--paper)",
              cursor: (busy || !tokenSet) ? "not-allowed" : "pointer",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
            title={tokenSet ? "" : "Set operator token first"}
          >
            {busy ? "..." : "Approve"}
          </button>
          <button
            type="button"
            onClick={() => onReject(note)}
            disabled={busy || !tokenSet}
            style={{
              flex: 1,
              fontFamily: "var(--mono)",
              fontSize: 12,
              padding: "8px 10px",
              border: "1px solid var(--bad)",
              background: "var(--paper)",
              color: busy ? "var(--ink-3)" : "var(--bad)",
              cursor: (busy || !tokenSet) ? "not-allowed" : "pointer",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
            title={tokenSet ? "" : "Set operator token first"}
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Exposures (donut + legend) ───────────────────────────────────────────────
//
// Pure inline SVG so we don't pull a charting library. Aggregates open
// positions by asset_class, sums amount_usd, renders a single donut and a
// legend. If a position lacks amount_usd, it's skipped (no zero-slice).

const ASSET_CLASS_COLOR = {
  equity:         "var(--ok)",
  etf:            "var(--ink-2)",
  crypto:         "var(--warn)",
  bond:           "var(--ink-3)",
  option:         "var(--bad)",
  option_spread:  "var(--ink-4)",
};

/** Is this position backed by a bot that is currently working?
 *
 *  Added 2026-07-25 (M8). `bot_positions` is queried with
 *  `.eq("status","open")` and no bound on `entry_at`. If a bot dies
 *  mid-position, or is killed without its rows being reconciled, the row
 *  stays `open` forever and keeps contributing to the exposures headline —
 *  presented as live risk you currently hold. Same shape as the dead crypto
 *  symbol that rendered a full "live" panel for months: nothing checks.
 *
 *  A position is "unconfirmed" when its owning bot is retired, unhealthy,
 *  or absent from the registry entirely. */
function positionIsConfirmed(pos, botByIdMap) {
  const bot = botByIdMap[pos.bot_id];
  if (!bot) return false;                                   // orphaned row
  if (["killed", "disabled"].includes(bot.registry.status)) return false;
  if (["bad", "idle"].includes(bot.derived.bucket)) return false;
  return true;
}

function ExposuresPanel({ positions, botsById = {} }) {
  // LIVE ONLY in the donut (fixed 2026-07-25). This used to sum every open
  // position — paper and live together — into one "Notional $X" headline, so
  // a figure like $8,400 could be $400 of real exposure and $8,000 of
  // simulation. The per-row table showed is_paper; the aggregate erased it.
  //
  // Paper notional is still computed and shown as a separate subtotal, so
  // nothing is hidden — it just isn't added to the number that reads as
  // "money at risk".
  const byClass = new Map();
  let total = 0;
  let paperTotal = 0;
  let paperCount = 0;
  let unconfirmedTotal = 0;
  let unconfirmedCount = 0;

  for (const p of positions) {
    const amt = Number(p.amount_usd || 0);
    if (!Number.isFinite(amt) || amt <= 0) continue;
    if (p.is_paper) {
      paperTotal += amt;
      paperCount++;
      continue;
    }
    // Positions whose bot is retired, unhealthy, or missing are counted
    // separately — they may be stale rows rather than live exposure, and
    // folding them into the headline overstates what you actually hold.
    if (!positionIsConfirmed(p, botsById)) {
      unconfirmedTotal += amt;
      unconfirmedCount++;
      continue;
    }
    const cls = p.asset_class || "unknown";
    byClass.set(cls, (byClass.get(cls) || 0) + amt);
    total += amt;
  }
  // Stable ordering: largest slice first
  const slices = [...byClass.entries()]
    .map(([asset_class, amount]) => ({
      asset_class,
      amount,
      fraction: total > 0 ? amount / total : 0,
      color: ASSET_CLASS_COLOR[asset_class] || "var(--ink-4)",
    }))
    .sort((a, b) => b.amount - a.amount);

  if (total <= 0) {
    return (
      <div style={{
        fontSize: 12,
        color: "var(--ink-4)",
        marginBottom: "var(--s-5)",
        fontFamily: "var(--mono)",
      }}>
        {paperTotal > 0
          ? `No live notional. ${fmtUsd(paperTotal)} in ${paperCount} paper position${paperCount === 1 ? "" : "s"}.`
          : "No notional in open positions yet."}
      </div>
    );
  }

  // Donut math
  const r = 38;
  const C = 2 * Math.PI * r;

  let acc = 0;
  const segments = slices.map((s, i) => {
    const dash = s.fraction * C;
    const node = (
      <circle
        key={s.asset_class}
        cx="50" cy="50" r={r}
        fill="none"
        stroke={s.color}
        strokeWidth="14"
        strokeDasharray={`${dash} ${C - dash}`}
        strokeDashoffset={-acc}
        transform="rotate(-90 50 50)"
      />
    );
    acc += dash;
    return node;
  });

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "120px 1fr",
      gap: "var(--s-5)",
      alignItems: "center",
      paddingBottom: "var(--s-5)",
      marginBottom: "var(--s-5)",
      borderBottom: "1px solid var(--rule)",
    }}>
      <div style={{ position: "relative", width: 120, height: 120 }}>
        <svg viewBox="0 0 100 100" width="120" height="120">
          {/* Track ring (faint) */}
          <circle cx="50" cy="50" r={r} fill="none"
                  stroke="var(--rule)" strokeWidth="14" />
          {segments}
        </svg>
        <div style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "var(--mono)",
          color: "var(--ink-3)",
        }}>
          <div style={{ fontSize: 9, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--ink-4)" }}>
            Live notional
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }} className="tabular">
            ${total.toFixed(0)}
          </div>
        </div>
      </div>

      {/* Everything the donut deliberately excludes, stated rather than
          silently dropped. */}
      {(paperCount > 0 || unconfirmedCount > 0) && (
        <div style={{
          fontSize: 11,
          color: "var(--ink-3)",
          fontFamily: "var(--mono)",
          marginBottom: "var(--s-4)",
          lineHeight: 1.6,
        }}>
          {paperCount > 0 && (
            <div>
              Excluded: {fmtUsd(paperTotal)} across {paperCount} paper
              position{paperCount === 1 ? "" : "s"} (simulated).
            </div>
          )}
          {unconfirmedCount > 0 && (
            <div style={{ color: "var(--warn)" }}>
              Excluded: {fmtUsd(unconfirmedTotal)} across {unconfirmedCount}{" "}
              unconfirmed position{unconfirmedCount === 1 ? "" : "s"} — owning bot
              is retired, unhealthy, or missing from the registry. These rows may
              be stale rather than live exposure; reconcile against the broker.
            </div>
          )}
        </div>
      )}

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
        gap: "var(--s-3) var(--s-5)",
      }}>
        {slices.map(s => (
          <div key={s.asset_class} style={{
            display: "flex",
            alignItems: "baseline",
            gap: "var(--s-2)",
            fontSize: 12,
          }}>
            <span style={{
              display: "inline-block",
              width: 8, height: 8,
              background: s.color,
              flexShrink: 0,
            }} />
            <span style={{
              fontFamily: "var(--mono)",
              fontSize: 11,
              letterSpacing: "0.02em",
              textTransform: "uppercase",
              color: "var(--ink-3)",
            }}>
              {s.asset_class}
            </span>
            <span style={{
              fontFamily: "var(--mono)",
              fontSize: 12,
              color: "var(--ink)",
              marginLeft: "auto",
            }} className="tabular">
              ${s.amount.toFixed(0)}
            </span>
            <span style={{
              fontFamily: "var(--mono)",
              fontSize: 10,
              color: "var(--ink-4)",
              minWidth: 36,
              textAlign: "right",
            }} className="tabular">
              {(s.fraction * 100).toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  ExpensesPanel — current-month cost picture + net P&L
//
//  Combines two sources:
//    1. Manual entries in bot_expenses (subscriptions, hosting, API credits)
//    2. Auto-derived trading fees from bot_trades.fees_usd (current month)
//
//  Shows:
//    - Realized trade P&L this month (from bot_trades.pnl_usd)
//    - Total expenses this month (manual + trading fees)
//    - Net = P&L − expenses
//    - Breakdown by category
//
//  Notes:
//    - "This month" uses UTC for consistency with bot_trades.occurred_at and
//      bot_expenses.period (YYYY-MM).
//    - Annual entries (period = 'YYYY') are spread evenly across the year for
//      the monthly view, so a $12/yr entry shows as $1 this month.
//    - We only see TRADES_LIMIT recent trades, so the "trade P&L this month"
//      is approximate if you have more than that many trades in-month. For
//      our scale that's not yet a concern.
// ─────────────────────────────────────────────────────────────────────────────

const EXPENSE_CATEGORY_LABEL = {
  fly_hosting:             "Fly hosting",
  anthropic_api:           "Anthropic API",
  claude_subscription:     "Claude subscription",
  perplexity_subscription: "Perplexity subscription",
  openclaw_hosting:        "OpenClaw hosting",
  public_subscription:     "Public subscription",
  data_feed:               "Data feed",
  trading_fees:            "Trading fees",  // virtual category derived from bot_trades
  other:                   "Other",
};

function ExpensesPanel({ expenses, trades }) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const currentMonth = `${yyyy}-${mm}`;
  const currentYear  = String(yyyy);

  // Manual expenses for the current month.
  //
  // RECURRING SUPPORT (M9, added 2026-07-25). Previously only two period
  // formats contributed: an exact `YYYY-MM` match, or `YYYY` divided by 12.
  // A monthly subscription entered once — say Claude Pro at period
  // "2026-05" — therefore contributed ZERO in June onward. Expenses drifted
  // downward every month unless someone remembered to add a row, and
  // because `net = pnl - expenses`, "Net contribution" drifted *upward*.
  // The dashboard got progressively more flattering with no signal it was
  // doing so.
  //
  // A row now counts toward the current month when `recurring` is true and
  // the month falls within [period, period_end ?? forever]. Those two
  // columns do not exist on bot_expenses yet — see
  // supabase/migrations/*_bot_expenses_recurring.sql in the League repo.
  // Until they are added, `e.recurring` is undefined and behaviour is
  // exactly as before, so this is safe to ship ahead of the migration.
  const manualByCategory = new Map();
  let staleOneOffCount = 0;

  for (const e of expenses) {
    const amt = Number(e.amount_usd || 0);
    if (!Number.isFinite(amt) || amt <= 0) continue;

    let monthShare = 0;
    const isMonthlyPeriod = /^\d{4}-\d{2}$/.test(e.period || "");

    if (e.period === currentMonth) {
      monthShare = amt;
    } else if (e.period === currentYear) {
      monthShare = amt / 12;                        // annual, spread evenly
    } else if (e.recurring && isMonthlyPeriod) {
      // Recurs from `period` until `period_end` (inclusive) or indefinitely.
      const startsBefore = e.period <= currentMonth;
      const endsAfter    = !e.period_end || e.period_end >= currentMonth;
      if (startsBefore && endsAfter) monthShare = amt;
    } else if (isMonthlyPeriod && e.period < currentMonth && e.recurring === undefined) {
      // A past monthly row on a schema without the `recurring` column. We
      // cannot tell whether it was a one-off or an unmarked subscription,
      // so we do NOT count it — but we surface that it exists rather than
      // letting the total quietly under-report.
      staleOneOffCount++;
    }

    if (monthShare <= 0) continue;
    const cat = e.category || "other";
    manualByCategory.set(cat, (manualByCategory.get(cat) || 0) + monthShare);
  }

  // Trading fees + P&L from bot_trades occurring in current month (UTC).
  //
  // LIVE AND PAPER ARE KEPT SEPARATE (fixed 2026-07-25). This loop used to
  // sum every row into one "Trade P&L" figure and then compute
  // `net = pnl - expenses`, which subtracted REAL dollars (Fly hosting,
  // Anthropic API, Claude subscription) from SIMULATED gains. The resulting
  // "Net contribution" was not a quantity that exists. Paper P&L is now
  // reported alongside, never netted against real cash.
  //
  // Phantom rows are excluded entirely. Per the project convention,
  // bot_trades rows with metadata.phantom = true are non-strategic
  // artefacts — 28 such rows exist on etf_rotation_v1 from a state-reset
  // bug — and counting them corrupts both P&L and fees.
  const isPhantom = (t) =>
    t?.metadata?.phantom === true || t?.metadata?.phantom === "true";

  let tradingFees = 0;   // live only — this is real money out
  let realizedPnl = 0;   // live only
  let paperPnl    = 0;   // simulated, reported separately
  let phantomSkipped = 0;

  for (const t of trades) {
    if (!t.occurred_at) continue;
    // Parse rather than string-slice so a non-UTC timestamp can't misbucket
    // trades at a month boundary.
    const d = new Date(t.occurred_at);
    if (Number.isNaN(d.getTime())) continue;
    const occurredMonth =
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (occurredMonth !== currentMonth) continue;

    if (isPhantom(t)) { phantomSkipped++; continue; }

    const fee = Number(t.fees_usd || 0);
    const pnl = Number(t.pnl_usd || 0);

    if (t.is_paper) {
      if (Number.isFinite(pnl)) paperPnl += pnl;
      continue; // simulated fills incur no real fee
    }
    if (Number.isFinite(fee)) tradingFees += fee;
    if (Number.isFinite(pnl)) realizedPnl += pnl;
  }

  if (tradingFees > 0) {
    // ADD, don't overwrite — a bot_expenses row may already use this
    // category this month, and `.set` silently discarded it.
    manualByCategory.set(
      "trading_fees",
      (manualByCategory.get("trading_fees") || 0) + tradingFees
    );
  }

  const totalExpenses = [...manualByCategory.values()].reduce((s, x) => s + x, 0);
  // Net is deliberately live-only. Mixing paper gains in here is what made
  // the old figure meaningless.
  const net = realizedPnl - totalExpenses;

  const rows = [...manualByCategory.entries()]
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);

  if (rows.length === 0 && realizedPnl === 0 && paperPnl === 0) {
    return (
      <EmptyHint>
        No expenses or realized P&amp;L recorded for {currentMonth} yet. Add rows
        to bot_expenses or wait for the first closed trade.
      </EmptyHint>
    );
  }

  return (
    <div className="stack-sm" style={{
      display: "grid",
      gridTemplateColumns: "repeat(4, 1fr)",
      gap: "var(--s-5)",
      alignItems: "stretch",
      marginBottom: "var(--s-5)",
    }}>
      <Stat label={`Live P&L (${currentMonth})`} value={fmtUsd(realizedPnl)}
            alarm={realizedPnl < 0} />
      <Stat label={`Paper P&L (${currentMonth})`} value={fmtUsd(paperPnl)}
            alarm={false} />
      <Stat label={`Expenses (${currentMonth})`} value={fmtUsd(totalExpenses)}
            alarm={false} />
      <Stat label="Net (live only)" value={fmtUsd(net)}
            alarm={net < 0} />

      {phantomSkipped > 0 && (
        <div style={{
          gridColumn: "1 / -1",
          fontSize: 11,
          color: "var(--ink-3)",
          marginTop: "calc(-1 * var(--s-3))",
        }}>
          {phantomSkipped} phantom trade{phantomSkipped === 1 ? "" : "s"} excluded
          (metadata.phantom — non-strategic rows from a state-reset bug).
        </div>
      )}

      {staleOneOffCount > 0 && (
        <div style={{
          gridColumn: "1 / -1",
          fontSize: 11,
          color: "var(--warn)",
          marginTop: "calc(-1 * var(--s-3))",
          lineHeight: 1.6,
        }}>
          {staleOneOffCount} past expense row{staleOneOffCount === 1 ? "" : "s"} not
          counted this month. `bot_expenses` has no `recurring` column, so a
          subscription entered once cannot be distinguished from a one-off charge —
          and expenses under-report until someone adds a new row each month. Run the
          `bot_expenses_recurring` migration and mark the subscriptions.
        </div>
      )}

      <div style={{
        gridColumn: "1 / -1",
        borderTop: "1px solid var(--rule)",
        paddingTop: "var(--s-4)",
      }}>
        <div style={{
          fontSize: 10, color: "var(--ink-4)", letterSpacing: "0.04em",
          textTransform: "uppercase", marginBottom: "var(--s-3)",
        }}>
          Expense breakdown — {currentMonth}
        </div>
        {rows.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--ink-4)", fontFamily: "var(--mono)" }}>
            No expenses recorded for this month.
          </div>
        ) : (
          <table style={{
            width: "100%",
            borderCollapse: "collapse",
            fontFamily: "var(--mono)",
            fontSize: 12,
          }}>
            <tbody>
              {rows.map(r => (
                <tr key={r.category}>
                  <td style={{ padding: "4px 0", color: "var(--ink-2)" }}>
                    {EXPENSE_CATEGORY_LABEL[r.category] || r.category}
                  </td>
                  <td style={{ padding: "4px 0", textAlign: "right", color: "var(--ink-3)" }}>
                    {fmtUsd(r.amount)}
                  </td>
                </tr>
              ))}
              <tr style={{ borderTop: "1px solid var(--rule)" }}>
                <td style={{ padding: "6px 0 0", color: "var(--ink)", fontWeight: 600 }}>
                  Total
                </td>
                <td style={{ padding: "6px 0 0", textAlign: "right", color: "var(--ink)", fontWeight: 600 }}>
                  {fmtUsd(totalExpenses)}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function DirectionBadge({ direction }) {
  const map = {
    LONG:    { color: "var(--ok)",   label: "LONG" },
    SHORT:   { color: "var(--bad)",  label: "SHORT" },
    NEUTRAL: { color: "var(--ink-3)", label: "NEUTRAL" },
    EXIT:    { color: "var(--warn)", label: "EXIT" },
  };
  const c = map[direction] || { color: "var(--ink-4)", label: direction || "—" };
  return (
    <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: c.color, fontWeight: 600 }}>
      {c.label}
    </span>
  );
}

function ClassificationBadge({ classification }) {
  const map = {
    keep_active:     { color: "var(--ok)",   label: "keep_active" },
    reduce_priority: { color: "var(--warn)", label: "reduce_priority" },
    paper_only:      { color: "var(--ink-3)", label: "paper_only" },
    remove:          { color: "var(--bad)",  label: "remove" },
  };
  const c = map[classification] || { color: "var(--ink-4)", label: classification || "—" };
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      gap: "var(--s-2)",
      fontFamily: "var(--mono)",
      fontSize: 11,
      color: c.color,
    }}>
      <span style={{
        display: "inline-block",
        width: 6, height: 6, borderRadius: "50%",
        background: c.color,
      }} />
      {c.label}
    </span>
  );
}

function SideBadge({ side }) {
  const color = side === "BUY" || side === "COVER" ? "var(--ok)"
              : side === "SELL" || side === "SHORT" ? "var(--bad)"
              : "var(--ink-3)";
  return (
    <span style={{ fontFamily: "var(--mono)", fontSize: 11, color, fontWeight: 600 }}>
      {side}
    </span>
  );
}

function BotRow({ bot, index, total }) {
  const r = bot.registry;
  const s = bot.status;
  const d = bot.derived;
  const last = s?.last_heartbeat_at;
  const lastMs = last ? Date.now() - new Date(last).getTime() : null;
  const isLast = index === total - 1;
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "minmax(220px, 1fr) 2fr minmax(160px, auto)",
      gap: "var(--s-7)",
      padding: "var(--s-5) 0",
      borderBottom: isLast ? "none" : "1px solid var(--rule)",
    }} className="fade-up stack-sm">

      {/* LEFT: name + mode + status dot */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)" }}>
          <StatusDot status={d.bucket} />
          <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>
            {r.bot_name}
          </span>
        </div>
        <div style={{
          marginTop: "var(--s-2)",
          display: "flex", alignItems: "center", gap: "var(--s-3)",
        }}>
          <ModeBadge mode={r.mode} />
          <span style={{
            fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-4)",
            letterSpacing: "0.04em",
          }}>
            {r.bot_id}
          </span>
        </div>
        <div style={{
          marginTop: "var(--s-2)",
          fontSize: 11, color: "var(--ink-4)",
          fontFamily: "var(--mono)",
        }}>
          {r.bot_type}
          {r.status === "killed" && " · killed"}
          {r.status === "disabled" && " · disabled"}
        </div>
      </div>

      {/* MIDDLE: reason + stats */}
      <div>
        <div style={{ fontSize: 14, color: "var(--ink-2)", lineHeight: 1.5, marginBottom: "var(--s-5)" }}>
          <strong style={{ fontWeight: 600 }}>{d.label}.</strong> {d.reason}
        </div>
        <div className="stack-sm" style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: "var(--s-5)",
          paddingTop: "var(--s-4)",
          borderTop: "1px solid var(--rule)",
        }}>
          <Stat label="Last heartbeat" value={last ? fmtAgo(lastMs) : "Never"} />
          <Stat label="Last run"       value={s?.last_run_status || "—"} />
          <Stat label="Max order"      value={r.max_order_usd != null ? `$${Number(r.max_order_usd).toFixed(0)}` : "—"} />
          <Stat label="Daily trades"   value={r.max_daily_trades > 0 ? `${r.max_daily_trades}` : "unlimited"} />
        </div>
        {s?.last_error_msg && (
          <div style={{
            marginTop: "var(--s-3)",
            paddingTop: "var(--s-3)",
            borderTop: "1px solid var(--rule)",
            fontFamily: "var(--mono)", fontSize: 11, color: "var(--bad)",
          }}>
            {String(s.last_error_msg).slice(0, 160)}
          </div>
        )}
      </div>

      {/* RIGHT: capability flags */}
      <div style={{
        display: "flex", flexDirection: "column",
        gap: "var(--s-2)", alignItems: "flex-end", textAlign: "right",
        fontSize: 11, fontFamily: "var(--mono)", color: "var(--ink-3)",
      }}>
        <div>orders: {r.can_place_orders ? "yes" : "no"}</div>
        <div>approval: {r.manual_approval_required ? "required" : "auto"}</div>
        {Array.isArray(r.allowed_instruments) && r.allowed_instruments.length > 0 && (
          <div style={{ color: "var(--ink-4)" }}>
            {r.allowed_instruments.length} symbol{r.allowed_instruments.length === 1 ? "" : "s"}
          </div>
        )}
        {r.repo_url && (
          <a href={r.repo_url} target="_blank" rel="noopener noreferrer" className="tnav"
             style={{ fontSize: 11 }}>
            repo →
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
        fontFamily: "var(--mono)",
        fontSize: 13,
        color: alarm ? "var(--bad)" : "var(--ink)",
        fontWeight: 500,
      }} className="tabular">
        {value}
      </div>
    </div>
  );
}

function Table({ cols, colAlign = [], children }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{
        width: "100%",
        borderCollapse: "collapse",
        fontSize: 13,
      }}>
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th key={c} style={{
                textAlign: colAlign[i] || "left",
                padding: "var(--s-2) var(--s-3)",
                borderBottom: "1px solid var(--rule)",
                fontSize: 11,
                fontWeight: 500,
                color: "var(--ink-4)",
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                fontFamily: "var(--mono)",
              }}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Td({ children, mono, align = "left", alarm }) {
  return (
    <td style={{
      padding: "var(--s-2) var(--s-3)",
      borderBottom: "1px solid var(--rule)",
      textAlign: align,
      fontFamily: mono ? "var(--mono)" : "var(--sans)",
      color: alarm ? "var(--bad)" : "var(--ink-2)",
      fontSize: 13,
      verticalAlign: "top",
      whiteSpace: "nowrap",
    }} className={mono ? "tabular" : ""}>
      {children}
    </td>
  );
}

function EmptyHint({ children }) {
  return (
    <div style={{
      fontSize: 13,
      color: "var(--ink-4)",
      fontStyle: "italic",
      padding: "var(--s-5) 0",
    }}>
      {children}
    </div>
  );
}

/** Section-level failure state.
 *
 *  Distinct from EmptyHint on purpose (2026-07-25). Every fetch setter uses
 *  `|| []`, so a failed query previously became an empty array and the
 *  section asserted absence — "No pending approvals." — when the truth was
 *  "I could not find out". For an approvals queue that is the difference
 *  between "nothing needs you" and "an order is waiting and you cannot see
 *  it". */
function ErrorHint({ children }) {
  return (
    <div style={{
      fontSize: 13,
      color: "var(--bad)",
      padding: "var(--s-5) 0",
      fontFamily: "var(--mono)",
    }}>
      {children}
    </div>
  );
}
