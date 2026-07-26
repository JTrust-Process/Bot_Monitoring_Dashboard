import "./globals.css";
import Link from "next/link";
import HeaderClock from "../components/HeaderClock";

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
            {/* next/link, not bare <a> — an anchor triggers a full document
                load on every tab switch: React state discarded, both
                dashboards remounted, every query refetched from scratch. */}
            <Link href="/" className="tnav">Health</Link>
            <Link href="/league" className="tnav">League</Link>
            {repoUrl && (
              <a href={repoUrl} target="_blank" rel="noopener noreferrer" className="tnav">
                Source
              </a>
            )}
            <HeaderClock />
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
          <span>Refresh every 60 seconds while this tab is visible.</span>
          <span className="tabular">All times UTC.</span>
        </footer>
      </body>
    </html>
  );
}