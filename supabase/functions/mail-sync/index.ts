// POST — pull new inbox mail, triage it, store the envelopes.
//
// Two ways in:
//   (a) a signed-in user syncing their own mailbox from the app;
//   (b) the scheduler, presenting `x-cron-secret`, which sweeps every connected
//       account (four times a day — see EMAIL-SETUP.md).
//
// What is stored is deliberately thin: sender, subject, date, addressing and
// the triage decision. Message BODIES ARE NEVER WRITTEN — email_messages has no
// column for one. Bodies are fetched only when a draft is being written
// (mail-draft) and are discarded with the request.

import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { HttpError, requireActiveUser, serviceClient } from "../_shared/auth.ts";
import {
  accessTokenFromRefresh,
  listInboxSince,
  type MailMessage,
} from "../_shared/graphMail.ts";
import { triage, type Triage } from "../_shared/triage.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** How far back a first-ever sync reaches. Older mail is already handled. */
const FIRST_SYNC_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Ceiling for an interactive re-scan window (7 days). */
const MAX_SINCE_HOURS = 168;
/** Ceiling on messages examined per account per run. */
const MAX_MESSAGES = 100;

interface MailAccount {
  user_id: string;
  ms_email: string;
  refresh_token: string;
  last_sync_at: string | null;
}

interface Counts {
  synced: number;
  action: number;
  fyi: number;
  ignored: number;
}

function emptyCounts(): Counts {
  return { synced: 0, action: 0, fyi: 0, ignored: 0 };
}

function tally(counts: Counts, verdict: Triage): void {
  counts.synced += 1;
  if (verdict === "action") counts.action += 1;
  else if (verdict === "fyi") counts.fyi += 1;
  else counts.ignored += 1;
}

/** Cron mode when the shared secret matches. Constant-time to avoid leaking it. */
function isCronRequest(req: Request): boolean {
  const presented = req.headers.get("x-cron-secret");
  const expected = Deno.env.get("CRON_SECRET");
  if (!presented || !expected) return false;
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    // Only an interactive caller may widen their own window; the scheduler
    // always uses the normal forward-moving window.
    const cron = isCronRequest(req);
    const sinceHours = !cron && typeof body.sinceHours === "number"
      ? body.sinceHours
      : undefined;

    const svc = serviceClient();
    const accounts = cron
      ? await loadAllAccounts(svc)
      : await loadOneAccount(svc, (await requireActiveUser(req)).user.id);

    const totals = emptyCounts();
    for (const account of accounts) {
      // One account's failure must not abort the sweep — a revoked mailbox
      // would otherwise stop every other account from syncing. The error is
      // recorded on the row so the UI can show "reconnect your mailbox".
      try {
        const counts = await syncAccount(svc, account, sinceHours);
        totals.synced += counts.synced;
        totals.action += counts.action;
        totals.fyi += counts.fyi;
        totals.ignored += counts.ignored;
      } catch (e) {
        const message = e instanceof Error ? e.message : "Sync failed";
        await svc
          .from("mail_accounts")
          .update({ last_sync_error: message.slice(0, 500) })
          .eq("user_id", account.user_id);
        // A single user syncing their own mailbox should see the failure.
        if (accounts.length === 1) throw e;
      }
    }

    return jsonResponse(totals);
  } catch (e) {
    return errorResponse(e);
  }
});

// ---------------------------------------------------------------------------
// Account loading
// ---------------------------------------------------------------------------

const ACCOUNT_COLUMNS = "user_id,ms_email,refresh_token,last_sync_at";

async function loadAllAccounts(svc: SupabaseClient): Promise<MailAccount[]> {
  const { data, error } = await svc
    .from("mail_accounts")
    .select(ACCOUNT_COLUMNS);
  if (error) throw new HttpError(500, "Could not load mailbox connections");
  return (data ?? []) as MailAccount[];
}

async function loadOneAccount(
  svc: SupabaseClient,
  userId: string,
): Promise<MailAccount[]> {
  const { data, error } = await svc
    .from("mail_accounts")
    .select(ACCOUNT_COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new HttpError(500, "Could not load your mailbox connection");
  if (!data) {
    throw new HttpError(
      400,
      "No mailbox connected. Connect your mailbox from the Email page.",
      "mailbox_not_connected",
    );
  }
  return [data as MailAccount];
}

// ---------------------------------------------------------------------------
// Per-account sync
// ---------------------------------------------------------------------------

async function syncAccount(
  svc: SupabaseClient,
  account: MailAccount,
  sinceHours?: number,
): Promise<Counts> {
  const { accessToken, refreshToken } = await accessTokenFromRefresh(
    account.refresh_token,
  );

  // Microsoft rotates refresh tokens. Persist the new one IMMEDIATELY and
  // before anything else that can fail — if we kept the old one the connection
  // would keep working for a while and then die silently, days from now, with
  // nothing to correlate it to. See accessTokenFromRefresh.
  if (refreshToken) {
    const { error } = await svc
      .from("mail_accounts")
      .update({ refresh_token: refreshToken })
      .eq("user_id", account.user_id);
    if (error) {
      throw new HttpError(500, "Could not save the refreshed mailbox token");
    }
  }

  // `sinceHours` lets an interactive caller re-scan a window they have already
  // synced. Needed whenever the triage rules change: without it, mail that was
  // classified under the old rules would keep its stale verdict forever, since
  // the normal window only ever moves forward. Bounded so a stray value cannot
  // pull the entire mailbox.
  const overrideMs = sinceHours === undefined
    ? null
    : Math.min(Math.max(sinceHours, 1), MAX_SINCE_HOURS) * 3_600_000;

  const since = overrideMs !== null
    ? new Date(Date.now() - overrideMs)
    : account.last_sync_at
    ? new Date(account.last_sync_at)
    : new Date(Date.now() - FIRST_SYNC_WINDOW_MS);

  const messages = (await listInboxSince(
    accessToken,
    since.toISOString(),
    MAX_MESSAGES,
  )).slice(0, MAX_MESSAGES);

  const rules = await loadRules(svc, account.user_id);
  const owner = account.ms_email;

  const counts = emptyCounts();
  const rows = messages
    .filter((m) => m.id)
    .map((m) => {
      const verdict = triage({
        fromEmail: m.fromEmail,
        fromName: m.fromName,
        subject: m.subject,
        toRecipients: m.toRecipients,
        ccRecipients: m.ccRecipients,
        bodyPreview: m.bodyPreview,
        ownerEmail: owner,
        rules,
      });
      tally(counts, verdict.triage);
      return rowFor(m, account.user_id, owner, verdict);
    });

  if (rows.length > 0) {
    // Refresh the verdict on conflict rather than skipping. Every column here
    // is derived from the message plus the current rules, so re-triaging is
    // how a rule change (or a fix to the triage logic) reaches mail that was
    // already synced. Skipping instead would freeze a wrong verdict forever —
    // which is exactly what happened when the first live sync mis-classified
    // microsoft-noreply and the corrected rules could not dislodge it.
    //
    // WHEN a user-action column is added (dismissed, replied, snoozed), it must
    // be excluded from this update or the sync will trample the user's intent.
    const { error } = await svc
      .from("email_messages")
      .upsert(rows, { onConflict: "id", ignoreDuplicates: false });
    if (error) throw new HttpError(500, "Could not save messages");
  }

  const { error } = await svc
    .from("mail_accounts")
    .update({
      last_sync_at: new Date().toISOString(),
      last_sync_error: null,
    })
    .eq("user_id", account.user_id);
  if (error) throw new HttpError(500, "Could not record the sync time");

  return counts;
}

async function loadRules(
  svc: SupabaseClient,
  userId: string,
): Promise<{ pattern: string; action: "ignore" | "prioritise" }[]> {
  const { data, error } = await svc
    .from("email_rules")
    .select("pattern,action")
    .eq("user_id", userId);
  if (error) throw new HttpError(500, "Could not load your email rules");
  return (data ?? []) as { pattern: string; action: "ignore" | "prioritise" }[];
}

function rowFor(
  m: MailMessage,
  userId: string,
  ownerEmail: string,
  verdict: { triage: Triage; reason: string },
): Record<string, unknown> {
  const owner = ownerEmail.trim().toLowerCase();
  return {
    id: m.id,
    user_id: userId,
    conversation_id: m.conversationId,
    from_email: m.fromEmail,
    from_name: m.fromName,
    subject: m.subject,
    received_at: m.receivedAt,
    // In the To line, not merely copied — the difference between "answer this"
    // and "you were kept informed".
    to_me: m.toRecipients.some((r) => r.trim().toLowerCase() === owner),
    triage: verdict.triage,
    triage_reason: verdict.reason,
    web_link: m.webLink,
  };
}

function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) {
    const payload: Record<string, unknown> = { error: e.message };
    if (e.code) payload.code = e.code;
    return jsonResponse(payload, e.status);
  }
  const message = e instanceof Error ? e.message : "Server error";
  return jsonResponse({ error: message }, 500);
}
