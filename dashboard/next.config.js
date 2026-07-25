/** @type {import('next').NextConfig} */

// ─────────────────────────────────────────────────────────────────────────────
//  Build-time guard: never ship a service-role key to the browser
// ─────────────────────────────────────────────────────────────────────────────
//
// Next.js inlines every NEXT_PUBLIC_* value into the client bundle. A
// service-role Supabase key placed behind that prefix is therefore published
// to every visitor, bypassing all RLS — and the build still succeeds, the
// page still works, and nothing looks wrong.
//
// The README used to actively instruct this mistake (fixed 2026-07-25), so a
// comment alone is not sufficient defence. This fails the build instead.
//
// Supabase keys are JWTs: header.payload.signature, base64url. We decode the
// payload and look for role === "service_role". Anything unparseable is
// ignored — this must never fail a build for a non-JWT value like a URL.
function assertNoServiceRoleKeysArePublic() {
  const offenders = [];

  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("NEXT_PUBLIC_") || !value) continue;

    const parts = String(value).split(".");
    if (parts.length !== 3) continue; // not a JWT

    let payload;
    try {
      payload = JSON.parse(
        Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64")
          .toString("utf8")
      );
    } catch {
      continue; // not decodable — not our problem
    }

    if (payload && payload.role === "service_role") {
      offenders.push(name);
    }
  }

  if (offenders.length > 0) {
    throw new Error(
      "\n\n" +
      "═".repeat(72) + "\n" +
      "  BUILD BLOCKED — service-role key exposed to the browser\n" +
      "═".repeat(72) + "\n\n" +
      `  These NEXT_PUBLIC_* variables contain a Supabase SERVICE-ROLE key:\n\n` +
      offenders.map(n => `    - ${n}`).join("\n") + "\n\n" +
      "  NEXT_PUBLIC_* values are inlined into the JavaScript bundle served\n" +
      "  to every visitor. A service-role key there grants full read/write on\n" +
      "  the database with RLS bypassed.\n\n" +
      "  Fix: re-add the variable WITHOUT the NEXT_PUBLIC_ prefix. Only anon\n" +
      "  keys belong in client-visible env vars. See README > Deploy dashboard\n" +
      "  to Vercel > Env var prefixes.\n\n" +
      "═".repeat(72) + "\n"
    );
  }
}

assertNoServiceRoleKeysArePublic();

// ─────────────────────────────────────────────────────────────────────────────
//  Security headers
// ─────────────────────────────────────────────────────────────────────────────
//
// This page holds an operator bearer token in sessionStorage that can approve
// real-money orders, so a CSP is doing real work here: it is the control that
// limits an XSS from exfiltrating that token.
//
// NOTE: `script-src` is intentionally permissive for now because
// app/layout.jsx renders an inline clock script via dangerouslySetInnerHTML.
// Tighten to `'self'` once that is replaced with next/script or a useEffect.
const securityHeaders = [
  { key: "X-Frame-Options",        value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy",        value: "strict-origin-when-cross-origin" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // Supabase REST + realtime, across all three projects.
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "script-src 'self' 'unsafe-inline'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
];

const nextConfig = {
  // Don't advertise the framework version to scanners.
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

module.exports = nextConfig;
