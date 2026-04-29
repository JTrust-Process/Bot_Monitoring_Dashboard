import "./globals.css";

export const metadata = {
  title: "BOT.HEALTH // MISSION CONTROL",
  description: "Operational health monitor for trading bots",
};

export default function RootLayout({ children }) {
  const selfRepoUrl = process.env.NEXT_PUBLIC_REPO_URL;

  return (
    <html lang="en">
      <body>
        <div style={{ position: "relative", zIndex: 2, minHeight: "100vh" }}>
          {/* TOP STATUS BAR */}
          <header style={{
            borderBottom: "1px solid #1f2024",
            background: "#0a0a0a",
            padding: "0.6rem 1.5rem",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 10,
            fontFamily: "var(--mono)",
            letterSpacing: "0.15em",
            color: "#6b6e75",
            textTransform: "uppercase",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
              <span style={{ color: "#d8d4ca" }}>BOT.HEALTH</span>
              <span>/</span>
              <span>MISSION CONTROL</span>
              <span>/</span>
              <span className="blink" style={{ color: "#00ff88" }}>● LIVE</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
              {selfRepoUrl && (
                <a
                  href={selfRepoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="source-link"
                >
                  ◇ SOURCE
                </a>
              )}
              <span>SYS.UTC <span id="hdr-clock" suppressHydrationWarning style={{ color: "#d8d4ca" }}>--:--:--</span></span>
              <span>v0.1.0</span>
            </div>
          </header>

          {children}

          {/* BOTTOM BAR */}
          <footer style={{
            borderTop: "1px solid #1f2024",
            padding: "0.6rem 1.5rem",
            fontSize: 9,
            fontFamily: "var(--mono)",
            letterSpacing: "0.15em",
            color: "#4a4a52",
            textTransform: "uppercase",
            display: "flex",
            justifyContent: "space-between",
          }}>
            <span>// REFRESH 60s · SUPABASE.PROJECT.A + SUPABASE.PROJECT.B</span>
            <span>END.OF.TRANSMISSION</span>
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