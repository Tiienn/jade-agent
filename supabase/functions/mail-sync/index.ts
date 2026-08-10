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
//
// A second, additive pass runs over the same fetched messages: the office
// manager's all-staff absence notices are extracted into staff_presence so the
// presence board can be read at a glance. It changes no triage verdict — those
// mails were and remain "ignore / sent to all staff" — and its failures are
// contained, because delivering the mailbox is the primary job of this
// function.

import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { HttpError, requireActiveUser, serviceClient } from "../_shared/auth.ts";
import {
  accessTokenFromRefresh,
  getMessageBody,
  listInboxSince,
  type MailMessage,
} from "../_shared/graphMail.ts";
import { triage, type Triage } from "../_shared/triage.ts";
import { extractPresence, isPresenceEmail } from "../_shared/presence.ts";
import {
  loadAnnouncers,
  loadRoster,
  presenceSource,
  resolveFacts,
  type RosterEntry,
  storePresence,
} from "../_shared/presenceStore.ts";
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
  /** staff_presence rows written this run. Independent of the triage tallies:
   *  a presence email is counted in `ignored` as well, because it genuinely is
   *  an all-staff mail nobody has to answer. */
  presence: number;
}

function emptyCounts(): Counts {
  return { synced: 0, action: 0, fyi: 0, ignored: 0, presence: 0 };
}

/**
 * Everything the presence pass needs that does not vary per message.
 * Null when it could not be loaded — see loadPresenceConfig.
 */
interface PresenceConfig {
  announcers: string[];
  roster: RosterEntry[];
}

function tally(counts: Counts, verdict: Triage): void {
  counts.synced += 1;
  if (verdict === "action") counts.action += 1;
  else if (verdict === "fyi") counts.fyi += 1;
  else counts.ignored += 1;
}

/**
 * Cron mode when the shared secret matches.
 *
 * The expected value is read from `public.cron_config`, which pg_cron also
 * reads when it builds the request. One source of truth, generated in the
 * database and never copied anywhere — see migration 0004. The older env-var
 * approach required the same secret in two places and would fail open-ended
 * and silently if they ever drifted.
 *
 * Comparison is constant-time so a wrong guess cannot be narrowed by timing.
 */
async function isCronRequest(
  req: Request,
  svc: SupabaseClient,
): Promise<boolean> {
  const presented = req.headers.get("x-cron-secret");
  if (!presented) return false;

  const { data, error } = await svc
    .from("cron_config")
    .select("cron_secret")
    .limit(1)
    .maybeSingle();
  const expected = error ? null : (data?.cron_secret as string | undefined);
  if (!expected) return false;

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
    const svc = serviceClient();
    const cron = await isCronRequest(req, svc);
    const sinceHours = !cron && typeof body.sinceHours === "number"
      ? body.sinceHours
      : undefined;

    const accounts = cron
      ? await loadAllAccounts(svc)
      : await loadOneAccount(svc, (await requireActiveUser(req)).user.id);

    // ONCE per run, before the account loop. Both tables are company-wide and a
    // few dozen rows: loading them per account (or, worse, per message) would
    // turn a cron sweep into hundreds of identical queries for data that cannot
    // change mid-run.
    const presenceConfig = await loadPresenceConfig(svc);

    const totals = emptyCounts();
    for (const account of accounts) {
      // One account's failure must not abort the sweep — a revoked mailbox
      // would otherwise stop every other account from syncing. The error is
      // recorded on the row so the UI can show "reconnect your mailbox".
      try {
        const counts = await syncAccount(svc, account, sinceHours, presenceConfig);
        totals.synced += counts.synced;
        totals.action += counts.action;
        totals.fyi += counts.fyi;
        totals.ignored += counts.ignored;
        totals.presence += counts.presence;
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
  sinceHours: number | undefined,
  presenceConfig: PresenceConfig | null,
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

  // Additive second pass over the SAME messages. Deliberately after the
  // envelopes are safely stored, and deliberately unable to throw: mail triage
  // is what this function is for.
  counts.presence = await syncPresence(svc, accessToken, messages, presenceConfig);

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

// ---------------------------------------------------------------------------
// Presence extraction
// ---------------------------------------------------------------------------

/**
 * Announcers + roster, or null if either could not be read.
 *
 * Returning null instead of throwing is the first half of the containment rule:
 * a missing table, a permissions change or a slow query must not stop a mailbox
 * from syncing. The board falling behind is a nuisance; mail not arriving is
 * the thing the office actually notices.
 */
async function loadPresenceConfig(
  svc: SupabaseClient,
): Promise<PresenceConfig | null> {
  try {
    const [announcers, roster] = await Promise.all([
      loadAnnouncers(svc),
      loadRoster(svc),
    ]);
    return { announcers, roster };
  } catch (e) {
    console.error("presence: could not load configuration", e);
    return null;
  }
}

/**
 * Extract absences from the announcer mail in `messages`. Never throws.
 *
 * !! MESSAGE BODIES ARE NEVER PERSISTED. !!
 * The full body is fetched here because bodyPreview truncates at ~255
 * characters and cuts the multi-person notices in half (see getMessageBody).
 * It is read, turned into facts, and dropped when this iteration ends. Nothing
 * downstream stores it, no column exists for it, and none should be added:
 * email_messages holds envelopes only, on purpose. If you are here to "avoid
 * re-fetching" by caching bodies in the database, that is the change this
 * comment exists to stop.
 *
 * KNOWN LIMIT, harmless today and not so tomorrow: the row identity is the
 * Graph message id, which is per MAILBOX. One all-staff notice therefore has a
 * different id in every recipient's inbox, so the day a second colleague
 * connects their mailbox the cron sweep will file that notice twice — same
 * person, same date, two rows. Today exactly one mailbox is connected. The fix
 * when that changes is `internetMessageId` (the RFC 5322 Message-ID, identical
 * in every copy) as source_message_id, which makes the dedupe index in 0006
 * collapse them on its own; it needs a re-read of the comment there, since that
 * column is documented as the email_messages id.
 */
async function syncPresence(
  svc: SupabaseClient,
  accessToken: string,
  messages: MailMessage[],
  config: PresenceConfig | null,
): Promise<number> {
  // No announcers configured means nothing qualifies — fail closed, the same
  // way isPresenceEmail does. Skipping the loop entirely also avoids a body
  // fetch per message on installs that never turn this on.
  if (!config || config.announcers.length === 0) return 0;

  let written = 0;
  for (const m of messages) {
    if (!m.id) continue;

    // Gate on the preview first. It is truncated, but the lead-in ("Please note
    // that") sits in the first line of every one of these, and the subject
    // fallback catches the rest — so this rejects the other 99% of the mailbox
    // without spending a Graph call on it.
    if (
      !isPresenceEmail({
        fromEmail: m.fromEmail,
        subject: m.subject,
        body: m.bodyPreview,
        announcerEmails: config.announcers,
      })
    ) continue;

    try {
      const body = await getMessageBody(accessToken, m.id);
      const facts = extractPresence({
        subject: m.subject,
        body,
        // These are internal mails delivered in seconds, so received time is
        // the send time for every practical purpose — and it is the only
        // timestamp listInboxSince selects.
        sentAt: m.receivedAt ?? "",
        fromEmail: m.fromEmail,
      });
      // Key the rows on the announcement's RFC 5322 Message-ID, not this
      // mailbox's Graph id — see presenceSource(). The cron sweep visits every
      // connected mailbox, and an all-staff notice sits in all of them; keying
      // on the per-mailbox id would file the same absence once per recipient
      // who happens to use the app.
      const source = presenceSource(
        m.internetMessageId,
        m.id,
        resolveFacts(facts, config.roster),
      );
      written += await storePresence(svc, source.messageId, source.rows);
    } catch (e) {
      // Per message, so one unreadable notice cannot cost us the others in the
      // same run. Logged rather than written to mail_accounts.last_sync_error:
      // that column drives a "reconnect your mailbox" prompt in the UI, and
      // sending the user to re-authorise Microsoft over a presence bug would be
      // a lie about what is broken.
      console.error(`presence: message ${m.id} failed`, e);
    }
  }
  return written;
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
