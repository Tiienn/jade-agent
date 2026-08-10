// Deno tests for the pure calendar rules.
// Run: deno test supabase/functions/_shared/calendar_test.ts
//
// What these tests protect is a warning that fails QUIETLY. A conflict check is
// only consulted when it speaks, so every bug in this module is silent by
// construction: a date read four hours wrong, an evening meeting whose second
// day is never checked, a grid that renders the right dates in the wrong
// columns. Nothing throws, nothing fails a sync, and the first symptom is a
// colleague sitting in a meeting room waiting for somebody who is in Rodrigues.
//
// The timezone tests are all written around 01:00 and 02:00 Port Louis, because
// that is the only window where UTC is on the PREVIOUS day and therefore the
// only window where a naive implementation is wrong. A test suite that only
// used office hours would pass on an implementation that subtracts four hours
// from the time field and leaves the date alone.

import { assertEquals } from "jsr:@std/assert@1";
import {
  type AbsenceLookup,
  attendeeConflicts,
  datesTouched,
  type EventInput,
  MAURITIUS_OFFSET_MS,
  mauritiusToInstant,
  monthGrid,
  rangesOverlap,
  type TimeRange,
  toMauritiusParts,
  validateEvent,
} from "./calendar.ts";

/** Monday 10 August 2026, the same "today" leave_test.ts uses. */
const TODAY = "2026-08-10";

/** Did validation complain about this, whatever the wording? Asserting on a
 * substring keeps these tests about the RULE — the message is UI copy. */
function complains(errors: string[], fragment: string): boolean {
  return errors.some((e) => e.toLowerCase().includes(fragment.toLowerCase()));
}

/** The whole point of the two conversions: whatever the spelling, the same
 * moment in time comes back. */
function assertRoundTrips(iso: string) {
  const parts = toMauritiusParts(iso);
  if (!parts) throw new Error(`expected ${iso} to be readable`);
  const back = mauritiusToInstant(parts.date, parts.time);
  if (!back) throw new Error(`expected ${parts.date} ${parts.time} to be storable`);
  assertEquals(Date.parse(back), Date.parse(iso), `${iso} did not round-trip (got ${back})`);
}

function ev(over: Partial<EventInput> = {}): EventInput {
  return {
    title: "Site visit — Grand Baie",
    startsAt: "2026-08-10T05:00:00.000Z", // 09:00 Mauritius
    endsAt: "2026-08-10T06:00:00.000Z", // 10:00 Mauritius
    allDay: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// toMauritiusParts / mauritiusToInstant
// ---------------------------------------------------------------------------

Deno.test("offset: the exported constant really is four hours", () => {
  assertEquals(MAURITIUS_OFFSET_MS, 14_400_000);
});

Deno.test("parts: an ordinary working morning", () => {
  // 05:00 UTC is 09:00 in Port Louis on the same calendar day.
  assertEquals(toMauritiusParts("2026-08-10T05:00:00.000Z"), {
    date: "2026-08-10",
    time: "09:00",
  });
});

Deno.test("parts: 21:00 UTC is already TOMORROW in Port Louis", () => {
  // The case the whole module exists to get right. A naive implementation that
  // shifts the time and keeps the date reports Sunday 9 August here, and the
  // meeting lands on the wrong day of the board.
  assertEquals(toMauritiusParts("2026-08-09T21:00:00.000Z"), {
    date: "2026-08-10",
    time: "01:00",
  });
});

Deno.test("parts: 20:00 UTC is exactly midnight in Port Louis", () => {
  assertEquals(toMauritiusParts("2026-08-09T20:00:00.000Z"), {
    date: "2026-08-10",
    time: "00:00",
  });
});

Deno.test("parts: seconds and milliseconds are kept, and only when present", () => {
  // "HH:MM" for the tidy case the UI produces, longer forms only when the
  // instant actually carries the precision — which is what makes the round trip
  // exact for every instant rather than only for the tidy ones.
  assertEquals(toMauritiusParts("2026-08-10T05:00:00.000Z")?.time, "09:00");
  assertEquals(toMauritiusParts("2026-08-10T05:00:45.000Z")?.time, "09:00:45");
  assertEquals(toMauritiusParts("2026-08-10T05:00:45.120Z")?.time, "09:00:45.120");
});

Deno.test("parts: unreadable input is null, not a guess", () => {
  for (const bad of ["", "   ", "not a date", "2026-13-40T00:00:00Z", "10/08/2026"]) {
    assertEquals(toMauritiusParts(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
  // Callers are browsers; missing fields arrive as undefined however the types
  // are written.
  assertEquals(toMauritiusParts(undefined as unknown as string), null);
});

Deno.test("parts: a DD/MM date is refused rather than read American-end-first", () => {
  // Date.parse("10/08/2026") succeeds and returns the 7th of OCTOBER. In
  // Mauritius that string means the 10th of August. There is no way to tell
  // which was meant, so the only safe answer is to refuse it — a meeting
  // silently moved two months is the worst outcome available here.
  assertEquals(toMauritiusParts("10/08/2026"), null);
  assertEquals(toMauritiusParts("Aug 10 2026 09:00"), null);
});

Deno.test("parts: a timestamp with NO ZONE is refused", () => {
  // It parses — as LOCAL time, which resolves one way on the edge runtime (UTC)
  // and another on a laptop in Port Louis (UTC+4). A timestamp without a zone
  // is not an instant, and picking a zone for it would be a guess that only
  // shows up as a four-hour error in production.
  assertEquals(toMauritiusParts("2026-08-10T05:00:00"), null);
  assertEquals(toMauritiusParts("2026-08-10"), null);
});

Deno.test("parts: the zoned forms Postgres and toISOString actually produce are accepted", () => {
  // PostgREST hands back a timestamptz with a numeric offset; toISOString
  // writes Z. Both are the same instant and both must read the same.
  assertEquals(toMauritiusParts("2026-08-10T05:00:00+00:00")?.time, "09:00");
  assertEquals(toMauritiusParts("2026-08-10T09:00:00+04:00"), {
    date: "2026-08-10",
    time: "09:00",
  });
  assertEquals(toMauritiusParts("2026-08-10T05:00:00Z")?.time, "09:00");
});

Deno.test("parts: an instant on a date that does not exist is refused, not rolled", () => {
  // Same trap as mauritiusToInstant, reached from the other side: Date.parse
  // turns 30 February into 2 March without a murmur.
  assertEquals(toMauritiusParts("2026-02-30T05:00:00Z"), null);
  assertEquals(toMauritiusParts("2025-02-29T05:00:00Z"), null);
  assertEquals(toMauritiusParts("2024-02-29T05:00:00Z")?.date, "2024-02-29");
});

Deno.test("instant: an ordinary working morning, inverted", () => {
  assertEquals(mauritiusToInstant("2026-08-10", "09:00"), "2026-08-10T05:00:00.000Z");
});

Deno.test("instant: 01:00 in Port Louis is 21:00 the PREVIOUS day in UTC", () => {
  // The date must be allowed to move backwards. Subtracting four hours from the
  // hour field alone gives 2026-08-10T21:00Z — same wall time, wrong day, and
  // it looks entirely plausible in the database.
  assertEquals(mauritiusToInstant("2026-08-10", "01:00"), "2026-08-09T21:00:00.000Z");
});

Deno.test("instant: midnight in Port Louis is 20:00 the previous day", () => {
  assertEquals(mauritiusToInstant("2026-08-10", "00:00"), "2026-08-09T20:00:00.000Z");
});

Deno.test("instant: seconds and milliseconds are accepted", () => {
  assertEquals(mauritiusToInstant("2026-08-10", "09:00:45"), "2026-08-10T05:00:45.000Z");
  assertEquals(mauritiusToInstant("2026-08-10", "09:00:45.120"), "2026-08-10T05:00:45.120Z");
  // A one-digit fraction is TENTHS of a second, padded on the right. ".5" is
  // 500ms, not 5ms.
  assertEquals(mauritiusToInstant("2026-08-10", "09:00:00.5"), "2026-08-10T05:00:00.500Z");
});

Deno.test("instant: a date that does not exist is refused, never rolled forward", () => {
  // Date.parse("2026-02-30T…") happily returns the 2nd of March. A meeting
  // booked on the 30th of February must come back as an error the user can see,
  // not as a meeting three days later that nobody notices until it is missed.
  assertEquals(mauritiusToInstant("2026-02-30", "09:00"), null);
  assertEquals(mauritiusToInstant("2025-02-29", "09:00"), null); // 2025 is not a leap year
  assertEquals(mauritiusToInstant("2026-04-31", "09:00"), null);
  // ...but the real leap day is fine.
  assertEquals(mauritiusToInstant("2024-02-29", "09:00"), "2024-02-29T05:00:00.000Z");
});

Deno.test("instant: malformed dates and times are null, never thrown", () => {
  const bad: [string, string][] = [
    ["", "09:00"],
    ["2026-8-10", "09:00"], // single-digit month
    ["10-08-2026", "09:00"],
    ["2026-08-10", ""],
    ["2026-08-10", "9:00"], // single-digit hour is refused, not guessed at
    ["2026-08-10", "25:00"],
    ["2026-08-10", "09:60"],
    ["2026-08-10", "09:00:60"],
    ["2026-08-10", "0900"],
    ["2026-08-10", "9am"],
  ];
  for (const [date, time] of bad) {
    assertEquals(
      mauritiusToInstant(date, time),
      null,
      `expected null for ${JSON.stringify(date)} ${JSON.stringify(time)}`,
    );
  }
  assertEquals(
    mauritiusToInstant(undefined as unknown as string, undefined as unknown as string),
    null,
  );
});

// ---------------------------------------------------------------------------
// Round trips — the property that matters more than any single conversion
// ---------------------------------------------------------------------------

Deno.test("round trip: an ordinary meeting", () => {
  assertRoundTrips("2026-08-10T05:30:00.000Z");
});

Deno.test("round trip: ACROSS UTC MIDNIGHT, the case that breaks naive code", () => {
  // 01:00 Mauritius is 21:00 the previous day UTC. Every instant in this test
  // is read in Port Louis as a date one day ahead of its UTC date, and an
  // implementation that keeps the date and shifts the hour passes every other
  // test in this file and fails these.
  assertRoundTrips("2026-08-09T20:00:00.000Z"); // 00:00 Tue 10 Aug, Mauritius
  assertRoundTrips("2026-08-09T20:00:00.001Z"); // one millisecond after midnight
  assertRoundTrips("2026-08-09T21:00:00.000Z"); // 01:00
  assertRoundTrips("2026-08-09T23:59:59.999Z"); // 03:59:59.999
  assertRoundTrips("2026-08-10T00:00:00.000Z"); // 04:00, the first instant back in step
});

Deno.test("round trip: across a MONTH boundary", () => {
  // 31 August 21:00 UTC is 1 September in Port Louis: the month rolls over four
  // hours before UTC agrees.
  assertRoundTrips("2026-08-31T21:00:00.000Z");
  assertEquals(toMauritiusParts("2026-08-31T21:00:00.000Z"), {
    date: "2026-09-01",
    time: "01:00",
  });
  // And the short-month edge, in both directions.
  assertRoundTrips("2026-02-28T20:00:00.000Z"); // 00:00 Sun 1 March
  assertRoundTrips("2024-02-28T21:00:00.000Z"); // 01:00 on the leap day itself
  assertEquals(toMauritiusParts("2024-02-28T21:00:00.000Z")?.date, "2024-02-29");
});

Deno.test("round trip: across a YEAR boundary", () => {
  // New Year in Port Louis happens at 20:00 UTC on 31 December. An hour later
  // it is 2027 locally and still 2026 in the database.
  assertRoundTrips("2026-12-31T20:00:00.000Z");
  assertRoundTrips("2026-12-31T21:00:00.000Z");
  assertEquals(toMauritiusParts("2026-12-31T21:00:00.000Z"), {
    date: "2027-01-01",
    time: "01:00",
  });
  // The other direction: 00:00 UTC on 1 January is already 04:00 on New Year's
  // Day locally, same year.
  assertRoundTrips("2027-01-01T00:00:00.000Z");
});

Deno.test("round trip: every hour of a day survives", () => {
  // Brute force over the day the office is most likely to schedule in, plus the
  // three hours either side of the UTC-midnight seam.
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 1, 30, 59]) {
      assertRoundTrips(`2026-08-09T${h < 10 ? `0${h}` : h}:${m < 10 ? `0${m}` : m}:00.000Z`);
    }
  }
});

// ---------------------------------------------------------------------------
// rangesOverlap
// ---------------------------------------------------------------------------

/** 09:00-10:00 Mauritius on Monday 10 August 2026. */
const NINE_TO_TEN: TimeRange = {
  startsAt: "2026-08-10T05:00:00.000Z",
  endsAt: "2026-08-10T06:00:00.000Z",
};
/** 10:00-11:00, starting exactly when the above ends. */
const TEN_TO_ELEVEN: TimeRange = {
  startsAt: "2026-08-10T06:00:00.000Z",
  endsAt: "2026-08-10T07:00:00.000Z",
};

Deno.test("overlap: exactly touching ranges do NOT overlap", () => {
  // Half-open. Back-to-back meetings are the normal shape of a morning, and a
  // check that called them a clash would be switched off by lunchtime.
  assertEquals(rangesOverlap(NINE_TO_TEN, TEN_TO_ELEVEN), false);
  assertEquals(rangesOverlap(TEN_TO_ELEVEN, NINE_TO_TEN), false);
});

Deno.test("overlap: one minute of shared time IS an overlap", () => {
  const nudged: TimeRange = {
    startsAt: "2026-08-10T05:59:00.000Z",
    endsAt: "2026-08-10T07:00:00.000Z",
  };
  assertEquals(rangesOverlap(NINE_TO_TEN, nudged), true);
});

Deno.test("overlap: a range fully containing another overlaps it", () => {
  const allMorning: TimeRange = {
    startsAt: "2026-08-10T04:00:00.000Z", // 08:00
    endsAt: "2026-08-10T08:00:00.000Z", // 12:00
  };
  assertEquals(rangesOverlap(allMorning, NINE_TO_TEN), true);
  assertEquals(rangesOverlap(NINE_TO_TEN, allMorning), true);
});

Deno.test("overlap: identical ranges overlap", () => {
  assertEquals(rangesOverlap(NINE_TO_TEN, { ...NINE_TO_TEN }), true);
});

Deno.test("overlap: disjoint ranges do not", () => {
  const afternoon: TimeRange = {
    startsAt: "2026-08-10T10:00:00.000Z",
    endsAt: "2026-08-10T11:00:00.000Z",
  };
  assertEquals(rangesOverlap(NINE_TO_TEN, afternoon), false);
});

Deno.test("overlap: the relation is symmetric for every pair here", () => {
  // Symmetry is a property, not a coincidence of argument order, and an
  // asymmetric comparison would warn about a clash on one screen and not the
  // other.
  const ranges: TimeRange[] = [
    NINE_TO_TEN,
    TEN_TO_ELEVEN,
    { startsAt: "2026-08-10T04:00:00.000Z", endsAt: "2026-08-10T08:00:00.000Z" },
    { startsAt: "2026-08-10T05:30:00.000Z", endsAt: "2026-08-10T05:45:00.000Z" },
    { startsAt: "2026-08-09T21:00:00.000Z", endsAt: "2026-08-09T22:00:00.000Z" },
    { startsAt: "2026-08-10T05:00:00.000Z", endsAt: "2026-08-10T05:00:00.000Z" }, // zero length
    { startsAt: "nonsense", endsAt: "2026-08-10T06:00:00.000Z" },
  ];
  for (const a of ranges) {
    for (const b of ranges) {
      assertEquals(
        rangesOverlap(a, b),
        rangesOverlap(b, a),
        `asymmetric for ${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
      );
    }
  }
});

Deno.test("overlap: a zero-length range clashes with nothing", () => {
  const instant: TimeRange = {
    startsAt: "2026-08-10T05:30:00.000Z",
    endsAt: "2026-08-10T05:30:00.000Z",
  };
  assertEquals(rangesOverlap(instant, NINE_TO_TEN), false);
});

Deno.test("overlap: unreadable or backwards ranges clash with nothing, and never throw", () => {
  assertEquals(rangesOverlap({ startsAt: "", endsAt: "" }, NINE_TO_TEN), false);
  assertEquals(rangesOverlap({ startsAt: "tuesday", endsAt: "later" }, NINE_TO_TEN), false);
  assertEquals(
    rangesOverlap(
      { startsAt: NINE_TO_TEN.endsAt, endsAt: NINE_TO_TEN.startsAt },
      NINE_TO_TEN,
    ),
    false,
  );
  assertEquals(rangesOverlap(undefined as unknown as TimeRange, NINE_TO_TEN), false);
});

// ---------------------------------------------------------------------------
// validateEvent
// ---------------------------------------------------------------------------

Deno.test("validate: an ordinary hour-long meeting is accepted", () => {
  assertEquals(validateEvent(ev()), { ok: true, errors: [] });
});

Deno.test("validate: an empty or whitespace-only title is refused", () => {
  for (const title of ["", "   ", "\t\n"]) {
    const v = validateEvent(ev({ title }));
    assertEquals(v.ok, false);
    assertEquals(complains(v.errors, "title"), true);
  }
});

Deno.test("validate: an end before the start is refused", () => {
  const v = validateEvent(ev({
    startsAt: "2026-08-10T06:00:00.000Z",
    endsAt: "2026-08-10T05:00:00.000Z",
  }));
  assertEquals(v.ok, false);
  assertEquals(complains(v.errors, "before the start"), true);
});

Deno.test("validate: unparseable timestamps are each reported", () => {
  const v = validateEvent(ev({ startsAt: "sometime tuesday", endsAt: "" }));
  assertEquals(v.ok, false);
  assertEquals(complains(v.errors, "start time"), true);
  assertEquals(complains(v.errors, "end time"), true);
});

Deno.test("validate: a backwards range is not ALSO reported as too long", () => {
  // One mistake, one error. A list that describes the same slip three ways is a
  // list people stop reading.
  const v = validateEvent(ev({
    startsAt: "2026-08-20T06:00:00.000Z",
    endsAt: "2026-08-10T05:00:00.000Z",
  }));
  assertEquals(v.errors.length, 1);
});

Deno.test("validate: a timed event of exactly 24 hours is accepted, 24h+1ms is not", () => {
  // The boundary, not the middle. Over-tightening refuses a legitimate
  // all-day-plus-evening booking; over-loosening lets a mistyped year smear a
  // bar across the whole grid.
  const exactly = validateEvent(ev({
    startsAt: "2026-08-10T05:00:00.000Z",
    endsAt: "2026-08-11T05:00:00.000Z",
  }));
  assertEquals(exactly, { ok: true, errors: [] });

  const over = validateEvent(ev({
    startsAt: "2026-08-10T05:00:00.000Z",
    endsAt: "2026-08-11T05:00:00.001Z",
  }));
  assertEquals(over.ok, false);
  assertEquals(complains(over.errors, "24 hours"), true);
});

Deno.test("validate: an ALL-DAY event may span several days", () => {
  // A conference or a block booking is genuinely multi-day. This is the whole
  // distinction the allDay flag draws, so the length rule must not apply.
  const v = validateEvent(ev({
    title: "Property expo — Ebène",
    startsAt: "2026-08-10T20:00:00.000Z",
    endsAt: "2026-08-14T20:00:00.000Z",
    allDay: true,
  }));
  assertEquals(v, { ok: true, errors: [] });
});

Deno.test("validate: an all-day event still cannot end before it starts", () => {
  const v = validateEvent(ev({
    startsAt: "2026-08-14T20:00:00.000Z",
    endsAt: "2026-08-10T20:00:00.000Z",
    allDay: true,
  }));
  assertEquals(v.ok, false);
  assertEquals(complains(v.errors, "before the start"), true);
});

Deno.test("validate: every problem is reported at once, not one per submission", () => {
  const v = validateEvent({
    title: "  ",
    startsAt: "2026-08-10T05:00:00.000Z",
    endsAt: "2026-08-20T05:00:00.000Z",
    allDay: false,
  });
  assertEquals(v.ok, false);
  assertEquals(v.errors.length, 2);
  assertEquals(complains(v.errors, "title"), true);
  assertEquals(complains(v.errors, "24 hours"), true);
});

Deno.test("validate: garbage input is refused, never thrown", () => {
  const v = validateEvent(undefined as unknown as EventInput);
  assertEquals(v.ok, false);
  assertEquals(v.errors.length, 3); // title, start, end
  assertEquals(validateEvent({} as EventInput).ok, false);
});

// ---------------------------------------------------------------------------
// monthGrid
// ---------------------------------------------------------------------------

Deno.test("grid: always exactly 42 cells, whatever the month", () => {
  // Six rows of seven, so the calendar never changes height as the user pages
  // through months and the cell under the pointer never moves between clicks.
  const months: [number, number][] = [
    [2026, 1],
    [2026, 2], // 28 days, starts on a Sunday — fits in five rows and still gets six
    [2024, 2], // leap February
    [2026, 8],
    [2026, 11],
    [2027, 12],
  ];
  for (const [year, month] of months) {
    assertEquals(monthGrid(year, month, TODAY).length, 42, `${year}-${month}`);
  }
});

Deno.test("grid: month is 1-12, not zero-based", () => {
  // The classic off-by-one. If `Date`'s convention leaked out of the module,
  // month 1 would render February.
  const jan = monthGrid(2026, 1, TODAY).filter((c) => c.inMonth);
  assertEquals(jan[0].date, "2026-01-01");
  assertEquals(jan.length, 31);

  const dec = monthGrid(2026, 12, TODAY).filter((c) => c.inMonth);
  assertEquals(dec[0].date, "2026-12-01");
  assertEquals(dec[dec.length - 1].date, "2026-12-31");
});

Deno.test("grid: every row starts on a Monday", () => {
  const cells = monthGrid(2026, 8, TODAY);
  for (let i = 0; i < cells.length; i += 7) {
    const weekday = new Date(`${cells[i].date}T12:00:00Z`).getUTCDay();
    assertEquals(weekday, 1, `${cells[i].date} is not a Monday`);
  }
  // ...and the weekend sits in the last two columns, which is what Monday-first
  // is FOR: Saturday and Sunday together at the end of the row.
  for (let i = 0; i < cells.length; i++) {
    assertEquals(cells[i].isWeekend, i % 7 >= 5, `column ${i % 7} at ${cells[i].date}`);
  }
});

Deno.test("grid: FEBRUARY 2026 starts on a Sunday — the worst case for a Monday-first grid", () => {
  // A Sunday start needs the full six leading days from January, the largest
  // lead a Monday-first grid can have. Get the rotation wrong (leaving Sunday
  // as 0 instead of 6) and the whole month renders a week early.
  const cells = monthGrid(2026, 2, TODAY);
  assertEquals(cells[0].date, "2026-01-26"); // the Monday before
  assertEquals(cells[0].inMonth, false);
  assertEquals(cells[6].date, "2026-02-01"); // Sunday, last column of row one
  assertEquals(cells[6].inMonth, true);
  assertEquals(cells[6].isWeekend, true);
  assertEquals(cells.filter((c) => c.inMonth).length, 28);
  assertEquals(cells[41].date, "2026-03-08"); // trailing days from March
  assertEquals(cells[41].inMonth, false);
});

Deno.test("grid: FEBRUARY 2024 is a leap February and shows 29 days", () => {
  const cells = monthGrid(2024, 2, TODAY);
  assertEquals(cells.length, 42);
  const inMonth = cells.filter((c) => c.inMonth);
  assertEquals(inMonth.length, 29);
  assertEquals(inMonth[28].date, "2024-02-29");
  assertEquals(cells[0].date, "2024-01-29"); // 1 Feb 2024 is a Thursday, so 3 leading days
  assertEquals(cells[3].date, "2024-02-01");
});

Deno.test("grid: February 2026 has 28 days, and 2100 is not a leap year", () => {
  assertEquals(monthGrid(2026, 2, TODAY).filter((c) => c.inMonth).length, 28);
  // Divisible by 100 but not 400. Nobody will be using this then; the point is
  // that the arithmetic is the calendar's, not ours.
  assertEquals(monthGrid(2100, 2, TODAY).filter((c) => c.inMonth).length, 28);
  assertEquals(monthGrid(2000, 2, TODAY).filter((c) => c.inMonth).length, 29);
});

Deno.test("grid: the dates are contiguous with no gap or repeat at the seams", () => {
  // Leading and trailing days are real, clickable dates from the adjacent
  // months, not blanks — "the meeting is on the 1st" is a thing people click on
  // from the 31st.
  const cells = monthGrid(2026, 8, TODAY);
  for (let i = 1; i < cells.length; i++) {
    const prev = Date.parse(`${cells[i - 1].date}T12:00:00Z`);
    const cur = Date.parse(`${cells[i].date}T12:00:00Z`);
    assertEquals(cur - prev, 86_400_000, `gap between ${cells[i - 1].date} and ${cells[i].date}`);
  }
  assertEquals(cells[0].date, "2026-07-27"); // 1 Aug 2026 is a Saturday
  assertEquals(cells[5].date, "2026-08-01");
});

Deno.test("grid: exactly one cell is today, and only when today is on the grid", () => {
  const august = monthGrid(2026, 8, TODAY);
  const marked = august.filter((c) => c.isToday);
  assertEquals(marked.length, 1);
  assertEquals(marked[0].date, TODAY);
  assertEquals(marked[0].inMonth, true);

  // A date can be today on a grid it is only a TRAILING day of, and it must
  // still be highlighted there — the August grid runs to Sunday 6 September, so
  // somebody paging back from September sees the 1st marked.
  const fromSeptember = monthGrid(2026, 8, "2026-09-01");
  const trailing = fromSeptember.filter((c) => c.isToday);
  assertEquals(trailing.length, 1);
  assertEquals(trailing[0].inMonth, false);

  // ...and today is marked nowhere on a month nowhere near it. (August 10 is
  // genuinely absent from the July grid: July 2026 starts on a Wednesday, so
  // that grid ends on Sunday 9 August — one day short.)
  assertEquals(monthGrid(2026, 3, TODAY).some((c) => c.isToday), false);
  assertEquals(monthGrid(2026, 7, TODAY).some((c) => c.isToday), false);
});

Deno.test("grid: a missing or malformed today highlights nothing, and never throws", () => {
  for (const today of ["", "   ", "not a date", undefined as unknown as string]) {
    const cells = monthGrid(2026, 8, today);
    assertEquals(cells.length, 42);
    assertEquals(cells.some((c) => c.isToday), false);
  }
});

Deno.test("grid: an impossible month or year is empty rather than an exception", () => {
  for (const [year, month] of [[2026, 0], [2026, 13], [2026, -1], [2026, 1.5]] as [number, number][]) {
    assertEquals(monthGrid(year, month, TODAY), [], `${year}-${month}`);
  }
  // Two-digit years are refused outright: Date.UTC would read 26 as 1926 and
  // render a perfectly convincing grid for the wrong century.
  assertEquals(monthGrid(26, 8, TODAY), []);
  assertEquals(monthGrid(NaN, 8, TODAY), []);
  assertEquals(monthGrid(2026, NaN, TODAY), []);
});

// ---------------------------------------------------------------------------
// datesTouched
// ---------------------------------------------------------------------------

Deno.test("touched: an ordinary meeting touches one day", () => {
  assertEquals(datesTouched(NINE_TO_TEN), ["2026-08-10"]);
});

Deno.test("touched: a meeting CROSSING MAURITIUS MIDNIGHT yields two dates", () => {
  // 23:00 Monday to 01:00 Tuesday, Port Louis. This is what makes the conflict
  // check right for evening calls with counterparties abroad: somebody on leave
  // on the Tuesday is just as absent at 00:30 as at 09:00.
  const lateCall: TimeRange = {
    startsAt: "2026-08-10T19:00:00.000Z", // 23:00 Mon 10 Aug
    endsAt: "2026-08-10T21:00:00.000Z", // 01:00 Tue 11 Aug
  };
  assertEquals(datesTouched(lateCall), ["2026-08-10", "2026-08-11"]);
});

Deno.test("touched: a meeting ending EXACTLY at midnight touches only the day it is in", () => {
  // Half-open, consistently with rangesOverlap. Counting the next day here
  // would warn about a Tuesday absence for a meeting that finishes on Monday,
  // and a warning that cries wolf is a warning people click past.
  const evening: TimeRange = {
    startsAt: "2026-08-10T18:00:00.000Z", // 22:00 Mon
    endsAt: "2026-08-10T20:00:00.000Z", // 00:00 Tue exactly
  };
  assertEquals(datesTouched(evening), ["2026-08-10"]);

  // One millisecond later and it really does reach into Tuesday.
  assertEquals(
    datesTouched({ startsAt: evening.startsAt, endsAt: "2026-08-10T20:00:00.001Z" }),
    ["2026-08-10", "2026-08-11"],
  );
});

Deno.test("touched: a meeting starting exactly at midnight starts on the new day", () => {
  const graveyard: TimeRange = {
    startsAt: "2026-08-09T20:00:00.000Z", // 00:00 Mon 10 Aug
    endsAt: "2026-08-09T22:00:00.000Z", // 02:00 Mon 10 Aug
  };
  assertEquals(datesTouched(graveyard), ["2026-08-10"]);
});

Deno.test("touched: a multi-day block lists every day inclusive", () => {
  const expo: TimeRange = {
    startsAt: "2026-08-09T20:00:00.000Z", // 00:00 Mon 10 Aug
    endsAt: "2026-08-12T20:00:00.000Z", // 00:00 Thu 13 Aug — exclusive
  };
  assertEquals(datesTouched(expo), ["2026-08-10", "2026-08-11", "2026-08-12"]);
});

Deno.test("touched: a range crossing a month and a year boundary", () => {
  assertEquals(
    datesTouched({
      startsAt: "2026-08-31T19:00:00.000Z", // 23:00 Mon 31 Aug
      endsAt: "2026-08-31T21:00:00.000Z", // 01:00 Tue 1 Sep
    }),
    ["2026-08-31", "2026-09-01"],
  );
  assertEquals(
    datesTouched({
      startsAt: "2026-12-31T19:00:00.000Z", // 23:00 Thu 31 Dec
      endsAt: "2026-12-31T21:00:00.000Z", // 01:00 Fri 1 Jan 2027
    }),
    ["2026-12-31", "2027-01-01"],
  );
});

Deno.test("touched: a zero-length range still reports the day it sits on", () => {
  assertEquals(
    datesTouched({
      startsAt: "2026-08-10T05:30:00.000Z",
      endsAt: "2026-08-10T05:30:00.000Z",
    }),
    ["2026-08-10"],
  );
});

Deno.test("touched: unreadable or backwards ranges are empty, and never throw", () => {
  assertEquals(datesTouched({ startsAt: "", endsAt: "" }), []);
  assertEquals(datesTouched({ startsAt: "whenever", endsAt: "2026-08-10T05:00:00.000Z" }), []);
  assertEquals(
    datesTouched({ startsAt: "2026-08-10T06:00:00.000Z", endsAt: "2026-08-10T05:00:00.000Z" }),
    [],
  );
  assertEquals(datesTouched(undefined as unknown as TimeRange), []);
});

// ---------------------------------------------------------------------------
// attendeeConflicts — the reason this calendar lives in the app
// ---------------------------------------------------------------------------

const ABSENCES: AbsenceLookup = {
  "staff-vidhya": ["2026-08-10", "2026-08-11", "2026-08-12"], // three days' vacation leave
  "staff-kamini": ["2026-08-11"], // sick, the Tuesday only
  "staff-rekha": ["2026-09-01"], // away, but nowhere near this meeting
};

Deno.test("conflicts: nobody absent returns an empty list", () => {
  // An empty array means "nothing to say" and the UI renders nothing. This is
  // the overwhelmingly common case and it has to be silent.
  assertEquals(
    attendeeConflicts(["staff-rekha", "staff-jerome"], ABSENCES, NINE_TO_TEN),
    [],
  );
});

Deno.test("conflicts: an invitee on leave that day is reported", () => {
  assertEquals(
    attendeeConflicts(["staff-vidhya"], ABSENCES, NINE_TO_TEN),
    [{ staffId: "staff-vidhya", dates: ["2026-08-10"] }],
  );
});

Deno.test("conflicts: only the invitees WITH a conflict come back, in the order given", () => {
  // Order is the order the organiser typed the names in. Re-sorting a list
  // somebody just entered makes them re-read it to find who the warning is
  // about.
  const conflicts = attendeeConflicts(
    ["staff-rekha", "staff-vidhya", "staff-jerome", "staff-kamini"],
    ABSENCES,
    {
      startsAt: "2026-08-10T19:00:00.000Z", // 23:00 Mon 10 Aug
      endsAt: "2026-08-10T21:00:00.000Z", // 01:00 Tue 11 Aug
    },
  );
  assertEquals(conflicts, [
    { staffId: "staff-vidhya", dates: ["2026-08-10", "2026-08-11"] },
    { staffId: "staff-kamini", dates: ["2026-08-11"] },
  ]);
});

Deno.test("conflicts: an EVENING meeting catches the second day's absence", () => {
  // The payoff of datesTouched. Kamini is absent only on the Tuesday, and a
  // meeting that starts on Monday evening runs into it. A conflict check that
  // looked at the start date alone would say nothing at all here.
  assertEquals(
    attendeeConflicts(["staff-kamini"], ABSENCES, {
      startsAt: "2026-08-10T19:00:00.000Z",
      endsAt: "2026-08-10T21:00:00.000Z",
    }),
    [{ staffId: "staff-kamini", dates: ["2026-08-11"] }],
  );
});

Deno.test("conflicts: dates are sorted and de-duplicated", () => {
  const messy: AbsenceLookup = {
    // Two sources file the same day — an email-parsed absence and an approved
    // request for the same morning is the normal way this happens.
    "staff-vidhya": ["2026-08-12", "2026-08-10", "2026-08-10", "2026-08-11"],
  };
  assertEquals(
    attendeeConflicts(["staff-vidhya"], messy, {
      startsAt: "2026-08-09T20:00:00.000Z", // 00:00 Mon 10 Aug
      endsAt: "2026-08-12T20:00:00.000Z", // 00:00 Thu 13 Aug
    }),
    [{ staffId: "staff-vidhya", dates: ["2026-08-10", "2026-08-11", "2026-08-12"] }],
  );
});

Deno.test("conflicts: a person invited twice is warned about once", () => {
  assertEquals(
    attendeeConflicts(["staff-vidhya", "staff-vidhya"], ABSENCES, NINE_TO_TEN),
    [{ staffId: "staff-vidhya", dates: ["2026-08-10"] }],
  );
});

Deno.test("conflicts: an unknown staff id simply has no absences", () => {
  // A new joiner not yet on the board is not an error.
  assertEquals(attendeeConflicts(["staff-nobody"], ABSENCES, NINE_TO_TEN), []);
  assertEquals(attendeeConflicts(["staff-nobody"], {}, NINE_TO_TEN), []);
});

Deno.test("conflicts: an unreadable meeting time warns about nothing", () => {
  // There is no honest answer for a range nobody can place, and inventing a
  // clash is worse than staying quiet — validateEvent is what tells the user.
  assertEquals(
    attendeeConflicts(["staff-vidhya"], ABSENCES, { startsAt: "", endsAt: "" }),
    [],
  );
});

Deno.test("conflicts: missing and malformed input never throws", () => {
  assertEquals(attendeeConflicts([], ABSENCES, NINE_TO_TEN), []);
  assertEquals(
    attendeeConflicts(undefined as unknown as string[], ABSENCES, NINE_TO_TEN),
    [],
  );
  assertEquals(
    attendeeConflicts(["staff-vidhya"], undefined as unknown as AbsenceLookup, NINE_TO_TEN),
    [],
  );
  assertEquals(
    attendeeConflicts(["", "   ", null as unknown as string], ABSENCES, NINE_TO_TEN),
    [],
  );
  // A lookup whose value is not an array — the shape a JSON body can arrive in.
  assertEquals(
    attendeeConflicts(
      ["staff-vidhya"],
      { "staff-vidhya": "2026-08-10" } as unknown as AbsenceLookup,
      NINE_TO_TEN,
    ),
    [],
  );
});
