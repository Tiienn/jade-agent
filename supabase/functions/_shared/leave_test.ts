// Deno tests for the pure leave-request rules.
// Run: deno test supabase/functions/_shared/leave_test.ts
//
// Three groups, matching the three decisions in leave.ts: is the request
// answerable, who answers it, and what "yes" writes on the board.
//
// What these tests protect is different from what presenceStore_test.ts
// protects. There, the failure mode was a doubtful row that looked confident.
// Here it is an APPROVAL that never happened — a request that routed back to
// the person who filed it, or a range that quietly expanded to nothing and
// looked approved anyway. Neither throws, neither fails a sync, and neither is
// visible on the board: an absence approved by nobody looks exactly like an
// absence approved by a manager.
//
// Every date below is a real weekday in August 2026, named in the comment where
// it matters, because half of these rules are about which day of the week a
// date falls on and a bare YYYY-MM-DD tells the next reader nothing.

import { assertEquals } from "jsr:@std/assert@1";
import {
  expandLeaveToPresence,
  type LeaveRequestInput,
  overlappingDates,
  type PresenceRowForRequest,
  resolveApprover,
  type RosterPerson,
  validateLeaveRequest,
} from "./leave.ts";

/** Monday 10 August 2026. Every "today" in this file. */
const TODAY = "2026-08-10";

// The week TODAY sits in, so no test has to work out a weekday in its head:
//   Fri 07 | Sat 08 | Sun 09 | MON 10 | Tue 11 | Wed 12 | Thu 13 | Fri 14 |
//   Sat 15 | Sun 16 | Mon 17
const FRI_07 = "2026-08-07";
const SAT_08 = "2026-08-08";
const SUN_09 = "2026-08-09";
const MON_10 = "2026-08-10";
const TUE_11 = "2026-08-11";
const WED_12 = "2026-08-12";
const THU_13 = "2026-08-13";
const FRI_14 = "2026-08-14";
const SAT_15 = "2026-08-15";
const SUN_16 = "2026-08-16";
const MON_17 = "2026-08-17";

function req(over: Partial<LeaveRequestInput> = {}): LeaveRequestInput {
  return {
    leaveType: "local_leave",
    startDate: MON_10,
    endDate: MON_10,
    dayPart: "full",
    ...over,
  };
}

/** Did validation complain about this, whatever the wording? Asserting on a
 * substring rather than the whole sentence keeps these tests about the RULE —
 * the message is UI copy and will be reworded. */
function complains(errors: string[], fragment: string): boolean {
  return errors.some((e) => e.toLowerCase().includes(fragment.toLowerCase()));
}

// ---------------------------------------------------------------------------
// validateLeaveRequest
// ---------------------------------------------------------------------------

Deno.test("validate: an ordinary single day is accepted", () => {
  assertEquals(validateLeaveRequest(req(), TODAY), { ok: true, errors: [] });
});

Deno.test("validate: an ordinary week is accepted", () => {
  const v = validateLeaveRequest(req({ startDate: MON_10, endDate: FRI_14 }), TODAY);
  assertEquals(v, { ok: true, errors: [] });
});

Deno.test("validate: an end before the start is refused", () => {
  const v = validateLeaveRequest(req({ startDate: FRI_14, endDate: MON_10 }), TODAY);
  assertEquals(v.ok, false);
  assertEquals(complains(v.errors, "before the start"), true);
});

Deno.test("validate: a backwards range reports ONE problem, not three", () => {
  // A negative span is also "no working days" and also a length violation, and
  // saying all three describes one mistake three times. The requester has to be
  // able to read the list.
  const v = validateLeaveRequest(req({ startDate: FRI_14, endDate: MON_10 }), TODAY);
  assertEquals(v.errors.length, 1);
});

Deno.test("validate: a half day over more than one day is refused", () => {
  for (const dayPart of ["am", "pm"] as const) {
    const v = validateLeaveRequest(
      req({ dayPart, startDate: MON_10, endDate: TUE_11 }),
      TODAY,
    );
    assertEquals(v.ok, false);
    assertEquals(complains(v.errors, "half day is a single day"), true);
  }
});

Deno.test("validate: a half day on a single day is fine", () => {
  for (const dayPart of ["am", "pm"] as const) {
    assertEquals(validateLeaveRequest(req({ dayPart }), TODAY).ok, true);
  }
});

Deno.test("validate: a 90-day range is accepted and a 91-day range is not", () => {
  // The boundary, not the middle. 90 is counted inclusively: Monday 10 August
  // 2026 through Saturday 7 November is ninety calendar days with both ends
  // counted. Getting this off by one either refuses a legitimate long leave —
  // maternity, a long trip home — or lets a mistyped year through, and only one
  // of those two is ever reported as a bug.
  const ninety = validateLeaveRequest(
    req({ startDate: MON_10, endDate: "2026-11-07" }),
    TODAY,
  );
  assertEquals(ninety, { ok: true, errors: [] });

  const ninetyOne = validateLeaveRequest(
    req({ startDate: MON_10, endDate: "2026-11-08" }),
    TODAY,
  );
  assertEquals(ninetyOne.ok, false);
  assertEquals(complains(ninetyOne.errors, "longer than 90 days"), true);
});

Deno.test("validate: a request wholly inside a weekend is refused", () => {
  // Saturday 15 to Sunday 16 August 2026. This one must be caught HERE: it
  // expands to zero rows, so approving it would record nothing at all while
  // looking, to everybody involved, exactly like an approval that worked.
  const v = validateLeaveRequest(req({ startDate: SAT_15, endDate: SUN_16 }), TODAY);
  assertEquals(v.ok, false);
  assertEquals(complains(v.errors, "no working days"), true);
});

Deno.test("validate: a single Saturday is refused for the same reason", () => {
  const v = validateLeaveRequest(req({ startDate: SAT_08, endDate: SAT_08 }), TODAY);
  assertEquals(v.ok, false);
  assertEquals(complains(v.errors, "no working days"), true);
});

Deno.test("validate: a range that merely spans a weekend is fine", () => {
  // Friday 14 to Monday 17: the weekend is inside it but the range is not.
  assertEquals(
    validateLeaveRequest(req({ startDate: FRI_14, endDate: MON_17 }), TODAY).ok,
    true,
  );
});

Deno.test("validate: a start more than 12 months ahead is refused, 12 months exactly is not", () => {
  const ok = validateLeaveRequest(
    req({ startDate: "2027-08-10", endDate: "2027-08-10" }), // Tuesday, one year out
    TODAY,
  );
  assertEquals(ok, { ok: true, errors: [] });

  const tooFar = validateLeaveRequest(
    req({ startDate: "2027-08-11", endDate: "2027-08-11" }),
    TODAY,
  );
  assertEquals(tooFar.ok, false);
  assertEquals(complains(tooFar.errors, "12 months"), true);
});

Deno.test("validate: filing for last Friday is allowed", () => {
  // The rule this file cares about most. Sick leave and permission are filed
  // the same morning or a day or three late, by definition — nobody plans flu.
  // Refusing a backdated request would send exactly those people back to
  // announcing absences by email, which is the thing the board replaced.
  assertEquals(
    validateLeaveRequest(req({ leaveType: "sick", startDate: FRI_07, endDate: FRI_07 }), TODAY).ok,
    true,
  );
});

Deno.test("validate: filing for this morning is allowed", () => {
  assertEquals(validateLeaveRequest(req({ startDate: TODAY, endDate: TODAY }), TODAY).ok, true);
});

Deno.test("validate: 60 days back is allowed and 61 is not", () => {
  // Thursday 11 June 2026 is exactly 60 days before Monday 10 August.
  assertEquals(
    validateLeaveRequest(req({ startDate: "2026-06-11", endDate: "2026-06-11" }), TODAY).ok,
    true,
  );

  const tooOld = validateLeaveRequest(
    req({ startDate: "2026-06-10", endDate: "2026-06-10" }),
    TODAY,
  );
  assertEquals(tooOld.ok, false);
  assertEquals(complains(tooOld.errors, "days ago"), true);
});

Deno.test("validate: every problem is reported at once", () => {
  // A form that reveals one problem per submission takes three round trips to
  // file one day of leave, and the fourth attempt is an email.
  const v = validateLeaveRequest(
    req({ dayPart: "am", startDate: SAT_15, endDate: SUN_16 }),
    TODAY,
  );
  assertEquals(v.ok, false);
  assertEquals(complains(v.errors, "no working days"), true);
  assertEquals(complains(v.errors, "half day is a single day"), true);
  assertEquals(v.errors.length >= 2, true);
});

Deno.test("validate: malformed dates are errors, never exceptions", () => {
  for (const bad of ["", "   ", "not a date", "10/08/2026", "2026-8-10", "2026-02-30"]) {
    const v = validateLeaveRequest(req({ startDate: bad, endDate: bad }), TODAY);
    assertEquals(v.ok, false, `expected ${JSON.stringify(bad)} to be refused`);
    assertEquals(complains(v.errors, "not a real date"), true);
  }
});

Deno.test("validate: the 30th of February is refused rather than rolled into March", () => {
  // Date.parse happily turns 2026-02-30 into the 2nd of March. Accepting it
  // would book somebody off on a day they never asked for.
  const v = validateLeaveRequest(req({ startDate: "2026-02-30", endDate: "2026-02-30" }), TODAY);
  assertEquals(v.ok, false);
});

Deno.test("validate: a missing end date does not suppress the start date's error", () => {
  const v = validateLeaveRequest(req({ startDate: "nope", endDate: "" }), TODAY);
  assertEquals(v.errors.length, 2);
});

Deno.test("validate: an unusable `today` is reported rather than silently skipped", () => {
  // A caller bug, not a user one — but skipping the past/future checks in
  // silence would let a request dated 2019 straight through.
  const v = validateLeaveRequest(req(), "not a date");
  assertEquals(v.ok, false);
  assertEquals(complains(v.errors, "today"), true);
});

Deno.test("validate: an unknown leave type or day part is refused, not passed to the database", () => {
  // status and day_part both carry CHECK constraints (0006, 0009). Without this
  // an unrecognised value survives to the insert and comes back as a database
  // error with no field attached to it.
  const badType = validateLeaveRequest(
    { ...req(), leaveType: "sabbatical" } as unknown as LeaveRequestInput,
    TODAY,
  );
  assertEquals(badType.ok, false);
  assertEquals(complains(badType.errors, "not a leave type"), true);

  const badPart = validateLeaveRequest(
    { ...req(), dayPart: "evening" } as unknown as LeaveRequestInput,
    TODAY,
  );
  assertEquals(badPart.ok, false);
  assertEquals(complains(badPart.errors, "not a valid day part"), true);
});

Deno.test("validate: every requestable leave type is accepted", () => {
  for (const leaveType of ["sick", "local_leave", "vacation_leave", "permission"] as const) {
    assertEquals(validateLeaveRequest(req({ leaveType }), TODAY).ok, true, leaveType);
  }
});

Deno.test("validate: a garbage object does not throw", () => {
  const v = validateLeaveRequest({} as unknown as LeaveRequestInput, TODAY);
  assertEquals(v.ok, false);
  assertEquals(v.errors.length > 0, true);
});

// ---------------------------------------------------------------------------
// resolveApprover
// ---------------------------------------------------------------------------
//
// The rule under test throughout is the one that cannot be seen from the
// outside: a requester is NEVER their own approver. Everything else here is
// routing, and routing to the wrong manager is embarrassing. Routing to
// yourself is a leave request with no approval in it, recorded on the board as
// though a manager had read it.

const AMIT = "11111111-1111-4111-8111-111111111111";
const PRIYA = "22222222-2222-4222-8222-222222222222";
const NAVIN = "33333333-3333-4333-8333-333333333333";
const RAJ = "44444444-4444-4444-8444-444444444444";
const LEELA = "55555555-5555-4555-8555-555555555555";
const SOLO = "66666666-6666-4666-8666-666666666666";

function person(over: Partial<RosterPerson> & { id: string }): RosterPerson {
  return {
    known_as: "Someone",
    full_name: "Some One",
    department: "Finance",
    manager_id: null,
    is_manager: false,
    active: true,
    ...over,
  };
}

const amit = person({
  id: AMIT,
  known_as: "Amit",
  full_name: "Amit Ramdhun",
  manager_id: PRIYA,
});
const priya = person({
  id: PRIYA,
  known_as: "Priya",
  full_name: "Priya Bhugaloo",
  is_manager: true,
  manager_id: NAVIN,
});
const navin = person({
  id: NAVIN,
  known_as: "Navin",
  full_name: "Navin Appadoo",
  department: "Executive",
  is_manager: true,
});

const ROSTER: RosterPerson[] = [amit, priya, navin];

Deno.test("approver: an explicit reporting line wins", () => {
  const out = resolveApprover(amit, ROSTER);
  assertEquals(out.approverId, PRIYA);
  // The reason is stored for audit and shown in the UI, so it has to name the
  // person, not just assert that routing happened.
  assertEquals(out.reason, "reports to Priya");
});

Deno.test("approver: a manager_id naming an INACTIVE person falls through to the department", () => {
  // Leavers are deactivated, never deleted (0006), so the FK never nulls the
  // pointer and the stale reporting line survives forever. Routing a request to
  // somebody who left means it is never approved and nobody is told why.
  const leela = person({
    id: LEELA,
    known_as: "Leela",
    full_name: "Leela Seeruttun",
    is_manager: true,
    active: false,
  });
  const orphan = person({ id: SOLO, known_as: "Kavi", full_name: "Kavi Naiko", manager_id: LEELA });

  const out = resolveApprover(orphan, [leela, priya, orphan]);
  assertEquals(out.approverId, PRIYA);
  assertEquals(out.reason, "department manager for Finance");
});

Deno.test("approver: a manager_id naming nobody at all falls through rather than throwing", () => {
  const orphan = person({
    id: SOLO,
    known_as: "Kavi",
    full_name: "Kavi Naiko",
    manager_id: "99999999-9999-4999-8999-999999999999",
  });
  const out = resolveApprover(orphan, [priya, orphan]);
  assertEquals(out.approverId, PRIYA);
});

Deno.test("approver: the department manager is used when no reporting line is set", () => {
  const staff = person({ id: SOLO, known_as: "Kavi", full_name: "Kavi Naiko" });
  const out = resolveApprover(staff, [priya, staff]);
  assertEquals(out.approverId, PRIYA);
  assertEquals(out.reason, "department manager for Finance");
});

Deno.test("approver: department matching survives an admin's stray capital and space", () => {
  // staff_directory.department is free text, so "Finance" and " finance " are
  // one department typed by two different admins on two different days.
  const staff = person({ id: SOLO, known_as: "Kavi", full_name: "Kavi Naiko", department: " finance " });
  const out = resolveApprover(staff, [priya, staff]);
  assertEquals(out.approverId, PRIYA);
});

Deno.test("approver: two managers in one department produce no approver and say why", () => {
  // Picking one would be a coin flip that lands on a real person's name in the
  // audit trail, and nothing downstream would ever reveal that it was a guess.
  const raj = person({ id: RAJ, known_as: "Raj", full_name: "Raj Mootoosamy", is_manager: true });
  // No reporting line, so the department rule is the one being exercised.
  const unassigned = person({ ...amit, manager_id: null });
  const out = resolveApprover(unassigned, [unassigned, priya, raj]);

  assertEquals(out.approverId, null);
  assertEquals(out.reason.includes("Priya"), true);
  assertEquals(out.reason.includes("Raj"), true);
  assertEquals(out.reason.includes("Finance"), true);
  assertEquals(out.reason.toLowerCase().includes("admin"), true);
});

Deno.test("approver: nobody to route to at all falls to an admin, with the cause named", () => {
  const loner = person({
    id: SOLO,
    known_as: "Kavi",
    full_name: "Kavi Naiko",
    department: null,
  });
  const out = resolveApprover(loner, [loner, priya]);
  assertEquals(out.approverId, null);
  assertEquals(out.reason.toLowerCase().includes("admin"), true);
  assertEquals(out.reason.includes("Kavi"), true);
});

Deno.test("approver: a department with no manager is a different message from no department", () => {
  // One is fixed on the roster, the other is just how a small department works.
  // The admin picking this up needs to be able to tell them apart.
  const staff = person({ id: SOLO, known_as: "Kavi", full_name: "Kavi Naiko", department: "Legal" });
  const out = resolveApprover(staff, [staff, priya]);
  assertEquals(out.approverId, null);
  assertEquals(out.reason.includes("Legal"), true);
});

Deno.test("approver: an empty roster does not throw", () => {
  const out = resolveApprover(amit, []);
  assertEquals(out.approverId, null);
  assertEquals(out.reason.length > 0, true);
});

// --- self-approval, the rule most likely to be broken by a later refactor ----

Deno.test("approver: a manager filing their own leave routes to THEIR manager", () => {
  const out = resolveApprover(priya, ROSTER);
  assertEquals(out.approverId, NAVIN);
  assertEquals(out.reason, "reports to Navin");
});

Deno.test("approver: the only manager in a department never approves their own leave", () => {
  // Priya is the Finance manager and has no manager of her own. The department
  // rule would hand her back to herself if it did not exclude the requester,
  // and the resulting request would be approved by nobody while looking exactly
  // like an approved one on the board.
  const orphanPriya = person({ ...priya, manager_id: null });
  const out = resolveApprover(orphanPriya, [amit, orphanPriya]);
  assertEquals(out.approverId, null);
  assertEquals(out.reason.toLowerCase().includes("admin"), true);
});

Deno.test("approver: a roster row whose manager_id points at itself does not self-approve", () => {
  // A data error somebody will eventually make in the admin UI. It must fall
  // through to the department rule, not hand out a rubber stamp.
  const selfManaged = person({ ...priya, manager_id: PRIYA });
  const out = resolveApprover(selfManaged, [amit, selfManaged]);
  assertEquals(out.approverId, null);
});

Deno.test("approver: no route ever returns the requester, whatever the roster says", () => {
  // The blanket version of the three tests above, run over every shape of
  // roster this module can be handed. If a later refactor drops one of the
  // `id !== requester.id` guards, this is what catches it.
  const raj = person({ id: RAJ, known_as: "Raj", full_name: "Raj Mootoosamy", is_manager: true });
  const rosters: RosterPerson[][] = [
    [],
    [priya],
    [amit, priya, navin],
    [person({ ...priya, manager_id: PRIYA })],
    [priya, raj],
    [person({ ...priya, manager_id: null }), amit],
  ];
  for (const roster of rosters) {
    for (const requester of [amit, priya, navin, person({ ...priya, manager_id: PRIYA })]) {
      assertEquals(
        resolveApprover(requester, roster).approverId === requester.id,
        false,
        `${requester.known_as} approved their own leave`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// expandLeaveToPresence
// ---------------------------------------------------------------------------

Deno.test("expand: Monday to Friday is five rows", () => {
  const rows = expandLeaveToPresence(req({ startDate: MON_10, endDate: FRI_14 }), amit);
  assertEquals(rows.map((r) => r.on_date), [MON_10, TUE_11, WED_12, THU_13, FRI_14]);
});

Deno.test("expand: Friday to Monday is two rows, not four", () => {
  // The whole weekend rule in one case. Writing Saturday and Sunday rows would
  // put a permanent block of grey across every long leave and train people to
  // stop reading the board — the same reasoning as expandDays in
  // presenceStore.ts, which this deliberately matches.
  const rows = expandLeaveToPresence(req({ startDate: FRI_14, endDate: MON_17 }), amit);
  assertEquals(rows.map((r) => r.on_date), [FRI_14, MON_17]);
});

Deno.test("expand: a single-day PM request is one row on the afternoon", () => {
  const rows = expandLeaveToPresence(req({ dayPart: "pm" }), amit);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].day_part, "pm");
  assertEquals(rows[0].on_date, MON_10);
});

Deno.test("expand: a single-day AM request keeps its morning", () => {
  const rows = expandLeaveToPresence(req({ dayPart: "am" }), amit);
  assertEquals(rows.map((r) => r.day_part), ["am"]);
});

Deno.test("expand: every day of a multi-day request is a full day", () => {
  // Validation refuses a multi-day half day, so this is belt and braces — but
  // the alternative is three consecutive mornings, which no rule downstream
  // knows how to read.
  const rows = expandLeaveToPresence(
    req({ dayPart: "am", startDate: MON_10, endDate: WED_12 }),
    amit,
  );
  assertEquals(rows.length, 3);
  assertEquals(rows.every((r) => r.day_part === "full"), true);
});

Deno.test("expand: the leave type becomes the status verbatim", () => {
  // LeaveType and PresenceStatus share these four spellings on purpose, so an
  // email-sourced sick day and a requested one are the same thing on the board.
  for (const leaveType of ["sick", "local_leave", "vacation_leave", "permission"] as const) {
    assertEquals(expandLeaveToPresence(req({ leaveType }), amit)[0].status, leaveType);
  }
});

Deno.test("expand: the row is attributed to the requester", () => {
  const rows = expandLeaveToPresence(req(), amit);
  assertEquals(rows[0].staff_id, AMIT);
  assertEquals(rows[0].raw_name, "Amit");
});

Deno.test("expand: an approved request never needs review", () => {
  // The flag asks a human to look at a row. A human has just looked at this one
  // and said yes. Setting it would fill phase 1's review queue with approvals,
  // and a queue that is mostly noise gets cleared without being read.
  const rows = expandLeaveToPresence(req({ startDate: MON_10, endDate: FRI_14 }), amit);
  assertEquals(rows.every((r) => r.needs_review === false), true);
});

Deno.test("expand: the reason becomes the note, trimmed", () => {
  const rows = expandLeaveToPresence(req({ reason: "  hospital appointment  " }), amit);
  assertEquals(rows[0].note, "hospital appointment");
});

Deno.test("expand: the same note is carried onto every day of a range", () => {
  const rows = expandLeaveToPresence(
    req({ startDate: MON_10, endDate: WED_12, reason: "family funeral" }),
    amit,
  );
  assertEquals(rows.map((r) => r.note), ["family funeral", "family funeral", "family funeral"]);
});

Deno.test("expand: no reason is null, not an empty string", () => {
  // staff_presence.note is nullable and the UI tests it for truthiness; "" and
  // null must not mean two different kinds of nothing.
  for (const reason of [undefined, "", "   "]) {
    assertEquals(expandLeaveToPresence(req({ reason }), amit)[0].note, null);
  }
});

Deno.test("expand: a weekend-only request produces nothing", () => {
  assertEquals(expandLeaveToPresence(req({ startDate: SAT_15, endDate: SUN_16 }), amit), []);
});

Deno.test("expand: a single Saturday produces nothing", () => {
  // The one place this diverges from expandDays in presenceStore.ts, which
  // honours a stated Saturday. There, a human wrote the date down and dropping
  // it would lose a real absence. Here validation has already refused it and
  // told the requester why, so there is no fact to lose.
  assertEquals(expandLeaveToPresence(req({ startDate: SAT_08, endDate: SAT_08 }), amit), []);
});

Deno.test("expand: an invalid or backwards range produces nothing and does not throw", () => {
  assertEquals(expandLeaveToPresence(req({ startDate: "", endDate: "" }), amit), []);
  assertEquals(expandLeaveToPresence(req({ startDate: "nope", endDate: MON_10 }), amit), []);
  assertEquals(expandLeaveToPresence(req({ startDate: FRI_14, endDate: MON_10 }), amit), []);
  assertEquals(expandLeaveToPresence({} as unknown as LeaveRequestInput, amit), []);
});

Deno.test("expand: a runaway range cannot flood the board", () => {
  // Only reachable by a caller that skipped validation, which is exactly when a
  // cap earns its keep — the same reasoning as MAX_EXPANSION_DAYS in
  // presenceStore.ts. 90 calendar days from Monday 10 August 2026 hold 65
  // weekdays (twelve whole weeks plus Monday to Saturday), and a five-year
  // range must not produce one more than that.
  const rows = expandLeaveToPresence(
    req({ startDate: MON_10, endDate: "2031-08-10" }),
    amit,
  );
  assertEquals(rows.length, 65);
  assertEquals(rows[0].on_date, MON_10);
  assertEquals(rows[rows.length - 1].on_date, "2026-11-06");
});

Deno.test("expand: a range starting on a Sunday begins on the Monday", () => {
  const rows = expandLeaveToPresence(req({ startDate: SUN_09, endDate: TUE_11 }), amit);
  assertEquals(rows.map((r) => r.on_date), [MON_10, TUE_11]);
});

// ---------------------------------------------------------------------------
// overlappingDates
// ---------------------------------------------------------------------------

function rows(...dates: string[]): PresenceRowForRequest[] {
  return dates.map((on_date) => ({
    staff_id: AMIT,
    raw_name: "Amit",
    on_date,
    status: "local_leave",
    day_part: "full",
    note: null,
    needs_review: false,
  }));
}

Deno.test("overlap: no overlap is an empty list", () => {
  assertEquals(overlappingDates(rows(MON_10, TUE_11), [THU_13, FRI_14]), []);
});

Deno.test("overlap: the intersection comes back sorted", () => {
  // Sorted so the approver reads a list of days rather than whatever order the
  // rows happened to arrive in.
  assertEquals(
    overlappingDates(rows(MON_10, TUE_11, WED_12), [WED_12, MON_10, "2026-09-01"]),
    [MON_10, WED_12],
  );
});

Deno.test("overlap: a date recorded twice is reported once", () => {
  assertEquals(overlappingDates(rows(MON_10, MON_10), [MON_10, MON_10]), [MON_10]);
});

Deno.test("overlap: empty and malformed inputs are empty results, not throws", () => {
  assertEquals(overlappingDates([], [MON_10]), []);
  assertEquals(overlappingDates(rows(MON_10), []), []);
  assertEquals(overlappingDates(rows(MON_10), ["", "   "]), []);
  assertEquals(
    overlappingDates(
      null as unknown as PresenceRowForRequest[],
      null as unknown as string[],
    ),
    [],
  );
});

Deno.test("overlap: a real half-day clash is reported, because the approver decides", () => {
  // An overlap is usually a correction — half a day already on the board from
  // an email, now being requested properly. Blocking it would leave the wrong
  // version there with no way to replace it, so this only ever warns.
  const proposed = expandLeaveToPresence(req({ startDate: MON_10, endDate: WED_12 }), amit);
  assertEquals(overlappingDates(proposed, [TUE_11]), [TUE_11]);
});
