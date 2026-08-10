// Leave requests — the pure decision logic behind phase 2 of the presence board.
//
// Phase 1 reads absences out of the all-staff emails (presence.ts) and files
// them (presenceStore.ts). Phase 2 lets somebody ask for leave in the app and a
// manager approve it, and an approved request lands in the SAME staff_presence
// table with source='request' — see 0006, which was built for both paths from
// the start so this is an insert, not a migration of history.
//
// Three decisions live here and nothing else:
//
//   1. Is this request even answerable? (`validateLeaveRequest`)
//   2. Who is allowed to answer it? (`resolveApprover`)
//   3. What does "yes" write on the board? (`expandLeaveToPresence`)
//
// All three are pure and take everything they need as arguments — no client, no
// env, no `new Date()`. The Mauritius date is passed in as `today` because a
// function that reads the clock cannot be tested against a boundary, and every
// interesting rule in here IS a boundary. See leave_test.ts.
//
// The governing asymmetry is the opposite of presence.ts's. There, a dropped
// absence was worse than a wrong one, because the alternative to a flagged row
// was silence. Here there is no silence to fear: a person is sitting in front of
// a form, and an error message sends them straight back to fix it. So this
// module is allowed to REFUSE — but only where refusing costs less than the
// workaround, which is always "give up and send an email instead". Every
// rejection below is measured against that, and the near-miss cases (a request
// filed yesterday, a request filed this morning for this morning) are
// deliberately let through.

/**
 * The four leave types a person may request.
 *
 * A strict subset of presence.ts's `PresenceStatus`: `late`, `off_site` and
 * `other` are things that HAPPEN to you and get reported after the fact, not
 * things you ask permission for in advance. The four that remain are spelled
 * identically to the extractor's, which is what lets `expandLeaveToPresence`
 * copy the type into `status` verbatim instead of maintaining a translation
 * table that would drift.
 */
export type LeaveType = "sick" | "local_leave" | "vacation_leave" | "permission";

/**
 * No `partial` here, unlike presence.ts's `DayPart`. `partial` means "half a day
 * but we could not tell which half" — an admission the extractor has to make
 * about prose. A form has a dropdown, so there is nothing to be uncertain about.
 */
export type LeaveDayPart = "full" | "am" | "pm";

/** A staff_directory row, only the columns these rules read. */
export interface RosterPerson {
  id: string;
  known_as: string;
  full_name: string;
  department: string | null;
  manager_id: string | null;
  is_manager: boolean;
  active: boolean;
}

export interface LeaveRequestInput {
  leaveType: LeaveType;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  dayPart: LeaveDayPart;
  reason?: string;
}

export interface Validation {
  ok: boolean;
  errors: string[];
}

/**
 * Longest request that can be made in the app, counted inclusively: start and
 * end on the same day is a span of 1, so 90 means ninety calendar days with the
 * first and last counted.
 *
 * Chosen for the same reason as MAX_EXPANSION_DAYS in presenceStore.ts, one step
 * removed. There, a runaway range was a misparse of somebody's prose. Here it is
 * a typo in a date picker — 2027 where 2026 was meant — and the consequence is
 * identical: hundreds of rows across a person's board that somebody then deletes
 * by hand. The number is higher than the extractor's 60 because a REQUEST can
 * legitimately be long. Maternity leave and the long unpaid stretches people
 * take to visit family abroad are real and are planned months ahead, and a rule
 * that forced those to be filed in chunks would be a rule people route around.
 */
const MAX_SPAN_DAYS = 90;

/**
 * How far ahead a request may start. Beyond a year it is not planning, it is a
 * year typed wrong — and the board it would write to does not usefully exist
 * that far out.
 */
const MAX_MONTHS_AHEAD = 12;

/**
 * How far back a request may start.
 *
 * Backdating is ALLOWED and this is the single most important judgement in the
 * file. Sick leave and permission are filed the same morning or the day after by
 * definition — you do not know you will be ill. Somebody back from three days
 * flat with flu files on the Thursday for the Monday, and a system that answers
 * "start date is in the past" has just taught them that the app is for planned
 * holidays and email is for everything else. That is how the presence board goes
 * back to being a mailbox.
 *
 * So the limit is not "no backdating", it is "not so far back that this is
 * obviously a wrong year or a wrong month". Two months covers every real late
 * filing seen in the phase-1 corpus with room to spare.
 */
const MAX_DAYS_BACKDATED = 60;

const LEAVE_TYPES: ReadonlySet<string> = new Set<LeaveType>([
  "sick",
  "local_leave",
  "vacation_leave",
  "permission",
]);

const DAY_PARTS: ReadonlySet<string> = new Set<LeaveDayPart>(["full", "am", "pm"]);

// ---------------------------------------------------------------------------
// Dates
//
// Same shape as the helpers in presenceStore.ts, and re-derived here for the
// same reason they were re-derived there: these operate on plain YYYY-MM-DD
// strings that already carry the right calendar day, so there is no timezone
// question left to get wrong, and four lines duplicated is cheaper than a
// dependency between two modules that otherwise share nothing.
// ---------------------------------------------------------------------------

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Midday UTC, not midnight, is the instant every date below is anchored at.
 *
 * The arithmetic is done in UTC and would be exact at midnight too — that is
 * what presenceStore.ts does, and `Z` leaves no room for a local reading. Noon
 * is belt and braces for the ONE way this still goes wrong: somebody later adds
 * a `new Date(ymd)` or a `.getDate()` somewhere downstream, reads the instant in
 * a local timezone, and lands on the previous or next calendar day. From noon
 * there are twelve hours of slack in either direction, which absorbs every real
 * offset on earth (UTC-12 to UTC+14 is the full range, and Mauritius is +4). An
 * off-by-one day here is not a cosmetic bug: it books a person off on a day they
 * worked and leaves the day they were away showing them at their desk.
 */
const NOON = "T12:00:00Z";

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** The date as a UTC-noon epoch, or NaN if it is not a real calendar date. */
function epoch(ymd: string): number {
  const s = (ymd ?? "").trim();
  if (!YMD.test(s)) return NaN;
  const ms = Date.parse(`${s}${NOON}`);
  if (Number.isNaN(ms)) return NaN;
  // Date.parse accepts 2026-02-30 and rolls it into March. Round-tripping is
  // the only way to catch a date that is well-formed but does not exist —
  // and a date picker with a manual text entry can and does produce them.
  return format(ms) === s ? ms : NaN;
}

function format(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function isValidDate(ymd: string): boolean {
  return !Number.isNaN(epoch(ymd));
}

function addDays(ymd: string, days: number): string {
  return format(epoch(ymd) + days * 86_400_000);
}

/**
 * Calendar months, clamped to the end of a short month, exactly as
 * presence.ts's `addMonths` does: twelve months after the 29th of February is
 * the 28th, not the 1st of March. Only used for the "too far ahead" ceiling,
 * where an off-by-one day would be harmless — but a ceiling that moves depending
 * on which month you ask from is the kind of thing that produces a bug report
 * once a year and is impossible to reproduce.
 */
function addMonths(ymd: string, months: number): string {
  const d = new Date(epoch(ymd));
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastOfMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastOfMonth));
  return format(d.getTime());
}

function isWeekend(ymd: string): boolean {
  const day = new Date(epoch(ymd)).getUTCDay();
  return day === 0 || day === 6;
}

/** Inclusive calendar-day count: same day start and end is 1, not 0. */
function spanDays(startDate: string, endDate: string): number {
  return Math.round((epoch(endDate) - epoch(startDate)) / 86_400_000) + 1;
}

/**
 * Every weekday from `startDate` to `endDate` inclusive, Saturdays and Sundays
 * dropped.
 *
 * Deliberately the same walk as `expandDays` in presenceStore.ts, for the reason
 * given there: this is a WORKING presence board answering "who is not at their
 * desk today", and nobody can be absent from a day they were never expected on.
 * Writing weekend rows would put a permanent block of grey across every long
 * leave and train people to stop reading the board.
 *
 * It differs from `expandDays` in two places, both because the input has a
 * different provenance:
 *
 *   * a single stated day is NOT exempted from the weekend rule. `expandDays`
 *     honours a Saturday because the office manager typed it and Jade does have
 *     staff on site at weekends, so dropping it would lose a real absence.
 *     Nothing is lost here: `validateLeaveRequest` refuses a weekend-only
 *     request outright and tells the requester why, so a Saturday reaching this
 *     function means it was called on input that was already refused.
 *   * the cap is MAX_SPAN_DAYS rather than 60, so it can never truncate a range
 *     validation accepted. It exists for the same reason the other one does —
 *     one bad input must not be able to write hundreds of rows — and matters
 *     because this function is exported and a caller may reach it without
 *     validating first.
 *
 * Returns [] rather than a fallback row for an unusable range. The fallback in
 * `expandDays` exists so a real absence somebody announced is never dropped;
 * an approved request that expands to nothing has no such fact behind it.
 */
function weekdaysBetween(startDate: string, endDate: string): string[] {
  if (!isValidDate(startDate) || !isValidDate(endDate)) return [];
  if (endDate < startDate) return [];

  const dates: string[] = [];
  let cursor = startDate;
  let walked = 0;
  while (cursor <= endDate && walked < MAX_SPAN_DAYS) {
    if (!isWeekend(cursor)) dates.push(cursor);
    cursor = addDays(cursor, 1);
    walked += 1;
  }
  return dates;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Check a request, reporting EVERY problem with it.
 *
 * `today` is the Mauritius date, passed in so this stays pure — see
 * `mauritiusDate` in presence.ts for how the caller gets it. A function that
 * read the clock itself could not be tested at the boundaries, and the
 * boundaries are the entire content of this function.
 *
 * All errors are collected rather than returned one at a time. A form that
 * reveals exactly one problem per submission is a form people abandon: fix the
 * date, resubmit, learn the half-day rule, fix that, resubmit, learn the length
 * rule. Three round trips to file one day of sick leave and the next one goes by
 * email.
 *
 * Never throws. The input is whatever a browser posted; a malformed date is an
 * error message, not a 500.
 */
export function validateLeaveRequest(input: LeaveRequestInput, today: string): Validation {
  const errors: string[] = [];

  const startDate = (input?.startDate ?? "").trim();
  const endDate = (input?.endDate ?? "").trim();
  const dayPart = (input?.dayPart ?? "") as string;
  const leaveType = (input?.leaveType ?? "") as string;

  // The two enum checks are not in the written spec, and are here because
  // `expandLeaveToPresence` copies leaveType straight into staff_presence.status
  // and dayPart into day_part, both of which carry CHECK constraints (0006,
  // 0009). Without this an unrecognised value survives all the way to the insert
  // and surfaces as a database error with no field attached to it — the one
  // failure mode a validator exists to prevent.
  if (!LEAVE_TYPES.has(leaveType)) {
    errors.push(`"${leaveType}" is not a leave type that can be requested`);
  }
  if (!DAY_PARTS.has(dayPart)) {
    errors.push(`"${dayPart}" is not a valid day part`);
  }

  const startOk = isValidDate(startDate);
  const endOk = isValidDate(endDate);
  if (!startOk) errors.push("Start date is missing or not a real date");
  if (!endOk) errors.push("End date is missing or not a real date");

  // `today` arriving malformed is a caller bug, not a user one, and there is no
  // honest way to check "in the past" without it. Saying so loudly beats
  // silently skipping two rules and letting a request dated 2019 through.
  const todayOk = isValidDate((today ?? "").trim());
  if (!todayOk) errors.push("Could not determine today's date, so the request cannot be checked");

  // Everything below reads both dates. Running it on a date that did not parse
  // would pile speculative errors on top of the real one.
  if (!startOk || !endOk) return { ok: errors.length === 0, errors };

  if (endDate < startDate) {
    errors.push("End date is before the start date");
  } else {
    // Only meaningful on a forwards range; on a backwards one the span is
    // negative and the weekday walk is empty, and reporting either would be
    // three errors describing one mistake.
    const span = spanDays(startDate, endDate);
    if (span > MAX_SPAN_DAYS) {
      errors.push(
        `A request cannot be longer than ${MAX_SPAN_DAYS} days — this one is ${span}. ` +
          "Split a longer absence into separate requests.",
      );
    }

    if (weekdaysBetween(startDate, endDate).length === 0) {
      // A Saturday-to-Sunday request expands to no rows at all, so approving it
      // would record nothing and look exactly like an approval that worked.
      errors.push("There are no working days in that range — it falls entirely on a weekend");
    }
  }

  // Half days are a single day by construction: `expandLeaveToPresence` writes
  // one row per day, and the am/pm on a three-day range would have to mean "the
  // morning of each of them", which is not a thing anybody asks for. Saying so
  // is better than silently widening it to full days.
  if ((dayPart === "am" || dayPart === "pm") && startDate !== endDate) {
    errors.push("A half day is a single day — set the same start and end date, or ask for full days");
  }

  if (todayOk) {
    const t = (today ?? "").trim();

    if (startDate > addMonths(t, MAX_MONTHS_AHEAD)) {
      errors.push(`Start date is more than ${MAX_MONTHS_AHEAD} months away — check the year`);
    }

    // See MAX_DAYS_BACKDATED: a start date in the past is expected and fine.
    // This only catches the ones that are past by an amount no late filing
    // explains.
    if (startDate < addDays(t, -MAX_DAYS_BACKDATED)) {
      errors.push(
        `Start date is more than ${MAX_DAYS_BACKDATED} days ago — ` +
          "check the date, or ask an admin to record it for you",
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Approver routing
// ---------------------------------------------------------------------------

export interface ApproverResult {
  approverId: string | null;
  /** Short human-readable explanation, shown in the UI and stored for audit. */
  reason: string;
}

/** The name to put in front of a human. `known_as` is what colleagues call each
 * other and what the whole presence board is built around; full_name is the
 * fallback for a roster row that was imported without one. */
function displayName(person: RosterPerson): string {
  return (person?.known_as ?? "").trim() || (person?.full_name ?? "").trim() || "an unnamed colleague";
}

/** Departments are free text in staff_directory, so "Finance" and "finance "
 * are the same department typed by two different admins. Compared normalised,
 * displayed as the requester wrote it. */
function deptKey(department: string | null): string {
  return (department ?? "").trim().toLowerCase();
}

/**
 * Who may approve this person's leave.
 *
 * Three rules in order, and one absolute: **the requester is never their own
 * approver**. That is not a tidiness rule, it is the feature. A leave request
 * that the requester can approve is a leave request with no approval in it, and
 * the failure is invisible — the board shows an approved absence exactly as if a
 * manager had looked at it. Every branch below therefore excludes
 * `requester.id`, including the manager_id branch: a roster row that points at
 * itself is a data error somebody will make, and it must fall through to the
 * department rule rather than hand the person a rubber stamp.
 *
 * A null approverId is a real answer, not a failure. It means "an admin decides
 * this one", and the reason string says why so the admin is not left guessing.
 * That is strictly better than the two alternatives: picking arbitrarily between
 * two real managers (undetectable afterwards — the audit trail would show a
 * confident routing), or refusing the request outright and sending the person
 * back to email.
 */
export function resolveApprover(requester: RosterPerson, roster: RosterPerson[]): ApproverResult {
  const people = roster ?? [];
  const requesterId = (requester?.id ?? "").trim();

  // 1. An explicit reporting line, if it names somebody who still works here.
  const managerId = (requester?.manager_id ?? "").trim();
  if (managerId && managerId !== requesterId) {
    // Missing id, or an id belonging to a leaver, is not an error — people
    // leave and the FK in 0006 only nulls the pointer when the ROW is deleted,
    // which deactivation deliberately never does. Both fall through.
    const manager = people.find((p) => (p?.id ?? "").trim() === managerId && p?.active);
    if (manager) {
      return { approverId: manager.id, reason: `reports to ${displayName(manager)}` };
    }
  }

  // 2. The department's manager. Only reachable when there is no usable
  //    reporting line, so this is the fallback for the majority of the roster
  //    whose manager_id has never been filled in.
  const dept = deptKey(requester?.department ?? null);
  const shown = (requester?.department ?? "").trim();
  if (dept) {
    const managers = people.filter((p) =>
      p?.active &&
      p?.is_manager &&
      deptKey(p?.department ?? null) === dept &&
      (p?.id ?? "").trim() !== requesterId
    );

    if (managers.length === 1) {
      return {
        approverId: managers[0].id,
        reason: `department manager for ${shown}`,
      };
    }

    if (managers.length > 1) {
      const names = managers.map(displayName).sort().join(", ");
      return {
        approverId: null,
        reason:
          `${shown} has ${managers.length} managers (${names}) — an admin must choose who approves this`,
      };
    }
  }

  // 3. Nothing to route on. Two different causes, and the admin picking this up
  //    needs to know which, because one is fixed on the roster and the other is
  //    just how a one-person department works.
  if (!dept) {
    return {
      approverId: null,
      reason: `no manager or department is set for ${displayName(requester)} — an admin must approve this`,
    };
  }
  return {
    approverId: null,
    reason: `no other manager is set for ${shown} — an admin must approve this`,
  };
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

/** A staff_presence row for an APPROVED request. Same shape as `ResolvedRow` in
 * presenceStore.ts minus the nullable staff_id: a request always knows whose it
 * is, because it was filed from that person's own account. */
export interface PresenceRowForRequest {
  staff_id: string;
  raw_name: string;
  on_date: string;
  status: string;
  day_part: string;
  note: string | null;
  needs_review: boolean;
}

/**
 * An approved request -> the rows it puts on the board.
 *
 * Called only after a human has approved it. That is why `needs_review` is
 * false and not merely defaulted: the flag exists to ask a person to look at a
 * row, and a person has just looked at this one and said yes. Setting it here
 * would put every approved request into the queue that phase 1 built for
 * absences nobody could parse, and a queue that is mostly noise gets cleared
 * without being read.
 *
 * Never throws and returns [] for input it cannot expand — a caller that skipped
 * `validateLeaveRequest` gets nothing rather than an exception in a request
 * handler.
 */
export function expandLeaveToPresence(
  input: LeaveRequestInput,
  requester: RosterPerson,
): PresenceRowForRequest[] {
  const startDate = (input?.startDate ?? "").trim();
  const endDate = (input?.endDate ?? "").trim();

  // A half day only ever means anything on a single-day request, and validation
  // has already refused the multi-day case. Forcing "full" here rather than
  // trusting the caller means the worst an unvalidated am/pm range can do is
  // book full days, not book three consecutive mornings that no rule downstream
  // knows how to read.
  const singleDay = startDate === endDate;
  const dayPart = singleDay ? (input?.dayPart ?? "full") : "full";

  // Whatever the requester typed, or nothing. Never invented: an empty note is
  // null so the UI's truthiness test cannot see two kinds of nothing (the same
  // rule presenceStore.ts follows), and a note nobody wrote must not appear on
  // somebody's record as though they had explained themselves.
  const note = (input?.reason ?? "").trim() || null;

  return weekdaysBetween(startDate, endDate).map((onDate) => ({
    staff_id: requester?.id ?? "",
    raw_name: requester?.known_as ?? "",
    on_date: onDate,
    // Verbatim. LeaveType and PresenceStatus share these four spellings on
    // purpose — see the comment on LeaveType — so a mapping here would be a
    // second place for the vocabulary to drift out of step with the CHECK
    // constraint in 0009.
    status: input?.leaveType ?? "",
    day_part: dayPart,
    note,
    needs_review: false,
  }));
}

/**
 * Dates in `proposed` that the person is already recorded absent for.
 *
 * Shown to the approver, never used to block. A genuine overlap is usually a
 * correction — half a day already recorded from an email, now being requested
 * properly, or a range being extended — and refusing those would leave the
 * wrong version on the board with no way to replace it. Telling the approver is
 * enough: they are the person who knows which of the two is right.
 *
 * Sorted and de-duplicated so the warning reads as a list of days rather than a
 * multiset, and so its output is stable enough to assert on.
 */
export function overlappingDates(
  proposed: PresenceRowForRequest[],
  existingDates: string[],
): string[] {
  const existing = new Set((existingDates ?? []).map((d) => (d ?? "").trim()).filter(Boolean));
  const hits = new Set<string>();
  for (const row of proposed ?? []) {
    const onDate = (row?.on_date ?? "").trim();
    if (onDate && existing.has(onDate)) hits.add(onDate);
  }
  // ISO dates sort lexicographically as dates, which is the only reason this
  // module can compare and sort them as plain strings throughout.
  return [...hits].sort();
}
