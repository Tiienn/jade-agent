// Typed data access for the in-app calendar — phase 3.
//
// Three tables, and unlike everything else in src/lib they are all
// CLIENT-WRITABLE. That is a deliberate difference rather than a gap:
// staff_presence (0006) and leave_requests (0010) carry a claim about somebody
// else, decided by server-side logic a browser must not be able to skip, so
// their writes go through edge functions. A meeting is not a claim about
// anyone — it is something a person schedules, owns and may cancel — so there
// is no server-side decision here to protect and no function to route through.
// See the table comment on calendar_events in 0011_calendar.sql.
//
// What RLS does enforce is authorship, and this file has to cooperate with it
// in exactly one place: `created_by_profile_id = auth.uid()` is a `with check`,
// so an insert that omits the column fails. Hence `currentProfileId()` below.
//
// The one thing worth knowing before editing calendar_event_attendees: it
// carries a COLUMN-LEVEL grant. `authenticated` may UPDATE `response` and
// nothing else, so an update whose payload mentions any other column is
// refused by the privilege check before RLS is even consulted — and PostgREST
// reports that as "permission denied for table calendar_event_attendees",
// which mentions no column at all. Changing WHO is invited is therefore an
// insert and a delete (see `setAttendees`), never an update.
//
// Time handling is delegated wholesale to supabase/functions/_shared/calendar.ts.
// That module is pure TypeScript with no Deno globals, so it imports here
// unchanged, and one implementation of the Mauritius wall-clock/instant
// conversion is worth more than a browser copy that agrees with the edge
// runtime's until the day it does not.

import { mauritiusToInstant } from '../../supabase/functions/_shared/calendar.ts'
import { addDays } from './presenceApi'
import { supabase } from './supabase'

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** An invitation is not an agreement, so 'pending' is a real state, not a null.
 * There is no 'tentative': nothing in the app would treat it differently. */
export type AttendeeResponse = 'pending' | 'accepted' | 'declined'

/**
 * A row of `calendar_event_attendees`, joined to the roster.
 *
 * `staff_id` is a `staff_directory` id — the same id `staff_presence` is keyed
 * by, which is the whole reason this calendar exists rather than an Outlook
 * link. `known_as`/`full_name` are nullable here only because the join is a
 * join: the columns themselves are NOT NULL, so a null means the embed came
 * back empty, not that somebody has no name.
 */
export interface EventAttendee {
  staff_id: string
  response: AttendeeResponse
  known_as: string | null
  full_name: string | null
}

/** A row of `calendar_events`, with its guest list. */
export interface CalendarEvent {
  id: string
  title: string
  description: string | null
  /** An instant (ISO with a zone), NOT a wall-clock time. Render it through
   * `toMauritiusParts`; never slice a date off it. */
  starts_at: string
  ends_at: string
  /** A RENDERING flag — "do not show a time". The timestamps still bound the
   * Mauritius-local day, 00:00+04 to the next 00:00+04. */
  all_day: boolean
  location: string | null
  created_by_profile_id: string
  attendees: EventAttendee[]
}

export interface CalendarEventInput {
  title: string
  description?: string | null
  starts_at: string
  ends_at: string
  all_day?: boolean
  location?: string | null
  /**
   * Omit to leave the guest list alone; pass a list (including `[]`) to make it
   * exactly that. The distinction matters on update: an editor that saved a
   * changed location would otherwise silently empty the invite list of every
   * caller that did not think to re-send it.
   */
  attendeeStaffIds?: string[]
}

/** A row of `calendar_notes` — pinned to a day, not to an instant. */
export interface CalendarNote {
  id: string
  /** `YYYY-MM-DD`. A DATE in the schema, lining up directly with
   * `staff_presence.on_date`. */
  on_date: string
  body: string
  /** Hidden from colleagues, NOT from admins — the select policy lets
   * `is_admin()` read every note. "Not shown to the team", not a secret. */
  is_private: boolean
  created_by_profile_id: string
  created_at: string
}

export interface CalendarNoteInput {
  on_date: string
  body: string
  is_private?: boolean
}

// ---------------------------------------------------------------------------
// Column lists
// ---------------------------------------------------------------------------

/**
 * The attendee embed goes two levels deep — attendee → staff_directory —
 * because a guest list of bare uuids is unreadable and a second round trip to
 * resolve them would race the first. PostgREST can follow both FKs, so this is
 * one request.
 */
const ATTENDEE_EMBED =
  'attendees:calendar_event_attendees(staff_id,response,staff:staff_directory(known_as,full_name))'

const EVENT_COLUMNS =
  'id,title,description,starts_at,ends_at,all_day,location,created_by_profile_id,' +
  ATTENDEE_EMBED

const ATTENDEE_COLUMNS =
  'staff_id,response,staff:staff_directory(known_as,full_name)'

const NOTE_COLUMNS =
  'id,on_date,body,is_private,created_by_profile_id,created_at'

/** The shape PostgREST returns for the embed above, before flattening. */
interface RawAttendee {
  staff_id: string
  response: AttendeeResponse
  staff: { known_as: string | null; full_name: string | null } | null
}

interface RawEvent {
  id: string
  title: string
  description: string | null
  starts_at: string
  ends_at: string
  all_day: boolean
  location: string | null
  created_by_profile_id: string
  attendees: RawAttendee[] | null
}

function toAttendee(row: RawAttendee): EventAttendee {
  return {
    staff_id: row.staff_id,
    response: row.response,
    known_as: row.staff?.known_as ?? null,
    full_name: row.staff?.full_name ?? null,
  }
}

/** Attendees sort by the name people actually use, so a long invite list reads
 * as a list rather than as insertion order nobody chose. */
function toAttendees(rows: RawAttendee[] | null | undefined): EventAttendee[] {
  return (rows ?? [])
    .map(toAttendee)
    .sort((a, b) =>
      (a.known_as ?? a.full_name ?? '').localeCompare(
        b.known_as ?? b.full_name ?? '',
      ),
    )
}

function toEvent(row: RawEvent): CalendarEvent {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    all_day: row.all_day,
    location: row.location,
    created_by_profile_id: row.created_by_profile_id,
    attendees: toAttendees(row.attendees),
  }
}

// ---------------------------------------------------------------------------
// Errors
//
// Postgres 42501 reaches the browser for two quite different reasons here, and
// the messages have to be different because the fixes are: RLS refusing a row
// ("not yours"), or the column grant refusing a column ("not that field").
// ---------------------------------------------------------------------------

const NOT_YOURS =
  'Only the person who created this — or an administrator — can change it.'

function writeMessage(error: { code?: string }, fallback: string): string {
  return error.code === '42501' ? NOT_YOURS : fallback
}

/**
 * The signed-in login's id, for `created_by_profile_id`.
 *
 * Read from the session the same way `authHeaders` in api.ts does, rather than
 * from AuthContext: this module is called from loaders and event handlers that
 * have no React context, and the session is the thing the database will
 * actually check `auth.uid()` against anyway.
 */
async function currentProfileId(): Promise<string> {
  const { data } = await supabase.auth.getSession()
  const id = data.session?.user?.id
  if (!id) {
    throw new Error('You appear to be signed out. Please sign in and try again.')
  }
  return id
}

// ---------------------------------------------------------------------------
// Date windows
//
// The window bounds are Mauritius DATES; the column is an instant. Converting
// with `mauritiusToInstant` rather than appending a "T00:00:00Z" is the whole
// point — Mauritius is UTC+4, so the Mauritius day starts at 20:00 UTC the
// evening before, and a naive bound quietly loses four hours off each end.
// ---------------------------------------------------------------------------

/** Start of `date` in Mauritius, as an instant. */
function dayStart(date: string): string {
  const instant = mauritiusToInstant(date, '00:00')
  if (!instant) throw new Error(`"${date}" is not a date the calendar has.`)
  return instant
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Events overlapping `[fromDate, toDate]` (Mauritius dates), attendees included.
 *
 * BOTH ends of the range are filtered, and that is the bug this comment exists
 * to prevent being reintroduced. Filtering on `starts_at` alone reads correctly
 * and silently drops any event already in progress when the window opens — the
 * week-long site visit that began last Thursday vanishes from this week's grid,
 * which is precisely the event nobody can afford to miss. An event overlaps the
 * window when it starts before the window ends AND ends after the window
 * begins; the second half is what needs `ends_at`, and no index serves it (see
 * the note on `calendar_events_starts_at_idx` in 0011 — fine at a company's
 * volume).
 *
 * The comparisons are inclusive at both ends, so a zero-length marker sitting
 * exactly on the window's first instant is returned rather than dropped. That
 * also admits the occasional event that merely touches a boundary — one that
 * ended at exactly 00:00 on `fromDate`. Over-fetching one row is invisible;
 * under-fetching is an event missing from somebody's week, and `datesTouched`
 * is what decides which day each event is drawn on regardless.
 */
export async function fetchEvents(
  fromDate: string,
  toDate: string,
): Promise<CalendarEvent[]> {
  const windowStart = dayStart(fromDate)
  // End-exclusive midnight: `toDate` runs up to, but not into, the next day.
  const windowEnd = dayStart(addDays(toDate, 1))

  const { data, error } = await supabase
    .from('calendar_events')
    .select(EVENT_COLUMNS)
    .lte('starts_at', windowEnd)
    .gte('ends_at', windowStart)
    .order('starts_at', { ascending: true })

  if (error) {
    throw new Error('Could not load the calendar. Please try again.')
  }
  return ((data ?? []) as unknown as RawEvent[]).map(toEvent)
}

/** The columns of an event write, with the strings trimmed and blanks nulled —
 * `title` is NOT NULL and `btrim(title) <> ''`, so a space-only title is a
 * constraint violation rather than an empty block on everyone's grid. */
function eventFields(input: CalendarEventInput) {
  return {
    title: input.title.trim(),
    description: input.description?.trim() || null,
    starts_at: input.starts_at,
    ends_at: input.ends_at,
    all_day: input.all_day ?? false,
    location: input.location?.trim() || null,
  }
}

export async function createEvent(
  input: CalendarEventInput,
): Promise<CalendarEvent> {
  const profileId = await currentProfileId()

  const { data, error } = await supabase
    .from('calendar_events')
    .insert({
      ...eventFields(input),
      // Required, not incidental: the insert policy is
      // `with check (created_by_profile_id = auth.uid())`, so omitting this
      // fails the policy rather than defaulting to anything.
      created_by_profile_id: profileId,
    })
    .select(EVENT_COLUMNS)
    .single()

  if (error) {
    throw new Error(writeMessage(error, 'Could not create that event.'))
  }

  const event = toEvent(data as unknown as RawEvent)
  if (!input.attendeeStaffIds?.length) return event

  // Separate statement because the guests live in a separate table. The event
  // is already saved at this point, so a failure here leaves a real event with
  // an empty guest list — recoverable by editing it — rather than losing what
  // the user typed.
  return { ...event, attendees: await setAttendees(event.id, input.attendeeStaffIds) }
}

/**
 * Edit an event. `attendeeStaffIds` is honoured only when present — see the
 * field's comment; `undefined` leaves the guest list untouched.
 */
export async function updateEvent(
  id: string,
  input: CalendarEventInput,
): Promise<CalendarEvent> {
  const { data, error } = await supabase
    .from('calendar_events')
    .update(eventFields(input))
    .eq('id', id)
    .select(EVENT_COLUMNS)
    .single()

  if (error) {
    throw new Error(writeMessage(error, 'Could not save those changes.'))
  }

  const event = toEvent(data as unknown as RawEvent)
  if (!input.attendeeStaffIds) return event

  return { ...event, attendees: await setAttendees(id, input.attendeeStaffIds) }
}

export async function deleteEvent(id: string): Promise<void> {
  const { error } = await supabase.from('calendar_events').delete().eq('id', id)
  if (error) {
    throw new Error(writeMessage(error, 'Could not delete that event.'))
  }
}

// ---------------------------------------------------------------------------
// Attendees
// ---------------------------------------------------------------------------

/** The guest list as it stands, name-resolved. */
async function fetchAttendees(eventId: string): Promise<EventAttendee[]> {
  const { data, error } = await supabase
    .from('calendar_event_attendees')
    .select(ATTENDEE_COLUMNS)
    .eq('event_id', eventId)

  if (error) {
    throw new Error('Could not load who is invited. Please try again.')
  }
  return toAttendees(data as unknown as RawAttendee[])
}

/**
 * Make the guest list exactly `staffIds`. Owner-only per RLS.
 *
 * Written as a diff — delete the departed, insert the new — rather than
 * "delete everything, insert everything", and the reason is `response`. A
 * wholesale replace would reset every acceptance to 'pending' each time the
 * organiser saved a changed room or a corrected title, so the accept/decline
 * feature would quietly stop meaning anything within a week. The end state is
 * identical; only the responses of people who were already invited survive,
 * which is the honest answer — they did accept, and nothing about that changed.
 *
 * Note there is no update path here at all, by design: the column grant on this
 * table permits `authenticated` to write only `response`, so re-pointing an
 * existing row at a different person is refused by the privilege check.
 * Membership is insert and delete.
 */
export async function setAttendees(
  eventId: string,
  staffIds: string[],
): Promise<EventAttendee[]> {
  // A person invited twice is one person; the composite PK would reject the
  // second row anyway, taking the whole insert with it.
  const desired = [...new Set((staffIds ?? []).map((id) => id?.trim()).filter(Boolean))]

  const { data, error } = await supabase
    .from('calendar_event_attendees')
    .select('staff_id')
    .eq('event_id', eventId)

  if (error) {
    throw new Error('Could not load who is invited. Please try again.')
  }

  const current = ((data ?? []) as { staff_id: string }[]).map((r) => r.staff_id)
  const removed = current.filter((id) => !desired.includes(id))
  const added = desired.filter((id) => !current.includes(id))

  if (removed.length) {
    const { error: delError } = await supabase
      .from('calendar_event_attendees')
      .delete()
      .eq('event_id', eventId)
      .in('staff_id', removed)
    if (delError) {
      throw new Error(
        writeMessage(delError, 'Could not remove someone from the guest list.'),
      )
    }
  }

  if (added.length) {
    const { error: insError } = await supabase
      .from('calendar_event_attendees')
      // `response` is left to its 'pending' default — an invitation is not an
      // agreement, and stating the default here would only be a second place
      // for it to be wrong.
      .insert(added.map((staff_id) => ({ event_id: eventId, staff_id })))
    if (insError) {
      throw new Error(
        writeMessage(insError, 'Could not add someone to the guest list.'),
      )
    }
  }

  return fetchAttendees(eventId)
}

/**
 * An invitee accepting or declining.
 *
 * The payload is `{ response }` and MUST stay that way. `authenticated` holds a
 * column-level UPDATE grant on `response` alone, so adding any other column —
 * `staff_id`, an `updated_at`, anything a well-meaning refactor might include
 * for symmetry — fails the privilege check for the whole statement. The error
 * PostgREST returns says "permission denied for table
 * calendar_event_attendees" and names no column, so the cause is not
 * discoverable from the message. Widening the payload on failure would be
 * exactly the wrong retry.
 *
 * There is no delete here either: declining sets a status, it does not remove
 * the row. A declined invitation tells the organiser something; a vanished one
 * is indistinguishable from never having invited the person, so they re-invite.
 */
export async function respondToEvent(
  eventId: string,
  staffId: string,
  response: AttendeeResponse,
): Promise<void> {
  const { error } = await supabase
    .from('calendar_event_attendees')
    .update({ response })
    .eq('event_id', eventId)
    .eq('staff_id', staffId)

  if (error) {
    // Surfaced rather than translated: 42501 here means either "not your
    // invitation" or the column grant, and guessing which would put a
    // confidently wrong sentence in front of the user.
    throw new Error(
      error.message
        ? `Could not save that response: ${error.message}`
        : 'Could not save that response.',
    )
  }
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/**
 * Notes on days in `[fromDate, toDate]`, inclusive, oldest first.
 *
 * A plain date comparison, with none of the instant arithmetic events need:
 * `on_date` is a DATE precisely so that "which day is this about" is stored
 * rather than inferred. Private notes belonging to other people are filtered by
 * RLS, not here.
 */
export async function fetchNotes(
  fromDate: string,
  toDate: string,
): Promise<CalendarNote[]> {
  const { data, error } = await supabase
    .from('calendar_notes')
    .select(NOTE_COLUMNS)
    .gte('on_date', fromDate)
    .lte('on_date', toDate)
    .order('on_date', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) {
    throw new Error('Could not load the calendar notes. Please try again.')
  }
  return (data ?? []) as unknown as CalendarNote[]
}

export async function createNote(input: CalendarNoteInput): Promise<CalendarNote> {
  const profileId = await currentProfileId()

  const { data, error } = await supabase
    .from('calendar_notes')
    .insert({
      on_date: input.on_date,
      // `check (btrim(body) <> '')` — a note made of spaces takes up a line in
      // everyone's day and says nothing.
      body: input.body.trim(),
      // Shared is the default in the schema on purpose; repeated here so a
      // caller that omits the flag gets the schema's answer, not undefined.
      is_private: input.is_private ?? false,
      created_by_profile_id: profileId,
    })
    .select(NOTE_COLUMNS)
    .single()

  if (error) {
    throw new Error(writeMessage(error, 'Could not save that note.'))
  }
  return data as unknown as CalendarNote
}

/**
 * Edit a note. Only the fields present in `patch` are sent — an absent `body`
 * must not become a blank one, and `is_private` has to be flippable in both
 * directions without restating the text.
 */
export async function updateNote(
  id: string,
  input: Partial<CalendarNoteInput>,
): Promise<CalendarNote> {
  const patch: Record<string, unknown> = {}
  if (input.on_date !== undefined) patch.on_date = input.on_date
  if (input.body !== undefined) patch.body = input.body.trim()
  if (input.is_private !== undefined) patch.is_private = input.is_private

  const { data, error } = await supabase
    .from('calendar_notes')
    .update(patch)
    .eq('id', id)
    .select(NOTE_COLUMNS)
    .single()

  if (error) {
    throw new Error(writeMessage(error, 'Could not save that note.'))
  }
  return data as unknown as CalendarNote
}

export async function deleteNote(id: string): Promise<void> {
  const { error } = await supabase.from('calendar_notes').delete().eq('id', id)
  if (error) {
    throw new Error(writeMessage(error, 'Could not delete that note.'))
  }
}

// ---------------------------------------------------------------------------
// The leave warning
// ---------------------------------------------------------------------------

/**
 * `staff_id` → the Mauritius dates that person is recorded absent. Feeds
 * `attendeeConflicts`.
 *
 * `staff_presence` is read-only from the browser — rows are written by the edge
 * functions that read the office manager's mail and by approved leave — and
 * nothing here writes it.
 *
 * Rows with a null `staff_id` are skipped. That is not tidying up: 0006 keeps
 * those rows alive deliberately, because an absence whose name the extractor
 * could not resolve is still evidence somebody is away and must not be
 * silently dropped from the board. But an unresolved name cannot be matched to
 * an attendee — there is no id to key it under — so it cannot participate in
 * this lookup. The place to see it is the presence board's review queue.
 *
 * A person with no absences is simply absent from the map, which is what
 * `attendeeConflicts` expects: unknown means "nothing to warn about", never an
 * error.
 */
export async function fetchAbsencesByStaff(
  fromDate: string,
  toDate: string,
): Promise<Record<string, string[]>> {
  const { data, error } = await supabase
    .from('staff_presence')
    .select('staff_id,on_date')
    .gte('on_date', fromDate)
    .lte('on_date', toDate)

  if (error) {
    throw new Error('Could not check who is away. Please try again.')
  }

  const rows = (data ?? []) as { staff_id: string | null; on_date: string }[]
  const byStaff: Record<string, string[]> = {}
  for (const row of rows) {
    if (!row.staff_id) continue
    const dates = (byStaff[row.staff_id] ??= [])
    // One person can have several rows for a day (a morning and an afternoon
    // absence). The warning lists days, so the duplicate would read as two
    // problems.
    if (!dates.includes(row.on_date)) dates.push(row.on_date)
  }
  for (const dates of Object.values(byStaff)) dates.sort()
  return byStaff
}
