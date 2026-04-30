"use client";

import { useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";

// ── Bot configuration: schema differs per bot ────────────────────────────────
const BOTS = [
  {
    id:   "crypto",
    name: "CRYPTO",
    callsign: "UNIT.A",
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
    callsign: "UNIT.B",
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
  if (ms == null) return "----";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<01M";
  if (m < 60) return `${String(m).padStart(2, "0")}M`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${String(h).padStart(2, "0")}H${String(m % 60).padStart(2, "0")}M`;
  return `${Math.floor(h / 24)}D${String(h % 24).padStart(2, "0")}H`;
};

const fmtTime = (iso) => iso ? new Date(iso).toISOString().slice(11, 19) : "--:--:--";
const fmtDate = (iso) => iso ? new Date(iso).toISOString().slice(5, 10).replace("-", ".") : "----";

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
      // Health score 0-100 for needle
      healthScore: 50,
    };
  }

  const lastRun = runs[0] || null;
  const lastTs  = lastRun?.[bot.cols.runStarted] || null;
  const msSince = lastTs ? Date.now() - new Date(lastTs).getTime() : null;
  const minSince = msSince != null ? msSince / 60000 : null;

  let healthScore = 100;

  if (minSince == null) {
    status = "DOWN";
    reasons.push("NO RUN HISTORY ON RECORD");
    healthScore = 0;
  } else if (minSince > bot.expectedMinutes * 2) {
    status = "DOWN";
    reasons.push(`LAST RUN ${Math.floor(minSince)}M AGO · EXPECTED ≤${bot.expectedMinutes}M`);
    healthScore = Math.max(0, 30 - (minSince - bot.expectedMinutes * 2));
  } else if (minSince > bot.expectedMinutes) {
    status = "DEGRADED";
    reasons.push(`LAST RUN ${Math.floor(minSince)}M AGO · EXPECTED ≤${bot.expectedMinutes}M`);
    healthScore = 60 - (minSince - bot.expectedMinutes) / bot.expectedMinutes * 30;
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
    reasons.push(`${errCount} ERRORS IN 6H WINDOW`);
    healthScore = Math.min(healthScore, 20);
  } else if (errCount >= 1 && status === "HEALTHY") {
    status = "DEGRADED";
    reasons.push(`${errCount} ERROR${errCount > 1 ? "S" : ""} IN 6H WINDOW`);
    healthScore = Math.min(healthScore, 65);
  }

  // Stuck runs
  const stuckThreshold = Date.now() - 30 * 60 * 1000;
  const stuck = runs.filter(r =>
    r.status === "running" &&
    new Date(r[bot.cols.runStarted]).getTime() < stuckThreshold
  );

  if (stuck.length > 0) {
    status = "DOWN";
    reasons.push(`${stuck.length} STUCK CYCLE${stuck.length > 1 ? "S" : ""} > 30M`);
    healthScore = Math.min(healthScore, 15);
  }

  if (reasons.length === 0) reasons.push("ALL PARAMETERS NOMINAL");

  return {
    status,
    reasons,
    lastRun,
    msSinceRun: msSince,
    errors6h: errCount,
    stuckCount: stuck.length,
    healthScore: Math.max(0, Math.min(100, healthScore)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function HealthDashboard() {
  const [data, setData]       = useState({});
  const [loading, setLoading] = useState(true);
  const [lastFetch, setLastFetch] = useState(null);

  const fetchAll = async () => {
    const result = {};
    for (const bot of BOTS) {
      if (!bot.supabaseUrl || !bot.supabaseKey) {
        result[bot.id] = { runs: [], errors: [], err: "NO LINK CONFIG" };
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
      <main style={{ padding: "6rem 2rem", textAlign: "center" }}>
        <div style={{
          fontFamily: "var(--stencil)",
          fontSize: 14,
          letterSpacing: "0.4em",
          color: "var(--label-silver)",
          opacity: 0.6,
        }}>
          ◌ POWERING ON SYSTEMS · STAND BY
        </div>
      </main>
    );
  }

  const statuses = BOTS.map(bot => ({
    bot,
    payload: data[bot.id] || { runs: [], errors: [] },
    status:  deriveStatus(bot, data[bot.id]?.runs || [], data[bot.id]?.errors || []),
  }));

  return (
    <main style={{ padding: "2rem", maxWidth: 1400, margin: "0 auto" }}>

      {/* AGGREGATE STATUS RACK */}
      <AggregateRack statuses={statuses} lastFetch={lastFetch} />

      {/* PER-BOT INSTRUMENT PANELS */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(540px, 1fr))",
        gap: 24,
        marginBottom: 32,
      }}>
        {statuses.map((s, i) => (
          <InstrumentPanel key={s.bot.id} {...s} delay={i * 0.15} />
        ))}
      </div>

      {/* RECENT RUNS — looks like a printed log roll */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
        gap: 24,
        marginBottom: 32,
      }}>
        {statuses.map(s => <CycleLog key={s.bot.id} bot={s.bot} runs={s.payload.runs} />)}
      </div>

      {/* AGGREGATE FAULT LOG */}
      <FaultLog statuses={statuses} />

    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  AGGREGATE RACK — top banner with master indicator lamps
// ─────────────────────────────────────────────────────────────────────────────

function AggregateRack({ statuses, lastFetch }) {
  const overall = statuses.some(s => s.status.status === "DOWN")     ? "DOWN"     :
                  statuses.some(s => s.status.status === "DEGRADED") ? "DEGRADED" :
                  statuses.every(s => s.status.status === "STANDBY") ? "STANDBY"  :
                  "HEALTHY";

  const messages = {
    HEALTHY:  "ALL.SYSTEMS.OPERATIONAL",
    DEGRADED: "DEGRADED.PERFORMANCE",
    DOWN:     "FAULT.STATE.DETECTED",
    STANDBY:  "AWAITING.MARKET.OPEN",
  };

  return (
    <Panel style={{ padding: "2rem 2rem 1.75rem", marginBottom: 32 }}>
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "stretch",
        gap: 32,
        position: "relative",
      }}>
        {/* Engraved master message */}
        <div>
          <Engraving size={9} color="var(--label-silver)" style={{ opacity: 0.5, marginBottom: 8 }}>
            ◍ MASTER STATUS
          </Engraving>
          <div style={{
            fontFamily: "var(--stencil)",
            fontSize: "clamp(2.25rem, 5.5vw, 3.75rem)",
            letterSpacing: "0.04em",
            color: "var(--label-white)",
            textShadow: "0 2px 0 rgba(0,0,0,0.7), 0 -1px 0 rgba(255,255,255,0.04)",
            lineHeight: 1,
          }}>
            {messages[overall]}
          </div>
          <div style={{
            marginTop: 16,
            display: "flex",
            gap: 16,
            fontFamily: "var(--label)",
            fontSize: 10,
            letterSpacing: "0.2em",
            color: "var(--label-silver)",
            textTransform: "uppercase",
            opacity: 0.7,
          }}>
            {statuses.map(s => (
              <div key={s.bot.id}>
                {s.bot.callsign}: <span style={{ color: getBulbColor(s.status.status) }}>{s.status.status}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Indicator lamp bank */}
        <div style={{ display: "flex", gap: 18, alignItems: "center" }}>
          <IndicatorLamp label="OK"     color="green"  active={overall === "HEALTHY"} />
          <IndicatorLamp label="WARN"   color="amber"  active={overall === "DEGRADED"} />
          <IndicatorLamp label="FAULT"  color="red"    active={overall === "DOWN"} flicker />
          <IndicatorLamp label="HOLD"   color="blue"   active={overall === "STANDBY"} />
        </div>

        {/* Scan timestamp readout */}
        <div style={{ alignSelf: "flex-end", textAlign: "right" }}>
          <Engraving size={8} color="var(--label-silver)" style={{ opacity: 0.5 }}>
            LAST SCAN
          </Engraving>
          <SegmentDisplay
            value={lastFetch ? fmtTime(lastFetch.toISOString()) : "--:--:--"}
            color="amber"
            width={120}
          />
        </div>
      </div>
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  INSTRUMENT PANEL — one per bot
// ─────────────────────────────────────────────────────────────────────────────

function InstrumentPanel({ bot, status, payload, delay }) {
  const hasError = payload.err;
  const bulbColor = getBulbColor(status.status);

  return (
    <Panel
      className="fade-in"
      style={{ animationDelay: `${delay}s`, padding: 0 }}
    >
      {/* Top label strip — like a Dymo tape */}
      <div style={{
        background: "linear-gradient(180deg, #14171a, #1a1d1f)",
        borderBottom: "1px solid #0a0c0e",
        padding: "10px 24px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}>
        <Engraving size={9} color="var(--label-silver)" style={{ opacity: 0.7 }}>
          ◍ {bot.callsign} / {bot.name} TRADING SYSTEM
        </Engraving>
        <Engraving size={8} color="var(--label-silver)" style={{ opacity: 0.4 }}>
          MK-I REV.B
        </Engraving>
      </div>

      <div style={{ padding: "1.75rem 1.75rem 1.5rem" }}>

        {/* Top section: gauge + indicator lamps */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: 28,
          marginBottom: 28,
        }}>
          <Gauge
            score={status.healthScore}
            status={status.status}
            label="SYSTEM HEALTH"
          />

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Engraving size={9} color="var(--label-silver)" style={{ opacity: 0.5 }}>
              ◍ STATUS INDICATORS
            </Engraving>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              <IndicatorLamp label="OK"    color="green" active={status.status === "HEALTHY"} small />
              <IndicatorLamp label="WARN"  color="amber" active={status.status === "DEGRADED"} small />
              <IndicatorLamp label="FAULT" color="red"   active={status.status === "DOWN"} flicker small />
              <IndicatorLamp label="HOLD"  color="blue"  active={status.status === "STANDBY"} small />
            </div>

            {/* Reasons strip — looks like a printed advisory */}
            <div style={{
              marginTop: 8,
              padding: "10px 12px",
              background: "var(--bezel-black)",
              border: "1px solid #0a0c0e",
              boxShadow: "inset 0 1px 3px rgba(0,0,0,0.6)",
              fontFamily: "var(--led)",
              fontSize: 11,
              color: bulbColor,
              minHeight: 60,
              letterSpacing: "0.06em",
              textShadow: `0 0 6px ${bulbColor}55`,
            }}>
              {status.reasons.map((r, i) => (
                <div key={i} style={{ marginBottom: i < status.reasons.length - 1 ? 4 : 0 }}>
                  {">"} {r}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Bottom section: segmented displays */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 14,
          paddingTop: 18,
          borderTop: "1px solid #0a0c0e",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
        }}>
          <Readout label="LAST CYCLE"   value={status.lastRun ? fmtAgo(status.msSinceRun) : "NEVER"} color="amber" />
          <Readout label="ERR / 6H"     value={String(status.errors6h).padStart(3, "0")}    color={status.errors6h > 0 ? "amber" : "green"} />
          <Readout label="STUCK"        value={String(status.stuckCount).padStart(3, "0")}  color={status.stuckCount > 0 ? "red" : "green"} />
          <Readout label="EXPECTED"     value={`<${String(bot.expectedMinutes).padStart(3, "0")}M`} color="green" />
        </div>

        {/* Connection error placard */}
        {hasError && (
          <div style={{
            marginTop: 14,
            padding: "8px 12px",
            background: "linear-gradient(180deg, #2a1416, #1a0c0e)",
            border: "1px solid #4a1818",
            borderLeft: "3px solid #ef4444",
            fontFamily: "var(--led)",
            fontSize: 10,
            color: "var(--bulb-red)",
            letterSpacing: "0.08em",
          }}>
            ⚠ TELEMETRY LINK ERROR: {String(payload.err).slice(0, 100)}
          </div>
        )}

        {/* Action footer — like nameplate at bottom */}
        <div style={{
          marginTop: 18,
          paddingTop: 14,
          borderTop: "1px solid #0a0c0e",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
          display: "flex",
          gap: 10,
        }}>
          {bot.dashboardUrl && (
            <a href={bot.dashboardUrl} target="_blank" rel="noopener noreferrer" className="metal-button">
              ▸ DASHBOARD
            </a>
          )}
          {bot.repoUrl && (
            <a href={bot.repoUrl} target="_blank" rel="noopener noreferrer" className="metal-button">
              ◊ SOURCE
            </a>
          )}
        </div>
      </div>
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  CYCLE LOG — recent runs as printer-roll output
// ─────────────────────────────────────────────────────────────────────────────

function CycleLog({ bot, runs }) {
  const recent = runs.slice(0, 12);
  return (
    <Panel style={{ padding: 0 }}>
      <div style={{
        background: "linear-gradient(180deg, #14171a, #1a1d1f)",
        borderBottom: "1px solid #0a0c0e",
        padding: "10px 20px",
      }}>
        <Engraving size={9} color="var(--label-silver)" style={{ opacity: 0.7 }}>
          ◍ {bot.callsign} / CYCLE.LOG · LAST 12
        </Engraving>
      </div>

      <div style={{ padding: "16px 20px" }}>
        {recent.length === 0 ? (
          <div style={{
            padding: "20px 0",
            fontSize: 11,
            color: "#5a5e64",
            fontStyle: "italic",
            letterSpacing: "0.1em",
          }}>
            NO CYCLES RECORDED
          </div>
        ) : (
          <div style={{ fontFamily: "var(--led)", fontSize: 11 }}>
            {recent.map((run, i) => {
              const ts = run[bot.cols.runStarted];
              const status = (run.status || "").toUpperCase();
              const color = status === "COMPLETED" ? "var(--bulb-green)" :
                            status === "RUNNING"   ? "var(--bulb-amber)" :
                            status === "ERROR"     ? "var(--bulb-red)"   :
                            "#5a5e64";
              return (
                <div key={i} style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr auto",
                  gap: 14,
                  padding: "5px 0",
                  borderBottom: i < recent.length - 1 ? "1px dashed #1a1d1f" : "none",
                  alignItems: "center",
                  letterSpacing: "0.05em",
                }}>
                  <span style={{ color: "#5a5e64", fontSize: 10 }}>
                    {fmtDate(ts)}·{fmtTime(ts).slice(0, 5)}
                  </span>
                  <span style={{ color, fontSize: 10, textShadow: `0 0 6px ${color}66` }}>
                    {status || "??"}
                  </span>
                  <span style={{ color: "#5a5e64", fontSize: 10 }}>
                    {fmtAgo(Date.now() - new Date(ts).getTime())}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  FAULT LOG — aggregate errors across both bots
// ─────────────────────────────────────────────────────────────────────────────

function FaultLog({ statuses }) {
  const allErrors = statuses.flatMap(s =>
    (s.payload.errors || []).slice(0, 10).map(e => ({
      ...e,
      _bot: s.bot,
      _ts: e[s.bot.cols.errorTs],
    }))
  ).sort((a, b) => new Date(b._ts) - new Date(a._ts)).slice(0, 15);

  return (
    <Panel style={{ padding: 0 }}>
      <div style={{
        background: "linear-gradient(180deg, #14171a, #1a1d1f)",
        borderBottom: "1px solid #0a0c0e",
        padding: "10px 20px",
        display: "flex",
        justifyContent: "space-between",
      }}>
        <Engraving size={9} color="var(--label-silver)" style={{ opacity: 0.7 }}>
          ◍ FAULT LOG · AGGREGATE · LAST 15
        </Engraving>
        <Engraving size={9} color={allErrors.length > 0 ? "var(--bulb-red)" : "#5a5e64"}>
          [{String(allErrors.length).padStart(3, "0")} RECORDS]
        </Engraving>
      </div>

      <div style={{ padding: "16px 20px" }}>
        {allErrors.length === 0 ? (
          <div style={{
            padding: "12px 0",
            fontFamily: "var(--led)",
            fontSize: 11,
            color: "var(--bulb-green)",
            letterSpacing: "0.1em",
            textShadow: "0 0 6px rgba(74, 222, 128, 0.4)",
          }}>
            ▲ NO FAULTS LOGGED · CHANNEL CLEAR
          </div>
        ) : (
          <div style={{ fontFamily: "var(--led)", fontSize: 10 }}>
            {allErrors.map((e, i) => {
              const errMessage = e.message || e.error || "(no message)";
              const context = e.context || e.stage || e.error_type || "";
              return (
                <div key={i} style={{
                  padding: "8px 0",
                  borderBottom: i < allErrors.length - 1 ? "1px dashed #1a1d1f" : "none",
                  display: "grid",
                  gridTemplateColumns: "auto auto 1fr",
                  gap: 14,
                  alignItems: "start",
                  letterSpacing: "0.04em",
                }}>
                  <span style={{ color: "#5a5e64" }}>
                    {fmtDate(e._ts)}·{fmtTime(e._ts).slice(0, 5)}
                  </span>
                  <span style={{ color: "var(--bulb-red)", textShadow: "0 0 4px #ef444477" }}>
                    [{e._bot.callsign}]
                  </span>
                  <div style={{ color: "var(--label-silver)" }}>
                    {context && <span style={{ color: "#7a7e84", marginRight: 6 }}>{context}:</span>}
                    <span>{String(errMessage).slice(0, 200)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────

function Panel({ children, style, className }) {
  return (
    <div
      className={className}
      style={{
        background:
          "linear-gradient(180deg, #2a2e32 0%, #1a1d1f 100%)",
        border: "1px solid #0a0c0e",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.05), inset 0 -1px 0 rgba(0,0,0,0.6), 0 4px 12px rgba(0,0,0,0.6)",
        position: "relative",
        ...style,
      }}
    >
      {/* Four corner screws */}
      <Screw style={{ top: 7,    left: 7    }} />
      <Screw style={{ top: 7,    right: 7   }} />
      <Screw style={{ bottom: 7, left: 7    }} />
      <Screw style={{ bottom: 7, right: 7   }} />
      {children}
    </div>
  );
}

function Screw({ style }) {
  return (
    <div style={{
      position: "absolute",
      width: 10, height: 10,
      borderRadius: "50%",
      background:
        "radial-gradient(circle at 35% 30%, #6a6e74 0%, #3a3e44 45%, #14171a 100%)",
      boxShadow:
        "inset 0 -1px 1px rgba(0,0,0,0.6), 0 1px 1px rgba(0,0,0,0.5)",
      pointerEvents: "none",
      ...style,
    }}>
      {/* Phillips slot */}
      <span style={{
        position: "absolute",
        inset: 2,
        background:
          "linear-gradient(0deg, transparent 47%, rgba(0,0,0,0.7) 48%, rgba(0,0,0,0.7) 52%, transparent 53%), " +
          "linear-gradient(90deg, transparent 47%, rgba(0,0,0,0.7) 48%, rgba(0,0,0,0.7) 52%, transparent 53%)",
      }} />
    </div>
  );
}

function Engraving({ children, size = 10, color = "var(--label-silver)", style }) {
  return (
    <div style={{
      fontFamily: "var(--label)",
      fontSize: size,
      letterSpacing: "0.25em",
      color,
      textTransform: "uppercase",
      fontWeight: 500,
      ...style,
    }}>
      {children}
    </div>
  );
}

function getBulbColor(status) {
  return status === "HEALTHY"  ? "var(--bulb-green)" :
         status === "DEGRADED" ? "var(--bulb-amber)" :
         status === "DOWN"     ? "var(--bulb-red)"   :
                                 "var(--bulb-blue)";
}

// ── Indicator lamp ──────────────────────────────────────────────────────────
function IndicatorLamp({ label, color, active, flicker, small }) {
  const hot  = `var(--bulb-${color})`;
  const glow = `var(--bulb-${color}-glow)`;
  const size = small ? 14 : 22;

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 6,
    }}>
      <div style={{ position: "relative", width: size + 8, height: size + 8 }}>
        {/* Bezel ring */}
        <div style={{
          position: "absolute", inset: 0,
          borderRadius: "50%",
          background:
            "radial-gradient(circle at 30% 30%, #4a4e54 0%, #2a2e32 60%, #14171a 100%)",
          boxShadow: "inset 0 1px 1px rgba(0,0,0,0.7), 0 1px 1px rgba(0,0,0,0.6)",
        }} />
        {/* Lens */}
        <div
          className={active && color === "red" && flicker ? "lamp-flicker-red" : (active ? "lamp-pulse" : "")}
          style={{
            position: "absolute",
            inset: 4,
            borderRadius: "50%",
            background: active
              ? `radial-gradient(circle at 30% 30%, ${hot}ee 0%, ${glow} 50%, ${hot}77 100%)`
              : `radial-gradient(circle at 30% 30%, ${hot}33 0%, var(--bulb-off) 80%)`,
            boxShadow: active
              ? `0 0 ${size}px ${hot}aa, 0 0 ${size * 2}px ${hot}55, inset 0 -1px 2px rgba(0,0,0,0.5)`
              : "inset 0 -1px 2px rgba(0,0,0,0.7)",
            transition: "all 0.3s",
          }}
        />
      </div>
      {label && (
        <Engraving size={7} style={{ opacity: 0.6, color: "var(--label-silver)" }}>
          {label}
        </Engraving>
      )}
    </div>
  );
}

// ── Segmented LED display ────────────────────────────────────────────────────
function SegmentDisplay({ value, color = "amber", width = 100 }) {
  const colorMap = {
    amber: "#ff7e3d",
    green: "#4ade80",
    red:   "#ef4444",
  };
  const c = colorMap[color] || colorMap.amber;
  return (
    <div style={{
      background: "var(--bezel-black)",
      border: "1px solid #14171a",
      boxShadow: "inset 0 2px 4px rgba(0,0,0,0.8), 0 1px 0 rgba(255,255,255,0.05)",
      padding: "6px 12px",
      fontFamily: "var(--led)",
      fontSize: 16,
      letterSpacing: "0.1em",
      color: c,
      textShadow: `0 0 8px ${c}88`,
      minWidth: width,
      textAlign: "center",
      marginTop: 6,
    }}>
      {value}
    </div>
  );
}

// ── Readout: small segment display with engraved label above ────────────────
function Readout({ label, value, color }) {
  return (
    <div>
      <Engraving size={7} color="var(--label-silver)" style={{ opacity: 0.55, marginBottom: 4 }}>
        {label}
      </Engraving>
      <SegmentDisplay value={value} color={color} width={80} />
    </div>
  );
}

// ── ANALOG GAUGE — the centerpiece ───────────────────────────────────────────
function Gauge({ score, status, label }) {
  // Convert 0-100 score to needle angle (-130deg=left, 0=top, 130deg=right)
  const angle = -130 + (score / 100) * 260;

  // Status color tints the needle highlight
  const tint = status === "DOWN"     ? "#ef4444" :
               status === "DEGRADED" ? "#fbbf24" :
               status === "STANDBY"  ? "#60a5fa" :
                                       "#4ade80";

  return (
    <div style={{
      width: 220,
      height: 220,
      position: "relative",
      flexShrink: 0,
    }}>
      {/* Outer bezel */}
      <div style={{
        position: "absolute", inset: 0,
        borderRadius: "50%",
        background:
          "radial-gradient(circle at 30% 30%, #5a5e64 0%, #2a2e32 50%, #0a0c0e 100%)",
        boxShadow:
          "inset 0 2px 4px rgba(0,0,0,0.6), 0 4px 12px rgba(0,0,0,0.7)",
      }} />

      {/* Inner face */}
      <div style={{
        position: "absolute", inset: 14,
        borderRadius: "50%",
        background:
          "radial-gradient(circle at 50% 30%, #1f2226 0%, #0a0c0e 90%)",
        boxShadow: "inset 0 4px 8px rgba(0,0,0,0.7)",
        overflow: "hidden",
      }}>
        {/* Tick marks + colored arcs as SVG */}
        <svg viewBox="0 0 200 200" style={{ position: "absolute", inset: 0 }}>
          {/* Colored zone arcs */}
          {/* Red zone left (-130 to -65 deg) */}
          <path d={arcPath(100, 100, 78, -130, -65)}
                fill="none" stroke="#5a1818" strokeWidth="6" />
          {/* Amber zone middle */}
          <path d={arcPath(100, 100, 78, -65, 25)}
                fill="none" stroke="#5a3d00" strokeWidth="6" />
          {/* Green zone right */}
          <path d={arcPath(100, 100, 78, 25, 130)}
                fill="none" stroke="#1a4a2a" strokeWidth="6" />

          {/* Major tick marks */}
          {Array.from({ length: 11 }).map((_, i) => {
            const t = -130 + i * 26;
            const rad = (t - 90) * Math.PI / 180;
            const x1 = 100 + Math.cos(rad) * 70;
            const y1 = 100 + Math.sin(rad) * 70;
            const x2 = 100 + Math.cos(rad) * 82;
            const y2 = 100 + Math.sin(rad) * 82;
            return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2}
                         stroke="#d8d4ca" strokeWidth="1.2" opacity="0.7" />;
          })}

          {/* Minor ticks */}
          {Array.from({ length: 51 }).map((_, i) => {
            if (i % 5 === 0) return null;
            const t = -130 + i * 5.2;
            const rad = (t - 90) * Math.PI / 180;
            const x1 = 100 + Math.cos(rad) * 73;
            const y1 = 100 + Math.sin(rad) * 73;
            const x2 = 100 + Math.cos(rad) * 80;
            const y2 = 100 + Math.sin(rad) * 80;
            return <line key={`m${i}`} x1={x1} y1={y1} x2={x2} y2={y2}
                         stroke="#7a7e84" strokeWidth="0.5" opacity="0.5" />;
          })}

          {/* Number labels */}
          {[0, 25, 50, 75, 100].map((n, i) => {
            const t = -130 + (n / 100) * 260;
            const rad = (t - 90) * Math.PI / 180;
            const x = 100 + Math.cos(rad) * 58;
            const y = 100 + Math.sin(rad) * 58;
            return (
              <text key={n} x={x} y={y}
                    fill="#d8d4ca"
                    fontSize="10"
                    fontFamily="Oxanium, sans-serif"
                    fontWeight="500"
                    textAnchor="middle"
                    dominantBaseline="middle"
                    opacity="0.8">
                {n}
              </text>
            );
          })}

          {/* Center hub label */}
          <text x="100" y="135"
                fill="#d8d4ca"
                fontSize="7"
                fontFamily="Oxanium, sans-serif"
                fontWeight="500"
                letterSpacing="2"
                textAnchor="middle"
                opacity="0.6">
            HEALTH
          </text>
          <text x="100" y="148"
                fill="#d8d4ca"
                fontSize="6"
                fontFamily="Oxanium, sans-serif"
                letterSpacing="2"
                textAnchor="middle"
                opacity="0.4">
            INDEX %
          </text>
        </svg>

        {/* The needle — animates from startup position to current score */}
        <div
          style={{
            position: "absolute",
            top: "12%",
            left: "calc(50% - 1.5px)",
            width: 3,
            height: "76%",
            transformOrigin: "50% 88%",
            transform: `rotate(${angle}deg)`,
            transition: "transform 1.4s cubic-bezier(0.34, 1.56, 0.64, 1)",
            pointerEvents: "none",
          }}
        >
          <div style={{
            width: "100%",
            height: "82%",
            background: `linear-gradient(180deg, ${tint} 0%, var(--needle) 30%, var(--needle) 100%)`,
            boxShadow: `0 0 8px ${tint}aa, 0 1px 2px var(--needle-shadow)`,
            clipPath: "polygon(50% 0%, 100% 100%, 0% 100%)",
          }} />
        </div>

        {/* Center hub */}
        <div style={{
          position: "absolute",
          top: "calc(50% - 12px)",
          left: "calc(50% - 12px)",
          width: 24, height: 24,
          borderRadius: "50%",
          background:
            "radial-gradient(circle at 30% 30%, #6a6e74 0%, #2a2e32 60%, #0a0c0e 100%)",
          boxShadow: "0 2px 4px rgba(0,0,0,0.7), inset 0 -1px 2px rgba(0,0,0,0.6)",
        }} />

        {/* Glass reflection sweep */}
        <div style={{
          position: "absolute", inset: 0,
          background:
            "linear-gradient(135deg, rgba(255,255,255,0.06) 0%, transparent 30%, transparent 70%, rgba(255,255,255,0.02) 100%)",
          pointerEvents: "none",
          borderRadius: "50%",
        }} />
      </div>

      {/* Engraved label below */}
      <div style={{
        position: "absolute",
        bottom: -22,
        left: 0,
        right: 0,
        textAlign: "center",
      }}>
        <Engraving size={8} style={{ opacity: 0.6 }}>
          {label}
        </Engraving>
      </div>
    </div>
  );
}

// SVG arc path helper
function arcPath(cx, cy, r, startDeg, endDeg) {
  const start = polar(cx, cy, r, startDeg - 90);
  const end   = polar(cx, cy, r, endDeg - 90);
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}
function polar(cx, cy, r, deg) {
  const rad = deg * Math.PI / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}