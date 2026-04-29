"use client";

import { useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";

// ── Bot configuration: schema differs per bot ────────────────────────────────
const BOTS = [
  {
    id:   "crypto",
    name: "CRYPTO",
    callsign: "CRYPTO-01",
    repo: "Crypto_Trading_Bot",
    repoUrl: process.env.NEXT_PUBLIC_CRYPTO_REPO_URL || "",
    dashboardUrl: process.env.NEXT_PUBLIC_CRYPTO_DASHBOARD_URL || "",
    supabaseUrl: process.env.NEXT_PUBLIC_CRYPTO_SUPABASE_URL,
    supabaseKey: process.env.NEXT_PUBLIC_CRYPTO_SUPABASE_ANON_KEY,
    cols: { runStarted: "started_at", runEnded: "ended_at", errorTs: "created_at" },
    expectedMinutes: 30,
    marketHoursOnly: false,
  },
  {
    id:   "stock",
    name: "STOCK",
    callsign: "EQUITY-01",
    repo: "Stock_Trading_Bot",
    repoUrl: process.env.NEXT_PUBLIC_STOCK_REPO_URL || "",
    dashboardUrl: process.env.NEXT_PUBLIC_STOCK_DASHBOARD_URL || "",
    supabaseUrl: process.env.NEXT_PUBLIC_STOCK_SUPABASE_URL,
    supabaseKey: process.env.NEXT_PUBLIC_STOCK_SUPABASE_ANON_KEY,
    cols: { runStarted: "start_time",  runEnded: "end_time",  errorTs: "timestamp" },
    expectedMinutes: 90,
    marketHoursOnly: true,
  },
];

// ── Utilities ────────────────────────────────────────────────────────────────
const fmtAgo = (ms) => {
  if (ms == null) return "—";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
};

const fmtTime = (iso) => {
  if (!iso) return "--:--:--";
  return new Date(iso).toISOString().slice(11, 19);
};

const fmtDate = (iso) => {
  if (!iso) return "----";
  return new Date(iso).toISOString().slice(5, 10).replace("-", ".");
};

const inMarketHours = () => {
  const now = new Date();
  const utcDay = now.getUTCDay();
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (utcDay === 0 || utcDay === 6) return false;
  return utcMin >= 13 * 60 + 30 && utcMin <= 21 * 60;
};

// ── Status determination ─────────────────────────────────────────────────────
function deriveStatus(bot, runs, errors) {
  const reasons = [];
  let status = "HEALTHY";

  if (bot.marketHoursOnly && !inMarketHours()) {
    return {
      status: "STANDBY",
      reasons: ["MARKET CLOSED · OBSERVATION SUSPENDED"],
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

  if (minSince == null) {
    status = "DOWN";
    reasons.push("NO RUN HISTORY");
  } else if (minSince > bot.expectedMinutes * 2) {
    status = "DOWN";
    reasons.push(`LAST RUN ${Math.floor(minSince)}M AGO · EXPECTED ≤${bot.expectedMinutes}M`);
  } else if (minSince > bot.expectedMinutes) {
    status = "DEGRADED";
    reasons.push(`LAST RUN ${Math.floor(minSince)}M AGO · EXPECTED ≤${bot.expectedMinutes}M`);
  }

  // Errors in last 6h
  const sixHrAgo = Date.now() - 6 * 3600 * 1000;
  const recentErrors = errors.filter(e => {
    const t = new Date(e[bot.cols.errorTs]).getTime();
    return t >= sixHrAgo;
  });
  const errCount = recentErrors.length;

  if (errCount >= 3) {
    status = "DOWN";
    reasons.push(`${errCount} ERRORS / 6H`);
  } else if (errCount >= 1 && status === "HEALTHY") {
    status = "DEGRADED";
    reasons.push(`${errCount} ERROR${errCount > 1 ? "S" : ""} / 6H`);
  }

  // Stuck runs
  const stuckThreshold = Date.now() - 30 * 60 * 1000;
  const stuck = runs.filter(r =>
    r.status === "running" &&
    new Date(r[bot.cols.runStarted]).getTime() < stuckThreshold
  );

  if (stuck.length > 0) {
    status = "DOWN";
    reasons.push(`${stuck.length} STUCK RUN${stuck.length > 1 ? "S" : ""} > 30M`);
  }

  if (reasons.length === 0) reasons.push("NOMINAL");

  return {
    status,
    reasons,
    lastRun,
    msSinceRun: msSince,
    errors6h: errCount,
    stuckCount: stuck.length,
  };
}

const STATUS_META = {
  HEALTHY:  { color: "var(--nuclear)", bg: "var(--nuclear-dim)", glyph: "▲" },
  DEGRADED: { color: "var(--warning)", bg: "var(--warning-dim)", glyph: "◆" },
  DOWN:     { color: "var(--alarm)",   bg: "var(--alarm-dim)",   glyph: "✕" },
  STANDBY:  { color: "var(--foglight)", bg: "var(--rust)",       glyph: "○" },
};

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function HealthDashboard() {
  const [data, setData]       = useState({});  // { crypto: {runs,errors}, stock: {...} }
  const [loading, setLoading] = useState(true);
  const [lastFetch, setLastFetch] = useState(null);

  const fetchAll = async () => {
    const result = {};
    for (const bot of BOTS) {
      if (!bot.supabaseUrl || !bot.supabaseKey) {
        result[bot.id] = { runs: [], errors: [], err: "MISSING ENV CONFIG" };
        continue;
      }
      try {
        const sb = createClient(bot.supabaseUrl, bot.supabaseKey);
        const [r, e] = await Promise.all([
          sb.from("bot_runs").select("*").order(bot.cols.runStarted, { ascending: false }).limit(50),
          sb.from("bot_errors").select("*").order(bot.cols.errorTs, { ascending: false }).limit(20),
        ]);
        result[bot.id] = { runs: r.data || [], errors: e.data || [], err: r.error?.message || e.error?.message || null };
      } catch (err) {
        result[bot.id] = { runs: [], errors: [], err: String(err.message || err) };
      }
    }
    setData(result);
    setLoading(false);
    setLastFetch(new Date());
  };

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, 60000);
    return () => clearInterval(id);
  }, []);

  if (loading) {
    return (
      <main style={{ padding: "4rem 1.5rem", textAlign: "center", color: "var(--foglight)", fontFamily: "var(--mono)" }}>
        <div style={{ fontSize: 10, letterSpacing: "0.3em" }} className="blink">
          [ INITIALIZING TELEMETRY · STAND BY ]
        </div>
      </main>
    );
  }

  // Compute statuses
  const statuses = BOTS.map(bot => ({
    bot,
    payload: data[bot.id] || { runs: [], errors: [] },
    status:  deriveStatus(bot, data[bot.id]?.runs || [], data[bot.id]?.errors || []),
  }));

  const overall = statuses.some(s => s.status.status === "DOWN") ? "DOWN" :
                  statuses.some(s => s.status.status === "DEGRADED") ? "DEGRADED" :
                  "HEALTHY";

  return (
    <main style={{ padding: "1.5rem", maxWidth: 1400, margin: "0 auto" }}>

      {/* ============================================================
          OVERALL SYSTEM STATUS BAND
         ============================================================ */}
      <section style={{
        background: "var(--gunmetal)",
        border: `1px solid ${overall === "HEALTHY" ? "#1a3a2a" : overall === "DEGRADED" ? "#3a2e10" : "#4a1818"}`,
        padding: "1.5rem 1.5rem 1.25rem",
        marginBottom: 32,
        position: "relative",
        overflow: "hidden",
      }} className="fade-in">
        {/* corner brackets */}
        <CornerBrackets />

        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 24 }}>
          <div>
            <div style={{ fontSize: 10, color: "var(--foglight)", letterSpacing: "0.25em" }}>
              ▶ AGGREGATE.SYSTEM.STATUS
            </div>
            <div style={{
              fontFamily: "var(--display)",
              fontSize: "clamp(3.5rem, 10vw, 6.5rem)",
              fontWeight: 900,
              lineHeight: 0.9,
              letterSpacing: "-0.02em",
              color: STATUS_META[overall].color,
              marginTop: 8,
              textShadow: `0 0 40px ${STATUS_META[overall].color}33`,
            }} className={overall === "DOWN" ? "flicker" : ""}>
              {overall === "HEALTHY" ? "ALL.SYSTEMS.GO" :
               overall === "DEGRADED" ? "DEGRADED.PERFORMANCE" :
               "ALERT.STATE"}
            </div>
            <div style={{
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--foglight)",
              letterSpacing: "0.15em",
              marginTop: 12,
              textTransform: "uppercase",
            }}>
              {statuses.map(s => `${s.bot.callsign}: ${s.status.status}`).join(" · ")}
            </div>
          </div>

          <div style={{ textAlign: "right" }}>
            <StatusOrb status={overall} large />
            <div style={{
              fontSize: 9,
              color: "var(--foglight)",
              letterSpacing: "0.2em",
              marginTop: 12,
              textTransform: "uppercase",
            }}>
              SCAN.{lastFetch ? fmtTime(lastFetch.toISOString()) : "--:--:--"}
            </div>
          </div>
        </div>
      </section>

      {/* ============================================================
          PER-BOT STATUS PANELS
         ============================================================ */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
        gap: 24,
        marginBottom: 32,
      }}>
        {statuses.map(({ bot, status, payload }, i) => (
          <BotPanel key={bot.id} bot={bot} status={status} payload={payload} delay={i * 0.1} />
        ))}
      </div>

      {/* ============================================================
          RECENT RUNS TABLE PER BOT
         ============================================================ */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
        gap: 24,
        marginBottom: 32,
      }}>
        {statuses.map(({ bot, payload }) => (
          <RunsPanel key={bot.id} bot={bot} runs={payload.runs} />
        ))}
      </div>

      {/* ============================================================
          ERRORS PANEL
         ============================================================ */}
      <ErrorsPanel statuses={statuses} />

    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

function CornerBrackets() {
  const style = (x, y) => ({
    position: "absolute",
    width: 18, height: 18,
    [y]: -1, [x]: -1,
    border: "1px solid #6b6e75",
    [`border${y === "top" ? "Bottom" : "Top"}`]: "none",
    [`border${x === "left" ? "Right" : "Left"}`]: "none",
    pointerEvents: "none",
  });
  return (
    <>
      <span style={style("left", "top")} />
      <span style={style("right", "top")} />
      <span style={style("left", "bottom")} />
      <span style={style("right", "bottom")} />
    </>
  );
}

function StatusOrb({ status, large }) {
  const meta = STATUS_META[status];
  const size = large ? 24 : 12;
  const cls = status === "HEALTHY" ? "pulse-nuclear" : status === "DOWN" ? "pulse-alarm" : "";
  return (
    <span style={{
      display: "inline-block",
      width: size, height: size,
      background: meta.color,
      borderRadius: "50%",
      boxShadow: `0 0 ${size}px ${meta.color}66`,
    }} className={cls} />
  );
}

function BotPanel({ bot, status, payload, delay }) {
  const meta = STATUS_META[status.status];
  const hasError = payload.err;

  return (
    <section
      style={{
        background: "var(--gunmetal)",
        border: `1px solid var(--rust)`,
        borderLeft: `3px solid ${meta.color}`,
        padding: "1.25rem 1.5rem",
        position: "relative",
        animationDelay: `${delay}s`,
      }}
      className="fade-in"
    >
      <CornerBrackets />

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 10, color: "var(--foglight)", letterSpacing: "0.25em" }}>
            ▶ {bot.callsign}
          </div>
          <h2 style={{
            fontFamily: "var(--display)",
            fontSize: "2.4rem",
            fontWeight: 900,
            lineHeight: 1,
            color: "var(--paper)",
            letterSpacing: "-0.01em",
            marginTop: 4,
          }}>
            {bot.name}.BOT
          </h2>
        </div>
        <StatusOrb status={status.status} />
      </div>

      {/* The big status word */}
      <div style={{
        fontFamily: "var(--display)",
        fontSize: "clamp(2.5rem, 6vw, 4rem)",
        fontWeight: 800,
        lineHeight: 0.95,
        color: meta.color,
        letterSpacing: "-0.01em",
        textShadow: `0 0 30px ${meta.color}33`,
        marginBottom: 16,
      }}>
        {status.status}
      </div>

      {/* Reasons line */}
      <div style={{
        fontSize: 10,
        color: "var(--foglight)",
        letterSpacing: "0.1em",
        marginBottom: 20,
        minHeight: 14,
      }}>
        {status.reasons.map((r, i) => (
          <div key={i}>// {r}</div>
        ))}
      </div>

      {/* Stats grid */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: "12px 24px",
        paddingTop: 16,
        borderTop: "1px dashed var(--rust)",
      }}>
        <Stat label="LAST.RUN" value={status.lastRun ? fmtAgo(status.msSinceRun) : "NEVER"} />
        <Stat label="ERR.6H" value={String(status.errors6h)} highlight={status.errors6h > 0 ? "var(--warning)" : null} />
        <Stat label="STUCK" value={String(status.stuckCount)} highlight={status.stuckCount > 0 ? "var(--alarm)" : null} />
        <Stat label="EXPECTED" value={`≤${bot.expectedMinutes}m`} />
      </div>

      {/* Connection error notice */}
      {hasError && (
        <div style={{
          marginTop: 16,
          padding: "8px 12px",
          background: "var(--alarm-dim)",
          fontSize: 9,
          letterSpacing: "0.1em",
          color: "var(--alarm)",
        }}>
          ⚠ DATA.LINK.ERROR: {String(payload.err).slice(0, 80)}
        </div>
      )}

      {/* Action footer */}
      <div style={{
        display: "flex",
        gap: 12,
        marginTop: 18,
        paddingTop: 16,
        borderTop: "1px solid var(--rust)",
        fontSize: 10,
        letterSpacing: "0.15em",
      }}>
        {bot.dashboardUrl && (
          <a href={bot.dashboardUrl} target="_blank" rel="noopener" style={linkStyle}>
            DASHBOARD ↗
          </a>
        )}
        {bot.repoUrl && (
          <a href={bot.repoUrl} target="_blank" rel="noopener" style={linkStyle}>
            GITHUB ↗
          </a>
        )}
      </div>
    </section>
  );
}

const linkStyle = {
  color: "var(--bone)",
  textDecoration: "none",
  borderBottom: "1px dashed var(--foglight)",
  paddingBottom: 2,
  transition: "color 0.2s, border-color 0.2s",
};

function Stat({ label, value, highlight }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: "var(--foglight)", letterSpacing: "0.2em" }}>{label}</div>
      <div style={{
        fontSize: 18,
        fontWeight: 500,
        color: highlight || "var(--paper)",
        marginTop: 4,
        fontVariantNumeric: "tabular-nums",
      }}>{value}</div>
    </div>
  );
}

function RunsPanel({ bot, runs }) {
  const recent = runs.slice(0, 12);
  return (
    <section style={{
      background: "var(--gunmetal)",
      border: "1px solid var(--rust)",
      padding: "1.25rem 1.5rem",
      position: "relative",
    }} className="fade-in">
      <CornerBrackets />

      <div style={{
        fontSize: 10,
        color: "var(--foglight)",
        letterSpacing: "0.25em",
        marginBottom: 16,
      }}>
        ▶ {bot.callsign} / RUN.HISTORY [LAST 12]
      </div>

      {recent.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--inert)", fontStyle: "italic", padding: "20px 0" }}>
          NO RUNS RECORDED
        </div>
      ) : (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
          {recent.map((run, i) => {
            const ts = run[bot.cols.runStarted];
            const status = (run.status || "").toUpperCase();
            const color = status === "COMPLETED" ? "var(--nuclear)" :
                          status === "RUNNING"   ? "var(--warning)" :
                          status === "ERROR"     ? "var(--alarm)" :
                          "var(--foglight)";
            return (
              <div key={i} style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr auto",
                gap: 14,
                padding: "6px 0",
                borderBottom: i < recent.length - 1 ? "1px dashed #1f2024" : "none",
                alignItems: "center",
              }}>
                <span style={{ color: "var(--foglight)", fontSize: 10 }}>
                  {fmtDate(ts)}.{fmtTime(ts).slice(0, 5)}
                </span>
                <span style={{ color, letterSpacing: "0.1em", fontSize: 10 }}>
                  {status || "??"}
                </span>
                <span style={{ color: "var(--inert)", fontSize: 10, fontVariantNumeric: "tabular-nums" }}>
                  {fmtAgo(Date.now() - new Date(ts).getTime())}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ErrorsPanel({ statuses }) {
  const allErrors = statuses.flatMap(s =>
    (s.payload.errors || []).slice(0, 10).map(e => ({
      ...e,
      _bot: s.bot,
      _ts: e[s.bot.cols.errorTs],
    }))
  ).sort((a, b) => new Date(b._ts) - new Date(a._ts)).slice(0, 15);

  return (
    <section style={{
      background: "var(--gunmetal)",
      border: "1px solid var(--rust)",
      padding: "1.25rem 1.5rem",
      position: "relative",
      marginBottom: 24,
    }} className="fade-in">
      <CornerBrackets />

      <div style={{
        fontSize: 10,
        color: "var(--foglight)",
        letterSpacing: "0.25em",
        marginBottom: 16,
        display: "flex",
        justifyContent: "space-between",
      }}>
        <span>▶ ERROR.LOG / AGGREGATE [LAST 15]</span>
        <span style={{ color: allErrors.length > 0 ? "var(--alarm)" : "var(--inert)" }}>
          [{allErrors.length} RECORDS]
        </span>
      </div>

      {allErrors.length === 0 ? (
        <div style={{
          fontSize: 11,
          color: "var(--nuclear-dim)",
          padding: "20px 0",
          letterSpacing: "0.15em",
        }}>
          ▲ NO ERRORS LOGGED · CHANNEL CLEAR
        </div>
      ) : (
        <div style={{ fontFamily: "var(--mono)", fontSize: 10 }}>
          {allErrors.map((e, i) => {
            const errMessage = e.message || e.error || "(no message)";
            const context = e.context || e.stage || e.error_type || "";
            return (
              <div key={i} style={{
                padding: "10px 0",
                borderBottom: i < allErrors.length - 1 ? "1px dashed #1f2024" : "none",
                display: "grid",
                gridTemplateColumns: "auto auto 1fr",
                gap: 14,
                alignItems: "start",
              }}>
                <span style={{ color: "var(--foglight)" }}>
                  {fmtDate(e._ts)}.{fmtTime(e._ts).slice(0, 5)}
                </span>
                <span style={{ color: "var(--alarm)", letterSpacing: "0.1em" }}>
                  [{e._bot.callsign}]
                </span>
                <div style={{ color: "var(--bone)" }}>
                  {context && (
                    <span style={{ color: "var(--foglight)", marginRight: 6 }}>{context}:</span>
                  )}
                  <span>{String(errMessage).slice(0, 200)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}