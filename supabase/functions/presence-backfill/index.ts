// POST { months? } — read the last few months of absence notices into the
// presence board. Admin only.
//
// mail-sync only ever looks forward, so the day the board is switched on it is
// empty and stays empty until somebody is next off sick. This function fills in
// the history that already exists in the mailbox, which matters for two
// reasons: the board is immediately worth looking at, and — more usefully —
// every name the office manager has used in three months comes back in
// `unresolvedNames`, which is how the roster gets seeded without anyone having
// to remember that "Marie-Claire" is also written "MC".
//
// It is a manual, admin-triggered job, not a scheduled one: it walks months of
// mail across every configured announcer and there is nothing to gain from
// running it twice. Re-running is harmless (each email replaces its own rows —
// see replace_presence_for_message), just slow.
//
// Like mail-sync, this reads message bodies and NEVER stores them. The body is
// extracted and dropped; only the resulting facts are written.

import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { HttpError, requireAdmin, serviceClient } from "../_shared/auth.ts";
import {
  accessTokenFromRefresh,
  getMessageBody,
  listMessagesFromSender,
} from "../_shared/graphMail.ts";
import { extractPresence, isPresenceEmail } from "../_shared/presence.ts";
import {
  loadAnnouncers,
  loadRoster,
  presenceSource,
  resolveFacts,
  storePresence,
} from "../_shared/presenceStore.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** Long enough to cover a quarter of absences, short enough to finish. */
const DEFAULT_MONTHS = 3;
/** Beyond a year the roster has changed enough that old names mislead. */
const MAX_MONTHS = 12;
/**
 * Hard ceiling on messages examined, across all announcers. This runs inside a
 * single HTTP request that an admin is watching, and each qualifying message
 * costs a second Graph call for its body — so the cap is what keeps a busy
 * mailbox from turning the backfill into a timeout with nothing written.
 */
const MAX_EXAMINED = 500;

interface BackfillResult {
  examined: number;
  presenceEmails: number;
  rowsWritten: number;
  unresolvedNames: string[];
}

Deno.serve(async (req: Request) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");

    // Same admin check as admin-users: requireActiveUser plus profiles.role,
    // wrapped up in requireAdmin so there is one definition of "admin" in the
    // codebase rather than a second hand-rolled one here.
    const { user } = await requireAdmin(req);

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const months = clampMonths(body.months);

    const svc = serviceClient();
    const result = await backfill(svc, user.id, months);
    return jsonResponse(result);
  } catch (e) {
    return errorResponse(e);
  }
});

function clampMonths(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_MONTHS;
  return Math.min(Math.max(Math.floor(v), 1), MAX_MONTHS);
}

/** `months` back from now, as an ISO instant Graph will accept in a filter. */
function windowStart(months: number): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString();
}

async function backfill(
  svc: SupabaseClient,
  userId: string,
  months: number,
): Promise<BackfillResult> {
  const announcers = await loadAnnouncers(svc);
  if (announcers.length === 0) {
    // Failing loudly rather than returning four zeros: an admin who just ran a
    // backfill and got nothing needs to know it was configuration and not an
    // empty mailbox.
    throw new HttpError(
      400,
      "No presence announcers are configured. Add the sender of the absence emails in Settings first.",
      "no_announcers",
    );
  }
  const roster = await loadRoster(svc);

  const accessToken = await tokenForUser(svc, userId);
  const since = windowStart(months);

  const result: BackfillResult = {
    examined: 0,
    presenceEmails: 0,
    rowsWritten: 0,
    unresolvedNames: [],
  };
  // Keyed on the lowercase name so "Vidhya" and "vidhya" are one entry to add
  // to the roster, but holding the first spelling seen so the UI shows the name
  // the way the office actually writes it.
  const unresolved = new Map<string, string>();

  for (const announcer of announcers) {
    const budget = MAX_EXAMINED - result.examined;
    if (budget <= 0) break;

    const messages = await listMessagesFromSender(
      accessToken,
      announcer,
      since,
      budget,
    );

    for (const m of messages) {
      result.examined += 1;
      if (!m.id) continue;
      if (
        !isPresenceEmail({
          fromEmail: m.fromEmail,
          subject: m.subject,
          body: m.bodyPreview,
          announcerEmails: announcers,
        })
      ) continue;

      result.presenceEmails += 1;

      try {
        // Full body, for the same reason mail-sync fetches it: bodyPreview cuts
        // the multi-person notices off part way down the list. Read, extracted,
        // and gone at the end of this block — never written anywhere.
        const text = await getMessageBody(accessToken, m.id);
        const facts = extractPresence({
          subject: m.subject,
          body: text,
          sentAt: m.receivedAt ?? "",
          fromEmail: m.fromEmail,
        });
        // Same identity rule as mail-sync. It matters more here: a backfill
        // re-reads mail the scheduled sync has already filed, so if the two
        // paths keyed rows differently every historic absence would be
        // duplicated rather than replaced.
        const source = presenceSource(
          m.internetMessageId,
          m.id,
          resolveFacts(facts, roster),
        );
        result.rowsWritten += await storePresence(svc, source.messageId, source.rows);

        // Iterate the SAME rows that were stored, not the pre-source ones:
        // presenceSource can rewrite a row (adding needs_review and a note when
        // the message carried no Message-ID), and the unresolved-name list an
        // admin acts on should reflect what actually landed in the table.
        for (const row of source.rows) {
          // staff_id null covers both "nobody on the roster answers to this"
          // and "two people do" — either way the roster cannot resolve it as
          // written, which is exactly what an admin needs to see. The blank
          // name from an unparseable clause is skipped: it is a real review
          // item, but it is not something anyone can add to the roster.
          if (row.staff_id === null && row.raw_name) {
            const key = row.raw_name.toLowerCase();
            if (!unresolved.has(key)) unresolved.set(key, row.raw_name);
          }
        }
      } catch (e) {
        // One bad message must not abandon the other 499. The counts stay
        // honest — the email was examined and recognised, it just wrote nothing.
        console.error(`presence-backfill: message ${m.id} failed`, e);
      }
    }
  }

  result.unresolvedNames = [...unresolved.values()].sort((a, b) =>
    a.localeCompare(b)
  );
  return result;
}

/**
 * An access token for the caller's own connected mailbox.
 *
 * Delegated, always the admin's own `/me` — a backfill reads months of somebody
 * else's inbox only if that somebody is the person who asked for it. The
 * announcer mails are sent to all staff, so any connected mailbox holds them.
 */
async function tokenForUser(
  svc: SupabaseClient,
  userId: string,
): Promise<string> {
  const { data, error } = await svc
    .from("mail_accounts")
    .select("refresh_token")
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

  const { accessToken, refreshToken } = await accessTokenFromRefresh(
    String((data as { refresh_token: string }).refresh_token),
  );
  // Microsoft rotates refresh tokens and the old one is on a short fuse once it
  // does. Persist before anything else can fail — see accessTokenFromRefresh.
  if (refreshToken) {
    const { error: uErr } = await svc
      .from("mail_accounts")
      .update({ refresh_token: refreshToken })
      .eq("user_id", userId);
    if (uErr) {
      throw new HttpError(500, "Could not save the refreshed mailbox token");
    }
  }
  return accessToken;
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
