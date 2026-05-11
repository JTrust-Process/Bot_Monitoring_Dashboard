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

export function createLeagueClient() {
  const { url, key } = getLeagueSupabaseConfig();
  if (!url || !key) return null;
  return createClient(url, key);
}
