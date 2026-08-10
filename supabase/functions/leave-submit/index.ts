// POST { requesterStaffId?, leaveType, startDate, endDate, dayPart, reason? }
// — file a leave request.
//
// All the rules live in _shared/leave.ts, which is pure and tested. This
// function is the plumbing around them: work out WHO the request is for, load
// the roster, run the rules, warn about days already on the board, and insert.
//
// Two things here are security decisions rather than convenience:
//
//   * The requester is resolved from the session, not from the body. A client
//     that could name an arbitrary requester could file leave in a colleague's
//     name — and, worse, have it routed to and approved by that colleague's
//     manager without either of them typing anything. Naming somebody else is
//     therefore an admin action, and admins do need it: only three of eighteen
//     staff have a login, so the guards and site staff are filed for.
//   * The insert uses the service role. That is not laziness about RLS — 0010
//     deliberately gives leave_requests no write policy for any role, because a
//     client that could INSERT would name itself as its own approver. Read the
//     comment on the table in that migration before changing this.

import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { HttpError, requireActiveUser, serviceClient } from "../_shared/auth.ts";
import {
  expandLeaveToPresence,
  type LeaveDayPart,
  type LeaveRequestInput,
  type LeaveType,
  overlappingDates,
  resolveApprover,
  type RosterPerson,
  validateLeaveRequest,
} from "../_shared/leave.ts";
// Reused, never reimplemented. Mauritius is UTC+4 with no DST and presence.ts
// already encodes that; a second copy of the offset here is a second thing to
// get wrong, and every date rule in leave.ts is measured against this value.
import { mauritiusDate } from "../_shared/presence.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** staff_directory columns the rules and the response need. */
const ROSTER_COLUMNS = "id,known_as,full_name,department,manager_id,is_manager,active";

Deno.serve(async (req: Request) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");

    const { user, profile } = await requireActiveUser(req);
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const svc = serviceClient();

    // ---- who is this request for? ----------------------------------------

    const callerStaff = await staffRowForProfile(svc, user.id);
    const asked = typeof body.requesterStaffId === "string" ? body.requesterStaffId.trim() : "";

    let requesterStaffId: string;
    if (!asked) {
      if (!callerStaff) {
        // Expected to be common at first — most people have no login, and the
        // few that do are not linked to a roster row until an admin does it.
        // A machine code so the UI can offer the right next step rather than
        // showing a wall of text.
        throw new HttpError(
          400,
          "Your login is not linked to a staff record yet, so we do not know whose leave this is. " +
            "Ask an admin to link your account to your name on the staff list.",
          "not_on_roster",
        );
      }
      requesterStaffId = callerStaff.id;
    } else if (callerStaff && asked === callerStaff.id) {
      requesterStaffId = asked;
    } else {
      // Filing for somebody else. See the header: this is the whole reason the
      // check exists, and it is not softened for "the office manager" or any
      // other role — admin or nothing.
      if (profile.role !== "admin") {
        throw new HttpError(
          403,
          "Only an admin can file a leave request on behalf of someone else.",
          "not_own_request",
        );
      }
      requesterStaffId = asked;
    }

    // ---- the roster -------------------------------------------------------

    const roster = await loadRoster(svc);
    const requester = roster.find((p) => p.id === requesterStaffId);
    if (!requester) {
      throw new HttpError(
        404,
        "That staff member is not on the active roster.",
        "requester_not_found",
      );
    }

    // ---- the rules --------------------------------------------------------

    const input: LeaveRequestInput = {
      leaveType: String(body.leaveType ?? "") as LeaveType,
      startDate: String(body.startDate ?? ""),
      endDate: String(body.endDate ?? ""),
      dayPart: String(body.dayPart ?? "full") as LeaveDayPart,
      reason: typeof body.reason === "string" ? body.reason : undefined,
    };

    const today = mauritiusDate(new Date().toISOString());
    const validation = validateLeaveRequest(input, today);
    if (!validation.ok) {
      // Every problem at once, not the first one. validateLeaveRequest collects
      // them for a reason (see its doc comment) and it would be wasted if this
      // handler only surfaced one.
      return jsonResponse({
        error: validation.errors[0] ?? "That request cannot be filed.",
        code: "validation",
        errors: validation.errors,
      }, 400);
    }

    // A null approver is an ANSWER, not a failure — it means an admin decides
    // this one, and `reason` says why. Refusing the request instead would send
    // the person straight back to email, which is the outcome the whole feature
    // exists to avoid.
    const approver = resolveApprover(requester, roster);
    const approverName = approver.approverId
      ? displayName(roster.find((p) => p.id === approver.approverId))
      : null;

    // ---- double-booking warning ------------------------------------------

    const rows = expandLeaveToPresence(input, requester);
    const overlaps = overlappingDates(
      rows,
      await existingPresenceDates(svc, requester.id, rows.map((r) => r.on_date)),
    );

    // ---- insert -----------------------------------------------------------

    const { data: created, error: insErr } = await svc
      .from("leave_requests")
      .insert({
        requester_staff_id: requester.id,
        // Who TYPED it, kept separate from who it is FOR. 0010 explains why
        // both are stored: it is the difference between a record and a claim
        // the moment anybody disputes an on-behalf-of filing.
        submitted_by_profile_id: user.id,
        leave_type: input.leaveType,
        start_date: input.startDate,
        end_date: input.endDate,
        day_part: input.dayPart,
        reason: (input.reason ?? "").trim() || null,
        approver_staff_id: approver.approverId,
        status: "pending",
      })
      .select("id")
      .single();
    if (insErr || !created) {
      throw new HttpError(500, "Could not file the leave request.");
    }

    return jsonResponse({
      requestId: String((created as { id: string }).id),
      status: "pending",
      approverId: approver.approverId,
      approverName,
      approverReason: approver.reason,
      overlaps,
    });
  } catch (e) {
    return errorResponse(e);
  }
});

// ---------------------------------------------------------------------------

function displayName(person: RosterPerson | undefined): string | null {
  if (!person) return null;
  return (person.known_as ?? "").trim() || (person.full_name ?? "").trim() || null;
}

/** The caller's own roster row, or null when their login is not linked. */
async function staffRowForProfile(
  svc: SupabaseClient,
  profileId: string,
): Promise<RosterPerson | null> {
  const { data, error } = await svc
    .from("staff_directory")
    .select(ROSTER_COLUMNS)
    .eq("profile_id", profileId)
    // A deactivated person keeps their history but stops being a live actor,
    // exactly as current_staff_id() in 0010 decides it.
    .eq("active", true)
    .maybeSingle();
  if (error) throw new HttpError(500, "Could not load your staff record.");
  return data ? (data as unknown as RosterPerson) : null;
}

/**
 * The whole active roster.
 *
 * resolveApprover needs everyone, not just the requester: it follows manager_id
 * and, failing that, looks for the department's manager, both of which are
 * questions about other rows. Loading eighteen rows is cheaper than two round
 * trips and keeps the rules pure.
 */
async function loadRoster(svc: SupabaseClient): Promise<RosterPerson[]> {
  const { data, error } = await svc
    .from("staff_directory")
    .select(ROSTER_COLUMNS)
    .eq("active", true);
  if (error) throw new HttpError(500, "Could not load the staff roster.");
  return (data ?? []) as unknown as RosterPerson[];
}

/**
 * Dates this person is already recorded absent for, among the ones proposed.
 *
 * Scoped to the proposed dates rather than fetching a person's whole history:
 * the answer is only ever used to warn about the days in front of the approver.
 * Failure here is swallowed to an empty list — the warning is a courtesy, and
 * losing it must not stop somebody filing leave.
 */
async function existingPresenceDates(
  svc: SupabaseClient,
  staffId: string,
  dates: string[],
): Promise<string[]> {
  if (dates.length === 0) return [];
  const { data, error } = await svc
    .from("staff_presence")
    .select("on_date")
    .eq("staff_id", staffId)
    .in("on_date", dates);
  if (error) {
    console.error("leave-submit: overlap check failed", error);
    return [];
  }
  return (data ?? []).map((r) => String((r as { on_date: string }).on_date));
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
