// Deno tests for the pure presence rules.
// Run: deno test supabase/functions/_shared/presence_test.ts
//
// Every fixture below is a real all-staff notice from the Jade mailbox, quoted
// verbatim down to the trailing space in one of the subjects. They are the
// whole specification: the vocabulary in presence.ts exists because these
// sentences exist, and a change that breaks one of them is a change that will
// mis-file a real person's absence.
//
// The envelope is always the same — greeting, one "Please note that" line,
// sign-off, and the legal disclaimer — so `email()` rebuilds it around each
// clause rather than repeating it sixteen times.

import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  extractPresence,
  isPresenceEmail,
  mauritiusDate,
  type PresenceInput,
} from "./presence.ts";

const MELANIE = "melanie.lau@jadegroup.mu";
const ANNOUNCERS = [MELANIE, "meera.beedassy@jadegroup.mu", "kelly.chan@jadegroup.mu"];

/** 08:12 in Mauritius — the usual time these go out. */
const MORNING = "2026-08-06T04:12:00Z";
const MORNING_DATE = "2026-08-06";

function bodyFor(clause: string): string {
  return [
    "Dear all,",
    "",
    `Please note that ${clause}`,
    "",
    "Regards",
    "",
    "Melanie Lau",
    "",
    "Disclaimer: All information in this message and attachments is confidential and may be legally privileged. Only intended recipients are authorized to use it.",
  ].join("\n");
}

function email(subject: string, clause: string, sentAt = MORNING): PresenceInput {
  return { subject, body: bodyFor(clause), sentAt, fromEmail: MELANIE };
}

// ---------------------------------------------------------------------------
// Mauritius time. Nothing else in this file is meaningful if this is wrong.
// ---------------------------------------------------------------------------

Deno.test("mauritiusDate: a morning send is the same calendar day", () => {
  assertEquals(mauritiusDate("2026-08-06T04:12:00Z"), "2026-08-06");
});

Deno.test("mauritiusDate: 20:30 UTC is already tomorrow in Port Louis", () => {
  assertEquals(mauritiusDate("2026-08-07T20:30:00Z"), "2026-08-08");
});

Deno.test("mauritiusDate: exactly 20:00 UTC is the rollover instant", () => {
  assertEquals(mauritiusDate("2026-08-07T19:59:59Z"), "2026-08-07");
  assertEquals(mauritiusDate("2026-08-07T20:00:00Z"), "2026-08-08");
});

Deno.test("mauritiusDate: no DST, ever — midwinter and midsummer behave alike", () => {
  // Mauritius abandoned its DST trial in 2009 and the offset has been +4 since.
  assertEquals(mauritiusDate("2026-01-15T21:00:00Z"), "2026-01-16");
  assertEquals(mauritiusDate("2026-07-15T21:00:00Z"), "2026-07-16");
});

Deno.test("mauritiusDate: unparseable timestamps yield no date, not today", () => {
  assertEquals(mauritiusDate("not a date"), "");
});

Deno.test("date rollover: an evening send files the absence on tomorrow's board", () => {
  // The failure this guards against is silent: the absence lands on the wrong
  // day and the board shows the person present while they are at home sick.
  const facts = extractPresence(
    email("Vidhya is sick", "Vidhya is sick today", "2026-08-07T20:30:00Z"),
  );
  assertEquals(facts.length, 1);
  assertEquals(facts[0].startDate, "2026-08-08");
  assertEquals(facts[0].endDate, "2026-08-08");
});

// ---------------------------------------------------------------------------
// The sixteen live fixtures, in the order they were pulled from the mailbox.
// ---------------------------------------------------------------------------

Deno.test("1. Permission - Sandy / has already left office", () => {
  const facts = extractPresence(email("Permission - Sandy", "Sandy has already left office"));
  assertEquals(facts.length, 1);
  assertEquals(facts[0].rawName, "Sandy");
  assertEquals(facts[0].status, "permission");
  assertEquals(facts[0].dayPart, "partial");
  assertEquals(facts[0].note, "left office early");
  assertEquals(facts[0].startDate, MORNING_DATE);
  assertEquals(facts[0].endDate, MORNING_DATE);
  assertEquals(facts[0].confident, true);
});

Deno.test("2. Vidhya is sick", () => {
  const facts = extractPresence(email("Vidhya is sick", "Vidhya is sick today"));
  assertEquals(facts.length, 1);
  assertEquals(facts[0].rawName, "Vidhya");
  assertEquals(facts[0].status, "sick");
  assertEquals(facts[0].dayPart, "full");
  assertEquals(facts[0].startDate, MORNING_DATE);
  assertEquals(facts[0].confident, true);
});

Deno.test("3. Permission - Kelly / out of office and will be back", () => {
  // The 'and' inside this clause is the reason names are only ever split from
  // the text before the verb — otherwise this books an absence for "will be
  // back afterwards".
  const facts = extractPresence(
    email("Permission - Kelly", "Kelly is out of office and will be back afterwards."),
  );
  assertEquals(facts.length, 1);
  assertEquals(facts[0].rawName, "Kelly");
  assertEquals(facts[0].status, "permission");
  assertEquals(facts[0].dayPart, "partial");
  assertEquals(facts[0].confident, true);
});

Deno.test("4. Marie-Claire and Vidhya are sick — two facts, one clause", () => {
  const facts = extractPresence(
    email("Marie-Claire and Vidhya are sick", "Marie-Claire and Vidhya are sick today"),
  );
  assertEquals(facts.length, 2);
  assertEquals(facts.map((f) => f.rawName), ["Marie-Claire", "Vidhya"]);
  assertEquals(facts.every((f) => f.status === "sick"), true);
  assertEquals(facts.every((f) => f.dayPart === "full"), true);
  assertEquals(facts.every((f) => f.confident), true);
});

Deno.test("5. Reshad is on half sick leave PM", () => {
  const facts = extractPresence(
    email("Reshad is on half sick leave PM", "Reshad is on half sick leave this afternoon"),
  );
  assertEquals(facts.length, 1);
  assertEquals(facts[0].rawName, "Reshad");
  assertEquals(facts[0].status, "sick");
  assertEquals(facts[0].dayPart, "pm");
  assertEquals(facts[0].confident, true);
});

Deno.test("6. Rekha is on local leave (subject has a trailing space)", () => {
  const facts = extractPresence(
    email("Rekha is on local leave ", "Rekha is on local leave today"),
  );
  assertEquals(facts.length, 1);
  assertEquals(facts[0].rawName, "Rekha");
  assertEquals(facts[0].status, "local_leave");
  assertEquals(facts[0].dayPart, "full");
  assertEquals(facts[0].confident, true);
});

Deno.test("7. Sandy will be late", () => {
  const facts = extractPresence(email("Sandy will be late", "Sandy will be late today"));
  assertEquals(facts.length, 1);
  assertEquals(facts[0].rawName, "Sandy");
  assertEquals(facts[0].status, "late");
  assertEquals(facts[0].dayPart, "partial");
  assertEquals(facts[0].note, "arriving late");
  assertEquals(facts[0].confident, true);
});

Deno.test("8. Charles is on half local leave PM", () => {
  const facts = extractPresence(
    email("Charles is on half local leave PM", "Charles is on half local leave this afternoon"),
  );
  assertEquals(facts.length, 1);
  assertEquals(facts[0].rawName, "Charles");
  assertEquals(facts[0].status, "local_leave");
  assertEquals(facts[0].dayPart, "pm");
  assertEquals(facts[0].confident, true);
});

Deno.test("9. Ashok is on half local leave AM", () => {
  const facts = extractPresence(
    email("Ashok is on half local leave AM", "Ashok is on half local leave this morning"),
  );
  assertEquals(facts.length, 1);
  assertEquals(facts[0].rawName, "Ashok");
  assertEquals(facts[0].status, "local_leave");
  assertEquals(facts[0].dayPart, "am");
  assertEquals(facts[0].confident, true);
});

Deno.test("10. kamini is sick — lowercase subject, body casing wins for the name", () => {
  const facts = extractPresence(email("kamini is sick", "Kamini is sick today"));
  assertEquals(facts.length, 1);
  assertEquals(facts[0].rawName, "Kamini");
  assertEquals(facts[0].status, "sick");
  assertEquals(facts[0].dayPart, "full");
  assertEquals(facts[0].confident, true);
});

Deno.test("11. Ashok is on half sick leave AM", () => {
  const facts = extractPresence(
    email("Ashok is on half sick leave AM", "Ashok is on half sick leave this morning"),
  );
  assertEquals(facts.length, 1);
  assertEquals(facts[0].rawName, "Ashok");
  assertEquals(facts[0].status, "sick");
  assertEquals(facts[0].dayPart, "am");
  assertEquals(facts[0].confident, true);
});

Deno.test("12. Antoine and Laval are sick", () => {
  const facts = extractPresence(
    email("Antoine and Laval are sick", "Antoine and Laval are sick today"),
  );
  assertEquals(facts.length, 2);
  assertEquals(facts.map((f) => f.rawName), ["Antoine", "Laval"]);
  assertEquals(facts.every((f) => f.status === "sick" && f.dayPart === "full"), true);
});

Deno.test("13. bullet list — two people, two different statuses", () => {
  // Outlook turns the multi-person notices into a bullet list and the
  // plain-text conversion strands each bullet on its own line above the
  // sentence it belongs to. Parsing this as one sentence loses Rekha entirely.
  const facts = extractPresence(email(
    "Kamini is sick and Rekha is on local leave",
    "\n*\nKamini is sick\n  *\nRekha is on local leave today",
  ));
  assertEquals(facts.length, 2);
  assertEquals(facts[0].rawName, "Kamini");
  assertEquals(facts[0].status, "sick");
  assertEquals(facts[0].dayPart, "full");
  assertEquals(facts[1].rawName, "Rekha");
  assertEquals(facts[1].status, "local_leave");
  assertEquals(facts[1].dayPart, "full");
  assertNotEquals(facts[0].status, facts[1].status);
  assertEquals(facts.every((f) => f.startDate === MORNING_DATE), true);
});

Deno.test("14. Sandy is on local leave (Mon-Wed) — a real date range", () => {
  const facts = extractPresence(email(
    "Sandy is on local leave (Mon-Wed)",
    "Sandy is on local leave from today until Wednesday.",
    "2026-07-27T04:32:28Z", // a Monday
  ));
  assertEquals(facts.length, 1);
  assertEquals(facts[0].rawName, "Sandy");
  assertEquals(facts[0].status, "local_leave");
  assertEquals(facts[0].dayPart, "full");
  assertEquals(facts[0].startDate, "2026-07-27");
  assertEquals(facts[0].endDate, "2026-07-29");
  assertEquals(facts[0].confident, true);
});

Deno.test("15. Permission - Mervyn / has already left office", () => {
  const facts = extractPresence(email("Permission - Mervyn", "Mervyn has already left office"));
  assertEquals(facts.length, 1);
  assertEquals(facts[0].rawName, "Mervyn");
  assertEquals(facts[0].status, "permission");
  assertEquals(facts[0].dayPart, "partial");
  assertEquals(facts[0].note, "left office early");
});

Deno.test("16. subject says sick, body says left office — the body wins", () => {
  // Melanie types the subject first and does not always come back to fix it.
  // The body is what she wrote deliberately, so it is authoritative — but the
  // disagreement itself is worth a human glance.
  const facts = extractPresence(email("Meera is sick", "Meera has already left office"));
  assertEquals(facts.length, 1);
  assertEquals(facts[0].rawName, "Meera");
  assertEquals(facts[0].status, "permission");
  assertEquals(facts[0].dayPart, "partial");
  assertEquals(facts[0].confident, false);
});

// ---------------------------------------------------------------------------
// Regression fixtures: the five notices the parser originally missed.
//
// These are verbatim from production. A backfill over three months of the live
// mailbox extracted 100 absences correctly and left exactly these five as
// `status: "other"` with the sentence in `note` and needs_review set — the
// designed fallback, working, but five real absences a human had to re-read.
// The clauses are quoted here exactly as they arrived, typos and all:
// fixture 2 says "willl" and ends in a stray "&" because the original does.
// Correcting a fixture to match the parser would defeat the whole point of
// keeping the corpus in the test file.
//
// The dates below are the real send dates, so the weekday arithmetic in the
// assertions is the arithmetic that actually had to be right:
//   2026-05-11 Mon   2026-05-12 Tue   2026-05-14 Thu
//   2026-05-18 Mon   2026-05-19 Tue   2026-05-29 Fri   2026-06-01 Mon
// ---------------------------------------------------------------------------

Deno.test("R1. Osman — 'will resume work on Monday' ends the absence on FRIDAY", () => {
  // The return date is the first day back, not the last day out. Reading the
  // 18th as the end marks Osman absent on a Monday he worked; taking the plain
  // day before gives Sunday the 17th, a day nobody is absent from.
  const facts = extractPresence(email(
    "Osman is on sick leave",
    "Osman is on sick leave and will resume work on Monday 18th May 2026.",
    "2026-05-11T04:20:00Z", // Monday
  ));
  assertEquals(facts.length, 1);
  assertEquals(facts[0].rawName, "Osman");
  assertEquals(facts[0].status, "sick");
  assertEquals(facts[0].dayPart, "full");
  assertEquals(facts[0].startDate, "2026-05-11");
  assertEquals(facts[0].endDate, "2026-05-15");
  assertEquals(facts[0].confident, true);
});

Deno.test("R2. Ashwiny — the 'willl' typo and a truncated trailing '&'", () => {
  // Verbatim. The tolerance for the typo is deliberate: `wil+ resume` costs
  // nothing and the alternative is losing a whole week of a real absence to a
  // doubled letter.
  const facts = extractPresence(email(
    "Ashwiny is on sick leave",
    "Ashwiny is on sick leave and willl resume work on Monday 18th May 2026 &",
    "2026-05-12T04:05:00Z", // Tuesday
  ));
  assertEquals(facts.length, 1);
  assertEquals(facts[0].rawName, "Ashwiny");
  assertEquals(facts[0].status, "sick");
  assertEquals(facts[0].startDate, "2026-05-12");
  assertEquals(facts[0].endDate, "2026-05-15");
  assertEquals(facts[0].confident, true);
});

Deno.test("R3. Marie-Claire — 3 weeks' vacation leave effective as from today", () => {
  // Vacation leave is its own status: filed as local_leave this reads as a
  // single casual day off instead of the three weeks it is.
  const facts = extractPresence(email(
    "Marie-Claire is on vacation leave",
    "Marie-Claire is on 3 weeks' vacation leave effective as from today.",
    "2026-05-14T05:41:00Z", // Thursday
  ));
  assertEquals(facts.length, 1);
  assertEquals(facts[0].rawName, "Marie-Claire");
  assertEquals(facts[0].status, "vacation_leave");
  assertEquals(facts[0].dayPart, "full");
  assertEquals(facts[0].startDate, "2026-05-14");
  // Inclusive of the first day: 14 May + 21 days - 1.
  assertEquals(facts[0].endDate, "2026-06-03");
  assertEquals(facts[0].confident, true);
});

Deno.test("R4. Mervyn — an end date AND a return date that corroborate each other", () => {
  // "until Friday 29th" and "resume on Monday 01st" are two independent
  // statements of the same end. They agree, so this is MORE trustworthy than a
  // clause that says it once — the reading stays confident.
  const facts = extractPresence(email(
    "Mervyn is on vacation leave",
    "Mervyn is on vacation leave until Friday 29th May 2026 and will resume work on Monday 01st June 2026.",
    "2026-05-18T04:11:00Z", // Monday
  ));
  assertEquals(facts.length, 1);
  assertEquals(facts[0].rawName, "Mervyn");
  assertEquals(facts[0].status, "vacation_leave");
  assertEquals(facts[0].dayPart, "full");
  assertEquals(facts[0].startDate, "2026-05-18");
  assertEquals(facts[0].endDate, "2026-05-29");
  assertEquals(facts[0].confident, true);
});

Deno.test("R5. Kelly — had to leave office due to an emergency", () => {
  const facts = extractPresence(email(
    "Permission - Kelly",
    "Kelly had to leave office due to an emergency.",
    "2026-05-19T09:30:00Z", // Tuesday, 13:30 in Mauritius
  ));
  assertEquals(facts.length, 1);
  assertEquals(facts[0].rawName, "Kelly");
  assertEquals(facts[0].status, "permission");
  assertEquals(facts[0].dayPart, "partial");
  assertEquals(facts[0].note, "left office - emergency");
  assertEquals(facts[0].startDate, "2026-05-19");
  assertEquals(facts[0].endDate, "2026-05-19");
  assertEquals(facts[0].confident, true);
});

// ---------------------------------------------------------------------------
// The properties those five fixtures depend on, stated on their own.
// ---------------------------------------------------------------------------

Deno.test("a Monday return means the previous FRIDAY, never the Sunday", () => {
  // The off-by-one this guards against is silent in both directions: Sunday as
  // the end writes a weekend absence nobody can be absent from, and the Friday
  // the person actually missed never reaches the board at all.
  const facts = extractPresence(email(
    "Vidhya is on sick leave",
    "Vidhya is on sick leave and will resume work on Monday 18th May 2026.",
    "2026-05-13T04:00:00Z", // Wednesday
  ));
  assertEquals(facts.length, 1);
  assertEquals(facts[0].startDate, "2026-05-13");
  assertEquals(facts[0].endDate, "2026-05-15"); // Friday, not Sunday the 17th
});

Deno.test("an until date and a return date that disagree keep the earlier end", () => {
  // Wednesday the 20th vs a Monday-the-25th return, which implies Friday the
  // 22nd. One of the two is a typo and nothing in the sentence says which, so
  // the shorter absence wins — over-stating one denies a colleague who is at
  // their desk — and a human is asked to look.
  const facts = extractPresence(email(
    "Sandy is on local leave",
    "Sandy is on local leave until Wednesday 20th May 2026 and will resume work on Monday 25th May 2026.",
    "2026-05-18T04:00:00Z", // Monday
  ));
  assertEquals(facts.length, 1);
  assertEquals(facts[0].status, "local_leave");
  assertEquals(facts[0].startDate, "2026-05-18");
  assertEquals(facts[0].endDate, "2026-05-20");
  assertEquals(facts[0].confident, false);
});

Deno.test("an unreadable date inside a recognised clause still yields the absence", () => {
  // The status is certain, the length is not. Dropping the fact — or dropping
  // the whole clause to 'other' — would lose a sick colleague over a mangled
  // date that the reader of the review queue can fix in seconds.
  const facts = extractPresence(email(
    "Osman is on sick leave",
    "Osman is on sick leave and will resume work on 31st Bluesday 2026.",
    "2026-05-11T04:20:00Z",
  ));
  assertEquals(facts.length, 1);
  assertEquals(facts[0].rawName, "Osman");
  assertEquals(facts[0].status, "sick");
  assertEquals(facts[0].startDate, "2026-05-11");
  assertEquals(facts[0].endDate, "2026-05-11");
  assertEquals(facts[0].confident, false);
});

Deno.test("the curly apostrophe Outlook substitutes is still a duration", () => {
  const facts = extractPresence(email(
    "Marie-Claire is on vacation leave",
    "Marie-Claire is on 2 weeks’ vacation leave effective as from today.",
    "2026-05-14T05:41:00Z",
  ));
  assertEquals(facts.length, 1);
  assertEquals(facts[0].status, "vacation_leave");
  assertEquals(facts[0].startDate, "2026-05-14");
  assertEquals(facts[0].endDate, "2026-05-27");
});

Deno.test("adding 'is on sick leave' did not steal the half-day reading", () => {
  // "is on half sick leave" does not contain "is on sick leave", so the
  // half-day phrase still wins wherever it is written. This is the one way the
  // new vocabulary could have quietly turned half days into full ones.
  const facts = extractPresence(
    email("Reshad is on half sick leave PM", "Reshad is on half sick leave this afternoon"),
  );
  assertEquals(facts.length, 1);
  assertEquals(facts[0].status, "sick");
  assertEquals(facts[0].dayPart, "pm");
  assertEquals(facts[0].startDate, facts[0].endDate);
  assertEquals(facts[0].confident, true);
});

// ---------------------------------------------------------------------------
// The boilerplate must never become a person.
// ---------------------------------------------------------------------------

Deno.test("the signature and disclaimer are never parsed as absent people", () => {
  const fixtures: PresenceInput[] = [
    email("Permission - Sandy", "Sandy has already left office"),
    email("Vidhya is sick", "Vidhya is sick today"),
    email("Marie-Claire and Vidhya are sick", "Marie-Claire and Vidhya are sick today"),
    email("Sandy will be late", "Sandy will be late today"),
    email(
      "Kamini is sick and Rekha is on local leave",
      "\n*\nKamini is sick\n  *\nRekha is on local leave today",
    ),
  ];
  for (const fixture of fixtures) {
    for (const fact of extractPresence(fixture)) {
      const name = fact.rawName.toLowerCase();
      assertEquals(name.includes("melanie"), false, `leaked signature: ${fact.rawName}`);
      assertEquals(name.includes("regards"), false, `leaked sign-off: ${fact.rawName}`);
      assertEquals(name.includes("disclaimer"), false, `leaked disclaimer: ${fact.rawName}`);
      assertEquals(name.includes("dear"), false, `leaked greeting: ${fact.rawName}`);
    }
  }
});

Deno.test("a sign-off with no blank line before it is still stripped", () => {
  const facts = extractPresence({
    subject: "Vidhya is sick",
    body: "Dear all,\nPlease note that Vidhya is sick today\nRegards\nMelanie Lau",
    sentAt: MORNING,
    fromEmail: MELANIE,
  });
  assertEquals(facts.length, 1);
  assertEquals(facts[0].rawName, "Vidhya");
});

// ---------------------------------------------------------------------------
// Unknown wording is surfaced, never dropped.
// ---------------------------------------------------------------------------

Deno.test("an unrecognised clause becomes exactly one low-confidence 'other'", () => {
  // A dropped absence is indistinguishable from a full office. This is the
  // single most important behaviour in the module.
  const facts = extractPresence(
    email("Nisha", "Nisha is attending a funeral and will not be reachable today"),
  );
  assertEquals(facts.length, 1);
  assertEquals(facts[0].status, "other");
  assertEquals(facts[0].confident, false);
  assertEquals(
    facts[0].note,
    "Nisha is attending a funeral and will not be reachable today",
  );
  assertEquals(facts[0].rawName, "Nisha");
  assertEquals(facts[0].startDate, MORNING_DATE);
});

Deno.test("an unrecognised clause with no readable name still produces a fact", () => {
  const facts = extractPresence(
    email("Office", "the office will operate on reduced hours this week"),
  );
  assertEquals(facts.length, 1);
  assertEquals(facts[0].status, "other");
  assertEquals(facts[0].confident, false);
  assertEquals(facts[0].rawName, "");
});

Deno.test("an unparseable date range keeps the absence but flags it", () => {
  const facts = extractPresence(
    email("Sandy is on local leave", "Sandy is on local leave from today until further notice."),
  );
  assertEquals(facts.length, 1);
  assertEquals(facts[0].status, "local_leave");
  assertEquals(facts[0].confident, false);
});

Deno.test("a half leave with no stated side is flagged rather than guessed", () => {
  const facts = extractPresence(
    email("Reshad is on half sick leave", "Reshad is on half sick leave today"),
  );
  assertEquals(facts.length, 1);
  assertEquals(facts[0].status, "sick");
  assertEquals(facts[0].dayPart, "partial");
  assertEquals(facts[0].confident, false);
});

Deno.test("a subject range that contradicts the body lowers confidence only", () => {
  // The dates still come from the body — the subject is a cross-check, never a
  // source.
  const facts = extractPresence(email(
    "Sandy is on local leave (Mon-Fri)",
    "Sandy is on local leave from today until Wednesday.",
    "2026-07-27T04:32:28Z",
  ));
  assertEquals(facts.length, 1);
  assertEquals(facts[0].startDate, "2026-07-27");
  assertEquals(facts[0].endDate, "2026-07-29");
  assertEquals(facts[0].confident, false);
});

// ---------------------------------------------------------------------------
// Never throws.
// ---------------------------------------------------------------------------

Deno.test("empty, malformed and hostile input return facts or nothing, never a throw", () => {
  assertEquals(extractPresence({ subject: "", body: "", sentAt: "", fromEmail: "" }), []);
  assertEquals(
    extractPresence({ subject: "", body: "Dear all,\n\nRegards\n\nMelanie Lau", sentAt: MORNING, fromEmail: MELANIE }),
    [],
  );
  // Deliberately wrong shapes — this runs over whatever the mail API returns.
  const junk = extractPresence(
    { subject: undefined, body: undefined, sentAt: undefined, fromEmail: undefined } as unknown as PresenceInput,
  );
  assertEquals(junk, []);
  assertEquals(extractPresence(null as unknown as PresenceInput), []);
});

Deno.test("a body with no lead-in phrase is still read", () => {
  // Kelly sometimes drops the "Please note that" preamble entirely.
  const facts = extractPresence({
    subject: "Vidhya is sick",
    body: "Dear all,\n\nVidhya is sick today\n\nRegards\n\nKelly",
    sentAt: MORNING,
    fromEmail: "kelly.chan@jadegroup.mu",
  });
  assertEquals(facts.length, 1);
  assertEquals(facts[0].rawName, "Vidhya");
  assertEquals(facts[0].status, "sick");
});

Deno.test("a missing timestamp does not invent a date", () => {
  const facts = extractPresence({
    subject: "Vidhya is sick",
    body: bodyFor("Vidhya is sick today"),
    sentAt: "",
    fromEmail: MELANIE,
  });
  assertEquals(facts.length, 1);
  assertEquals(facts[0].startDate, "");
  assertEquals(facts[0].confident, false);
});

// ---------------------------------------------------------------------------
// isPresenceEmail — the cheap gate.
// ---------------------------------------------------------------------------

Deno.test("isPresenceEmail: configured announcer with the lead-in phrase", () => {
  assertEquals(
    isPresenceEmail({
      fromEmail: MELANIE,
      subject: "Vidhya is sick",
      body: bodyFor("Vidhya is sick today"),
      announcerEmails: ANNOUNCERS,
    }),
    true,
  );
});

Deno.test("isPresenceEmail: a sender outside the configured list is never a notice", () => {
  // A supplier apologising for being off sick is not a staff record.
  assertEquals(
    isPresenceEmail({
      fromEmail: "sales@northernprint.mu",
      subject: "Our rep is sick — delivery delayed",
      body: bodyFor("Our rep is sick today"),
      announcerEmails: ANNOUNCERS,
    }),
    false,
  );
});

Deno.test("isPresenceEmail: an announcer with a presence-ish subject but no lead-in", () => {
  assertEquals(
    isPresenceEmail({
      fromEmail: "meera.beedassy@jadegroup.mu",
      subject: "Ashok is on half local leave AM",
      body: "Dear all,\n\nAshok will not be in this morning.\n\nRegards",
      announcerEmails: ANNOUNCERS,
    }),
    true,
  );
});

Deno.test("isPresenceEmail: an announcer's ordinary email is not a notice", () => {
  assertEquals(
    isPresenceEmail({
      fromEmail: MELANIE,
      subject: "Stationery order",
      body: "Dear all,\n\nThe new printer paper has arrived.\n\nRegards",
      announcerEmails: ANNOUNCERS,
    }),
    false,
  );
});

Deno.test("isPresenceEmail: sender matching ignores case and stray spacing", () => {
  assertEquals(
    isPresenceEmail({
      fromEmail: "  Melanie.Lau@JadeGroup.MU ",
      subject: "Rekha is on local leave ",
      body: bodyFor("Rekha is on local leave today"),
      announcerEmails: ANNOUNCERS,
    }),
    true,
  );
});

Deno.test("isPresenceEmail: no announcers configured means nothing qualifies", () => {
  // Fail closed. An unconfigured install must not start writing presence rows.
  assertEquals(
    isPresenceEmail({
      fromEmail: MELANIE,
      subject: "Vidhya is sick",
      body: bodyFor("Vidhya is sick today"),
      announcerEmails: [],
    }),
    false,
  );
});

Deno.test("isPresenceEmail: missing fields do not throw", () => {
  assertEquals(
    isPresenceEmail(
      { fromEmail: "", subject: "", body: "", announcerEmails: [] },
    ),
    false,
  );
});
