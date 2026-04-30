import "./globals.css";

export const metadata = {
  title: "BOT.HEALTH — INSTRUMENT PANEL",
  description: "Operational health monitor for trading bots",
};

export default function RootLayout({ children }) {
  const selfRepoUrl = process.env.NEXT_PUBLIC_REPO_URL;

  return (
    <html lang="en">
      <body suppressHydrationWarning>
        <div style={{ position: "relative", zIndex: 2, minHeight: "100vh" }}>

          {/* MASTHEAD: like a brass plaque on the equipment rack */}
          <header style={{
            background: "linear-gradient(180deg, #2a2e32 0%, #1a1d1f 100%)",
            borderBottom: "1px solid #0a0c0e",
            boxShadow: "inset 0 -1px 0 rgba(255,255,255,0.04), 0 2px 8px rgba(0,0,0,0.5)",
            padding: "1rem 2rem",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 32 }}>
              {/* Engraved-looking title */}
              <div style={{
                fontFamily: "var(--stencil)",
                fontSize: 22,
                letterSpacing: "0.15em",
                color: "var(--label-white)",
                textShadow: "0 1px 0 rgba(0,0,0,0.8), 0 -1px 0 rgba(255,255,255,0.05)",
              }}>
                BOT·HEALTH
              </div>

              <div style={{
                fontFamily: "var(--label)",
                fontSize: 9,
                letterSpacing: "0.3em",
                color: "var(--label-silver)",
                textTransform: "uppercase",
                opacity: 0.6,
                borderLeft: "1px solid #4a4e54",
                paddingLeft: 16,
              }}>
                INSTRUMENT PANEL
                <br />
                MK-I REV.A
              </div>
            </div>

            {/* Power indicator + clock + repo link */}
            <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
              <PowerLamp />

              {selfRepoUrl && (
                <a
                  href={selfRepoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="header-link"
                  style={{
                    fontFamily: "var(--label)",
                    fontSize: 9,
                    letterSpacing: "0.2em",
                    textTransform: "uppercase",
                    color: "var(--label-silver)",
                    padding: "4px 10px",
                    border: "1px solid #4a4e54",
                    background: "linear-gradient(180deg, #2a2e32, #1a1d1f)",
                    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06), 0 1px 2px rgba(0,0,0,0.6)",
                  }}
                >
                  ◊ SOURCE
                </a>
              )}

              <DigitalClock />
            </div>
          </header>

          {children}

          {/* FOOTER: maintenance label */}
          <footer style={{
            borderTop: "1px solid #0a0c0e",
            background: "linear-gradient(180deg, #1a1d1f 0%, #14171a 100%)",
            padding: "0.75rem 2rem",
            fontSize: 9,
            fontFamily: "var(--label)",
            letterSpacing: "0.2em",
            color: "#5a5e64",
            textTransform: "uppercase",
            display: "flex",
            justifyContent: "space-between",
          }}>
            <span>SCAN INTERVAL: 60s · DUAL CHANNEL TELEMETRY</span>
            <span>SERIAL N° 0001 · INSPECTED ✓</span>
          </footer>
        </div>

        <script dangerouslySetInnerHTML={{ __html: `
          (function tick() {
            var el = document.getElementById('hdr-clock');
            if (el) el.textContent = new Date().toISOString().slice(11,19);
            setTimeout(tick, 1000);
          })();
        `}} />
      </body>
    </html>
  );
}

function PowerLamp() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{
        fontFamily: "var(--label)",
        fontSize: 8,
        letterSpacing: "0.25em",
        color: "var(--label-silver)",
        opacity: 0.6,
      }}>PWR</span>
      <span style={{
        display: "inline-block",
        width: 10, height: 10,
        borderRadius: "50%",
        background: "radial-gradient(circle at 30% 30%, #86efac, #4ade80 40%, #15803d 100%)",
        boxShadow: "0 0 12px #4ade80aa, inset 0 -1px 2px rgba(0,0,0,0.4)",
      }} className="lamp-pulse" />
    </div>
  );
}

function DigitalClock() {
  return (
    <div style={{
      background: "var(--bezel-black)",
      border: "1px solid #14171a",
      boxShadow: "inset 0 2px 4px rgba(0,0,0,0.8), 0 1px 0 rgba(255,255,255,0.05)",
      padding: "4px 12px",
      fontFamily: "var(--led)",
      fontSize: 14,
      letterSpacing: "0.1em",
      color: "#ff7e3d",
      textShadow: "0 0 8px #ff7e3d88",
      minWidth: 110,
      textAlign: "center",
    }}>
      <span id="hdr-clock" suppressHydrationWarning>--:--:--</span>
    </div>
  );
}