// POST { requestId, decision: "approved" | "declined", note? } — approve or
// decline a leave request.
//
// This is the moment a request becomes a fact on the presence board, so the
// order of operations is the design:
//
//   1. Authorise. Only the named approver or an admin, and NEVER the requester.
//   2. Check it is still pending.
//   3. Write the decision and rebuild the presence rows, atomically, in
//      apply_leave_decision (0010).
//   4. THEN write the emails — and never let step 4 undo step 3.
//
// That last point is the one worth spelling out. The decision is the source of
// truth; the drafts are how people find out about it. A draft that fails to be
// created is an inconvenience somebody notices immediately (there is nothing in
// Drafts). A decision rolled back because a draft failed is a lie: the manager
// saw "approved", the requester was told nothing, and the board disagrees with
// both. So every draft is attempted inside its own try/catch and every failure
// becomes a string in `draftWarnings` rather than an error status.
//
// Nothing here sends. graphMail.ts has no send helper and the OAuth grant does
// not include Mail.Send, so an approval can address the entire company and the
// worst it can do is put a message in the approver's Drafts folder for them to
// read and press Send on. That guarantee is what makes an automated all-staff
// email acceptable at all.

import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { HttpError, requireActiveUser, serviceClient } from "../_shared/auth.ts";
import {
  expandLeaveToPresence,
  type LeaveDayPart,
  type LeaveRequestInput,
  type LeaveType,
  type PresenceRowForRequest,
  type RosterPerson,
} from "../_shared/leave.ts";
import { accessTokenFromRefresh, createNewDraft } from "../_shared/graphMail.ts";
import { allStaffNotice, type LeavePerson, requesterConfirmation } from "../_shared/leaveDrafts.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/**
 * The all-staff distribution list. Confirmed from the real notices in this
 * mailbox rather than guessed — the absence emails the presence board is built
 * on are addressed here, so a draft to any other address would be a different
 * email that nobody reads.
 */
const ALL_STAFF = "Allstaff@jadegroup.mu";

const ROSTER_COLUMNS = "id,known_as,full_name,email,department,manager_id,is_manager,active";

interface LeaveRequestRow {
  id: string;
  requester_staff_id: string;
  submitted_by_profile_id: string;
  leave_type: string;
  start_date: string;
  end_date: string;
  day_part: string;
  reason: string | null;
  status: string;
  approver_staff_id: string | null;
}

interface RequesterRow extends RosterPerson {
  email: string | null;
}

Deno.serve(async (req: Request) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");

    const { user, profile } = await requireActiveUser(req);
    const body = await req.json().catch(() => ({} as Record<string, unknown>));

    const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
    if (!requestId) throw new HttpError(400, "requestId is required.");

    const decision = body.decision;
    if (decision !== "approved" && decision !== "declined") {
      throw new HttpError(400, 'decision must be "approved" or "declined".');
    }
    const note = typeof body.note === "string" ? body.note.trim() : "";

    const svc = serviceClient();
    const isAdmin = profile.role === "admin";

    const request = await loadRequest(svc, requestId);
    const callerStaffId = await staffIdForProfile(svc, user.id);

    // ---- authorisation ----------------------------------------------------

    const isApprover = Boolean(
      request.approver_staff_id && callerStaffId &&
        request.approver_staff_id === callerStaffId,
    );
    if (!isApprover && !isAdmin) {
      throw new HttpError(
        403,
        "Only the approver named on this request, or an admin, can decide it.",
        "not_approver",
      );
    }

    // Self-approval, blocked here as well as in resolveApprover.
    //
    // resolveApprover already refuses to ROUTE a request to its own requester,
    // but routing is not the only way to arrive at this endpoint: an admin can
    // decide any request, and `approver_staff_id` can be null. This is the last
    // gate before the board changes, and the failure it prevents is invisible
    // afterwards — an approved absence looks identical whether a manager
    // considered it or the requester clicked their own button.
    //
    // Deliberately absolute, including for an admin with a null approver. That
    // does leave an admin unable to approve their own leave at all; the answer
    // is another admin, not a special case, because the special case is exactly
    // the thing that would get used every time.
    if (callerStaffId && request.requester_staff_id === callerStaffId) {
      throw new HttpError(
        403,
        "You cannot decide your own leave request. Ask another manager or admin to decide it.",
        "self_decision",
      );
    }

    // A manager with the queue open in two tabs must not approve twice — and
    // the second click must not silently overwrite the first decision, or the
    // note attached to it.
    if (request.status !== "pending") {
      throw new HttpError(
        409,
        `This request has already been ${request.status}.`,
        "not_pending",
      );
    }

    const requester = await loadRequester(svc, request.requester_staff_id);

    // ---- the decision, and the board --------------------------------------

    const input: LeaveRequestInput = {
      leaveType: request.leave_type as LeaveType,
      startDate: request.start_date,
      endDate: request.end_date,
      dayPart: request.day_part as LeaveDayPart,
      reason: request.reason ?? undefined,
    };
    // A decline writes nothing. apply_leave_decision deletes every row the
    // request owns before it looks at the status, so passing an empty array is
    // also how a reversal removes days that were previously approved.
    const rows: PresenceRowForRequest[] = decision === "approved"
      ? expandLeaveToPresence(input, requester)
      : [];

    const { data: written, error: rpcErr } = await svc.rpc("apply_leave_decision", {
      p_request_id: request.id,
      p_status: decision,
      p_decided_by: user.id,
      p_note: note || null,
      p_rows: rows,
    });
    if (rpcErr) {
      // Nothing has been emailed yet, which is why the drafts come after this
      // call and not before: a failed decision must leave no trace anywhere.
      throw new HttpError(500, `Could not record the decision: ${rpcErr.message}`);
    }
    const rowsWritten = Number(written ?? 0);

    // ---- the emails, which may not undo any of the above -------------------

    const drafts: { allStaff: string | null; requester: string | null } = {
      allStaff: null,
      requester: null,
    };
    const draftWarnings: string[] = [];

    const person: LeavePerson = {
      known_as: requester.known_as,
      full_name: requester.full_name,
      email: requester.email,
    };

    const accessToken = await mailboxToken(svc, user.id, draftWarnings);
    if (accessToken) {
      if (decision === "approved") {
        // Only an approval is anyone else's business. A declined request is
        // between the requester and their manager, and broadcasting it would
        // be a small cruelty the office has never committed by email either.
        try {
          const notice = allStaffNotice(
            person,
            request.leave_type,
            request.start_date,
            request.end_date,
            request.day_part,
          );
          drafts.allStaff = await createNewDraft(
            accessToken,
            [ALL_STAFF],
            notice.subject,
            notice.bodyHtml,
          );
        } catch (e) {
          draftWarnings.push(
            `The all-staff notice could not be drafted: ${messageOf(e)}`,
          );
        }
      }

      // Drafted for a decline too. The requester is the one person who has to
      // be told either way — a decline that reaches nobody is a request that
      // just sits there looking pending to the person who filed it.
      if (person.email && person.email.trim()) {
        try {
          const confirmation = requesterConfirmation(
            person,
            request.leave_type,
            request.start_date,
            request.end_date,
            request.day_part,
            decision,
            note || null,
          );
          drafts.requester = await createNewDraft(
            accessToken,
            [person.email.trim()],
            confirmation.subject,
            confirmation.bodyHtml,
          );
        } catch (e) {
          draftWarnings.push(
            `The confirmation to ${displayName(requester)} could not be drafted: ${messageOf(e)}`,
          );
        }
      } else {
        // Normal, not exceptional: most of the roster has no mailbox. Said out
        // loud so whoever approved it knows to tell them in person.
        draftWarnings.push(
          `${displayName(requester)} has no email address on the roster, ` +
            "so no confirmation was drafted — let them know directly.",
        );
      }
    }

    return jsonResponse({
      requestId: request.id,
      status: decision,
      rowsWritten,
      drafts,
      draftWarnings,
    });
  } catch (e) {
    return errorResponse(e);
  }
});

// ---------------------------------------------------------------------------

function displayName(person: { known_as: string; full_name: string }): string {
  return (person.known_as ?? "").trim() || (person.full_name ?? "").trim() || "This person";
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function loadRequest(
  svc: SupabaseClient,
  requestId: string,
): Promise<LeaveRequestRow> {
  const { data, error } = await svc
    .from("leave_requests")
    .select(
      "id,requester_staff_id,submitted_by_profile_id,leave_type,start_date,end_date,day_part,reason,status,approver_staff_id",
    )
    .eq("id", requestId)
    .maybeSingle();
  if (error) throw new HttpError(500, "Could not load the leave request.");
  if (!data) throw new HttpError(404, "That leave request no longer exists.");
  return data as unknown as LeaveRequestRow;
}

/** The caller's own roster id, or null when their login is not linked. */
async function staffIdForProfile(
  svc: SupabaseClient,
  profileId: string,
): Promise<string | null> {
  const { data, error } = await svc
    .from("staff_directory")
    .select("id")
    .eq("profile_id", profileId)
    .eq("active", true)
    .maybeSingle();
  if (error) throw new HttpError(500, "Could not load your staff record.");
  return data ? String((data as { id: string }).id) : null;
}

/**
 * The person the leave is for.
 *
 * Not filtered on `active`, unlike every other roster read here: a request
 * filed before somebody was deactivated still has to be decidable, and refusing
 * would leave it pending forever with no way to clear it.
 */
async function loadRequester(
  svc: SupabaseClient,
  staffId: string,
): Promise<RequesterRow> {
  const { data, error } = await svc
    .from("staff_directory")
    .select(ROSTER_COLUMNS)
    .eq("id", staffId)
    .maybeSingle();
  if (error) throw new HttpError(500, "Could not load the requester's staff record.");
  if (!data) throw new HttpError(404, "The staff member this request belongs to no longer exists.");
  return data as unknown as RequesterRow;
}

/**
 * An access token for the DECIDING user's own mailbox, or null.
 *
 * Delegated OAuth means `/me` and nothing else, so the drafts land in the
 * Drafts folder of whoever pressed Approve. That is the only mailbox this
 * function can reach, and it is the right one: the person who made the decision
 * is the person who should read the email before it goes out.
 *
 * Returns null with a warning rather than throwing. Not having a mailbox
 * connected is a perfectly ordinary state for a manager who only ever uses the
 * board, and it must not be able to fail a decision that has already been
 * written.
 */
async function mailboxToken(
  svc: SupabaseClient,
  userId: string,
  warnings: string[],
): Promise<string | null> {
  try {
    const { data, error } = await svc
      .from("mail_accounts")
      .select("refresh_token")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      warnings.push(
        "No mailbox is connected to your account, so no drafts were created. " +
          "Connect your mailbox from the Email page to have them written for you.",
      );
      return null;
    }

    const { accessToken, refreshToken } = await accessTokenFromRefresh(
      String((data as { refresh_token: string }).refresh_token),
    );
    // Microsoft rotates refresh tokens and puts the old one on a short fuse the
    // moment it does — persist before anything else can fail.
    if (refreshToken) {
      const { error: uErr } = await svc
        .from("mail_accounts")
        .update({ refresh_token: refreshToken })
        .eq("user_id", userId);
      if (uErr) console.error("leave-decide: could not persist rotated token", uErr);
    }
    return accessToken;
  } catch (e) {
    warnings.push(`Your mailbox could not be reached, so no drafts were created: ${messageOf(e)}`);
    return null;
  }
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
