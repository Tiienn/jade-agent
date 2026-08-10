// Leave notice templates — pure, deterministic, no model call.
//
// Two emails come out of a leave decision: the all-staff absence notice, and a
// confirmation to the person who asked. Both are built here, as strings, from a
// handful of arguments. Nothing in this module touches the network, the
// database, the clock or the environment, which is what lets the round-trip
// test in leaveDrafts_test.ts run the output straight back through the parser.
//
// WHY THERE IS NO LLM IN HERE
//
// mail-draft.ts asks a model to write a reply because a reply is a judgement:
// it has to read a thread nobody anticipated and answer it. An absence notice
// is the opposite. It is one sentence with four variables in it, the office has
// been writing it the same way for three years, and the app's own extractor
// (presence.ts) reads it back off the wire. Two things follow:
//
//   1. Latency. This runs inside the click that approves somebody's leave. A
//      model call would put a second or two of nothing between "Approve" and
//      the board updating, for a sentence we can produce in microseconds.
//   2. Variance, which is the real reason. presence.ts is a fifteen-phrase
//      literal matcher, deliberately, because the wording has been stable. A
//      generative step in the middle would produce "Vidhya will be absent
//      today" one week and "Vidhya is unwell" the next, and neither is in the
//      vocabulary — so the app's own announcement would land in its own review
//      queue. Every notice below is a phrase presence.ts already knows, and the
//      test proves it rather than assuming it.
//
// The mailbox is Stephan's, so the sign-off is his, taken from emailStyle.ts
// rather than written out here. There is exactly one sign-off in this codebase
// and this file must not become a second copy of it.

import { STYLE_PROFILE } from "./emailStyle.ts";

export interface DraftContent {
  subject: string;
  bodyHtml: string;
}

/** The person the leave belongs to. `email` is nullable for the same reason it
 * is nullable in staff_directory: guards and site staff have no mailbox. */
export interface LeavePerson {
  known_as: string;
  full_name: string;
  email: string | null;
}

/**
 * The word that goes between "is on" and "leave".
 *
 * These are not decorative. "sick", "local" and "vacation" are the three
 * spellings CLAUSE_RULES and PATTERN_RULES in presence.ts match on, so changing
 * one of them here silently stops the parser recognising our own notices.
 * `permission` has no "... leave" form at all — see `clauseFor`.
 */
const LEAVE_WORD: Record<string, string> = {
  sick: "sick",
  local_leave: "local",
  vacation_leave: "vacation",
};

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// ---------------------------------------------------------------------------
// Dates
//
// Plain YYYY-MM-DD in, English out. Noon UTC for the same reason leave.ts
// anchors there: twelve hours of slack in either direction, so no downstream
// local-time reading can slide a date onto the day before or after.
// ---------------------------------------------------------------------------

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function parts(ymd: string): { y: number; m: number; d: number; wd: number } | null {
  const s = (ymd ?? "").trim();
  if (!YMD.test(s)) return null;
  const ms = Date.parse(`${s}T12:00:00Z`);
  if (Number.isNaN(ms)) return null;
  const dt = new Date(ms);
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    wd: dt.getUTCDay(),
  };
}

/** 1st, 2nd, 3rd, 4th … 11th, 21st. The office writes "01st" sometimes and
 * presence.ts accepts any suffix on any number, but there is no reason for us
 * to emit a wrong one. */
function ordinal(day: number): string {
  const rem100 = day % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/**
 * "Monday 17th August 2026" — the exact shape the office manager writes and the
 * exact shape presence.ts's WRITTEN_DATE reads back.
 *
 * The weekday is included on purpose even though it is redundant. presence.ts
 * checks a stated weekday against the date and drops confidence when they
 * disagree, so writing both means a corrupted date in our own notice is caught
 * by the parser instead of being filed as fact.
 *
 * Falls back to the raw string for anything that is not a date, rather than
 * throwing: this is called from inside an approval that has already been
 * committed to the database, and an exception here would turn a cosmetic
 * problem into a 500 on a decision that actually succeeded.
 */
function writtenDate(ymd: string): string {
  const p = parts(ymd);
  if (!p) return (ymd ?? "").trim();
  return `${WEEKDAY_NAMES[p.wd]} ${ordinal(p.d)} ${MONTH_NAMES[p.m - 1]} ${p.y}`;
}

/** "Mon", "Wed" — the (Mon-Wed) hint in her multi-day subjects. */
function weekdayAbbrev(ymd: string): string {
  const p = parts(ymd);
  return p ? WEEKDAY_NAMES[p.wd].slice(0, 3) : "";
}

/** "19 August 2026", or "17 to 19 August 2026" when both ends share a month.
 * Subject-line length only — the body always uses `writtenDate`. */
function shortSpan(startDate: string, endDate: string): string {
  const a = parts(startDate);
  const b = parts(endDate);
  if (!a || !b) return startDate === endDate ? startDate : `${startDate} to ${endDate}`;
  if (startDate === endDate) return `${a.d} ${MONTH_NAMES[a.m - 1]} ${a.y}`;
  if (a.y === b.y && a.m === b.m) {
    return `${a.d} to ${b.d} ${MONTH_NAMES[a.m - 1]} ${a.y}`;
  }
  return `${a.d} ${MONTH_NAMES[a.m - 1]} to ${b.d} ${MONTH_NAMES[b.m - 1]} ${b.y}`;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Paragraphs to HTML, and nothing else.
 *
 * No CSS, no tables, no wrapper div with a font stack. These emails are read in
 * Outlook next to the office manager's own, which are plain; anything styled
 * would stand out as machine-written. It also keeps the body trivially
 * reversible back to text, which is what the parser has to do to it.
 */
function paragraphs(lines: string[]): string {
  return lines
    .filter((l) => l.trim().length > 0)
    .map((l) => `<p>${escapeHtml(l)}</p>`)
    .join("");
}

/** The sign-off, split at its blank line so it renders as two paragraphs
 * ("Regards" / the name) exactly as it reads in plain text. */
function signOffLines(): string[] {
  return STYLE_PROFILE.signOff.split(/\n{2,}/).map((s) => s.trim());
}

// ---------------------------------------------------------------------------
// The all-staff notice
// ---------------------------------------------------------------------------

function displayName(person: LeavePerson): string {
  return (person?.known_as ?? "").trim() ||
    (person?.full_name ?? "").trim() ||
    "A colleague";
}

/**
 * The clause that follows "Please note that".
 *
 * Every branch is a phrase lifted from a real notice, and every one of them is
 * in presence.ts's vocabulary. The mapping, and why each reading is the one it
 * is:
 *
 *   permission          -> "has already left office". There is no "permission
 *                          leave" phrasing in the corpus and none in the
 *                          parser; permission is the person who stepped out.
 *                          Dates are appended only in the multi-day case, which
 *                          validation permits but which does not happen in
 *                          practice, so that a long permission at least states
 *                          its own end.
 *   multi-day           -> "is on <word> leave from <date> until <date>".
 *                          "until" is deliberate: presence.ts reads it as the
 *                          last day OUT, whereas "will resume work on" means
 *                          the first day back and would shift the range by a
 *                          day (see lastWorkingDayBefore there). Both are real
 *                          phrasings; only one of them means what a leave
 *                          request's end_date means.
 *   half day, sick/local-> "is on half <sick|local> leave this morning".
 *   half day, vacation  -> "is on vacation leave this morning". There is no
 *                          "half vacation leave" phrase in the parser — the
 *                          half is carried by the morning/afternoon cue, which
 *                          presence.ts applies to any full-day status.
 *   single full day     -> "is sick today" / "is on local leave today" /
 *                          "is on vacation leave today".
 */
function clauseFor(
  name: string,
  leaveType: string,
  startDate: string,
  endDate: string,
  dayPart: string,
): string {
  const multiDay = startDate !== endDate;
  const span = `from ${writtenDate(startDate)} until ${writtenDate(endDate)}`;

  if (leaveType === "permission") {
    return multiDay
      ? `${name} has already left office ${span}`
      : `${name} has already left office`;
  }

  const word = LEAVE_WORD[leaveType];
  if (!word) {
    // Defensive only: validateLeaveRequest refuses anything outside the four
    // types before a request can exist. Say something true rather than pick a
    // type at random — the parser will flag it for review, which is the correct
    // outcome for a notice nobody meant to be able to generate.
    const raw = (leaveType ?? "").replace(/_/g, " ").trim() || "leave";
    return multiDay ? `${name} is on ${raw} ${span}` : `${name} is on ${raw} today`;
  }

  if (multiDay) return `${name} is on ${word} leave ${span}`;

  if (dayPart === "am" || dayPart === "pm") {
    const half = dayPart === "am" ? "this morning" : "this afternoon";
    // "half sick leave" and "half local leave" are literal phrases in
    // presence.ts; "half vacation leave" is not, so vacation states the plain
    // phrase and lets the morning/afternoon cue carry the half.
    return word === "vacation"
      ? `${name} is on vacation leave ${half}`
      : `${name} is on half ${word} leave ${half}`;
  }

  // "is sick" rather than "is on sick leave": the corpus uses the short form
  // for a single day and the long one for a range, and so do we.
  if (word === "sick") return `${name} is sick today`;
  return `${name} is on ${word} leave today`;
}

/**
 * Her subject lines, mirrored: "Vidhya is sick", "Permission - Sandy",
 * "Sandy is on local leave (Mon-Wed)".
 *
 * The subject is not decoration either. presence.ts cross-checks the status it
 * read from the body against the one implied by the subject, checks a
 * "(Mon-Wed)" hint against the dates it computed, and takes an "(AM)"/"(PM)"
 * suffix as corroboration of a half day. A subject that agrees with the body is
 * therefore what keeps our own notice `confident` when it is read back.
 */
function subjectFor(
  name: string,
  leaveType: string,
  startDate: string,
  endDate: string,
  dayPart: string,
): string {
  if (leaveType === "permission") return `Permission - ${name}`;

  const word = LEAVE_WORD[leaveType];
  if (!word) return `${name} - leave`;

  if (startDate !== endDate) {
    return `${name} is on ${word} leave (${weekdayAbbrev(startDate)}-${
      weekdayAbbrev(endDate)
    })`;
  }

  if (dayPart === "am" || dayPart === "pm") {
    const side = dayPart === "am" ? "AM" : "PM";
    return word === "vacation"
      ? `${name} is on vacation leave (${side})`
      : `${name} is on half ${word} leave (${side})`;
  }

  return word === "sick" ? `${name} is sick` : `${name} is on ${word} leave`;
}

/**
 * The all-staff absence notice.
 *
 * Envelope, wording and sign-off all match the notices the office already
 * sends, because the same parser reads both. See leaveDrafts_test.ts, which
 * feeds every shape of this back through `extractPresence` and asserts the
 * person, the status and the day part survive the round trip.
 */
export function allStaffNotice(
  person: LeavePerson,
  leaveType: string,
  startDate: string,
  endDate: string,
  dayPart: string,
): DraftContent {
  const name = displayName(person);
  return {
    subject: subjectFor(name, leaveType, startDate, endDate, dayPart),
    bodyHtml: paragraphs([
      "Dear all,",
      `Please note that ${clauseFor(name, leaveType, startDate, endDate, dayPart)}`,
      ...signOffLines(),
    ]),
  };
}

// ---------------------------------------------------------------------------
// The requester's confirmation
// ---------------------------------------------------------------------------

/** "sick leave", "local leave", "vacation leave", "permission" — how the
 * decision is described back to the person, in ordinary English rather than
 * the enum. */
function typePhrase(leaveType: string): string {
  if (leaveType === "permission") return "permission";
  const word = LEAVE_WORD[leaveType];
  if (!word) return (leaveType ?? "").replace(/_/g, " ").trim() || "leave";
  return `${word} leave`;
}

/** "on Wednesday 19th August 2026", "on the morning of …", "from … until …". */
function whenPhrase(startDate: string, endDate: string, dayPart: string): string {
  if (startDate !== endDate) {
    return `from ${writtenDate(startDate)} until ${writtenDate(endDate)}`;
  }
  if (dayPart === "am") return `on the morning of ${writtenDate(startDate)}`;
  if (dayPart === "pm") return `on the afternoon of ${writtenDate(startDate)}`;
  return `on ${writtenDate(startDate)}`;
}

/**
 * Confirmation to the person who asked.
 *
 * Warmer than the all-staff notice — it names what was decided rather than just
 * stating a fact about somebody — but written to the same profile, which means
 * short and with no greeting: `emailStyle.ts` records that he does not write
 * "Hi Charles" to colleagues, and there is no reason for the app to invent a
 * habit he does not have. It also stops dead after the decision. The style
 * profile's globalRules forbid a closing offer of further help ("He simply
 * stops"), and a template is exactly where that kind of filler creeps in.
 *
 * `note` is the approver's decision note, and it is included verbatim whenever
 * there is one. It carries the whole reason for a decline; dropping it would
 * leave the requester with a refusal and no explanation, which is the one thing
 * that would send them back to asking by email.
 *
 * Unlike the all-staff notice, this is not read by any parser. It is still a
 * fixed template for the same reason: it goes out under his name and it must
 * say the same thing every time.
 */
export function requesterConfirmation(
  person: LeavePerson,
  leaveType: string,
  startDate: string,
  endDate: string,
  dayPart: string,
  decision: "approved" | "declined",
  note: string | null,
): DraftContent {
  const when = whenPhrase(startDate, endDate, dayPart);
  const type = typePhrase(leaveType);
  const cleanNote = (note ?? "").trim();

  const verdict = decision === "approved"
    ? `Your request for ${type} ${when} has been approved.`
    : `Your request for ${type} ${when} has not been approved.`;

  return {
    subject: `Leave ${decision} - ${shortSpan(startDate, endDate)}`,
    bodyHtml: paragraphs([
      verdict,
      cleanNote ? `Note: ${cleanNote}` : "",
      ...signOffLines(),
    ]),
  };
}
