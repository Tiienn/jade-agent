// POST { requestId } — withdraw a leave request.
//
// The whole of this function is one trap, called out in 0010's comment on
// apply_leave_decision: `source_request_id` cascades when the REQUEST ROW is
// deleted, and cancelling does not delete the row, it sets a status. So a
// cancel that only writes `status = 'cancelled'` leaves every approved day of
// that leave sitting on the presence board forever, pointing at a request that
// says it was withdrawn, with no screen anywhere that can remove them.
//
// So this deletes the request's staff_presence rows too. Two statements rather
// than an RPC, because the operation is small enough that the failure modes are
// easier to reason about here than in another migration — and the ORDER is what
// makes that safe:
//
//   delete the presence rows FIRST, then update the status.
//
// If the second statement fails, the request still reads 'approved' while the
// board shows the person at their desk. That is the harmless direction: they
// cancelled, so they ARE at their desk, and the client can simply call again —
// the delete is idempotent and the update is the only thing left to do. The
// other order fails the other way: a request marked cancelled with its days
// still on the board, which is the exact state this function exists to prevent
// and which a retry would no longer detect.

import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { HttpError, requireActiveUser, serviceClient } from "../_shared/auth.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

interface LeaveRequestRow {
  id: string;
  requester_staff_id: string;
  submitted_by_profile_id: string;
  status: string;
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

    const svc = serviceClient();
    const request = await loadRequest(svc, requestId);
    const callerStaffId = await staffIdForProfile(svc, user.id);

    const isRequester = Boolean(
      callerStaffId && request.requester_staff_id === callerStaffId,
    );
    if (!isRequester && profile.role !== "admin") {
      // Deliberately narrower than the read policy in 0010, which also lets the
      // approver and the submitter see a request. Seeing somebody's leave is not
      // the same as withdrawing it: a manager who disagrees with a request
      // declines it, on the record, rather than making it disappear.
      throw new HttpError(
        403,
        "Only the person the leave is for, or an admin, can cancel it.",
        "not_requester",
      );
    }

    // Idempotent rather than a 409. Cancelling is the one action where a second
    // click means exactly what the first one meant, and the second tab that
    // sends it should be told the same thing as the first, not shown an error
    // about a state it already wanted.
    if (request.status === "cancelled") {
      return jsonResponse({ requestId: request.id, status: "cancelled", presenceRowsRemoved: 0 });
    }

    // 1. The board first — see the header for why this order and not the other.
    const { data: removed, error: delErr } = await svc
      .from("staff_presence")
      .delete()
      .eq("source_request_id", request.id)
      .select("id");
    if (delErr) {
      throw new HttpError(500, "Could not remove the leave days from the presence board.");
    }

    // 2. Then the request itself.
    const { error: updErr } = await svc
      .from("leave_requests")
      .update({ status: "cancelled" })
      .eq("id", request.id);
    if (updErr) {
      throw new HttpError(
        500,
        "The leave days were removed from the board but the request could not be marked cancelled. Try again.",
      );
    }

    return jsonResponse({
      requestId: request.id,
      status: "cancelled",
      presenceRowsRemoved: (removed ?? []).length,
    });
  } catch (e) {
    return errorResponse(e);
  }
});

// ---------------------------------------------------------------------------

async function loadRequest(
  svc: SupabaseClient,
  requestId: string,
): Promise<LeaveRequestRow> {
  const { data, error } = await svc
    .from("leave_requests")
    .select("id,requester_staff_id,submitted_by_profile_id,status")
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

function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) {
    const payload: Record<string, unknown> = { error: e.message };
    if (e.code) payload.code = e.code;
    return jsonResponse(payload, e.status);
  }
  const message = e instanceof Error ? e.message : "Server error";
  return jsonResponse({ error: message }, 500);
}
