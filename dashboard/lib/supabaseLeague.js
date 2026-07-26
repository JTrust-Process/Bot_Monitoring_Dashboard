// dashboard/lib/supabaseLeague.js
//
// Single source of truth for the Trading Bot League Supabase client.
// Returns null if env vars aren't set so the page can render a friendly
// "configuration missing" state rather than crashing.
//
// Env vars (in dashboard/.env.local + Vercel project settings):
//   NEXT_PUBLIC_LEAGUE_SUPABASE_URL
//   NEXT_PUBLIC_LEAGUE_SUPABASE_ANON_KEY
//
// Both are NEXT_PUBLIC_* because the dashboard reads them client-side via
// the same anon-key pattern the existing Health page uses. Anon keys are
// gated by Row-Level Security (the migrations only allow SELECT for anon).

"use client";

import { createClient } from "@supabase/supabase-js";

export function getLeagueSupabaseConfig() {
  return {
    url: process.env.NEXT_PUBLIC_LEAGUE_SUPABASE_URL || "",
    key: process.env.NEXT_PUBLIC_LEAGUE_SUPABASE_ANON_KEY || "",
  };
}

// Memoised at module scope (2026-07-25). This used to return a NEW client on
// every call, and LeagueDashboard calls it inside a 60-second poll. Each
// createClient builds a fresh GoTrueClient which — autoRefreshToken defaults
// to true — registers a ~30s setInterval and a `visibilitychange` listener
// that is never torn down. A tab left open all day accumulated ~1,440
// orphaned timers.
//
// The URL and key are NEXT_PUBLIC_* values, inlined at build time, so they
// cannot change during the process lifetime. One client is correct.
let _client = null;

export function createLeagueClient() {
  if (_client) return _client;
  const { url, key } = getLeagueSupabaseConfig();
  if (!url || !key) return null;
  _client = createClient(url, key);
  return _client;
}
