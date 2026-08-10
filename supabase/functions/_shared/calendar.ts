// The in-app calendar — pure time, grid and conflict rules for phase 3.
//
// Jade already has Outlook, and Outlook is better at calendars than anything
// written here will ever be. This module exists for the one thing Outlook
// cannot do: it KNOWS WHO IS AWAY. Phases 1 and 2 built a presence board out of
// the all-staff absence emails (presence.ts) and approved leave requests
// (leave.ts), and `attendeeConflicts` at the bottom of this file is the payoff —
// the moment somebody schedules a meeting, the app can say "Vidhya is on
// vacation leave that day" before the invitation goes out rather than after.
// Everything above it exists to make that answer correct.
//
// Two rules govern the whole file:
//
//   1. Wall clock and instant are different things and are never confused. What
//      is stored is an instant (an ISO timestamp); what a person reads off a
//      wall in Port Louis is a date and a time. `toMauritiusParts` and
//      `mauritiusToInstant` are the only two places that convert between them,
//      they are exact inverses, and every other function in here works in one
//      world or the other and says which.
//   2. Ranges are HALF-OPEN: [startsAt, endsAt). A meeting that ends at 10:00
//      and one that starts at 10:00 do not overlap, and a meeting that ends at
//      exactly midnight does not touch the next day. Back-to-back meetings are
//      the normal case in a small office, and a comparison that called them a
//      clash would make the warning worthless within a week — the whole value
//      of a conflict warning is that it is silent when there is no conflict.
//
// PURE: no network, no env, no database, and no reading of the clock. "Today"
// is always a parameter, for the reason given in leave.ts — every interesting
// rule in here is a boundary, and a function that reads the clock cannot be
// tested at one. See calendar_test.ts.

import { mauritiusDate } from "./presence.ts";

/**
 * Mauritius is UTC+4 and has never observed daylight saving — see the note on
 * `MAURITIUS_UTC_OFFSET_MINUTES` in presence.ts, which is this same fact in
 * different units. Exported because the UI needs it to label things, and stated
 * in milliseconds because that is what every arithmetic use below wants.
 *
 * The DATE half of the conversion is delegated to presence.ts's `mauritiusDate`
 * rather than re-derived here, so there is exactly one implementation of the
 * shift-the-epoch-then-read-UTC-fields trick in the codebase. Two would drift.
 */
export const MAURITIUS_OFFSET_MS = 4 * 60 * 60 * 1000;

/**
 * A wall-clock time, strictly as `<input type="time">` writes it, with optional
 * seconds and milliseconds. Two digits for the hour are required: "9:30" is
 * rejected rather than read as 09:30, because a module whose entire job is
 * being exact about time should not be the one place that guesses.
 */
const WALL_TIME = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * An ISO-8601 instant, with a zone, as PostgREST returns a timestamptz
 * ("2026-08-10T05:00:00+00:00") and as `toISOString` writes one.
 *
 * `Date.parse` is far more accommodating than this, and every extra thing it
 * accepts is a way to be silently wrong:
 *
 *   * "10/08/2026" parses. In Mauritius that is the 10th of August; V8 reads it
 *     American-end-first and returns the 7th of October. A meeting two months
 *     out, and nothing anywhere says so.
 *   * "2026-08-10T05:00:00" — no zone — parses as LOCAL time, which means it
 *     resolves differently on the edge runtime (UTC) than on a developer's
 *     laptop in Port Louis (UTC+4). A timestamp without a zone is not an
 *     instant, and guessing which zone was meant is the one thing this module
 *     must never do.
 *
 * So the gate is here rather than at each call site, and every function below
 * that reads a timestamp reads it through `instantOf`.
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2}?)$/i;

/**
 * A day in milliseconds, and the longest a TIMED event may run.
 *
 * Anything longer is a typo — a wrong date on the end picker, almost always the
 * year — and the consequence is not cosmetic: a timed event of eleven days
 * smears a solid bar across a fortnight of the grid and hides everything real
 * underneath it. An event that genuinely spans days is an all-day event, which
 * is exempt (see `validateEvent`), so nothing legitimate is refused.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Cells in a month grid: 6 rows of 7. See `monthGrid` for why it is fixed. */
const GRID_CELLS = 42;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function pad3(n: number): string {
  return n < 10 ? `00${n}` : n < 100 ? `0${n}` : `${n}`;
}

/**
 * Is this a date the calendar actually has?
 *
 * `Date` rolls the 30th of February into the 2nd of March rather than
 * complaining, so round-tripping the fields is the only way to catch a date
 * that is well-formed and does not exist. A text-entry date field produces
 * them, and so does a bad import.
 */
function isRealYmd(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const utc = Date.UTC(year, month - 1, day);
  if (Number.isNaN(utc)) return false;
  const back = new Date(utc);
  return back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 &&
    back.getUTCDate() === day;
}

/**
 * An ISO instant as an epoch, or NaN.
 *
 * The single door every timestamp in this file comes through — see
 * `ISO_INSTANT` for why `Date.parse` alone is not enough, and `isRealYmd` for
 * why a well-formed date still has to be checked against the calendar.
 */
function instantOf(iso: string): number {
  const m = ISO_INSTANT.exec((iso ?? "").trim());
  if (!m) return NaN;
  if (!isRealYmd(Number(m[1]), Number(m[2]), Number(m[3]))) return NaN;
  return Date.parse((iso ?? "").trim());
}

/**
 * An instant (ISO) → the wall clock a person in Port Louis would read.
 *
 * `time` carries only the precision the instant actually has: "14:30" for a
 * meeting on the minute, "14:30:45" if it has seconds, "14:30:45.120" if it has
 * milliseconds. That is what makes the round trip through `mauritiusToInstant`
 * exact for ANY instant rather than exact only for the tidy ones — truncating
 * to HH:MM would have been friendlier to the UI and would have quietly moved
 * every timestamp that was not on a whole minute.
 *
 * Returns null for anything unparseable. Never guesses, never falls back to
 * now: a null renders as an empty field the user can see and fix, where a
 * silently substituted "now" renders as a meeting at a plausible wrong time.
 */
export function toMauritiusParts(iso: string): { date: string; time: string } | null {
  const ms = instantOf(iso);
  if (Number.isNaN(ms)) return null;

  const date = mauritiusDate(iso);
  if (!date) return null;

  const shifted = new Date(ms + MAURITIUS_OFFSET_MS);
  const hh = pad2(shifted.getUTCHours());
  const mm = pad2(shifted.getUTCMinutes());
  const ss = shifted.getUTCSeconds();
  const mss = shifted.getUTCMilliseconds();

  const time = mss !== 0
    ? `${hh}:${mm}:${pad2(ss)}.${pad3(mss)}`
    : ss !== 0
    ? `${hh}:${mm}:${pad2(ss)}`
    : `${hh}:${mm}`;

  return { date, time };
}

/**
 * Mauritius wall clock → the instant to store. Inverse of `toMauritiusParts`.
 *
 * This is the function a naive implementation gets wrong, and it gets it wrong
 * in a way that is invisible for most of the day: 01:00 in Port Louis is 21:00
 * the PREVIOUS day in UTC, so subtracting four hours has to be allowed to move
 * the calendar date backwards. Doing the arithmetic on the epoch rather than on
 * the date fields is what makes that free — and is why the offset is applied
 * after `Date.UTC`, never by fiddling with the hour.
 *
 * Returns a canonical ISO string (always Z, always milliseconds), so the round
 * trip preserves the INSTANT rather than the caller's spelling of it.
 */
export function mauritiusToInstant(date: string, time: string): string | null {
  const ms = epochOf(date, time);
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * A Mauritius wall clock as an epoch, or null.
 *
 * Every field is range-checked by hand instead of being handed to `Date`,
 * because `Date` is forgiving in exactly the wrong direction: it rolls the 30th
 * of February into the 2nd of March and 25:00 into the next morning. A meeting
 * booked for a day that does not exist must be refused, not moved.
 */
function epochOf(date: string, time: string): number | null {
  const d = YMD.exec((date ?? "").trim());
  if (!d) return null;
  const t = WALL_TIME.exec((time ?? "").trim());
  if (!t) return null;

  const year = Number(d[1]);
  const month = Number(d[2]);
  const day = Number(d[3]);
  const hours = Number(t[1]);
  const minutes = Number(t[2]);
  const seconds = t[3] ? Number(t[3]) : 0;
  // ".5" is half a second, not five milliseconds — ISO fractions are padded on
  // the RIGHT. Getting this backwards would be a 495ms error nobody would ever
  // notice, which is precisely why it is spelled out.
  const millis = t[4] ? Number(t[4].padEnd(3, "0")) : 0;

  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  if (!isRealYmd(year, month, day)) return null;

  const utc = Date.UTC(year, month - 1, day, hours, minutes, seconds, millis);
  if (Number.isNaN(utc)) return null;

  return utc - MAURITIUS_OFFSET_MS;
}

export interface TimeRange {
  startsAt: string;
  endsAt: string;
}

/**
 * Do two ranges share any time at all?
 *
 * Half-open comparison: touching ranges (one ends exactly when the next begins)
 * do NOT overlap. Back-to-back meetings are the normal shape of an office
 * morning, and a warning that fired on every one of them would be turned off.
 *
 * A range that cannot be read, or one that runs backwards, overlaps nothing —
 * there is no honest answer to "does this clash?" for a range nobody can place,
 * and inventing a clash is worse than staying quiet.
 *
 * A zero-length range likewise overlaps nothing. That does NOT fall out of the
 * usual `aStart < bEnd && bStart < aEnd` comparison, which reports an empty
 * range as clashing with anything containing its instant, so it is an explicit
 * line below: half-open means an empty interval contains no time at all, and
 * something occupying no time cannot be double-booked. Note this is a different
 * question from the one `datesTouched` answers — a zero-length event is still
 * ON a day, and is reported there — and the two are deliberately not the same.
 */
export function rangesOverlap(a: TimeRange, b: TimeRange): boolean {
  const aStart = instantOf(a?.startsAt ?? "");
  const aEnd = instantOf(a?.endsAt ?? "");
  const bStart = instantOf(b?.startsAt ?? "");
  const bEnd = instantOf(b?.endsAt ?? "");

  if ([aStart, aEnd, bStart, bEnd].some(Number.isNaN)) return false;
  if (aEnd <= aStart || bEnd <= bStart) return false;

  return aStart < bEnd && bStart < aEnd;
}

export interface EventInput {
  title: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
}

export interface Validation {
  ok: boolean;
  errors: string[];
}

/**
 * Check an event, reporting EVERY problem with it.
 *
 * All errors are collected rather than returned one at a time, for the reason
 * spelled out on `validateLeaveRequest`: a form that reveals one problem per
 * submission is a form people abandon, and the alternative to this app is
 * putting the meeting in Outlook where nobody is warned about who is away.
 *
 * Never throws. The input is whatever a browser posted; an unreadable timestamp
 * is an error message, not a 500.
 *
 * One judgement call worth naming: an event whose end equals its start is NOT
 * refused here, because "ends before it starts" is the stated rule and a
 * zero-length event is not that. It is worth knowing that such an event is
 * invisible to `rangesOverlap` and to `attendeeConflicts` by construction — it
 * contains no instant — so if the UI ever grows a way to create one, the rule
 * belongs here.
 */
export function validateEvent(input: EventInput): Validation {
  const errors: string[] = [];

  const title = (input?.title ?? "").trim();
  if (!title) {
    // Whitespace counts as empty. A title of " " renders as a blank block on
    // the grid that can only be identified by clicking it.
    errors.push("Title is missing");
  }

  const startsAt = instantOf(input?.startsAt ?? "");
  const endsAt = instantOf(input?.endsAt ?? "");
  const startOk = !Number.isNaN(startsAt);
  const endOk = !Number.isNaN(endsAt);
  if (!startOk) errors.push("Start time is missing or not a readable timestamp");
  if (!endOk) errors.push("End time is missing or not a readable timestamp");

  // Every rule below reads both instants. Running them on a timestamp that did
  // not parse would pile speculative errors on top of the real one — the same
  // early return `validateLeaveRequest` makes, for the same reason.
  if (!startOk || !endOk) return { ok: errors.length === 0, errors };

  if (endsAt < startsAt) {
    errors.push("End time is before the start time");
  } else if (!input?.allDay && endsAt - startsAt > DAY_MS) {
    // All-day events are deliberately exempt: a conference or a week of leave
    // block IS multi-day, and that is the whole distinction the flag exists to
    // draw. Only a timed event of more than a day is a mistake.
    errors.push(
      "A timed event cannot be longer than 24 hours — check the end date, " +
        "or mark it all-day if it really does span days",
    );
  }

  return { ok: errors.length === 0, errors };
}

export interface MonthCell {
  date: string; // YYYY-MM-DD
  inMonth: boolean; // false for leading/trailing days from adjacent months
  isToday: boolean;
  isWeekend: boolean;
}

/**
 * A Monday-first 6x7 grid for one month.
 *
 * `month` is 1-12, NOT zero-based. `Date` disagrees — `new Date(y, 0, 1)` is
 * January — and this is the classic off-by-one in every calendar ever written,
 * so the conversion happens exactly once, at the `Date.UTC` call below, and
 * nowhere else in the file.
 *
 * Always 42 cells, even for a 28-day February that fits in five rows, so the
 * calendar never changes height as the user pages through months. A grid that
 * reflows moves the cell under the pointer between one click and the next.
 * Leading days come from the previous month and trailing days from the next;
 * they are real, clickable dates flagged `inMonth: false`, not blanks, because
 * "the meeting is on the 1st" is a thing people click on from the 31st. 42 is
 * always enough: the worst case is a 31-day month starting on a Sunday, which
 * needs 6 leading cells and 37 in total.
 *
 * `today` is a Mauritius date (see `mauritiusDate`), passed in for purity. A
 * missing or malformed one simply highlights nothing.
 *
 * Returns [] rather than throwing for a month outside 1-12 or a year outside
 * 1000-9999 — the low bound also keeps `Date.UTC`'s two-digit-year rule, where
 * year 26 means 1926, out of reach.
 */
export function monthGrid(year: number, month: number, today: string): MonthCell[] {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) return [];
  if (!Number.isInteger(month) || month < 1 || month > 12) return [];

  const first = Date.UTC(year, month - 1, 1);

  // getUTCDay() is Sunday-based (0=Sun). The office week starts on Monday, so
  // Sunday must become 6 and not stay 0 — this rotation is the whole difference
  // between a Monday-first grid and a Sunday-first one, and getting it wrong
  // shifts every date in the calendar by a day without ever looking broken.
  const leading = (new Date(first).getUTCDay() + 6) % 7;
  const gridStart = first - leading * DAY_MS;

  const todayYmd = (today ?? "").trim();
  const cells: MonthCell[] = [];

  for (let i = 0; i < GRID_CELLS; i++) {
    const d = new Date(gridStart + i * DAY_MS);
    const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    const weekday = d.getUTCDay();
    cells.push({
      date,
      inMonth: d.getUTCFullYear() === year && d.getUTCMonth() === month - 1,
      isToday: date === todayYmd,
      isWeekend: weekday === 0 || weekday === 6,
    });
  }

  return cells;
}

/**
 * The Mauritius dates a range touches, inclusive.
 *
 * A meeting can cross midnight — a 23:00 call with a supplier in another
 * timezone lands on two days — and conflict detection has to know about both,
 * because the person who is on leave on the second of them is just as absent.
 *
 * The end is EXCLUSIVE, consistently with `rangesOverlap`: a meeting that runs
 * 22:00 to midnight touches one day, not two. Otherwise every evening event
 * that happened to end on the hour would report a conflict on a day it does not
 * occupy at all, and a warning that cries wolf is a warning people click past.
 * A zero-length range still reports the single day it sits on.
 *
 * Returns [] for a range that cannot be read or that runs backwards.
 */
export function datesTouched(range: TimeRange): string[] {
  const start = instantOf(range?.startsAt ?? "");
  const end = instantOf(range?.endsAt ?? "");
  if (Number.isNaN(start) || Number.isNaN(end)) return [];
  if (end < start) return [];

  const firstDate = mauritiusDate(new Date(start).toISOString());
  // One millisecond before the end, so an end exactly at midnight belongs to
  // the day that is ending rather than to the one starting. See above.
  const lastDate = mauritiusDate(new Date(end > start ? end - 1 : end).toISOString());
  if (!firstDate || !lastDate) return [];

  const dates: string[] = [];
  // Walk in Mauritius local days by stepping the epoch: the offset is fixed, so
  // adding 24 hours to an instant always lands on the same wall-clock time the
  // next day. This would need care in a country with DST; Mauritius has none.
  let cursor = start;
  let ymd = firstDate;
  // The guard is not defensive dressing: `validateEvent` caps a timed event at
  // 24 hours, but this function is exported and reachable from a caller that
  // skipped validation, and an unbounded walk here would be a hung request.
  for (let guard = 0; guard <= 366 && ymd <= lastDate; guard++) {
    dates.push(ymd);
    cursor += DAY_MS;
    ymd = mauritiusDate(new Date(cursor).toISOString());
    if (!ymd) break;
  }

  return dates;
}

export interface AbsenceLookup {
  /** staff_id -> the set of YYYY-MM-DD they are recorded absent. */
  [staffId: string]: string[];
}

export interface AttendeeConflict {
  staffId: string;
  dates: string[];
}

/**
 * Which invitees are recorded absent on any date this meeting touches.
 *
 * This is the reason the calendar is in the app at all. It WARNS, it never
 * blocks — the same call `overlappingDates` makes in leave.ts. Half the
 * absences on the board were parsed out of prose and some are flagged for
 * review, the organiser may know something the board does not, and a meeting
 * refused by software is a meeting arranged over WhatsApp instead.
 *
 * Only attendees with a conflict are returned, so an empty array means "nothing
 * to say" and the UI has nothing to render. Input order of attendees is
 * preserved, because it is the order the organiser typed them and re-sorting a
 * list somebody just entered makes them re-read it. Dates are sorted and
 * de-duplicated so the warning reads as a list of days rather than a multiset —
 * ISO dates sort lexicographically as dates, which is why this whole file can
 * compare them as plain strings.
 *
 * An unknown staff id simply has no absences: a new joiner missing from the
 * board is not an error, and never throws.
 */
export function attendeeConflicts(
  attendeeStaffIds: string[],
  absences: AbsenceLookup,
  range: TimeRange,
): AttendeeConflict[] {
  const days = new Set(datesTouched(range));
  if (days.size === 0) return [];

  const lookup = absences ?? {};
  const conflicts: AttendeeConflict[] = [];
  const seen = new Set<string>();

  for (const raw of attendeeStaffIds ?? []) {
    const staffId = (raw ?? "").trim();
    if (!staffId || seen.has(staffId)) continue;
    // A person invited twice is one person. Warning about them twice would read
    // as two separate problems.
    seen.add(staffId);

    const absent = Array.isArray(lookup[staffId]) ? lookup[staffId] : [];
    const hits = new Set<string>();
    for (const date of absent) {
      const ymd = (date ?? "").trim();
      if (ymd && days.has(ymd)) hits.add(ymd);
    }

    if (hits.size > 0) conflicts.push({ staffId, dates: [...hits].sort() });
  }

  return conflicts;
}
