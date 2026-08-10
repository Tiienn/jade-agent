// Deno tests for name resolution and date expansion.
// Run: deno test supabase/functions/_shared/presenceStore_test.ts
//
// Only resolveFacts is covered, because it is the only part of presenceStore
// that decides anything — loadAnnouncers, loadRoster and storePresence are
// single queries whose behaviour is the database's, not ours.
//
// What these tests are really protecting is the review queue. Every rule here
// exists to make a doubtful row VISIBLE rather than plausible: a name nobody
// recognises, a name two colleagues answer to, a range that ran away. A
// regression in any of them does not throw or fail a sync — it quietly writes a
// confident-looking row about a real person, which is the failure mode nobody
// catches by looking at the board.

import { assertEquals } from "jsr:@std/assert@1";
import {
  presenceSource,
  resolveFacts,
  type ResolvedRow,
  type RosterEntry,
} from "./presenceStore.ts";
import type { PresenceFact } from "./presence.ts";

const VIDHYA = "11111111-1111-4111-8111-111111111111";
const MARIE = "22222222-2222-4222-8222-222222222222";
const SANDY_A = "33333333-3333-4333-8333-333333333333";
const SANDY_B = "44444444-4444-4444-8444-444444444444";

const ROSTER: RosterEntry[] = [
  { id: VIDHYA, known_as: "Vidhya", aliases: [] },
  { id: MARIE, known_as: "Marie-Claire", aliases: ["MC", "Marie Claire"] },
  // Two real people who answer to the same first name. The office has this
  // problem today; the roster is allowed to represent it (see 0006 — known_as
  // is deliberately not unique).
  { id: SANDY_A, known_as: "Sandy", aliases: [] },
  { id: SANDY_B, known_as: "Sandy", aliases: ["Sandhya"] },
];

/** 2026-08-06 is a Thursday; 08-08 a Saturday, 08-09 a Sunday. */
function fact(over: Partial<PresenceFact> = {}): PresenceFact {
  return {
    rawName: "Vidhya",
    status: "sick",
    dayPart: "full",
    startDate: "2026-08-06",
    endDate: "2026-08-06",
    confident: true,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Name resolution
// ---------------------------------------------------------------------------

Deno.test("resolveFacts: an exact name resolves, case-insensitively", () => {
  const rows = resolveFacts([fact({ rawName: "vIdHyA" })], ROSTER);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].staff_id, VIDHYA);
  assertEquals(rows[0].needs_review, false);
  // The spelling from the email survives resolution — it is the audit trail.
  assertEquals(rows[0].raw_name, "vIdHyA");
});

Deno.test("resolveFacts: a confident match of an unconfident fact still needs review", () => {
  // The person is certain, the sentence was not. Those are different doubts and
  // only the second one is the extractor's to report.
  const rows = resolveFacts([fact({ confident: false })], ROSTER);
  assertEquals(rows[0].staff_id, VIDHYA);
  assertEquals(rows[0].needs_review, true);
});

Deno.test("resolveFacts: an alias resolves to the same person", () => {
  const rows = resolveFacts([fact({ rawName: "MC" })], ROSTER);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].staff_id, MARIE);
  assertEquals(rows[0].needs_review, false);
});

Deno.test("resolveFacts: an unknown name is kept, unresolved and flagged", () => {
  // The whole point: a typo or a new joiner must land on the board for somebody
  // to fix, not vanish into a silently shorter result.
  const rows = resolveFacts([fact({ rawName: "Sndy" })], ROSTER);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].staff_id, null);
  assertEquals(rows[0].raw_name, "Sndy");
  assertEquals(rows[0].needs_review, true);
});

Deno.test("resolveFacts: an empty name is still recorded for review", () => {
  const rows = resolveFacts([fact({ rawName: "" })], ROSTER);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].staff_id, null);
  assertEquals(rows[0].needs_review, true);
});

Deno.test("resolveFacts: two colleagues sharing a name is never guessed", () => {
  const rows = resolveFacts([fact({ rawName: "Sandy" })], ROSTER);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].staff_id, null);
  assertEquals(rows[0].needs_review, true);
  // The note has to say WHY, or the reviewer sees an unresolved row and adds a
  // third Sandy to the roster.
  assertEquals(rows[0].note?.includes("ambiguous") ?? false, true);
  assertEquals(rows[0].note?.includes("Sandy") ?? false, true);
});

Deno.test("resolveFacts: an ambiguity note is appended to the extractor's note", () => {
  const rows = resolveFacts(
    [fact({ rawName: "Sandy", note: "left office early" })],
    ROSTER,
  );
  assertEquals(rows[0].note?.startsWith("left office early;") ?? false, true);
});

Deno.test("resolveFacts: one person listed twice under known_as and an alias is not ambiguous", () => {
  const roster: RosterEntry[] = [
    { id: VIDHYA, known_as: "Vidhya", aliases: ["vidhya", "Vidhya"] },
  ];
  const rows = resolveFacts([fact({ rawName: "Vidhya" })], roster);
  assertEquals(rows[0].staff_id, VIDHYA);
  assertEquals(rows[0].needs_review, false);
});

// ---------------------------------------------------------------------------
// Date expansion
// ---------------------------------------------------------------------------

Deno.test("resolveFacts: a single day is one row", () => {
  const rows = resolveFacts([fact()], ROSTER);
  assertEquals(rows.map((r) => r.on_date), ["2026-08-06"]);
});

Deno.test("resolveFacts: a range becomes one row per day and skips the weekend", () => {
  // Thursday 6 Aug to Tuesday 11 Aug 2026. Saturday the 8th and Sunday the 9th
  // are not working days, and marking somebody absent from one would put a
  // permanent block of grey on every long leave.
  const rows = resolveFacts(
    [fact({ startDate: "2026-08-06", endDate: "2026-08-11" })],
    ROSTER,
  );
  assertEquals(rows.map((r) => r.on_date), [
    "2026-08-06",
    "2026-08-07",
    "2026-08-10",
    "2026-08-11",
  ]);
  // Expansion alone is not a reason for review — the range parsed cleanly.
  assertEquals(rows.every((r) => r.needs_review === false), true);
  assertEquals(rows.every((r) => r.staff_id === VIDHYA), true);
});

Deno.test("resolveFacts: a single announced day on a Saturday is honoured", () => {
  // The weekend rule is about days we INFER. A Saturday somebody actually wrote
  // down is a Saturday somebody was expected to work.
  const rows = resolveFacts(
    [fact({ startDate: "2026-08-08", endDate: "2026-08-08" })],
    ROSTER,
  );
  assertEquals(rows.map((r) => r.on_date), ["2026-08-08"]);
});

Deno.test("resolveFacts: a weekend-only range keeps the stated day rather than nothing", () => {
  const rows = resolveFacts(
    [fact({ startDate: "2026-08-08", endDate: "2026-08-09" })],
    ROSTER,
  );
  assertEquals(rows.map((r) => r.on_date), ["2026-08-08"]);
  assertEquals(rows[0].needs_review, true);
});

Deno.test("resolveFacts: a runaway range is clamped to 60 days and flagged", () => {
  // "until March" misread as a year out. Without the clamp one bad email writes
  // hundreds of rows that a human then deletes by hand.
  const rows = resolveFacts(
    [fact({ startDate: "2026-08-06", endDate: "2027-08-06" })],
    ROSTER,
  );
  // 60 calendar days from Thursday 6 Aug 2026 ends on Tuesday 4 Oct; that
  // window holds 42 weekdays.
  assertEquals(rows.length, 42);
  assertEquals(rows[0].on_date, "2026-08-06");
  assertEquals(rows[rows.length - 1].on_date, "2026-10-02");
  assertEquals(rows.every((r) => r.needs_review === true), true);
});

Deno.test("resolveFacts: a range exactly at the clamp is not flagged", () => {
  // The boundary matters: flagging a legitimate two-month absence for review
  // every time would train people to clear the queue without reading it.
  const rows = resolveFacts(
    [fact({ startDate: "2026-08-06", endDate: "2026-10-04" })],
    ROSTER,
  );
  assertEquals(rows.every((r) => r.needs_review === false), true);
});

Deno.test("resolveFacts: a dateless fact cannot be stored, and says so by absence", () => {
  // on_date is NOT NULL and there is no honest date to invent. This is the one
  // case where a fact produces no row — it only happens when the email's own
  // timestamp was unreadable.
  assertEquals(resolveFacts([fact({ startDate: "", endDate: "" })], ROSTER), []);
});

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

Deno.test("resolveFacts: status, day part and note are carried through unchanged", () => {
  const rows = resolveFacts(
    [fact({ status: "local_leave", dayPart: "am", note: "back at noon" })],
    ROSTER,
  );
  assertEquals(rows[0].status, "local_leave");
  assertEquals(rows[0].day_part, "am");
  assertEquals(rows[0].note, "back at noon");
});

Deno.test("resolveFacts: a missing note is null, not an empty string", () => {
  // staff_presence.note is nullable and the UI tests it for truthiness; "" and
  // null must not mean two different kinds of nothing.
  assertEquals(resolveFacts([fact()], ROSTER)[0].note, null);
});

Deno.test("resolveFacts: no facts and no roster produce no rows and no throw", () => {
  assertEquals(resolveFacts([], []), []);
});

// ---------------------------------------------------------------------------
// presenceSource — which id a presence row is keyed on
// ---------------------------------------------------------------------------
//
// This is the whole defence against an absence appearing once per colleague who
// happens to have connected their mailbox. An all-staff notice sits in many
// mailboxes; the Graph id differs in each, the RFC 5322 Message-ID does not.
// Nothing about a regression here is visible from the code — it shows up as a
// board saying Vidhya was sick three times on one day.

const ROW: ResolvedRow = {
  staff_id: null,
  raw_name: "Vidhya",
  on_date: "2026-08-07",
  status: "sick",
  day_part: "full",
  note: null,
  needs_review: false,
};

Deno.test("presenceSource: the Message-ID is the key, not the mailbox's copy", () => {
  const out = presenceSource("<abc@jadegroup.mu>", "AAMkGraphIdForThisMailbox", [ROW]);
  assertEquals(out.messageId, "<abc@jadegroup.mu>");
  assertEquals(out.rows[0].needs_review, false);
});

Deno.test("presenceSource: two mailboxes holding one notice agree on the key", () => {
  // The same announcement as fetched by two different connected accounts.
  const a = presenceSource("<same@jadegroup.mu>", "AAMk-mailbox-A", [ROW]);
  const b = presenceSource("<same@jadegroup.mu>", "AAMk-mailbox-B", [ROW]);
  // Equal keys mean the unique index collapses them into one row.
  assertEquals(a.messageId, b.messageId);
});

Deno.test("presenceSource: no Message-ID falls back but flags the row", () => {
  for (const missing of [null, undefined, "", "   "]) {
    const out = presenceSource(missing, "AAMk-graph-id", [ROW]);
    assertEquals(out.messageId, "AAMk-graph-id");
    // Recorded rather than dropped — losing a sick colleague is worse than a
    // possible duplicate — but never silently.
    assertEquals(out.rows[0].needs_review, true);
    assertEquals(typeof out.rows[0].note, "string");
  }
});

Deno.test("presenceSource: the fallback does not mutate the caller's rows", () => {
  const original: ResolvedRow = { ...ROW };
  presenceSource(null, "AAMk-graph-id", [original]);
  assertEquals(original.needs_review, false);
  assertEquals(original.note, null);
});

Deno.test("presenceSource: an empty row list still yields the key", () => {
  // storePresence must still run on empty so a retracted notice clears its
  // old rows; that means presenceSource has to survive the empty case.
  const out = presenceSource("<x@jadegroup.mu>", "AAMk-graph-id", []);
  assertEquals(out.messageId, "<x@jadegroup.mu>");
  assertEquals(out.rows, []);
});
