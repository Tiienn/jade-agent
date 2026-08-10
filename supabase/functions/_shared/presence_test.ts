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
