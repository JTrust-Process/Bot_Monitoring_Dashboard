"use client";

import { useEffect, useState } from "react";

/**
 * Header UTC clock.
 *
 * Replaces an inline `dangerouslySetInnerHTML` script (removed 2026-07-25)
 * that had two problems:
 *
 *   1. Scripts injected via innerHTML DO NOT EXECUTE. It worked only because
 *      the markup was server-rendered on first paint; on any client-only
 *      render path the clock silently sat at "--:--:--" forever.
 *   2. It ran an unbounded `setTimeout` recursion with no teardown, and it
 *      blocked adopting a strict `script-src` CSP — which matters here,
 *      because the page holds an order-approving bearer token in
 *      sessionStorage and CSP is the control that limits an XSS from
 *      exfiltrating it.
 *
 * The label is explicit about UTC. Every timestamp on these dashboards is
 * UTC and none of them used to say so, which reads as four hours stale to
 * anyone in ET — right next to relative ages like "43 minutes ago" that are
 * timezone-independent. Mixing the two silently invites the wrong reading.
 */
export default function HeaderClock() {
  const [now, setNow] = useState(null);

  useEffect(() => {
    const tick = () => setNow(new Date().toISOString().slice(11, 19));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <span
      className="tabular"
      title="Current time, UTC"
      style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-4)" }}
    >
      {now ? `${now} UTC` : "--:--:-- UTC"}
    </span>
  );
}
