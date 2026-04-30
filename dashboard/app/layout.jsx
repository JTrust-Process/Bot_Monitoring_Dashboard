import "./globals.css";

export const metadata = {
  title: "Bot Health",
  description: "Operational health monitor for trading bots",
};

export default function RootLayout({ children }) {
  const repoUrl = process.env.NEXT_PUBLIC_REPO_URL;

  return (
    <html lang="en">
      <body suppressHydrationWarning>
        {/* Header — single 1px rule, generous padding, no background */}
        <header style={{
          borderBottom: "1px solid var(--rule)",
          padding: "var(--s-5) var(--s-7)",
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
        }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "var(--s-5)" }}>
            <span style={{
              fontSize: 15,
              fontWeight: 600,
              letterSpacing: "-0.01em",
              color: "var(--ink)",
            }}>
              Bot Health
            </span>
            <span style={{
              fontSize: 11,
              color: "var(--ink-4)",
              fontFamily: "var(--mono)",
              letterSpacing: "0.04em",
            }}>
              v1
            </span>
          </div>

          <div style={{
            display: "flex",
            alignItems: "baseline",
            gap: "var(--s-5)",
            fontSize: 12,
            color: "var(--ink-3)",
          }}>
            {repoUrl && (
              <a href={repoUrl} target="_blank" rel="noopener noreferrer" className="tnav">
                Source
              </a>
            )}
            <span
              id="hdr-clock"
              suppressHydrationWarning
              className="tabular"
              style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-4)" }}
            >
              --:--:--
            </span>
          </div>
        </header>

        {children}

        {/* Footer — one rule, tiny grey type, that's it */}
        <footer style={{
          borderTop: "1px solid var(--rule)",
          padding: "var(--s-4) var(--s-7)",
          display: "flex",
          justifyContent: "space-between",
          fontSize: 11,
          color: "var(--ink-4)",
          marginTop: "var(--s-9)",
        }}>
          <span>Refresh every 60 seconds.</span>
          <span className="tabular">Two channels.</span>
        </footer>

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