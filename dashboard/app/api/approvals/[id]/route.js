// dashboard/app/api/approvals/[id]/route.js
//
// Server-side approval / reject endpoint.
//
// Why this exists: the dashboard reads Supabase client-side with the
// anon key (gated by RLS to SELECT-only). For approve / reject we need
// to UPDATE bot_approvals, which requires the service-role key. The
// service-role key MUST NEVER reach the browser. So we route writes
// through this endpoint, which runs server-side on Vercel and holds
// LEAGUE_SUPABASE_SERVICE_KEY in a non-public env var.
//
// Auth: shared operator token in `LEAGUE_APPROVAL_TOKEN` env var.
// The dashboard prompts for it once per session, stores it in
// sessionStorage, and sends it as `Authorization: Bearer <token>`.
// Good enough for personal use. Can be swapped for Vercel password
// protection or proper auth later — only this file would change.
//
// Methods:
//   PATCH /api/approvals/<id>   body: { status: "approved" | "rejected", note?: string }

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic"; // always run, never cache

const ALLOWED_STATUSES = new Set(["approved", "rejected"]);

function unauthorized(message = "Unauthorized") {
  return NextResponse.json({ ok: false, error: message }, { status: 401 });
}

function badRequest(message) {
  return NextResponse.json({ ok: false, error: message }, { status: 400 });
}

function checkAuth(req) {
  const expected = (process.env.LEAGUE_APPROVAL_TOKEN || "").trim();
  if (!expected) {
    return { ok: false, why: "LEAGUE_APPROVAL_TOKEN not configured on server." };
  }
  const header = req.headers.get("authorization") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, why: "Missing Bearer token." };
  if (m[1].trim() !== expected) return { ok: false, why: "Invalid token." };
  return { ok: true };
}

export async function PATCH(req, { params }) {
  const auth = checkAuth(req);
  if (!auth.ok) return unauthorized(auth.why);

  const { id } = await params;
  if (!id) return badRequest("Missing approval id.");

  let body;
  try {
    body = await req.json();
  } catch {
    return badRequest("Body must be JSON.");
  }

  const status = (body?.status || "").toString();
  const note = body?.note != null ? String(body.note).slice(0, 500) : null;
  const approverEmail = body?.approver_email
    ? String(body.approver_email).slice(0, 200)
    : null;

  if (!ALLOWED_STATUSES.has(status)) {
    return badRequest(`status must be one of ${[...ALLOWED_STATUSES].join(", ")}.`);
  }

  const url = (process.env.LEAGUE_SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.LEAGUE_SUPABASE_SERVICE_KEY || "";
  if (!url || !key) {
    return NextResponse.json(
      { ok: false, error: "Server is missing LEAGUE_SUPABASE_URL or LEAGUE_SUPABASE_SERVICE_KEY." },
      { status: 500 }
    );
  }

  const patchBody = {
    status,
    approver_note: note,
    approver_email: approverEmail,
    decided_at: new Date().toISOString(),
  };

  // PostgREST PATCH with id=eq.<uuid>. Use Prefer=return=representation so
  // we can confirm the row actually existed and was updated.
  const supaUrl = `${url}/rest/v1/bot_approvals?id=eq.${encodeURIComponent(id)}&status=eq.pending`;
  // The status=eq.pending filter prevents double-decisions: only pending
  // rows can be moved to approved/rejected; already-decided rows are
  // silently no-op'd (PostgREST returns []).

  let resp;
  try {
    resp = await fetch(supaUrl, {
      method: "PATCH",
      headers: {
        "apikey":        key,
        "Authorization": `Bearer ${key}`,
        "Content-Type":  "application/json",
        "Prefer":        "return=representation",
      },
      body: JSON.stringify(patchBody),
      cache: "no-store",
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Supabase fetch failed: ${e?.message || e}` },
      { status: 502 }
    );
  }

  if (!resp.ok) {
    let detail = "";
    try { detail = (await resp.text()).slice(0, 300); } catch {}
    return NextResponse.json(
      { ok: false, error: `Supabase ${resp.status}`, detail },
      { status: 502 }
    );
  }

  let rows;
  try {
    rows = await resp.json();
  } catch {
    rows = [];
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    // Either the id doesn't exist, or the row was already decided.
    return NextResponse.json(
      { ok: false, error: "Approval not found or already decided." },
      { status: 409 }
    );
  }

  return NextResponse.json({ ok: true, row: rows[0] });
}
