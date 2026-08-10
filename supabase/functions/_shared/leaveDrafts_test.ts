// Deno tests for the leave notice templates.
// Run: deno test supabase/functions/_shared/leaveDrafts_test.ts
//
// The centrepiece is the round trip. Jade has two halves that describe the same
// fact in the same words: presence.ts READS absence notices out of the mailbox,
// and leaveDrafts.ts WRITES them. Nothing structural stops those two drifting
// apart — the parser is a list of literal phrases, the templates are a list of
// string branches, and neither imports the other. The day they disagree, the
// board and the mailbox start telling different stories about the same person,
// and the only symptom is a review queue slowly filling with the app's own
// emails.
//
// So every notice this module can produce is generated, flattened to text the
// way an Outlook body arrives, and fed straight back through
// `extractPresence`. If the app cannot read its own announcement, these fail.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { allStaffNotice, type LeavePerson, requesterConfirmation } from "./leaveDrafts.ts";
import { extractPresence, mauritiusDate } from "./presence.ts";
import { STYLE_PROFILE } from "./emailStyle.ts";

const STEPHAN = "stephan@jadegroup.mu";

/** 08:12 in Mauritius on Wednesday 19th August 2026 — the hour these go out. */
const WED_MORNING = "2026-08-19T04:12:00Z";
const WED = "2026-08-19";
/** Monday 17th August 2026, the first day of the multi-day fixture. */
const MON_MORNING = "2026-08-17T04:12:00Z";
const MON = "2026-08-17";

function person(known_as: string): LeavePerson {
  return { known_as, full_name: `${known_as} Test`, email: `${known_as.toLowerCase()}@jadegroup.mu` };
}

/**
 * HTML body -> the plain text a mail client (and mail-sync) would hand the
 * parser. Same flattening as mail-draft.ts's `plainTextOf`, kept here rather
 * than imported because that one lives in a function directory and this test
 * must stay inside _shared.
 */
function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

interface RoundTrip {
  label: string;
  name: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  /** What the requester picked in the form. */
  dayPart: string;
  sentAt: string;
  expectStatus: string;
  /**
   * What presence.ts should read back.
   *
   * Equal to `dayPart` in every case but permission. "has already left office"
   * is the only phrasing the office has ever used for permission and it states
   * no side of the day at all, so presence.ts classifies it `partial` — its
   * word for "gone for some undefined slice of the day". That is a real,
   * deliberate narrowing rather than a drift: a request for permission carries
   * `full` because the form has no other option to offer, and the notice cannot
   * honestly claim a whole day. Asserted explicitly so that if either side ever
   * changes its mind about permission, this test says so.
   */
  expectDayPart: string;
}

const ROUND_TRIPS: RoundTrip[] = [
  {
    label: "single-day sick",
    name: "Vidhya",
    leaveType: "sick",
    startDate: WED,
    endDate: WED,
    dayPart: "full",
    sentAt: WED_MORNING,
    expectStatus: "sick",
    expectDayPart: "full",
  },
  {
    label: "single-day local leave",
    name: "Sandy",
    leaveType: "local_leave",
    startDate: WED,
    endDate: WED,
    dayPart: "full",
    sentAt: WED_MORNING,
    expectStatus: "local_leave",
    expectDayPart: "full",
  },
  {
    label: "half-day PM sick",
    name: "Kamini",
    leaveType: "sick",
    startDate: WED,
    endDate: WED,
    dayPart: "pm",
    sentAt: WED_MORNING,
    expectStatus: "sick",
    expectDayPart: "pm",
  },
  {
    label: "multi-day vacation",
    name: "Rekha",
    leaveType: "vacation_leave",
    startDate: MON,
    endDate: WED,
    dayPart: "full",
    sentAt: MON_MORNING,
    expectStatus: "vacation_leave",
    expectDayPart: "full",
  },
  {
    label: "permission",
    name: "Sandy",
    leaveType: "permission",
    startDate: WED,
    endDate: WED,
    dayPart: "full",
    sentAt: WED_MORNING,
    expectStatus: "permission",
    expectDayPart: "partial",
  },
];

for (const c of ROUND_TRIPS) {
  Deno.test(`round trip: ${c.label} — the parser reads back what the template was given`, () => {
    const draft = allStaffNotice(
      person(c.name),
      c.leaveType,
      c.startDate,
      c.endDate,
      c.dayPart,
    );

    const facts = extractPresence({
      subject: draft.subject,
      body: plainText(draft.bodyHtml),
      sentAt: c.sentAt,
      fromEmail: STEPHAN,
    });

    // One notice announces one person. More than one fact means the template
    // grew a second sentence the parser split on; zero means it produced
    // something the vocabulary does not contain at all.
    assertEquals(facts.length, 1, `expected exactly one fact, got ${JSON.stringify(facts)}`);
    const fact = facts[0];

    assertEquals(fact.rawName, c.name);
    assertEquals(fact.status, c.expectStatus);
    assertEquals(fact.dayPart, c.expectDayPart);

    // `confident: false` means the row would land in the review queue. Our own
    // announcements must never do that — the subject, the body and the dates
    // are all written by the same function and have no excuse to disagree.
    assertEquals(fact.confident, true, `notice was not read confidently: ${JSON.stringify(fact)}`);
  });
}

Deno.test("round trip: the multi-day range is recovered as the days actually requested", () => {
  const draft = allStaffNotice(person("Rekha"), "vacation_leave", MON, WED, "full");
  const facts = extractPresence({
    subject: draft.subject,
    body: plainText(draft.bodyHtml),
    sentAt: MON_MORNING,
    fromEmail: STEPHAN,
  });

  assertEquals(facts.length, 1);
  // The notice is written on the first day of the leave, which is when these
  // go out, so the parser's "today" anchor and the request's start date are the
  // same day and the whole range must survive.
  assertEquals(facts[0].startDate, mauritiusDate(MON_MORNING));
  assertEquals(facts[0].endDate, WED);
});

// ---------------------------------------------------------------------------
// The exact wording
//
// The round trip proves the parser can read the notice. These prove it still
// looks like the one the office manager sends — a notice that parses but reads
// like a robot wrote it is its own kind of failure.
// ---------------------------------------------------------------------------

Deno.test("the single-day sick notice is her sentence, verbatim", () => {
  const draft = allStaffNotice(person("Vidhya"), "sick", WED, WED, "full");
  assertEquals(draft.subject, "Vidhya is sick");
  assertEquals(
    plainText(draft.bodyHtml),
    [
      "Dear all,",
      "Please note that Vidhya is sick today",
      "Regards",
      "Stephan Ah-Thien",
    ].join("\n"),
  );
});

Deno.test("subjects mirror the observed ones", () => {
  assertEquals(
    allStaffNotice(person("Sandy"), "permission", WED, WED, "full").subject,
    "Permission - Sandy",
  );
  assertEquals(
    allStaffNotice(person("Sandy"), "local_leave", MON, WED, "full").subject,
    "Sandy is on local leave (Mon-Wed)",
  );
  assertEquals(
    allStaffNotice(person("Vidhya"), "vacation_leave", WED, WED, "full").subject,
    "Vidhya is on vacation leave",
  );
});

Deno.test("multi-day notices spell the dates out the way the office writes them", () => {
  const body = plainText(
    allStaffNotice(person("Rekha"), "sick", MON, WED, "full").bodyHtml,
  );
  assertStringIncludes(
    body,
    "Rekha is on sick leave from Monday 17th August 2026 until Wednesday 19th August 2026",
  );
});

Deno.test("half days name the half in the body and echo it in the subject", () => {
  const am = allStaffNotice(person("Kamini"), "local_leave", WED, WED, "am");
  assertEquals(am.subject, "Kamini is on half local leave (AM)");
  assertStringIncludes(
    plainText(am.bodyHtml),
    "Kamini is on half local leave this morning",
  );

  // Vacation has no "half vacation leave" phrase in presence.ts, so the half is
  // carried by the morning/afternoon cue instead.
  const pm = allStaffNotice(person("Rekha"), "vacation_leave", WED, WED, "pm");
  assertStringIncludes(
    plainText(pm.bodyHtml),
    "Rekha is on vacation leave this afternoon",
  );
});

Deno.test("the notice falls back to full_name when known_as is blank", () => {
  const draft = allStaffNotice(
    { known_as: "", full_name: "Marie-Claire Rault", email: null },
    "sick",
    WED,
    WED,
    "full",
  );
  assertStringIncludes(plainText(draft.bodyHtml), "Marie-Claire Rault is sick today");
});

Deno.test("a name with HTML in it cannot become markup", () => {
  const draft = allStaffNotice(
    { known_as: "A<b>ngry", full_name: "", email: null },
    "sick",
    WED,
    WED,
    "full",
  );
  assertStringIncludes(draft.bodyHtml, "A&lt;b&gt;ngry");
});

// ---------------------------------------------------------------------------
// The requester's confirmation
// ---------------------------------------------------------------------------

Deno.test("approval confirmation states the decision, the type and the dates", () => {
  const draft = requesterConfirmation(
    person("Vidhya"),
    "sick",
    WED,
    WED,
    "full",
    "approved",
    null,
  );
  assertEquals(draft.subject, "Leave approved - 19 August 2026");
  assertEquals(
    plainText(draft.bodyHtml),
    [
      "Your request for sick leave on Wednesday 19th August 2026 has been approved.",
      "Regards",
      "Stephan Ah-Thien",
    ].join("\n"),
  );
});

Deno.test("a decline carries the approver's note verbatim", () => {
  const draft = requesterConfirmation(
    person("Sandy"),
    "local_leave",
    MON,
    WED,
    "full",
    "declined",
    "We have the audit that week — please refile for the following Monday.",
  );
  assertEquals(draft.subject, "Leave declined - 17 to 19 August 2026");
  const body = plainText(draft.bodyHtml);
  assertStringIncludes(
    body,
    "Your request for local leave from Monday 17th August 2026 until Wednesday 19th August 2026 has not been approved.",
  );
  assertStringIncludes(body, "Note: We have the audit that week — please refile for the following Monday.");
});

Deno.test("a half day is confirmed as a half day", () => {
  const body = plainText(
    requesterConfirmation(person("Kamini"), "sick", WED, WED, "pm", "approved", "").bodyHtml,
  );
  assertStringIncludes(
    body,
    "Your request for sick leave on the afternoon of Wednesday 19th August 2026 has been approved.",
  );
  // An empty note is not a note. Rendering "Note:" with nothing after it would
  // read as a paragraph somebody forgot to finish.
  assertEquals(body.includes("Note:"), false);
});

Deno.test("both drafts end with the one universal sign-off and offer nothing further", () => {
  const drafts = [
    allStaffNotice(person("Vidhya"), "sick", WED, WED, "full"),
    requesterConfirmation(person("Vidhya"), "sick", WED, WED, "full", "approved", null),
    requesterConfirmation(person("Vidhya"), "sick", WED, WED, "full", "declined", "no"),
  ];
  // The sign-off is two paragraphs in HTML, so flattening gives one newline
  // between them rather than the blank line it carries as plain text. Rebuilt
  // from STYLE_PROFILE rather than written out, so this still fails if anyone
  // hard-codes a second copy of it in leaveDrafts.ts.
  const signOff = STYLE_PROFILE.signOff.split(/\n{2,}/).map((s) => s.trim()).join("\n");

  for (const d of drafts) {
    const body = plainText(d.bodyHtml);
    assertEquals(body.endsWith(signOff), true, `draft does not end with the sign-off: ${body}`);
    // globalRules: "Never write a closing offer of further help. He simply
    // stops." Templates are where that filler creeps back in.
    for (const filler of ["let me know", "feel free", "happy to help", "do not hesitate"]) {
      assertEquals(
        body.toLowerCase().includes(filler),
        false,
        `confirmation should not contain "${filler}"`,
      );
    }
    assertEquals(/[\u{1F300}-\u{1FAFF}]/u.test(body), false, "no emoji in correspondence");
  }
});
