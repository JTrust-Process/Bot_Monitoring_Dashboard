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

// Modes that are NOT live → render with a less-loud accent.
const MODE_LABEL = {
  live:     "Live",
  paper:    "Paper",
  research: "Research",
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

const fmtPct = (n) => {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${(v * (Math.abs(v) > 1 ? 1 : 100)).toFixed(2)}%`;
};

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

function deriveBotStatus(registryRow, statusRow) {
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

  // Bucket from explicit health if available, then layer the age threshold on top.
  let bucket = HEALTH_BUCKET[statusRow.health] || "idle";
  let label = statusRow.health ? statusRow.health[0].toUpperCase() + statusRow.health.slice(1) : "Unknown";
  let reason = "—";

  if (ageMin == null) {
    bucket = "idle"; label = "No heartbeat"; reason = "Last heartbeat unknown.";
  } else if (ageMin > HEARTBEAT_DOWN_MIN) {
    bucket = "bad"; label = "Stale"; reason = `Last heartbeat ${Math.floor(ageMin)} minutes ago.`;
  } else if (ageMin > HEARTBEAT_DEGRADED_MIN) {
    if (bucket !== "bad") { bucket = "warn"; label = "Degraded"; reason = `Last heartbeat ${Math.floor(ageMin)} minutes ago.`; }
  } else if (statusRow.last_run_status === "failed" || statusRow.last_run_status === "timeout") {
    bucket = "bad"; label = "Last run failed"; reason = statusRow.last_error_msg || "Most recent run ended in failure.";
  } else if (statusRow.last_run_status === "warning") {
    bucket = bucket === "bad" ? "bad" : "warn"; label = "Warning"; reason = "Most recent run completed with warnings.";
  } else if (statusRow.last_run_status === "success") {
    bucket = "ok"; label = "Healthy"; reason = `Last run succeeded ${fmtAgo(Date.now() - lastHb)}.`;
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
      const [reg, st, rn, tr, sc] = await Promise.all([
        sb.from("bot_registry").select("*").order("bot_id", { ascending: true }),
        sb.from("bot_status").select("*"),
        sb.from("bot_runs").select("*").order("started_at", { ascending: false }).limit(RUNS_LIMIT),
        sb.from("bot_trades").select("*").order("occurred_at", { ascending: false }).limit(TRADES_LIMIT),
        sb.from("bot_research_scores").select("*").order("scored_at", { ascending: false }).limit(SCORES_LIMIT),
      ]);
      setRegistry(reg.data || []);
      setStatuses(st.data || []);
      setRuns(rn.data || []);
      setTrades(tr.data || []);
      setScores(sc.data || []);
      setFetchErr(
        reg.error?.message || st.error?.message || rn.error?.message ||
        tr.error?.message  || sc.error?.message || null
      );
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

  // Derived per-bot rows
  const bots = registry.map(r => ({
    registry: r,
    status:   statusByBot[r.bot_id] || null,
    derived:  deriveBotStatus(r, statusByBot[r.bot_id]),
  }));

  const overall = bots.length === 0 ? "idle"
                : bots.some(b => b.derived.bucket === "bad")  ? "bad"
                : bots.some(b => b.derived.bucket === "warn") ? "warn"
                : bots.every(b => b.derived.bucket === "idle") ? "idle"
                : "ok";

  const overallSentence = {
    ok:   `${bots.length} bot${bots.length === 1 ? "" : "s"} registered, all healthy.`,
    warn: `${bots.length} bot${bots.length === 1 ? "" : "s"} registered, some degraded.`,
    bad:  "A bot in the league requires attention.",
    idle: bots.length === 0 ? "No bots in registry yet." : "All bots idle.",
  }[overall];

  // Buckets for the dashboard's "live / paper / research" grouping
  const byMode = {
    live:     bots.filter(b => b.registry.mode === "live"),
    paper:    bots.filter(b => b.registry.mode === "paper"),
    research: bots.filter(b => b.registry.mode === "research"),
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
            Set NEXT_PUBLIC_LEAGUE_SUPABASE_URL and NEXT_PUBLIC_LEAGUE_SUPABASE_ANON_KEY in .env.local
            (and Vercel project settings) to enable.
          </div>
        )}
      </section>

      {/* ============================================================
          BOTS — grouped by mode
         ============================================================ */}
      {["live", "paper", "research"].map(mode => (
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
          RECENT RUNS
         ============================================================ */}
      <section style={{ marginBottom: "var(--s-8)" }}>
        <SectionHeader count={runs.length}>Recent runs</SectionHeader>
        {runs.length === 0 ? (
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
          RECENT TRADES
         ============================================================ */}
      <section style={{ marginBottom: "var(--s-8)" }}>
        <SectionHeader count={trades.length}>Recent trades</SectionHeader>
        {trades.length === 0 ? (
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
    }} className="fade-up">

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
        <div style={{
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
