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

export type PresenceStatus =
  | "sick"
  | "local_leave"
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

interface ClauseRule {
  /** Lowercase literal, matched by position so the earliest clause wins. */
  phrase: string;
  status: PresenceStatus;
  /** "half" means a half day whose side (am/pm) is decided separately. */
  dayPart: DayPart | "half";
  note?: string;
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
  { phrase: "will be late", status: "late", dayPart: "partial", note: "arriving late" },
  { phrase: "is sick", status: "sick", dayPart: "full" },
  { phrase: "are sick", status: "sick", dayPart: "full" },
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
  /\b(is|are)\s+sick\b|\bsick\s+leave\b|\blocal\s+leave\b|\bpermission\b|\bwill\s+be\s+late\b|\bout\s+of\s+office\b|\babsen(t|ce)\b|\bhalf\s+day\b/i;

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

function weekdayOf(ymd: string): number {
  const ms = Date.parse(`${ymd}T00:00:00Z`);
  return Number.isNaN(ms) ? -1 : new Date(ms).getUTCDay();
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
  rule: ClauseRule;
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
    let best: RuleMatch | null = null;
    for (const rule of CLAUSE_RULES) {
      const at = lower.indexOf(rule.phrase, from);
      if (at < 0) continue;
      const candidate = { rule, start: at, end: at + rule.phrase.length };
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
 * Dates for one clause, relative to the Mauritius date the mail was sent.
 * Absences are announced on the morning they start, so "today" — stated or
 * implied — is the default and the overwhelmingly common case.
 */
function resolveRange(segment: string, sendDate: string): ResolvedRange {
  if (!sendDate) return { startDate: "", endDate: "", confident: false };

  const lower = segment.toLowerCase();
  let startDate = sendDate;
  let confident = true;

  if (/\bfrom tomorrow\b/.test(lower)) startDate = addDays(sendDate, 1);

  let endDate = startDate;
  // A bare "to" is deliberately not accepted here: "late today due to traffic"
  // is not a date range, and treating it as one would drag a routine notice
  // into the review queue every time somebody explains themselves.
  const until = lower.match(/\b(?:until|till|til|up to|through)\s+(?:next\s+)?([a-z]+)/);
  if (until) {
    const token = until[1];
    if (token === "tomorrow") {
      endDate = addDays(startDate, 1);
    } else if (token in WEEKDAYS) {
      endDate = nextWeekdayOnOrAfter(startDate, WEEKDAYS[token]);
    } else {
      // A range we cannot read is exactly the case a human should see: the
      // absence is real, its length is not.
      confident = false;
    }
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
