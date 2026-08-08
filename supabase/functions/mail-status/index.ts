// POST {} — is the caller's mailbox connected, and how did the last sync go?
//
// This function exists because `mail_accounts` is deliberately unreadable by
// clients: RLS is on with zero policies, so not even the row's own owner can
// select it (see 0003_email_assistant.sql — the table holds Microsoft refresh
// tokens). The UI still needs to know whether to show "Connect your mailbox" or
// the inbox, so it asks here instead of selecting the table.
//
// The refresh token is NEVER part of the response. Only the four fields below
// are returned, and only ever for the calling user.

import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { HttpError, requireActiveUser, serviceClient } from "../_shared/auth.ts";

interface AccountStatusRow {
  ms_email: string;
  last_sync_at: string | null;
  last_sync_error: string | null;
}

Deno.serve(async (req: Request) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");

    const { user } = await requireActiveUser(req);

    const svc = serviceClient();
    // Column list is explicit, not "*": refresh_token must never leave the
    // server, and a narrow select means a future column cannot leak by default.
    const { data, error } = await svc
      .from("mail_accounts")
      .select("ms_email,last_sync_at,last_sync_error")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) {
      throw new HttpError(500, "Could not load your mailbox connection");
    }

    if (!data) {
      return jsonResponse({
        connected: false,
        email: null,
        lastSyncAt: null,
        lastSyncError: null,
      });
    }

    const row = data as AccountStatusRow;
    return jsonResponse({
      connected: true,
      email: row.ms_email,
      lastSyncAt: row.last_sync_at,
      lastSyncError: row.last_sync_error,
    });
  } catch (e) {
    return errorResponse(e);
  }
});

function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) {
    const payload: Record<string, unknown> = { error: e.message };
    if (e.code) payload.code = e.code;
    return jsonResponse(payload, e.status);
  }
  const message = e instanceof Error ? e.message : "Server error";
  return jsonResponse({ error: message }, 500);
}
