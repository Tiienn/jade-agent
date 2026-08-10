// Staff presence extraction — pure rules, no network, no model call.
//
// Melanie in the office emails all staff every time somebody is out, and the
// wording has been stable for years: "Please note that <person> <clause>".
// That regularity is worth exploiting — an LLM call per absence notice would be
// slower, dearer and less predictable than the fifteen phrases below, and the
// presence board has to be right every morning or nobody trusts it.
//
// Two things drive every design decision in here:
//
//   1. A dropped absence is worse than a wrong one. If a clause parses to
//      nothing we still emit a fact, flagged `confident: false`, so it lands in
//      the review queue instead of vanishing. Silence looks identical to "the
//      office was fully staffed", and that is the one lie the board must not
//      tell.
//   2. Dates are read in Mauritius time, never UTC. "today" in an email sent at
//      20:30 UTC is already tomorrow in Port Louis, and filing that absence a
//      day early is invisible until someone is marked present while they are at
//      home sick.
//
// Deliberately pure and dependency-free so it can be unit-tested against the
// real mailbox corpus — see presence_test.ts. Nothing in here may import graph,
// supabase, or env.

// `local_leave` and `vacation_leave` are deliberately separate. In Mauritius
// they are two different entitlements: local leave is the short casual day off,
// vacation leave is the long annual one. Folding the second into the first
// would report a three-week absence as a day off, which is not a rounding error
// — it is the difference between "back tomorrow" and "back next month" on a
// board people use to decide whether to wait for someone.
export type PresenceStatus =
  | "sick"
  | "local_leave"
  | "vacation_leave"
  | "permission"
  | "late"
  | "off_site"
  | "other";

export type DayPart = "full" | "am" | "pm" | "partial";

export interface PresenceFact {
  rawName: string; // name exactly as written, e.g. "Marie-Claire"
  status: PresenceStatus;
  dayPart: DayPart;
  startDate: string; // "YYYY-MM-DD" in Mauritius time
  endDate: string; // "YYYY-MM-DD"; equals startDate for a single day
  note?: string; // short human-readable detail, e.g. "left office early"
  confident: boolean; // false => caller must flag needs_review
}

export interface PresenceInput {
  subject: string;
  body: string; // plain text; may include signature and disclaimer
  sentAt: string; // ISO 8601 timestamp of the email
  fromEmail: string;
}

/**
 * Mauritius is UTC+4 and has never observed daylight saving — the 2008-09 trial
 * was abandoned and the offset has been fixed since. So a constant is honest
 * here in a way it would not be for almost any other country, and it keeps this
 * module dependency-free.
 */
const MAURITIUS_UTC_OFFSET_MINUTES = 240;

/**
 * Everything from the sign-off down is boilerplate. It has to go before any
 * parsing happens, otherwise "Melanie Lau" on the line under "Regards" is read
 * as a fourth absent colleague — she is the one person in the company who is
 * never absent in her own emails.
 */
const SIGNATURE_MARKERS = [
  /^\s*regards\b/i,
  /^\s*(kind|best|warm|warmest)\s+regards\b/i,
  /^\s*thanks?\s*(&|and)?\s*regards\b/i,
  /^\s*(best|kind)\s+wishes\b/i,
  /^\s*disclaimer\s*:/i,
  /^\s*sent from my /i,
];

/** The lead-in is fixed. Anything before it is the greeting, not a clause. */
const LEAD_IN = "please note that";

/**
 * A bare greeting is not a clause. It only survives this far when the sender
 * skipped the "Please note that" lead-in, and without this an email whose body
 * is nothing but "Dear all," files an absence for review every time.
 */
const GREETING_ONLY =
  /^(dear|hi|hello|greetings|good\s+(morning|afternoon|evening))(\s+(all|everyone|team|colleagues|staff))?\s*[,.!]*$/i;

/** What a matched phrase asserts, whichever kind of rule matched it. */
interface RuleEffect {
  status: PresenceStatus;
  /** "half" means a half day whose side (am/pm) is decided separately. */
  dayPart: DayPart | "half";
  note?: string;
}

interface ClauseRule extends RuleEffect {
  /** Lowercase literal, matched by position so the earliest clause wins. */
  phrase: string;
}

/**
 * The few phrases a literal cannot express, because a number or an optional
 * word sits inside them ("is on 3 weeks' vacation leave"). Matched exactly like
 * the literals — by position, earliest wins — so the two lists are one
 * vocabulary with two spellings, not two passes with a precedence rule to get
 * wrong. Kept small on purpose: a literal is easier to read and impossible to
 * make accidentally greedy, so a phrase only earns a regex when it must.
 */
interface PatternRule extends RuleEffect {
  /** Must be anchorless and non-global — `matchRules` scans from an offset. */
  pattern: RegExp;
}

/**
 * The whole observed vocabulary, from three years of notices. Order in this
 * array does not decide precedence — position in the sentence does (see
 * `matchRules`) — but longer phrases are listed first so that a tie at the same
 * index resolves to the more specific reading.
 *
 * Note that no phrase here is a substring of another at the same start
 * position: "is on half local leave" and "is on local leave" cannot both match
 * the same text, which is what lets a plain `indexOf` scan be trusted.
 */
const CLAUSE_RULES: ClauseRule[] = [
  { phrase: "is on half sick leave", status: "sick", dayPart: "half" },
  { phrase: "are on half sick leave", status: "sick", dayPart: "half" },
  { phrase: "is on half local leave", status: "local_leave", dayPart: "half" },
  { phrase: "are on half local leave", status: "local_leave", dayPart: "half" },
  {
    phrase: "is out of office and will be back",
    status: "permission",
    dayPart: "partial",
    note: "out of office, back later",
  },
  {
    phrase: "are out of office and will be back",
    status: "permission",
    dayPart: "partial",
    note: "out of office, back later",
  },
  {
    phrase: "has already left office",
    status: "permission",
    dayPart: "partial",
    note: "left office early",
  },
  {
    phrase: "have already left office",
    status: "permission",
    dayPart: "partial",
    note: "left office early",
  },
  { phrase: "is on local leave", status: "local_leave", dayPart: "full" },
  { phrase: "are on local leave", status: "local_leave", dayPart: "full" },
  // "is on sick leave" is the wording used for the multi-day notices ("… and
  // will resume work on Monday"), where "is sick" is used for a single day.
  // Both mean the same status. This cannot collide with the half-day rule
  // above: "is on half sick leave" does not contain "is on sick leave", so the
  // more specific phrase still wins wherever it is written.
  { phrase: "is on sick leave", status: "sick", dayPart: "full" },
  { phrase: "are on sick leave", status: "sick", dayPart: "full" },
  { phrase: "will be late", status: "late", dayPart: "partial", note: "arriving late" },
  { phrase: "is sick", status: "sick", dayPart: "full" },
  { phrase: "are sick", status: "sick", dayPart: "full" },
];

const PATTERN_RULES: PatternRule[] = [
  {
    // "is on vacation leave" and "is on 3 weeks' vacation leave" are one phrase
    // with an optional length in the middle. The length is left inside the
    // match rather than stripped out because `resolveRange` reads the segment
    // starting at the match, and that is where it looks for the duration.
    // The apostrophe in "weeks'" is optional and may be the curly one Outlook
    // substitutes.
    pattern:
      /\b(?:is|are)\s+on\s+(?:\d{1,3}\s*(?:day|week|month)s?\s*['’]?\s+)?vacation\s+leave\b/i,
    status: "vacation_leave",
    dayPart: "full",
  },
  {
    // Same family as "has already left office" — the person was here and is
    // now gone for an unstated slice of the day. The reason is worth keeping in
    // the note: it is the one detail a reader of the board would otherwise have
    // to go back to the mailbox for.
    pattern: /\bhad\s+to\s+leave\s+(?:the\s+)?office\s+due\s+to\s+(?:an?\s+)?emergency\b/i,
    status: "permission",
    dayPart: "partial",
    note: "left office - emergency",
  },
];

/** Which half of the day a half-leave falls on, as written in the body. */
const HALF_DAY_CUES: { cue: string; side: DayPart }[] = [
  { cue: "this morning", side: "am" },
  { cue: "in the morning", side: "am" },
  { cue: "this afternoon", side: "pm" },
  { cue: "in the afternoon", side: "pm" },
];

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tues: 2,
  tue: 2,
  wednesday: 3,
  weds: 3,
  wed: 3,
  thursday: 4,
  thurs: 4,
  thur: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

/**
 * A written-out date, as the office actually writes them: "Monday 18th May
 * 2026", "Friday 29th May 2026", "Monday 01st June 2026".
 *
 * Every part except the day and the month is optional, because every part
 * except those two is inconsistent in the real mail:
 *   * the weekday is usually but not always given — when it is, it is checked
 *     against the date rather than trusted (see `parseWrittenDate`);
 *   * the ordinal suffix is whatever was typed. "01st" is real, and so is
 *     "22th", so any of st/nd/rd/th is accepted on any number rather than the
 *     grammatically correct one — refusing a typo here would drop a date we can
 *     plainly read;
 *   * the year is omitted on same-year dates.
 *
 * Global because `parseWrittenDate` walks every candidate: the first
 * digits-then-word in a sentence is not always the date ("until 5 pm on Monday
 * 18th May"), and giving up at the first non-date would lose a date a human
 * reads at a glance. `matchAll` copies the regex before using it, so the shared
 * `lastIndex` is never mutated.
 */
const WRITTEN_DATE =
  /(?:([a-z]{3,9})\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})\b\.?(?:,?\s+(\d{4}))?/g;

/**
 * Single words that sit where a name would but cannot be one. Without this a
 * clause like "the office will be late opening" books an absence for a person
 * called "The office".
 */
const NAME_STOPWORDS = new Set([
  "the",
  "a",
  "he",
  "she",
  "they",
  "we",
  "i",
  "it",
  "this",
  "that",
  "there",
  "all",
  "everyone",
  "everybody",
  "staff",
  "office",
  "team",
  "management",
  "reception",
  "nobody",
  "someone",
]);

/**
 * Fragments that prove the signature stripper missed something. A name is never
 * allowed to contain these, so even a malformed email cannot file an absence
 * for "Regards" or for whoever signed the notice.
 */
const NAME_BLOCKLIST = [
  "regards",
  "disclaimer",
  "confidential",
  "privileged",
  "please note",
  "dear all",
  "thank",
  "sent from",
];

/**
 * Cheap subject-line sniff. Kept permissive on purpose: it only has to be good
 * enough to stop us parsing invoices, and anything it lets through is discarded
 * by extraction anyway.
 */
const SUBJECT_PRESENCE_PATTERN =
  /\b(is|are)\s+sick\b|\bsick\s+leave\b|\blocal\s+leave\b|\bvacation\s+leave\b|\bpermission\b|\bwill\s+be\s+late\b|\bout\s+of\s+office\b|\babsen(t|ce)\b|\bhalf\s+day\b/i;

function norm(s: string): string {
  return (s ?? "").trim().toLowerCase();
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * ISO timestamp -> the calendar date it was in Mauritius at that instant.
 *
 * Shifting the epoch by the fixed offset and then reading the *UTC* fields is
 * the only way to do this without a timezone library: reading local fields
 * would give whatever timezone the edge function happens to run in, which is
 * UTC in production and something else entirely on a developer's laptop.
 *
 * Returns "" for an unparseable timestamp; callers treat that as "no date" and
 * drop to low confidence rather than inventing today.
 */
export function mauritiusDate(iso: string): string {
  const ms = Date.parse(iso ?? "");
  if (Number.isNaN(ms)) return "";
  const shifted = new Date(ms + MAURITIUS_UTC_OFFSET_MINUTES * 60_000);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${
    pad2(shifted.getUTCDate())
  }`;
}

function addDays(ymd: string, days: number): string {
  const ms = Date.parse(`${ymd}T00:00:00Z`);
  if (Number.isNaN(ms)) return ymd;
  const d = new Date(ms + days * 86_400_000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * Calendar months, clamped to the end of a short month: one month after the
 * 31st of January is the 28th of February, not the 3rd of March. Only reachable
 * from "N months" durations, which are rare, but silently sliding a return date
 * into the following month is the kind of error nobody catches by reading the
 * board.
 */
function addMonths(ymd: string, months: number): string {
  const ms = Date.parse(`${ymd}T00:00:00Z`);
  if (Number.isNaN(ms)) return ymd;
  const d = new Date(ms);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastOfMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastOfMonth));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function weekdayOf(ymd: string): number {
  const ms = Date.parse(`${ymd}T00:00:00Z`);
  return Number.isNaN(ms) ? -1 : new Date(ms).getUTCDay();
}

function isWeekend(ymd: string): boolean {
  const day = weekdayOf(ymd);
  return day === 0 || day === 6;
}

/** Rejects the 31st of a 30-day month and the 30th of February. */
function isRealDate(ymd: string): boolean {
  const ms = Date.parse(`${ymd}T00:00:00Z`);
  if (Number.isNaN(ms)) return false;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` === ymd;
}

/**
 * "until Wednesday" means the Wednesday of the week you are already in, not the
 * one after — Melanie writes these on the Monday morning of the absence. On the
 * day itself ("on local leave today until Monday", sent Monday) the same day is
 * the honest reading: a one-day absence, not an eight-day one.
 */
function nextWeekdayOnOrAfter(ymd: string, target: number): string {
  const from = weekdayOf(ymd);
  if (from < 0 || target < 0) return ymd;
  return addDays(ymd, (target - from + 7) % 7);
}

/**
 * Strictly after, unlike `nextWeekdayOnOrAfter`. Used only for a RETURN date:
 * "will resume work on Monday" written on a Monday means the Monday after this
 * one, because the writer is telling us the person is out today.
 */
function nextWeekdayAfter(ymd: string, target: number): string {
  const from = weekdayOf(ymd);
  if (from < 0 || target < 0) return ymd;
  return addDays(ymd, ((target - from + 6) % 7) + 1);
}

/**
 * The last day somebody was absent, given the day they come back.
 *
 * This is the whole point of reading "will resume work on X": the return date
 * is NOT the last absent day, it is the first present one. A Monday return
 * means the absence ended on the FRIDAY — not the Sunday, which is what naive
 * "day before" arithmetic gives and which would mark a person absent on a
 * Saturday and Sunday they were never expected in, and (worse, because it is
 * invisible) leave the board silent about the Friday they actually missed.
 */
function lastWorkingDayBefore(ymd: string): string {
  let cursor = addDays(ymd, -1);
  for (let guard = 0; guard < 7 && isWeekend(cursor); guard++) {
    cursor = addDays(cursor, -1);
  }
  return cursor;
}

interface WrittenDate {
  ymd: string;
  /** False when a weekday name was given and it is not that date's weekday. */
  weekdayAgrees: boolean;
}

/**
 * The first readable written-out date in `text`, or null.
 *
 * `anchor` supplies the year when the writer left it off, choosing the reading
 * that is not in the past: an absence notice never talks about last year.
 *
 * A stated weekday is checked, never trusted. "Monday 18th May 2026" carries
 * the same fact twice, and the parser can therefore tell when one of them is a
 * typo — which is the difference between quietly filing a wrong date and
 * putting the mail in front of a human.
 */
function parseWrittenDate(text: string, anchor: string): WrittenDate | null {
  for (const m of (text ?? "").matchAll(WRITTEN_DATE)) {
    const month = MONTHS[m[3] ?? ""];
    if (!month) continue; // "5 pm", "2 hours" — a number and a word, not a date
    const day = Number(m[2]);
    if (!(day >= 1 && day <= 31)) continue;

    const base = Number((anchor ?? "").slice(0, 4));
    let year = m[4] ? Number(m[4]) : base;
    if (!m[4] && Number.isFinite(base)) {
      // No year written. Same year unless that would put the date before the
      // email that announces it, in which case it is next January onwards.
      if (`${year}-${pad2(month)}-${pad2(day)}` < anchor) year += 1;
    }
    if (!Number.isFinite(year)) continue;

    const ymd = `${year}-${pad2(month)}-${pad2(day)}`;
    if (!isRealDate(ymd)) continue;

    const statedWeekday = WEEKDAYS[m[1] ?? ""];
    return {
      ymd,
      weekdayAgrees: statedWeekday === undefined || weekdayOf(ymd) === statedWeekday,
    };
  }
  return null;
}

/** Everything above the sign-off. */
function stripSignature(body: string): string {
  const lines = (body ?? "").split(/\r?\n/);
  const cut = lines.findIndex((line) => SIGNATURE_MARKERS.some((m) => m.test(line)));
  return (cut < 0 ? lines : lines.slice(0, cut)).join("\n");
}

/**
 * Cut down to the part of the email that actually states the absence.
 * Everything before "Please note that" is "Dear all"; everything after the
 * sign-off is legal boilerplate.
 */
function clauseRegion(body: string): string {
  const stripped = stripSignature(body);
  const at = stripped.toLowerCase().indexOf(LEAD_IN);
  return (at < 0 ? stripped : stripped.slice(at + LEAD_IN.length)).trim();
}

/**
 * One clause per absence. Outlook renders the multi-person notices as a bullet
 * list and the plain-text conversion leaves the bullet alone on its own line,
 * with the sentence underneath — so a bullet starts an item and the lines that
 * follow belong to it.
 */
function splitClauses(region: string): string[] {
  const lines = region.split(/\r?\n/);
  const bulleted = lines.some((l) => /^\s*[*•\-–]\s*$|^\s*[*•]\s+\S/.test(l));

  if (bulleted) {
    const items: string[] = [];
    for (const line of lines) {
      const bullet = line.match(/^\s*[*•\-–]\s*(.*)$/);
      if (bullet) {
        items.push(bullet[1].trim());
        continue;
      }
      if (items.length === 0) continue; // preamble above the first bullet
      const text = line.trim();
      if (text) items[items.length - 1] = `${items[items.length - 1]} ${text}`.trim();
    }
    return items.map((i) => i.trim()).filter((i) => i && !GREETING_ONLY.test(i));
  }

  // Unbulleted: one sentence is one clause. Fragments of a single word are
  // dropped — they are abbreviations ("Mr.") split by the sentence rule, never
  // an absence worth reviewing.
  return region
    .split(/\r?\n+/)
    .join(" ")
    .split(/(?<=\.)\s+/)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).filter(Boolean).length >= 2)
    .filter((s) => !GREETING_ONLY.test(s));
}

function isPlausibleName(candidate: string): boolean {
  const name = candidate.trim();
  if (!name || name.length > 40) return false;
  // Letters, plus the punctuation that shows up in real Mauritian names:
  // Marie-Claire, D'Souza, J. Ah Thien.
  if (!/^\p{L}[\p{L}'’.\- ]*$/u.test(name)) return false;
  const words = name.split(/\s+/);
  if (words.length > 3) return false;
  const lower = name.toLowerCase();
  if (NAME_STOPWORDS.has(lower)) return false;
  return !NAME_BLOCKLIST.some((bad) => lower.includes(bad));
}

/**
 * "Marie-Claire and Vidhya" -> two people. Split only on the text that sits
 * *before* a status phrase: " and " is also load-bearing inside the clauses
 * themselves ("is out of office and will be back"), so splitting the whole
 * sentence would invent a colleague called "will be back afterwards".
 */
function splitNames(segment: string): string[] {
  return segment
    .replace(/^[\s,;:*•\-–]+/, "")
    .replace(/^and\s+/i, "")
    .split(/\s*,\s*|\s+and\s+|\s*&\s*/i)
    .map((n) => n.trim().replace(/[.,;:]+$/, ""))
    .filter((n) => isPlausibleName(n));
}

interface RuleMatch {
  rule: RuleEffect;
  start: number;
  end: number;
}

/**
 * Every non-overlapping vocabulary hit in a clause, left to right. Scanning for
 * all of them (rather than the first) is what lets a single unbulleted line
 * carry two different statuses — "Kamini is sick and Rekha is on local leave"
 * arrives that way whenever Outlook does not convert the list.
 */
function matchRules(clause: string): RuleMatch[] {
  const lower = clause.toLowerCase();
  const hits: RuleMatch[] = [];
  let from = 0;

  while (from < lower.length) {
    const candidates: RuleMatch[] = [];

    for (const rule of CLAUSE_RULES) {
      const at = lower.indexOf(rule.phrase, from);
      if (at < 0) continue;
      candidates.push({ rule, start: at, end: at + rule.phrase.length });
    }

    // The pattern rules are searched in the same window and compete on exactly
    // the same terms, so which list a phrase lives in never changes which
    // phrase wins — only how it is written down.
    for (const rule of PATTERN_RULES) {
      const m = lower.slice(from).match(rule.pattern);
      if (!m || m.index === undefined) continue;
      const at = from + m.index;
      candidates.push({ rule, start: at, end: at + m[0].length });
    }

    let best: RuleMatch | null = null;
    for (const candidate of candidates) {
      // Earliest wins; on a tie the longer (more specific) phrase wins.
      if (
        !best ||
        candidate.start < best.start ||
        (candidate.start === best.start && candidate.end > best.end)
      ) {
        best = candidate;
      }
    }
    if (!best) break;
    hits.push(best);
    from = best.end;
  }

  return hits;
}

/** Which side of the day, from the body first and the subject only as backup. */
function resolveSide(segment: string, subject: string): { side: DayPart; agreed: boolean } {
  const lower = segment.toLowerCase();
  const bodySide = HALF_DAY_CUES.find((c) => lower.includes(c.cue))?.side;

  // Uppercase-only on purpose: the convention in these subjects is a bare
  // "AM"/"PM" suffix, and lowercasing first would match the "am" in a name or
  // in "I am out".
  const subjectSide: DayPart | undefined = /\bAM\b/.test(subject ?? "")
    ? "am"
    : /\bPM\b/.test(subject ?? "")
    ? "pm"
    : undefined;

  if (bodySide && subjectSide) return { side: bodySide, agreed: bodySide === subjectSide };
  if (bodySide) return { side: bodySide, agreed: true };
  if (subjectSide) return { side: subjectSide, agreed: true };
  // A half day with no stated side is still a half day — but we do not know
  // which half, so it goes for review rather than being guessed at.
  return { side: "partial", agreed: false };
}

interface ResolvedRange {
  startDate: string;
  endDate: string;
  confident: boolean;
}

/**
 * One statement about when an absence ends.
 *
 * `endDate: ""` means the clause plainly stated a length and we could not read
 * it — which is a different thing from saying nothing, and must lower
 * confidence rather than be ignored.
 */
interface EndSignal {
  endDate: string;
  /** False when the statement contradicts itself, e.g. a wrong weekday name. */
  coherent: boolean;
}

/**
 * "until Wednesday", "until Friday 29th May 2026" — the last day OUT.
 *
 * A bare "to" is deliberately not accepted here: "late today due to traffic"
 * is not a date range, and treating it as one would drag a routine notice into
 * the review queue every time somebody explains themselves.
 */
function readUntil(lower: string, startDate: string): EndSignal | null {
  const until = lower.match(/\b(?:until|till|til|up to|through)\s+(?:next\s+)?(.*)/);
  if (!until) return null;
  const rest = until[1];

  const written = parseWrittenDate(rest, startDate);
  if (written) return { endDate: written.ymd, coherent: written.weekdayAgrees };

  const token = (rest.match(/^([a-z]+)/) ?? ["", ""])[1];
  if (token === "tomorrow") {
    return { endDate: addDays(startDate, 1), coherent: true };
  }
  if (token in WEEKDAYS) {
    const endDate = nextWeekdayOnOrAfter(startDate, WEEKDAYS[token]);
    return { endDate, coherent: true };
  }
  // A range we cannot read is exactly the case a human should see: the absence
  // is real, its length is not.
  return { endDate: "", coherent: false };
}

/**
 * "will resume work on Monday 18th May 2026" — the first day back IN, which is
 * the day AFTER the absence ends. See `lastWorkingDayBefore`.
 *
 * `wil+` rather than `will` because the office types these at 8am: "willl" is
 * in the corpus verbatim. The cost of being loose here is nil — no other word
 * in these notices is spelled w-i-l-something and followed by "resume".
 */
function readResume(lower: string, startDate: string): EndSignal | null {
  const resume = lower.match(/\bwil+\s+resume\s+(?:work\s+)?(?:on\s+)?(.*)/);
  if (!resume) return null;
  const rest = resume[1];

  const written = parseWrittenDate(rest, startDate);
  if (written) {
    return {
      endDate: lastWorkingDayBefore(written.ymd),
      coherent: written.weekdayAgrees,
    };
  }

  const token = (rest.match(/^([a-z]+)/) ?? ["", ""])[1];
  // "resume work tomorrow" says only one thing: out today. No weekend
  // arithmetic applies, because the day being named is the start day itself.
  if (token === "tomorrow") return { endDate: startDate, coherent: true };
  if (token in WEEKDAYS) {
    return {
      endDate: lastWorkingDayBefore(nextWeekdayAfter(startDate, WEEKDAYS[token])),
      coherent: true,
    };
  }
  return { endDate: "", coherent: false };
}

/**
 * "3 weeks' vacation leave", "2 days", "1 month" — a length rather than an end.
 *
 * Inclusive of the first day: three weeks starting Thursday the 14th runs
 * through Wednesday the 3rd, not the 4th. Weekends are counted, because a
 * calendar length is what was written; the store decides which of those days
 * become rows.
 */
function readDuration(lower: string, startDate: string): EndSignal | null {
  const m = lower.match(/\b(\d{1,3})\s*(day|week|month)s?\b/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1) return { endDate: "", coherent: false };

  if (m[2] === "day") {
    return { endDate: addDays(startDate, n - 1), coherent: true };
  }
  if (m[2] === "week") {
    return { endDate: addDays(startDate, n * 7 - 1), coherent: true };
  }
  return { endDate: addDays(addMonths(startDate, n), -1), coherent: true };
}

/**
 * Dates for one clause, relative to the Mauritius date the mail was sent.
 * Absences are announced on the morning they start, so "today" — stated or
 * implied — is the default and the overwhelmingly common case. "effective as
 * from today" says the same thing out loud and needs no special handling; only
 * "from tomorrow" moves the start.
 *
 * A clause may state the end more than once — "until Friday 29th May 2026 and
 * will resume work on Monday 01st June 2026" says it twice, and both readings
 * land on Friday the 29th. That agreement is information: two independent
 * statements of the same date are far better evidence than one, so a corroborated
 * range stays `confident`. When they DISAGREE one of them is a typo and there is
 * no way to tell which, so the EARLIER end is kept — under-stating an absence
 * puts a present person on the board, over-stating it denies a colleague who is
 * actually at their desk — and the fact goes for review.
 */
function resolveRange(segment: string, sendDate: string): ResolvedRange {
  if (!sendDate) return { startDate: "", endDate: "", confident: false };

  const lower = segment.toLowerCase();
  let startDate = sendDate;
  let confident = true;

  if (/\bfrom tomorrow\b/.test(lower)) startDate = addDays(sendDate, 1);

  const stated = [
    readUntil(lower, startDate),
    readResume(lower, startDate),
    readDuration(lower, startDate),
  ].filter((s): s is EndSignal => s !== null);

  let endDate = startDate;

  // Something was said about the length that we could not turn into a date.
  if (stated.some((s) => !s.endDate || !s.coherent)) confident = false;

  const readable = [...new Set(stated.filter((s) => s.endDate).map((s) => s.endDate))].sort();
  if (readable.length > 0) {
    endDate = readable[0];
    if (readable.length > 1) confident = false;
  }

  // An end before the start is not a range, it is a misreading — most often a
  // return date that has already passed. Keep the day we are certain of.
  if (endDate < startDate) {
    endDate = startDate;
    confident = false;
  }

  return { startDate, endDate, confident };
}

/**
 * Subjects carry a "(Mon-Wed)" hint on multi-day notices. Used only to check
 * the dates the body produced — the body is always the source of truth — so a
 * mismatch lowers confidence instead of changing a date.
 */
function subjectRangeAgrees(subject: string, startDate: string, endDate: string): boolean {
  const m = (subject ?? "").match(/\(\s*([a-z]{3,9})\s*[-–—]\s*([a-z]{3,9})\s*\)/i);
  if (!m) return true;
  const from = WEEKDAYS[m[1].toLowerCase()];
  const to = WEEKDAYS[m[2].toLowerCase()];
  if (from === undefined || to === undefined) return true;
  return weekdayOf(startDate) === from && weekdayOf(endDate) === to;
}

/**
 * The status a subject line implies, if any. "Permission - Sandy" is the
 * house shorthand for someone stepping out, and carries no verb at all.
 */
function subjectStatus(subject: string): PresenceStatus | undefined {
  const hits = matchRules(subject ?? "");
  if (hits.length === 1) return hits[0].rule.status;
  if (hits.length === 0 && /\bpermission\b/i.test(subject ?? "")) return "permission";
  return undefined;
}

/** Cheap gate: is this email plausibly an absence announcement at all? */
export function isPresenceEmail(input: {
  fromEmail: string;
  subject: string;
  body: string;
  announcerEmails: string[]; // configured senders, lowercase
}): boolean {
  // The sender check is the hard gate. Absence notices are an internal ritual
  // performed by two or three people; a stranger with a subject line about sick
  // leave is a supplier apologising, not a staff record. Who those people are
  // is configuration, never a constant in here — Melanie will not be the office
  // manager forever.
  const from = norm(input?.fromEmail);
  if (!from) return false;
  const announcers = (input?.announcerEmails ?? []).map(norm);
  if (!announcers.includes(from)) return false;

  if (norm(input?.body).includes(LEAD_IN)) return true;
  return SUBJECT_PRESENCE_PATTERN.test(input?.subject ?? "");
}

/** Extract zero or more absence facts. Never throws. */
export function extractPresence(input: PresenceInput): PresenceFact[] {
  try {
    const subject = (input?.subject ?? "").trim();
    const sendDate = mauritiusDate(input?.sentAt ?? "");
    const region = clauseRegion(input?.body ?? "");

    // Nothing at all to read. Better an honest empty result than a fact
    // invented out of a signature block.
    const clauses = splitClauses(region);
    if (clauses.length === 0) {
      const fromSubject = subject ? parseClause(subject, subject, sendDate, true) : [];
      // A subject-only reading is a guess by definition: the body said nothing.
      return fromSubject.map((f) => ({ ...f, confident: false }));
    }

    const facts: PresenceFact[] = [];
    for (const clause of clauses) {
      facts.push(...parseClause(clause, subject, sendDate, clauses.length === 1));
    }
    return facts;
  } catch {
    // Extraction runs over whatever the mail API hands us. It is called from a
    // sync loop that must not die on one strange email.
    return [];
  }
}

/**
 * One clause -> zero or more facts. Returns an `other` fact rather than nothing
 * when the wording is unfamiliar: the office has invented new phrasing before
 * and will again, and the reviewer needs to see the sentence to add it here.
 */
function parseClause(
  clause: string,
  subject: string,
  sendDate: string,
  crossCheckSubject: boolean,
): PresenceFact[] {
  const text = clause.trim();
  if (!text) return [];

  const hits = matchRules(text);
  if (hits.length === 0) {
    return [{
      rawName: guessLeadingName(text),
      status: "other",
      dayPart: "full",
      startDate: sendDate,
      endDate: sendDate,
      note: text,
      confident: false,
    }];
  }

  const facts: PresenceFact[] = [];
  let carriedNames: string[] = [];

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    const namesFrom = i === 0 ? 0 : hits[i - 1].end;
    const segmentEnd = i + 1 < hits.length ? hits[i + 1].start : text.length;
    const segment = text.slice(hit.start, segmentEnd);

    // "Sandy has already left office and will be late tomorrow" leaves nothing
    // but "and" between the two phrases — the second clause is about the same
    // person, so names carry forward.
    const names = splitNames(text.slice(namesFrom, hit.start));
    const people = names.length > 0 ? names : carriedNames;
    if (names.length > 0) carriedNames = names;
    if (people.length === 0) continue;

    const range = resolveRange(segment, sendDate);
    let confident = range.confident && Boolean(sendDate);

    let dayPart: DayPart;
    if (hit.rule.dayPart === "half") {
      const side = resolveSide(segment, subject);
      dayPart = side.side;
      if (!side.agreed) confident = false;
    } else {
      dayPart = hit.rule.dayPart;
      // A full-day status with an explicit half-day cue is a half day.
      if (dayPart === "full") {
        const cue = HALF_DAY_CUES.find((c) => segment.toLowerCase().includes(c.cue));
        if (cue) dayPart = cue.side;
      }
    }

    // Multi-day absences are full days regardless of any AM/PM in the subject.
    if (range.endDate !== range.startDate) dayPart = "full";

    if (!subjectRangeAgrees(subject, range.startDate, range.endDate)) confident = false;

    // The body is authoritative when the two disagree — the subject is typed
    // first and not always corrected. Only checked for single-fact emails: a
    // subject summarising a two-person notice can only ever name one status,
    // and that is not a contradiction.
    if (crossCheckSubject && hits.length === 1) {
      const hinted = subjectStatus(subject);
      if (hinted && hinted !== hit.rule.status) confident = false;
    }

    for (const rawName of people) {
      facts.push({
        rawName,
        status: hit.rule.status,
        dayPart,
        startDate: range.startDate,
        endDate: range.endDate,
        ...(hit.rule.note ? { note: hit.rule.note } : {}),
        confident,
      });
    }
  }

  if (facts.length === 0) {
    // A recognised phrase with no recognisable person is still an absence
    // somebody has to account for.
    return [{
      rawName: "",
      status: hits[0].rule.status,
      dayPart: "full",
      startDate: sendDate,
      endDate: sendDate,
      note: text,
      confident: false,
    }];
  }

  return facts;
}

/**
 * Best effort at the person in an unparseable clause, so the review queue shows
 * a name instead of a blank. Falls back to "" rather than guessing wrongly.
 */
function guessLeadingName(clause: string): string {
  const m = clause.match(/^\p{Lu}[\p{L}'’\-]*(?:\s+\p{Lu}[\p{L}'’\-]*)?/u);
  if (!m) return "";
  const two = m[0];
  if (isPlausibleName(two)) return two;
  const one = two.split(/\s+/)[0];
  return isPlausibleName(one) ? one : "";
}
