// Presence persistence — the layer between the pure extractor and the database.
//
// presence.ts turns an email into facts about names ("Vidhya", sick, today).
// This module turns those facts into rows about PEOPLE (staff_directory.id) and
// writes them. The split is deliberate: extraction is testable against the real
// mailbox corpus with no database in sight, and everything that needs a roster
// or a connection lives here.
//
// The resolution rules below all follow from one principle carried over from
// presence.ts: a dropped absence is worse than a wrong one, and a confidently
// wrong absence is worse than an admitted uncertainty. So nothing is ever
// discarded for being unrecognisable — it is emitted with needs_review set and
// dealt with by a human who can see the original mail.
//
// Takes a SupabaseClient as an argument and reads no environment: the caller
// (mail-sync, presence-backfill) owns the connection, and resolveFacts stays
// pure enough to unit test. See presenceStore_test.ts.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { HttpError } from "./auth.ts";
import type { PresenceFact } from "./presence.ts";

export interface RosterEntry {
  id: string;
  known_as: string;
  aliases: string[];
}

export interface ResolvedRow {
  staff_id: string | null;
  raw_name: string;
  on_date: string; // YYYY-MM-DD
  status: string;
  day_part: string;
  note: string | null;
  needs_review: boolean;
}

/**
 * Ceiling on the days one fact may expand into.
 *
 * A real absence announced by email is a day or a few; the longest genuine one
 * in three years of notices is under a fortnight. A range longer than this is
 * therefore not a long holiday, it is a misparse — "until March" read as a year
 * away — and without a cap a single bad email would write hundreds of rows that
 * somebody then has to find and delete by hand.
 */
const MAX_EXPANSION_DAYS = 60;

// ---------------------------------------------------------------------------
// Loading configuration
// ---------------------------------------------------------------------------

/**
 * The addresses whose mail may be read as staff records, lowercased.
 *
 * Only `active` announcers are returned: deactivating somebody who has moved on
 * must stop their old mail being believed on the next re-sync, not merely hide
 * them in the UI.
 */
export async function loadAnnouncers(svc: SupabaseClient): Promise<string[]> {
  const { data, error } = await svc
    .from("presence_announcers")
    .select("email")
    .eq("active", true);
  if (error) throw new HttpError(500, "Could not load the presence announcers");
  return (data ?? [])
    .map((r) => String((r as { email?: unknown }).email ?? "").trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The roster to resolve names against. Active staff only — a leaver's row is
 * kept so their past absences still show a name, but a new email naming them is
 * far more likely to be a namesake than a resurrection, and an unresolved row
 * asks a human rather than silently attaching to somebody who left.
 */
export async function loadRoster(svc: SupabaseClient): Promise<RosterEntry[]> {
  const { data, error } = await svc
    .from("staff_directory")
    .select("id,known_as,aliases")
    .eq("active", true);
  if (error) throw new HttpError(500, "Could not load the staff roster");
  return (data ?? []).map((r) => {
    const row = r as { id?: unknown; known_as?: unknown; aliases?: unknown };
    return {
      id: String(row.id ?? ""),
      known_as: String(row.known_as ?? ""),
      aliases: Array.isArray(row.aliases) ? row.aliases.map((a) => String(a ?? "")) : [],
    };
  });
}

// ---------------------------------------------------------------------------
// Dates
//
// presence.ts owns the Mauritius-time reasoning and is deliberately
// dependency-free, so it exports no date arithmetic. These two are re-derived
// here rather than reaching into that module: they operate on plain YYYY-MM-DD
// strings that already carry the right calendar day, so there is no timezone
// question left to get wrong, and duplicating four lines is cheaper than making
// the extractor depend on anything.
// ---------------------------------------------------------------------------

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function validDate(ymd: string): string {
  const s = (ymd ?? "").trim();
  if (!YMD.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) return "";
  return s;
}

function addDays(ymd: string, days: number): string {
  const d = new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function isWeekend(ymd: string): boolean {
  const day = new Date(Date.parse(`${ymd}T00:00:00Z`)).getUTCDay();
  return day === 0 || day === 6;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * name (lowercased) -> the ids that answer to it.
 *
 * A Set per name, not an array: one person whose known_as is "Sandy" and who
 * also carries "sandy" as an alias must not look like two people and get their
 * own absence flagged as ambiguous.
 */
function indexRoster(roster: RosterEntry[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  const add = (name: string, id: string) => {
    const key = (name ?? "").trim().toLowerCase();
    if (!key || !id) return;
    const bucket = index.get(key) ?? new Set<string>();
    bucket.add(id);
    index.set(key, bucket);
  };
  for (const entry of roster ?? []) {
    add(entry?.known_as ?? "", entry?.id ?? "");
    for (const alias of entry?.aliases ?? []) add(alias, entry?.id ?? "");
  }
  return index;
}

function appendNote(note: string | null, addition: string): string {
  return note ? `${note}; ${addition}` : addition;
}

/**
 * Facts -> rows ready for staff_presence.
 *
 * Two jobs: attach a staff_id where the name is unambiguous, and expand a
 * multi-day fact into one row per day (the table stores days, not ranges — see
 * 0006).
 */
export function resolveFacts(
  facts: PresenceFact[],
  roster: RosterEntry[],
): ResolvedRow[] {
  const index = indexRoster(roster ?? []);
  const rows: ResolvedRow[] = [];

  for (const fact of facts ?? []) {
    const rawName = (fact?.rawName ?? "").trim();
    const matches = rawName ? [...(index.get(rawName.toLowerCase()) ?? [])] : [];

    let staffId: string | null = null;
    let note: string | null = (fact?.note ?? "").trim() || null;
    let needsReview: boolean;

    if (matches.length === 1) {
      staffId = matches[0];
      // The name is certain; the reading of the sentence may not be.
      needsReview = !fact.confident;
    } else if (matches.length > 1) {
      // Two colleagues share a first name and the email used only that name.
      // Picking one is a coin flip that lands on a real person's record, and
      // nothing downstream would ever reveal the guess — the row would look
      // exactly like a confident match. Asking is the only honest option.
      needsReview = true;
      note = appendNote(
        note,
        `ambiguous name "${rawName}" — ${matches.length} people on the roster answer to it`,
      );
    } else {
      // Unknown name, or no name at all because the clause was unparseable.
      // Emitted anyway: an unresolved row is visible and fixable, a dropped one
      // is indistinguishable from a fully staffed office.
      needsReview = true;
    }

    const start = validDate(fact?.startDate ?? "");
    if (!start) {
      // The only case in this module where a fact does not become a row.
      // staff_presence.on_date is NOT NULL and there is no honest value to put
      // there: this only happens when the email's own timestamp was
      // unreadable, and inventing "today" would file an absence on a date
      // nobody asserted. Rare enough that it has never been seen in the corpus.
      continue;
    }
    const end = validDate(fact?.endDate ?? "") || start;

    const expansion = expandDays(start, end);
    if (expansion.flagged) needsReview = true;

    for (const onDate of expansion.dates) {
      rows.push({
        staff_id: staffId,
        raw_name: rawName,
        on_date: onDate,
        status: fact.status,
        day_part: fact.dayPart,
        note,
        needs_review: needsReview,
      });
    }
  }

  return rows;
}

interface Expansion {
  dates: string[];
  /** True when the expansion itself is a reason for a human to look. */
  flagged: boolean;
}

function expandDays(start: string, end: string): Expansion {
  // A single announced day is taken at face value, weekend or not. If the
  // office manager writes on a Saturday that somebody is out, she means it —
  // Jade has staff on site at weekends. The weekend rule below is about
  // INFERRED days only.
  if (end === start) return { dates: [start], flagged: false };

  // Backwards range: the extractor read "until" as something earlier than the
  // start. The absence is real, its shape is not.
  if (end < start) return { dates: [start], flagged: true };

  const dates: string[] = [];
  let cursor = start;
  let walked = 0;
  while (cursor <= end && walked < MAX_EXPANSION_DAYS) {
    // Saturdays and Sundays are skipped when filling in the middle of a range.
    // This is a WORKING presence board: it answers "who is not at their desk
    // today", and nobody can be absent from a day they were never expected on.
    // Writing weekend rows would put a permanent block of grey absences on
    // every long leave and train people to ignore the board.
    if (!isWeekend(cursor)) dates.push(cursor);
    cursor = addDays(cursor, 1);
    walked += 1;
  }

  // Ran out of budget before reaching the stated end — the range is almost
  // certainly a misparse, so what we did write is flagged rather than trusted.
  const clamped = cursor <= end;

  if (dates.length === 0) {
    // The whole range fell on a weekend. Rather than lose the fact entirely,
    // keep the day that was actually stated and let a human decide.
    return { dates: [start], flagged: true };
  }

  return { dates, flagged: clamped };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** What to file an extraction under, and the rows to file. */
export interface PresenceSource {
  /** Goes into staff_presence.source_message_id. */
  messageId: string;
  rows: ResolvedRow[];
}

/**
 * Decide the identity an absence is recorded against.
 *
 * The unit of truth is the ANNOUNCEMENT, not a mailbox's copy of it. Those are
 * different things and Graph only names the second: its message `id` is scoped
 * to one mailbox, so the same all-staff notice has a different id in every
 * recipient's inbox. The dedupe index in 0006 leads on source_message_id, so
 * storing that id means the second colleague to connect a mailbox silently
 * doubles every absence on the board — two rows, same person, same date, no
 * collision, nothing to see in the UI except that Vidhya appears twice.
 *
 * The RFC 5322 Message-ID is the identifier that means what we need: the
 * sending server stamps it once and every copy carries it. Two mailboxes then
 * produce the same key and the existing index collapses them by itself.
 *
 * Fallback: a malformed message can arrive with no Message-ID at all. Recording
 * the absence under the weaker per-mailbox id is better than dropping a sick
 * colleague off the board, so that is what happens — but it reintroduces the
 * duplication risk for that one email, so the rows are flagged for review. A
 * human seeing a note about it is the point; a silent second row is exactly the
 * failure this function exists to prevent.
 *
 * Pure, and shared by mail-sync and presence-backfill so the two write paths
 * cannot disagree about what a presence row is keyed on.
 */
export function presenceSource(
  internetMessageId: string | null | undefined,
  graphMessageId: string,
  rows: ResolvedRow[],
): PresenceSource {
  const announcementId = (internetMessageId ?? "").trim();
  const list = rows ?? [];
  if (announcementId) return { messageId: announcementId, rows: list };

  return {
    messageId: (graphMessageId ?? "").trim(),
    rows: list.map((row) => ({
      ...row,
      needs_review: true,
      note: appendNote(
        row.note,
        "source email carried no Message-ID — recorded against this mailbox's " +
          "copy, so it may appear twice if another mailbox receives it",
      ),
    })),
  };
}

/**
 * Replace everything this email previously asserted with `rows`.
 *
 * Always calls the RPC, including with an empty array. An email whose absences
 * were retracted — corrected, re-sent with a name removed — must clear its old
 * rows, and returning early on empty would leave the withdrawn absence on the
 * board forever with nothing to point at.
 *
 * `messageId` must come from presenceSource, not straight from Graph — see
 * there for why the two are not the same string.
 *
 * See replace_presence_for_message in 0007 for why this is a database function
 * and not a supabase-js upsert (short version: the dedupe key is an expression
 * index, which PostgREST cannot target, and a client-side delete-then-insert
 * leaves a window where the board denies a real absence).
 */
export async function storePresence(
  svc: SupabaseClient,
  messageId: string,
  rows: ResolvedRow[],
): Promise<number> {
  const { data, error } = await svc.rpc("replace_presence_for_message", {
    p_message_id: messageId,
    p_rows: rows ?? [],
  });
  if (error) throw new HttpError(500, `Could not store presence: ${error.message}`);
  return typeof data === "number" ? data : 0;
}
