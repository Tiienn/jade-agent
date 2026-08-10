// Typed data access for the staff presence board.
//
// Two tables, two very different permission stories:
//
//   staff_presence   — READ ONLY from the browser. Rows are written by the
//                      edge functions that read the office manager's mail; RLS
//                      carries no write policy at all, deliberately. Nothing in
//                      this module inserts, updates or deletes it.
//   staff_directory  — every authenticated user may read; only admins may
//                      write. The write helpers below simply let the RLS error
//                      surface rather than second-guessing the role client-side.
//
// Reads go through supabase-js directly, the same way the email pages read
// email_messages — RLS is the authority, not this file.

import { supabase } from './supabase'

export type PresenceStatus =
  | 'sick'
  /** Short casual leave — a day or two off, taken at short notice. */
  | 'local_leave'
  /** Annual leave — planned, and usually weeks rather than days. Deliberately
   * distinct from `local_leave`: a three-week holiday must not read as a day off. */
  | 'vacation_leave'
  | 'permission'
  | 'late'
  | 'off_site'
  | 'other'

export type DayPart = 'full' | 'am' | 'pm' | 'partial'

export type PresenceSource = 'email' | 'request' | 'manual'

/** A row of `staff_directory`. */
export interface StaffMember {
  id: string
  full_name: string
  /**
   * The first name as the office manager actually writes it — "Sandy", not the
   * first token of full_name. NOT NULL in the schema, and the column the
   * extractor resolves against, so it is never left empty here either.
   */
  known_as: string
  /** Other spellings the extractor may see ("Kavi", "K. Ramdin"). NOT NULL. */
  aliases: string[]
  email: string | null
  department: string | null
  manager_id: string | null
  is_manager: boolean
  active: boolean
  created_at: string
}

/** The slice of `staff_directory` embedded in a presence row. */
export interface PresenceStaffRef {
  id: string
  full_name: string
  known_as: string
  department: string | null
}

/**
 * A row of `staff_presence`, joined to the roster where the extractor managed
 * to resolve a name. `staff` is null exactly when `staff_id` is null — the name
 * was written in an email but is not (yet) in the directory.
 */
export interface PresenceRow {
  id: string
  staff_id: string | null
  /** The name as written in the source message. Always populated. */
  raw_name: string
  /** Calendar date, `YYYY-MM-DD`. */
  on_date: string
  status: PresenceStatus
  day_part: DayPart
  note: string | null
  source: PresenceSource
  source_message_id: string | null
  needs_review: boolean
  created_at: string
  staff: PresenceStaffRef | null
}

/** Fields an admin may set when creating or editing a roster entry. */
export interface StaffMemberInput {
  full_name: string
  /** Omit to derive it from the first word of `full_name` — never null: the
   * column is NOT NULL and matching depends on it. */
  known_as?: string
  aliases?: string[]
  email?: string | null
  department?: string | null
  manager_id?: string | null
  is_manager?: boolean
  active?: boolean
}

const PRESENCE_COLUMNS =
  'id,staff_id,raw_name,on_date,status,day_part,note,source,source_message_id,needs_review,created_at,' +
  'staff:staff_directory(id,full_name,known_as,department)'

const STAFF_COLUMNS =
  'id,full_name,known_as,aliases,email,department,manager_id,is_manager,active,created_at'

/** Writes to staff_directory fail this way for anyone who is not an admin. */
const NOT_ADMIN =
  'Only an administrator can change the staff roster.'

// ---------------------------------------------------------------------------
// Dates
//
// Mauritius is UTC+4 all year — the island has no daylight saving — so a fixed
// offset is correct, and the browser's own timezone is deliberately ignored.
// Someone opening the board from London at 21:00 must still see the Mauritius
// working day that everyone in the office is living in, not yesterday's.
// ---------------------------------------------------------------------------

const MAURITIUS_OFFSET_MS = 4 * 60 * 60 * 1000

/** Today's date in Mauritius as `YYYY-MM-DD`. */
export function mauritiusToday(): string {
  return new Date(Date.now() + MAURITIUS_OFFSET_MS).toISOString().slice(0, 10)
}

/** `YYYY-MM-DD` shifted by whole days, calendar-correct across month ends. */
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/**
 * The Monday–Friday week containing `isoDate`, as five `YYYY-MM-DD` strings.
 * Weekends are folded into the following week: nobody reports an absence for a
 * Saturday, so a Saturday view is more useful pointing at the week ahead.
 */
export function workWeek(isoDate: string): string[] {
  const [y, m, d] = isoDate.split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0 Sun … 6 Sat
  const toMonday = dow === 0 ? 1 : dow === 6 ? 2 : 1 - dow
  const monday = addDays(isoDate, toMonday)
  return [0, 1, 2, 3, 4].map((i) => addDays(monday, i))
}

// ---------------------------------------------------------------------------
// Name matching
// ---------------------------------------------------------------------------

/** Case/space-insensitive key for comparing a written name to the roster. */
export function normaliseName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Every spelling a roster entry answers to. */
function knownNames(member: StaffMember): string[] {
  return [member.full_name, member.known_as, ...(member.aliases ?? [])]
    .map(normaliseName)
    .filter(Boolean)
}

/** "Kavi Ramdin" → "Kavi". The fallback when no `known_as` is given. */
export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? ''
}

/**
 * Best guess at who `rawName` refers to, so the "link this name" control opens
 * on a sensible default instead of an empty select. An exact spelling wins; a
 * shared first name is the fallback. Returns null rather than guessing wildly —
 * a wrong default that gets clicked through is worse than no default.
 */
export function suggestMatch(
  rawName: string,
  roster: StaffMember[],
): StaffMember | null {
  const target = normaliseName(rawName)
  if (!target) return null

  const exact = roster.find((m) => knownNames(m).includes(target))
  if (exact) return exact

  const first = target.split(' ')[0]
  if (first.length < 3) return null
  return (
    roster.find((m) =>
      knownNames(m).some((n) => n.split(' ')[0] === first),
    ) ?? null
  )
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Every presence row from `fromDate` to `toDate` inclusive, oldest first.
 * Both bounds are `YYYY-MM-DD`.
 */
export async function fetchPresence(
  fromDate: string,
  toDate: string,
): Promise<PresenceRow[]> {
  const { data, error } = await supabase
    .from('staff_presence')
    .select(PRESENCE_COLUMNS)
    .gte('on_date', fromDate)
    .lte('on_date', toDate)
    .order('on_date', { ascending: true })
    .order('raw_name', { ascending: true })

  if (error) {
    throw new Error('Could not load the presence board. Please try again.')
  }
  return (data ?? []) as unknown as PresenceRow[]
}

/** The whole staff directory, active people first, then alphabetical. */
export async function fetchRoster(): Promise<StaffMember[]> {
  const { data, error } = await supabase
    .from('staff_directory')
    .select(STAFF_COLUMNS)
    .order('active', { ascending: false })
    .order('full_name', { ascending: true })

  if (error) {
    throw new Error('Could not load the staff roster. Please try again.')
  }
  return (data ?? []) as unknown as StaffMember[]
}

// ---------------------------------------------------------------------------
// Roster writes (admin only — enforced by RLS, not by this file)
// ---------------------------------------------------------------------------

export async function createStaffMember(
  input: StaffMemberInput,
): Promise<StaffMember> {
  const fullName = input.full_name.trim()
  const { data, error } = await supabase
    .from('staff_directory')
    .insert({
      full_name: fullName,
      // known_as and aliases are both NOT NULL in the schema, and known_as is
      // what name resolution actually reads — an empty one would quietly stop
      // this person's absences from ever matching.
      known_as: input.known_as?.trim() || firstName(fullName),
      aliases: input.aliases ?? [],
      email: input.email?.trim() || null,
      department: input.department?.trim() || null,
      manager_id: input.manager_id ?? null,
      is_manager: input.is_manager ?? false,
      active: input.active ?? true,
    })
    .select(STAFF_COLUMNS)
    .single()

  if (error) throw new Error(writeMessage(error, 'Could not add that person.'))
  return data as unknown as StaffMember
}

export async function updateStaffMember(
  id: string,
  patch: Partial<StaffMemberInput>,
): Promise<StaffMember> {
  const { data, error } = await supabase
    .from('staff_directory')
    .update(patch)
    .eq('id', id)
    .select(STAFF_COLUMNS)
    .single()

  if (error) {
    throw new Error(writeMessage(error, 'Could not save those changes.'))
  }
  return data as unknown as StaffMember
}

export async function deleteStaffMember(id: string): Promise<void> {
  const { error } = await supabase.from('staff_directory').delete().eq('id', id)
  if (error) {
    throw new Error(writeMessage(error, 'Could not remove that person.'))
  }
}

/**
 * Teach the roster that `rawName` is this person.
 *
 * Presence rows themselves are never rewritten from the browser — they cannot
 * be. What this does is add the spelling to `aliases`, which is what the
 * extractor matches against, so the next sync resolves it (and every future
 * mention) on its own. Already-known spellings are a no-op.
 */
export async function linkNameToStaff(
  member: StaffMember,
  rawName: string,
): Promise<StaffMember> {
  const name = rawName.trim()
  const existing = member.aliases ?? []
  if (!name || knownNames(member).includes(normaliseName(name))) {
    return member
  }
  return updateStaffMember(member.id, { aliases: [...existing, name] })
}

/**
 * Turn an unmatched name into a roster entry.
 *
 * The spelling from the email becomes `known_as`, because that is the column
 * name resolution reads — rostering "Kavi Ramdin" while throwing away the
 * "Kavi" that was actually written would leave every future mention unmatched.
 */
export function addNameToRoster(
  rawName: string,
  fullName: string,
  department: string | null,
): Promise<StaffMember> {
  const full = fullName.trim()
  return createStaffMember({
    full_name: full,
    known_as: rawName.trim() || firstName(full),
    department,
  })
}

/** Postgres 42501 is RLS refusing the write — say so in plain words. */
function writeMessage(error: { code?: string }, fallback: string): string {
  return error.code === '42501' ? NOT_ADMIN : fallback
}
