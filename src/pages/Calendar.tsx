// The in-app calendar — meetings and dated notes for phase 3.
//
// Jade already has Outlook, and Outlook is a better calendar than this will
// ever be. This page exists for the one thing Outlook cannot do: IT KNOWS WHO
// IS AWAY. Phases 1 and 2 built a presence board out of the office manager's
// absence emails and approved leave requests, and every view below spends part
// of its space saying who is out — the month grid, each day of the week, the
// day board, and above all the event editor, which checks the people being
// invited against the board before the invitation is sent rather than after.
//
// That check WARNS and never blocks. Half the absences on the board were parsed
// out of prose, some are flagged for review, and the organiser may well know
// something the board does not. A meeting refused by software is a meeting
// arranged over WhatsApp instead, so the amber panel appears, Save stays
// enabled, and the sentence says so out loud.
//
// Two rules about time, inherited from _shared/calendar.ts:
//
//   1. Everything the office reads is Mauritius wall clock (UTC+4, no daylight
//      saving); everything stored is an instant. `toMauritiusParts` and
//      `mauritiusToInstant` are the only conversions, and no `Date` is ever
//      built from a bare string in this file.
//   2. The month grid is always 42 cells, so paging between months never
//      changes the page height and never moves the cell under the pointer.
//
// The date maths, the grid and the conflict rule all come from
// supabase/functions/_shared/calendar.ts, which is unit-tested against the
// awkward cases (midnight ends, cross-month grids, back-to-back meetings).
// Nothing in here re-derives them.

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { Link } from 'react-router-dom'
import {
  AlertCircle, // error banner
  CalendarDays, // empty month / empty day
  Check, // accepted, saved
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  Lock, // a private note
  MapPin,
  Plus,
  StickyNote, // the note marker on a grid cell
  TriangleAlert, // absence clash
  UserCog, // "your login is not on the roster"
  Users as UsersIcon,
  X,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import {
  createEvent,
  createNote,
  deleteEvent,
  deleteNote,
  fetchAbsencesByStaff,
  fetchEvents,
  fetchNotes,
  respondToEvent,
  updateEvent,
  updateNote,
  type AttendeeResponse,
  type CalendarEvent,
  type CalendarEventInput,
  type CalendarNote,
  type EventAttendee,
} from '../lib/calendarApi'
import {
  addDays,
  fetchRoster,
  mauritiusToday,
  type StaffMember,
} from '../lib/presenceApi'
import {
  attendeeConflicts,
  datesTouched,
  mauritiusToInstant,
  monthGrid,
  toMauritiusParts,
  validateEvent,
  type MonthCell,
} from '../../supabase/functions/_shared/calendar.ts'

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` is a calendar date, not an instant — parse and format it as UTC
 * so the browser's timezone cannot shift it by a day. The same helper the
 * presence board and the leave page use. */
function dayText(iso: string, opts: Intl.DateTimeFormatOptions): string {
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' })
}

const LONG_DATE: Intl.DateTimeFormatOptions = {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
}

/** "12 Aug" — short enough to sit inside a warning sentence. */
function shortDate(iso: string): string {
  return dayText(iso, { day: 'numeric', month: 'short' })
}

/** "12, 13 and 16 Aug", the phrasing the leave page uses for the same job. */
function dateListText(days: string[]): string {
  const parts = days.map(shortDate)
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** The wall clock a person in Port Louis reads off an instant, or null. */
function clockOf(iso: string): string | null {
  return toMauritiusParts(iso)?.time.slice(0, 5) ?? null
}

/** "09:30 – 10:30", or "All day". Times are always Mauritius. */
function eventTimeLabel(ev: CalendarEvent): string {
  if (ev.all_day) return 'All day'
  const from = clockOf(ev.starts_at)
  const to = clockOf(ev.ends_at)
  if (!from) return 'Time not recorded'
  return to ? `${from} – ${to}` : from
}

/** Reading order within a day: all-day events first (they frame the day), then
 * by start time, then alphabetically so the order never wobbles. */
function compareEvents(a: CalendarEvent, b: CalendarEvent): number {
  if (a.all_day !== b.all_day) return a.all_day ? -1 : 1
  return a.starts_at.localeCompare(b.starts_at) || a.title.localeCompare(b.title)
}

/** The name to show for an attendee: what the office calls them, falling back
 * to the full name, and never to a raw uuid. */
function attendeeName(a: EventAttendee): string {
  return a.known_as?.trim() || a.full_name?.trim() || 'Someone'
}

function memberName(m: StaffMember): string {
  return m.known_as?.trim() || m.full_name
}

function errMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

/** `YYYY-MM-DD` → its year and month (1-12, the way `monthGrid` wants it). */
function ymOf(iso: string): { year: number; month: number } {
  const [y, m] = iso.split('-').map(Number)
  return { year: y, month: m }
}

function firstOfMonth(year: number, month: number): string {
  return `${year}-${month < 10 ? `0${month}` : month}-01`
}

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-jade-600 focus:ring-2 focus:ring-jade-600/20 disabled:opacity-60'

const BTN_PRIMARY =
  'inline-flex min-h-[38px] items-center justify-center gap-1.5 rounded-lg bg-jade-600 px-3.5 text-sm font-medium text-white transition-colors hover:bg-jade-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40 disabled:opacity-60'

const BTN_QUIET =
  'inline-flex min-h-[38px] items-center justify-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40 disabled:opacity-60'

/** The quiet button at row scale — the rows in here carry two or three
 * actions each, and a full-height button per row would out-shout the content. */
const BTN_SMALL =
  'inline-flex min-h-[32px] items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-2.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40 disabled:opacity-60'

const LABEL_CLASS = 'mb-1 block text-xs font-medium text-gray-700'

const ARROW_BTN =
  'inline-flex h-[38px] w-[38px] items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40'

/** Monday-first, matching `monthGrid`. Labels only — the grid itself is built
 * by the shared helper, so these can never drift out of step with it. */
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

type View = 'month' | 'week' | 'day'

/** What the editor is open on: an existing event, or a new one on a date. */
interface EditorTarget {
  event: CalendarEvent | null
  date: string
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Calendar() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'

  const today = mauritiusToday()
  const [date, setDate] = useState<string>(() => mauritiusToday())
  const [view, setView] = useState<View>('month')

  const [events, setEvents] = useState<CalendarEvent[] | null>(null)
  const [notes, setNotes] = useState<CalendarNote[] | null>(null)
  /** staff_id -> the dates they are recorded away. Straight from the board. */
  const [absences, setAbsences] = useState<Record<string, string[]>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [roster, setRoster] = useState<StaffMember[] | null>(null)
  const [rosterError, setRosterError] = useState<string | null>(null)

  const [editing, setEditing] = useState<EditorTarget | null>(null)
  const editorRef = useRef<HTMLDivElement>(null)

  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
    },
    [],
  )

  const showToast = useCallback((text: string) => {
    setToast(text)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 6000)
  }, [])

  // --- what is on screen ---------------------------------------------------

  const { year, month } = ymOf(date)
  const cells = useMemo(
    () => monthGrid(year, month, today),
    [year, month, today],
  )

  /**
   * The Monday–Sunday week around the selected date, taken as a row out of the
   * month grid rather than computed again here. The grid covers every day of
   * the month, is already Monday-first, and is already tested — a second
   * implementation of "which Monday is this" is exactly the kind of duplicate
   * that drifts.
   */
  const weekCells = useMemo(() => {
    const i = cells.findIndex((c) => c.date === date)
    if (i < 0) return cells.slice(0, 7)
    const start = Math.floor(i / 7) * 7
    return cells.slice(start, start + 7)
  }, [cells, date])

  const [rangeStart, rangeEnd] = useMemo<[string, string]>(() => {
    if (view === 'day') return [date, date]
    const span = view === 'month' ? cells : weekCells
    if (span.length === 0) return [date, date]
    return [span[0].date, span[span.length - 1].date]
  }, [view, date, cells, weekCells])

  // --- loading -------------------------------------------------------------

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // One trip for the range: the diary, the notes, and who is away. The
      // absences are as much a part of this page as the events are.
      const [nextEvents, nextNotes, nextAbsences] = await Promise.all([
        fetchEvents(rangeStart, rangeEnd),
        fetchNotes(rangeStart, rangeEnd),
        fetchAbsencesByStaff(rangeStart, rangeEnd),
      ])
      setEvents(nextEvents)
      setNotes(nextNotes)
      setAbsences(nextAbsences)
    } catch (e) {
      setEvents(null)
      setNotes(null)
      setAbsences({})
      setError(errMessage(e, 'Could not load the calendar.'))
    } finally {
      setLoading(false)
    }
  }, [rangeStart, rangeEnd])

  useEffect(() => {
    load()
  }, [load])

  // The roster is needed by every view: to name the people the board says are
  // away, and to fill the attendee picker. It changes far more slowly than the
  // diary, so it is fetched once rather than with every range change.
  const loadRoster = useCallback(async () => {
    setRosterError(null)
    try {
      setRoster(await fetchRoster())
    } catch (e) {
      setRoster(null)
      setRosterError(errMessage(e, 'Could not load the staff roster.'))
    }
  }, [])

  useEffect(() => {
    loadRoster()
  }, [loadRoster])

  // --- derived -------------------------------------------------------------

  /**
   * Which events land on which day. An event is listed on EVERY day it touches
   * (see `datesTouched`) so a conference that runs Monday to Wednesday appears
   * on all three, and a late call that crosses midnight appears on both.
   */
  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    for (const ev of events ?? []) {
      for (const d of datesTouched({
        startsAt: ev.starts_at,
        endsAt: ev.ends_at,
      })) {
        const list = map.get(d)
        if (list) list.push(ev)
        else map.set(d, [ev])
      }
    }
    for (const list of map.values()) list.sort(compareEvents)
    return map
  }, [events])

  const notesByDate = useMemo(() => {
    const map = new Map<string, CalendarNote[]>()
    for (const n of notes ?? []) {
      const list = map.get(n.on_date)
      if (list) list.push(n)
      else map.set(n.on_date, [n])
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.created_at.localeCompare(b.created_at))
    }
    return map
  }, [notes])

  const memberById = useMemo(
    () => new Map((roster ?? []).map((m) => [m.id, m])),
    [roster],
  )

  /** profile id -> the roster row that signs in with it. Notes carry only the
   * profile that wrote them, so this is how a note gets a name on it. */
  const memberByProfile = useMemo(
    () =>
      new Map(
        (roster ?? [])
          .filter((m) => m.profile_id)
          .map((m) => [m.profile_id as string, m]),
      ),
    [roster],
  )

  /** The board, inverted: a date -> the names recorded away on it. Sorted, so
   * the same day always reads the same way. */
  const awayByDate = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const [staffId, dates] of Object.entries(absences)) {
      const member = memberById.get(staffId)
      // A staff id with no roster row is somebody removed since the board was
      // written. Skipping is right: an anonymous "1 person away" tells nobody
      // anything they can act on.
      if (!member) continue
      for (const d of dates ?? []) {
        const list = map.get(d)
        if (list) list.push(memberName(member))
        else map.set(d, [memberName(member)])
      }
    }
    for (const list of map.values()) list.sort((a, b) => a.localeCompare(b))
    return map
  }, [absences, memberById])

  /** The roster row this login is, or null — most of the roster has no login
   * and some logins are on nobody. An inactive row cannot act, exactly as on
   * the leave page. */
  const me = useMemo(
    () => (profile ? memberByProfile.get(profile.id) ?? null : null),
    [profile, memberByProfile],
  )
  const myStaffId = me?.active ? me.id : null

  // --- mutations -----------------------------------------------------------
  //
  // Every one of these reloads the range rather than patching state in place.
  // A calendar is a derived view of a date range — an event whose time changed
  // may have moved to a different day, or off screen entirely — and re-deriving
  // it from the server is the only version of that which cannot go stale.

  const handleSaveEvent = useCallback(
    async (target: EditorTarget, input: CalendarEventInput) => {
      // The guest list always travels with the event: `updateEvent` honours
      // `attendeeStaffIds` when it is present, and `setAttendees` underneath it
      // adds and removes rather than replacing, so the people who had already
      // accepted keep their answer when a room or a title changes.
      if (target.event) {
        await updateEvent(target.event.id, input)
        showToast(`“${input.title}” updated.`)
      } else {
        await createEvent(input)
        showToast(`“${input.title}” added to the calendar.`)
      }
      setEditing(null)
      await load()
    },
    [load, showToast],
  )

  const handleDeleteEvent = useCallback(
    async (ev: CalendarEvent) => {
      await deleteEvent(ev.id)
      showToast(`“${ev.title}” removed.`)
      await load()
    },
    [load, showToast],
  )

  const handleRespond = useCallback(
    async (ev: CalendarEvent, response: AttendeeResponse) => {
      if (!myStaffId) return
      await respondToEvent(ev.id, myStaffId, response)
      await load()
    },
    [myStaffId, load],
  )

  const handleAddNote = useCallback(
    async (onDate: string, body: string, isPrivate: boolean) => {
      await createNote({ on_date: onDate, body, is_private: isPrivate })
      await load()
    },
    [load],
  )

  const handleUpdateNote = useCallback(
    async (note: CalendarNote, body: string, isPrivate: boolean) => {
      await updateNote(note.id, {
        on_date: note.on_date,
        body,
        is_private: isPrivate,
      })
      await load()
    },
    [load],
  )

  const handleDeleteNote = useCallback(
    async (note: CalendarNote) => {
      await deleteNote(note.id)
      await load()
    },
    [load],
  )

  // Opening the editor scrolls it into view: on a phone it sits below a full
  // month grid, and a form that appears off screen reads as a dead button.
  useEffect(() => {
    if (editing) editorRef.current?.scrollIntoView({ block: 'nearest' })
  }, [editing])

  // --- navigation ----------------------------------------------------------

  function step(direction: 1 | -1) {
    if (view === 'month') {
      const next = month + direction
      if (next < 1) setDate(firstOfMonth(year - 1, 12))
      else if (next > 12) setDate(firstOfMonth(year + 1, 1))
      else setDate(firstOfMonth(year, next))
      return
    }
    setDate(addDays(date, view === 'week' ? 7 * direction : direction))
  }

  const headingText =
    view === 'month'
      ? dayText(firstOfMonth(year, month), { month: 'long', year: 'numeric' })
      : view === 'week' && weekCells.length === 7
      ? `${shortDate(weekCells[0].date)} – ${dayText(weekCells[6].date, {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        })}`
      : dayText(date, LONG_DATE)

  const tabs: { value: View; label: string }[] = [
    { value: 'month', label: 'Month' },
    { value: 'week', label: 'Week' },
    { value: 'day', label: 'Day' },
  ]

  function openDay(d: string) {
    setDate(d)
    setView('day')
  }

  return (
    <div className="mx-auto h-full w-full max-w-5xl overflow-y-auto p-4 sm:p-6">
      {/* Header */}
      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-gray-900">Calendar</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            {headingText}
            {view !== 'month' && date === today && ' · today in Mauritius'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setEditing({ event: null, date })}
            className={BTN_PRIMARY}
          >
            <Plus size={15} />
            New event
          </button>
          <button
            onClick={() => setDate(today)}
            disabled={date === today}
            className={BTN_QUIET}
          >
            Today
          </button>
          <div className="flex items-center gap-1">
            <button
              onClick={() => step(-1)}
              aria-label={`Previous ${view}`}
              className={ARROW_BTN}
            >
              <ChevronLeft size={18} />
            </button>
            <input
              type="date"
              value={date}
              onChange={(e) => {
                if (e.target.value) setDate(e.target.value)
              }}
              aria-label="Show the calendar around this date"
              className="min-h-[38px] rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none transition focus:border-jade-600 focus:ring-2 focus:ring-jade-600/20"
            />
            <button
              onClick={() => step(1)}
              aria-label={`Next ${view}`}
              className={ARROW_BTN}
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
      </div>

      {/* Views */}
      <div
        role="tablist"
        aria-label="Calendar views"
        className="mt-4 flex gap-2 overflow-x-auto pb-1"
      >
        {tabs.map((t) => {
          const active = view === t.value
          return (
            <button
              key={t.value}
              role="tab"
              aria-selected={active}
              onClick={() => setView(t.value)}
              className={`inline-flex min-h-[38px] shrink-0 items-center rounded-full border px-4 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40 ${
                active
                  ? 'border-jade-600 bg-jade-600 text-white'
                  : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
              }`}
            >
              {t.label}
            </button>
          )
        })}
      </div>

      {error && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle size={18} className="shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
          <button onClick={load} className={BTN_QUIET}>
            Try again
          </button>
        </div>
      )}

      {rosterError && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          <TriangleAlert size={18} className="shrink-0" />
          <span className="min-w-0 flex-1">
            {rosterError} Meetings still work, but nobody can be invited and no
            absences can be named until it loads.
          </span>
          <button onClick={loadRoster} className={BTN_QUIET}>
            Try again
          </button>
        </div>
      )}

      {toast && (
        <p className="mt-3 rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600">
          {toast}
        </p>
      )}

      {/* The calendar is fully usable without a roster link — this only says
          what such a login cannot do, rather than replacing the page. */}
      {profile && !me && roster && <NotOnRoster isAdmin={isAdmin} inactive={false} />}
      {me && !me.active && <NotOnRoster isAdmin={isAdmin} inactive />}

      {editing && (
        <div ref={editorRef}>
          <EventEditor
            key={editing.event?.id ?? `new-${editing.date}`}
            target={editing}
            roster={roster}
            onCancel={() => setEditing(null)}
            onSave={handleSaveEvent}
          />
        </div>
      )}

      {loading && <CalendarSkeleton />}

      {!loading && !error && view === 'month' && (
        <MonthView
          cells={cells}
          selected={date}
          eventsByDate={eventsByDate}
          notesByDate={notesByDate}
          awayByDate={awayByDate}
          onPickDay={openDay}
        />
      )}

      {!loading && !error && view === 'week' && (
        <WeekView
          cells={weekCells}
          selected={date}
          eventsByDate={eventsByDate}
          notesByDate={notesByDate}
          awayByDate={awayByDate}
          onPickDay={openDay}
        />
      )}

      {!loading && !error && view === 'day' && (
        <DayView
          date={date}
          today={today}
          events={eventsByDate.get(date) ?? []}
          notes={notesByDate.get(date) ?? []}
          away={awayByDate.get(date) ?? []}
          profileId={profile?.id ?? null}
          myStaffId={myStaffId}
          isAdmin={isAdmin}
          nameForProfile={(id) => {
            const m = id ? memberByProfile.get(id) : undefined
            return m ? memberName(m) : null
          }}
          onEdit={(ev) => setEditing({ event: ev, date })}
          onNew={() => setEditing({ event: null, date })}
          onDelete={handleDeleteEvent}
          onRespond={handleRespond}
          onAddNote={handleAddNote}
          onUpdateNote={handleUpdateNote}
          onDeleteNote={handleDeleteNote}
        />
      )}
    </div>
  )
}

/**
 * A login with no active roster row. Deliberately a quiet strip rather than the
 * leave page's full-page explanation: on /leave an unlinked login can do
 * nothing at all, whereas here it can read the whole calendar and organise
 * meetings — the only losses are being invited and answering an invitation.
 */
function NotOnRoster({
  inactive,
  isAdmin,
}: {
  inactive: boolean
  isAdmin: boolean
}) {
  return (
    <div className="mt-4 flex flex-wrap items-start gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-500">
        <UserCog size={14} />
      </span>
      <p className="min-w-0 flex-1 text-sm text-gray-500">
        {inactive
          ? 'Your staff record is not active, so you cannot be invited to meetings or answer an invitation. '
          : 'Your login is not linked to a staff member yet, so you cannot be invited to meetings or answer an invitation. '}
        You can still read the calendar and organise meetings for other people.
        {isAdmin && (
          <>
            {' '}
            <Link
              to="/report"
              className="font-medium text-jade-700 underline-offset-2 hover:underline dark:text-jade-300"
            >
              Open the staff roster
            </Link>
            .
          </>
        )}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Month
// ---------------------------------------------------------------------------

/** How many event chips fit in a cell before it starts saying "+3 more". */
const CHIPS_PER_CELL = 3

function MonthView({
  cells,
  selected,
  eventsByDate,
  notesByDate,
  awayByDate,
  onPickDay,
}: {
  cells: MonthCell[]
  selected: string
  eventsByDate: Map<string, CalendarEvent[]>
  notesByDate: Map<string, CalendarNote[]>
  awayByDate: Map<string, string[]>
  onPickDay: (iso: string) => void
}) {
  if (cells.length === 0) {
    return (
      <p className="mt-10 text-center text-sm text-gray-500">
        That is not a month the calendar can show. Pick a date above.
      </p>
    )
  }

  const inMonth = cells.filter((c) => c.inMonth)
  const busy = inMonth.some(
    (c) => (eventsByDate.get(c.date)?.length ?? 0) > 0 || notesByDate.has(c.date),
  )

  return (
    <>
      <div className="mt-4 rounded-xl border border-gray-200 bg-white">
        {/* The grid, not the page, does the horizontal scrolling — the same
            rule the presence board's week table follows. At 375px the grid
            scrolls inside this box and the page body never moves sideways. */}
        <div className="overflow-x-auto">
          <div className="min-w-[42rem]">
            <div
              className="grid grid-cols-7 border-b border-gray-200"
              aria-hidden="true"
            >
              {WEEKDAYS.map((d) => (
                <div
                  key={d}
                  className="px-2 py-2 text-center text-xs font-medium text-gray-500"
                >
                  {d}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-7">
              {cells.map((cell) => (
                <MonthCellButton
                  key={cell.date}
                  cell={cell}
                  selected={cell.date === selected}
                  events={eventsByDate.get(cell.date) ?? []}
                  noteCount={notesByDate.get(cell.date)?.length ?? 0}
                  away={awayByDate.get(cell.date) ?? []}
                  onPick={onPickDay}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* An empty month is the normal state of a small office's diary, so it
          reads as a calm sentence under a perfectly good grid rather than as
          the "something went wrong" empty state. */}
      {!busy && (
        <p className="mt-3 text-center text-sm text-gray-500">
          Nothing in the diary this month. Pick a day to add something.
        </p>
      )}
    </>
  )
}

function MonthCellButton({
  cell,
  selected,
  events,
  noteCount,
  away,
  onPick,
}: {
  cell: MonthCell
  selected: boolean
  events: CalendarEvent[]
  noteCount: number
  away: string[]
  onPick: (iso: string) => void
}) {
  const shown = events.slice(0, CHIPS_PER_CELL)
  const hidden = events.length - shown.length

  // Spoken as one sentence, because a screen reader reads the whole button.
  const label = [
    dayText(cell.date, LONG_DATE),
    cell.isToday ? 'today' : null,
    events.length === 1 ? '1 event' : events.length > 1 ? `${events.length} events` : null,
    noteCount === 1 ? '1 note' : noteCount > 1 ? `${noteCount} notes` : null,
    away.length > 0 ? `away: ${away.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <button
      type="button"
      onClick={() => onPick(cell.date)}
      aria-label={label}
      aria-current={cell.isToday ? 'date' : undefined}
      className={`flex min-h-[6.5rem] flex-col items-stretch gap-1 border-b border-r border-gray-200 p-1.5 text-left transition-colors hover:bg-gray-50 focus:outline-none focus-visible:relative focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-jade-600/40 ${
        cell.isWeekend ? 'bg-gray-50' : 'bg-white'
      } ${selected ? 'ring-2 ring-inset ring-jade-600/40' : ''}`}
    >
      <span className="flex items-center justify-between gap-1">
        <span
          className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs tabular-nums ${
            cell.isToday
              ? 'bg-jade-600 font-semibold text-white'
              : cell.inMonth
              ? 'font-medium text-gray-900'
              : 'text-gray-400'
          }`}
        >
          {cell.date.slice(8)}
        </span>
        {noteCount > 0 && (
          <span className="inline-flex items-center gap-0.5 text-[10px] text-gray-500">
            <StickyNote size={11} />
            {noteCount}
          </span>
        )}
      </span>

      {shown.map((ev) => (
        <span
          key={ev.id}
          className={`truncate rounded px-1 py-0.5 text-[11px] ${
            ev.all_day
              ? 'bg-jade-50 text-jade-700 dark:text-jade-300'
              : 'bg-gray-100 text-gray-700'
          }`}
        >
          {ev.all_day ? ev.title : `${clockOf(ev.starts_at) ?? ''} ${ev.title}`}
        </span>
      ))}
      {hidden > 0 && (
        <span className="px-1 text-[10px] text-gray-500">+{hidden} more</span>
      )}

      {away.length > 0 && (
        <span className="mt-auto flex items-start gap-1 truncate px-1 pt-0.5 text-[10px] text-amber-700">
          <TriangleAlert size={10} className="mt-[3px] shrink-0" />
          <span className="truncate">
            {away.slice(0, 2).join(', ')}
            {away.length > 2 ? ` +${away.length - 2}` : ''} away
          </span>
        </span>
      )}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Week
// ---------------------------------------------------------------------------

function WeekView({
  cells,
  selected,
  eventsByDate,
  notesByDate,
  awayByDate,
  onPickDay,
}: {
  cells: MonthCell[]
  selected: string
  eventsByDate: Map<string, CalendarEvent[]>
  notesByDate: Map<string, CalendarNote[]>
  awayByDate: Map<string, string[]>
  onPickDay: (iso: string) => void
}) {
  if (cells.length === 0) return null

  return (
    // One markup, two shapes: a stack of days on a phone, seven columns from
    // `sm` up. Nothing is duplicated and nothing scrolls sideways.
    <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-7 sm:gap-2">
      {cells.map((cell) => {
        const events = eventsByDate.get(cell.date) ?? []
        const noteCount = notesByDate.get(cell.date)?.length ?? 0
        const away = awayByDate.get(cell.date) ?? []
        return (
          <section
            key={cell.date}
            className={`flex min-w-0 flex-col rounded-xl border p-2 ${
              // Saturday and Sunday are quieter: still there, still clickable,
              // but visibly not part of the working week.
              cell.isWeekend
                ? 'border-gray-200 bg-gray-50'
                : 'border-gray-200 bg-white'
            } ${cell.date === selected ? 'ring-2 ring-inset ring-jade-600/40' : ''}`}
          >
            <button
              type="button"
              onClick={() => onPickDay(cell.date)}
              aria-label={`Open ${dayText(cell.date, LONG_DATE)}`}
              aria-current={cell.isToday ? 'date' : undefined}
              className="flex items-center justify-between gap-2 rounded-lg px-1 py-1 text-left transition-colors hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40"
            >
              <span className="min-w-0">
                <span className="block text-xs font-medium text-gray-500">
                  {dayText(cell.date, { weekday: 'short' })}
                </span>
                <span
                  className={`mt-0.5 inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-sm tabular-nums ${
                    cell.isToday
                      ? 'bg-jade-600 font-semibold text-white'
                      : 'font-medium text-gray-900'
                  }`}
                >
                  {cell.date.slice(8)}
                </span>
              </span>
              {noteCount > 0 && (
                <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-gray-500">
                  <StickyNote size={11} />
                  {noteCount}
                </span>
              )}
            </button>

            {away.length > 0 && (
              <p className="mt-1 flex items-start gap-1 px-1 text-[11px] text-amber-700">
                <TriangleAlert size={11} className="mt-[3px] shrink-0" />
                <span className="min-w-0">{away.join(', ')} away</span>
              </p>
            )}

            <ul className="mt-1.5 space-y-1">
              {events.map((ev) => (
                <li
                  key={ev.id}
                  className={`rounded px-1.5 py-1 text-[11px] ${
                    ev.all_day
                      ? 'bg-jade-50 text-jade-700 dark:text-jade-300'
                      : 'bg-gray-100 text-gray-700'
                  }`}
                >
                  <span className="block font-medium">{ev.title}</span>
                  <span className="block opacity-80">{eventTimeLabel(ev)}</span>
                </li>
              ))}
            </ul>

            {events.length === 0 && away.length === 0 && (
              <p className="mt-1.5 px-1 text-[11px] text-gray-400">Clear</p>
            )}
          </section>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Day
// ---------------------------------------------------------------------------

function DayView({
  date,
  today,
  events,
  notes,
  away,
  profileId,
  myStaffId,
  isAdmin,
  nameForProfile,
  onEdit,
  onNew,
  onDelete,
  onRespond,
  onAddNote,
  onUpdateNote,
  onDeleteNote,
}: {
  date: string
  today: string
  events: CalendarEvent[]
  notes: CalendarNote[]
  away: string[]
  profileId: string | null
  myStaffId: string | null
  isAdmin: boolean
  nameForProfile: (id: string | null) => string | null
  onEdit: (ev: CalendarEvent) => void
  onNew: () => void
  onDelete: (ev: CalendarEvent) => Promise<void>
  onRespond: (ev: CalendarEvent, response: AttendeeResponse) => Promise<void>
  onAddNote: (date: string, body: string, isPrivate: boolean) => Promise<void>
  onUpdateNote: (
    note: CalendarNote,
    body: string,
    isPrivate: boolean,
  ) => Promise<void>
  onDeleteNote: (note: CalendarNote) => Promise<void>
}) {
  return (
    <div className="mt-4 space-y-4">
      {away.length > 0 && (
        <section className="flex flex-wrap items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" />
          <p className="min-w-0 flex-1">
            {away.length === 1
              ? `${away[0]} is recorded away`
              : `${away.join(', ')} are recorded away`}{' '}
            {date === today ? 'today' : `on ${shortDate(date)}`}.
          </p>
        </section>
      )}

      <section className="rounded-xl border border-gray-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-gray-900">
              {dayText(date, LONG_DATE)}
            </h2>
            <p className="mt-0.5 text-xs text-gray-500">
              {events.length === 0
                ? 'Nothing booked'
                : `${events.length} ${events.length === 1 ? 'event' : 'events'}`}
              {date === today && ' · today in Mauritius'}
            </p>
          </div>
          <button onClick={onNew} className={BTN_QUIET}>
            <Plus size={15} />
            Add an event
          </button>
        </div>

        {events.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-10 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-jade-50 text-jade-700 dark:text-jade-300">
              <CalendarDays size={26} />
            </div>
            <p className="mt-3 text-sm font-medium text-gray-900">
              A clear day
            </p>
            <p className="mt-1 max-w-sm text-sm text-gray-500">
              Nothing is booked. Anything added here shows up on the month and
              week views straight away.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {events.map((ev) => (
              <EventRow
                key={ev.id}
                event={ev}
                profileId={profileId}
                myStaffId={myStaffId}
                isAdmin={isAdmin}
                onEdit={() => onEdit(ev)}
                onDelete={() => onDelete(ev)}
                onRespond={(r) => onRespond(ev, r)}
              />
            ))}
          </ul>
        )}
      </section>

      <NotesSection
        date={date}
        notes={notes}
        profileId={profileId}
        nameForProfile={nameForProfile}
        onAdd={onAddNote}
        onUpdate={onUpdateNote}
        onDelete={onDeleteNote}
      />
    </div>
  )
}

const RESPONSE_META: Record<
  AttendeeResponse,
  { label: string; chip: string }
> = {
  accepted: {
    label: 'Coming',
    chip: 'border-gray-200 bg-jade-50 text-jade-700 dark:text-jade-300',
  },
  declined: {
    label: 'Not coming',
    chip: 'border-gray-200 bg-gray-100 text-gray-500 line-through',
  },
  pending: {
    label: 'No answer yet',
    chip: 'border-gray-200 bg-gray-100 text-gray-600',
  },
}

function EventRow({
  event,
  profileId,
  myStaffId,
  isAdmin,
  onEdit,
  onDelete,
  onRespond,
}: {
  event: CalendarEvent
  profileId: string | null
  myStaffId: string | null
  isAdmin: boolean
  onEdit: () => void
  onDelete: () => Promise<void>
  onRespond: (response: AttendeeResponse) => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState<'delete' | AttendeeResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // Exactly the rule the presence board uses for its admin tools: the role on
  // the signed-in profile, and nothing else. Ownership is the profile that
  // created the event.
  const mine = !!profileId && event.created_by_profile_id === profileId
  const canEdit = mine || isAdmin

  const myInvite = myStaffId
    ? event.attendees.find((a) => a.staff_id === myStaffId) ?? null
    : null

  async function run(kind: 'delete' | AttendeeResponse, action: () => Promise<void>) {
    setBusy(kind)
    setErr(null)
    try {
      await action()
    } catch (e) {
      setErr(errMessage(e, 'That did not work. Please try again.'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900">{event.title}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-gray-500">
            <span className="inline-flex items-center gap-1">
              <Clock size={12} className="shrink-0" />
              {eventTimeLabel(event)}
            </span>
            {event.location && (
              <span className="inline-flex items-center gap-1">
                <MapPin size={12} className="shrink-0" />
                {event.location}
              </span>
            )}
          </p>
          {event.description && (
            <p className="mt-2 whitespace-pre-wrap rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600">
              {event.description}
            </p>
          )}
        </div>

        {canEdit && (
          <div className="flex shrink-0 flex-wrap gap-2">
            <button onClick={onEdit} className={BTN_SMALL}>
              Edit
            </button>
            {confirming ? (
              <>
                <button
                  onClick={() => {
                    setConfirming(false)
                    run('delete', onDelete)
                  }}
                  disabled={busy !== null}
                  className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg border border-red-200 bg-white px-2.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40 disabled:opacity-60"
                >
                  {busy === 'delete' && (
                    <Loader2 size={13} className="animate-spin" />
                  )}
                  Delete it?
                </button>
                <button
                  onClick={() => setConfirming(false)}
                  className={BTN_SMALL}
                >
                  Keep
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirming(true)}
                disabled={busy !== null}
                className={BTN_SMALL}
              >
                Delete
              </button>
            )}
          </div>
        )}
      </div>

      {event.attendees.length > 0 && (
        <div className="mt-2">
          <p className="flex items-center gap-1.5 text-xs text-gray-500">
            <UsersIcon size={12} className="shrink-0" />
            {event.attendees.length === 1 ? '1 person' : `${event.attendees.length} people`}
          </p>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {event.attendees.map((a) => (
              <li
                key={a.staff_id}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
                  RESPONSE_META[a.response].chip
                }`}
                title={RESPONSE_META[a.response].label}
              >
                {a.response === 'accepted' && <Check size={11} />}
                {a.response === 'declined' && <X size={11} />}
                {attendeeName(a)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* An invitee who does not own the event answers instead of editing it. */}
      {myInvite && !canEdit && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-500">
            {myInvite.response === 'pending'
              ? 'You are invited.'
              : myInvite.response === 'accepted'
              ? 'You said you are coming.'
              : 'You said you are not coming.'}
          </span>
          <button
            onClick={() => run('accepted', () => onRespond('accepted'))}
            disabled={busy !== null || myInvite.response === 'accepted'}
            className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg bg-jade-600 px-2.5 text-xs font-medium text-white transition-colors hover:bg-jade-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40 disabled:opacity-60"
          >
            {busy === 'accepted' && <Loader2 size={13} className="animate-spin" />}
            Accept
          </button>
          <button
            onClick={() => run('declined', () => onRespond('declined'))}
            disabled={busy !== null || myInvite.response === 'declined'}
            className={BTN_SMALL}
          >
            {busy === 'declined' && <Loader2 size={13} className="animate-spin" />}
            Decline
          </button>
        </div>
      )}

      {err && <p className="mt-2 text-xs text-red-700">{err}</p>}
    </li>
  )
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

function NotesSection({
  date,
  notes,
  profileId,
  nameForProfile,
  onAdd,
  onUpdate,
  onDelete,
}: {
  date: string
  notes: CalendarNote[]
  profileId: string | null
  nameForProfile: (id: string | null) => string | null
  onAdd: (date: string, body: string, isPrivate: boolean) => Promise<void>
  onUpdate: (
    note: CalendarNote,
    body: string,
    isPrivate: boolean,
  ) => Promise<void>
  onDelete: (note: CalendarNote) => Promise<void>
}) {
  const bodyId = useId()

  const [body, setBody] = useState('')
  const [isPrivate, setIsPrivate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    const text = body.trim()
    if (!text) {
      setErr('Write something first.')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      await onAdd(date, text, isPrivate)
      setBody('')
      // The visibility choice deliberately resets to shared. A private note is
      // a decision made about one note, not a mode the page stays in.
      setIsPrivate(false)
    } catch (e) {
      setErr(errMessage(e, 'Could not save that note.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white">
      <div className="border-b border-gray-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-gray-900">Notes</h2>
        <p className="mt-0.5 text-xs text-gray-500">
          Anything worth remembering about this day. Notes are shared with
          everyone unless you say otherwise.
        </p>
      </div>

      {notes.length > 0 && (
        <ul className="divide-y divide-gray-100">
          {notes.map((n) => (
            <NoteRow
              key={n.id}
              note={n}
              mine={!!profileId && n.created_by_profile_id === profileId}
              authorName={nameForProfile(n.created_by_profile_id)}
              onUpdate={onUpdate}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}

      <form onSubmit={submit} className="p-4">
        <label htmlFor={bodyId} className="block">
          <span className={LABEL_CLASS}>
            {notes.length > 0 ? 'Add another note' : 'Add a note'}
          </span>
          <textarea
            id={bodyId}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={2}
            placeholder="e.g. Valuation due back from the bank"
            disabled={busy}
            className={INPUT_CLASS}
          />
        </label>

        <VisibilityChoice
          isPrivate={isPrivate}
          disabled={busy}
          onChange={setIsPrivate}
        />

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="submit" disabled={busy} className={BTN_PRIMARY}>
            {busy && <Loader2 size={15} className="animate-spin" />}
            Save note
          </button>
          {err && <span className="text-xs text-red-700">{err}</span>}
        </div>
      </form>
    </section>
  )
}

/**
 * Shared or private, as two radio buttons that are both always on screen.
 *
 * NOT a checkbox labelled "private": with a checkbox, "shared" is the absence
 * of a mark, and the one mistake that actually matters here is writing
 * something personal into a note that everybody can read while believing the
 * opposite. Two visible options mean the state is always spelled out in words,
 * shared is the one selected by default, and the selected option says which it
 * is rather than leaving it to be inferred.
 */
function VisibilityChoice({
  isPrivate,
  disabled,
  onChange,
}: {
  isPrivate: boolean
  disabled: boolean
  onChange: (next: boolean) => void
}) {
  const name = useId()
  return (
    <fieldset className="mt-3" disabled={disabled}>
      <legend className={LABEL_CLASS}>Who can see this?</legend>
      <div className="flex flex-wrap gap-2">
        {[
          { value: false, label: 'Shared with everyone' },
          { value: true, label: 'Private to me' },
        ].map((opt) => {
          const active = opt.value === isPrivate
          return (
            <label
              key={String(opt.value)}
              className={`inline-flex min-h-[38px] cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors focus-within:ring-2 focus-within:ring-jade-600/40 ${
                active
                  ? 'border-jade-600 bg-jade-50 text-jade-700 dark:text-jade-300'
                  : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
              }`}
            >
              <input
                type="radio"
                name={name}
                checked={active}
                onChange={() => onChange(opt.value)}
                className="h-4 w-4 accent-jade-600"
              />
              {opt.value && <Lock size={13} className="shrink-0" />}
              {opt.label}
            </label>
          )
        })}
      </div>
      {isPrivate && (
        <p className="mt-1.5 text-xs text-gray-500">
          Only you will see this note.
        </p>
      )}
    </fieldset>
  )
}

function NoteRow({
  note,
  mine,
  authorName,
  onUpdate,
  onDelete,
}: {
  note: CalendarNote
  mine: boolean
  authorName: string | null
  onUpdate: (
    note: CalendarNote,
    body: string,
    isPrivate: boolean,
  ) => Promise<void>
  onDelete: (note: CalendarNote) => Promise<void>
}) {
  const bodyId = useId()

  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(note.body)
  const [isPrivate, setIsPrivate] = useState(note.is_private)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function run(kind: 'save' | 'delete', action: () => Promise<void>) {
    setBusy(kind)
    setErr(null)
    try {
      await action()
    } catch (e) {
      setErr(errMessage(e, 'That did not work. Please try again.'))
    } finally {
      setBusy(null)
    }
  }

  function save(e: FormEvent) {
    e.preventDefault()
    const text = body.trim()
    if (!text) {
      setErr('A note cannot be empty. Delete it instead.')
      return
    }
    run('save', async () => {
      await onUpdate(note, text, isPrivate)
      setEditing(false)
    })
  }

  if (editing) {
    return (
      <li className="bg-gray-50 px-4 py-3">
        <form onSubmit={save}>
          <label htmlFor={bodyId} className="block">
            <span className={LABEL_CLASS}>Note</span>
            <textarea
              id={bodyId}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={2}
              disabled={busy !== null}
              className={INPUT_CLASS}
            />
          </label>

          <VisibilityChoice
            isPrivate={isPrivate}
            disabled={busy !== null}
            onChange={setIsPrivate}
          />

          <div className="mt-3 flex flex-wrap gap-2">
            <button type="submit" disabled={busy !== null} className={BTN_PRIMARY}>
              {busy === 'save' && <Loader2 size={15} className="animate-spin" />}
              Save changes
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false)
                setBody(note.body)
                setIsPrivate(note.is_private)
                setErr(null)
              }}
              className={BTN_QUIET}
            >
              Cancel
            </button>
          </div>

          {err && <p className="mt-2 text-xs text-red-700">{err}</p>}
        </form>
      </li>
    )
  }

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-wrap text-sm text-gray-900">{note.body}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-400">
            <span>{mine ? 'You' : authorName ?? 'Someone'}</span>
            {note.is_private && (
              <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 font-medium text-gray-600">
                <Lock size={11} />
                Private
              </span>
            )}
          </p>
        </div>

        {mine && (
          <div className="flex shrink-0 flex-wrap gap-2">
            <button onClick={() => setEditing(true)} className={BTN_SMALL}>
              Edit
            </button>
            {confirming ? (
              <>
                <button
                  onClick={() => {
                    setConfirming(false)
                    run('delete', () => onDelete(note))
                  }}
                  disabled={busy !== null}
                  className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg border border-red-200 bg-white px-2.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40 disabled:opacity-60"
                >
                  {busy === 'delete' && (
                    <Loader2 size={13} className="animate-spin" />
                  )}
                  Delete it?
                </button>
                <button onClick={() => setConfirming(false)} className={BTN_SMALL}>
                  Keep
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirming(true)}
                disabled={busy !== null}
                className={BTN_SMALL}
              >
                Delete
              </button>
            )}
          </div>
        )}
      </div>

      {err && <p className="mt-2 text-xs text-red-700">{err}</p>}
    </li>
  )
}

// ---------------------------------------------------------------------------
// Event editor
// ---------------------------------------------------------------------------

const DEFAULT_START = '09:00'
const DEFAULT_END = '10:00'

/**
 * Build the instants to store from what is on the form.
 *
 * All-day runs from midnight on the first day to midnight after the last, which
 * is the half-open range the rest of the calendar assumes: a one-day all-day
 * event touches one day, not two. Timed events live inside a single Mauritius
 * date — see the note on the form itself.
 *
 * Returns empty strings rather than null for anything unreadable, so
 * `validateEvent` is the single place that decides what is wrong and says so.
 */
function buildRange(fields: {
  allDay: boolean
  date: string
  endDate: string
  startTime: string
  endTime: string
}): { startsAt: string; endsAt: string } {
  if (fields.allDay) {
    const last = fields.endDate || fields.date
    return {
      startsAt: mauritiusToInstant(fields.date, '00:00') ?? '',
      endsAt: mauritiusToInstant(addDays(last, 1), '00:00') ?? '',
    }
  }
  return {
    startsAt: mauritiusToInstant(fields.date, fields.startTime) ?? '',
    endsAt: mauritiusToInstant(fields.date, fields.endTime) ?? '',
  }
}

function EventEditor({
  target,
  roster,
  onCancel,
  onSave,
}: {
  target: EditorTarget
  roster: StaffMember[] | null
  onCancel: () => void
  onSave: (target: EditorTarget, input: CalendarEventInput) => Promise<void>
}) {
  const ids = {
    title: useId(),
    description: useId(),
    date: useId(),
    endDate: useId(),
    start: useId(),
    end: useId(),
    location: useId(),
    filter: useId(),
  }

  const existing = target.event
  const startParts = existing ? toMauritiusParts(existing.starts_at) : null
  const endParts = existing ? toMauritiusParts(existing.ends_at) : null

  const [title, setTitle] = useState(existing?.title ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [location, setLocation] = useState(existing?.location ?? '')
  const [allDay, setAllDay] = useState(existing?.all_day ?? false)
  const [date, setDate] = useState(startParts?.date ?? target.date)
  const [endDate, setEndDate] = useState(() => {
    if (!existing?.all_day) return startParts?.date ?? target.date
    // Stored all-day ranges end at midnight AFTER the last day, so the last day
    // a person would name is the day before the stored end.
    const storedEnd = endParts?.date ?? startParts?.date ?? target.date
    return addDays(storedEnd, -1)
  })
  const [startTime, setStartTime] = useState(
    existing && !existing.all_day
      ? startParts?.time.slice(0, 5) ?? DEFAULT_START
      : DEFAULT_START,
  )
  const [endTime, setEndTime] = useState(
    existing && !existing.all_day
      ? endParts?.time.slice(0, 5) ?? DEFAULT_END
      : DEFAULT_END,
  )
  const [staffIds, setStaffIds] = useState<string[]>(
    existing ? existing.attendees.map((a) => a.staff_id) : [],
  )
  const [filter, setFilter] = useState('')

  const [busy, setBusy] = useState(false)
  const [problems, setProblems] = useState<string[]>([])

  const range = useMemo(
    () => buildRange({ allDay, date, endDate, startTime, endTime }),
    [allDay, date, endDate, startTime, endTime],
  )

  // --- the whole point of this page ---------------------------------------
  //
  // Who among the invitees is recorded away on a day this meeting touches. The
  // board is read here rather than reused from the page, because the event may
  // well be outside the range currently on screen.

  const days = useMemo(() => datesTouched(range), [range])
  const from = days[0] ?? ''
  const to = days[days.length - 1] ?? ''
  const hasAttendees = staffIds.length > 0

  const [absences, setAbsences] = useState<Record<string, string[]>>({})
  const [absencesLoading, setAbsencesLoading] = useState(false)
  const [absencesError, setAbsencesError] = useState<string | null>(null)

  useEffect(() => {
    if (!from || !to || !hasAttendees) {
      setAbsences({})
      setAbsencesError(null)
      setAbsencesLoading(false)
      return
    }
    let alive = true
    setAbsencesLoading(true)
    setAbsencesError(null)
    // Typing in a time field walks through a dozen intermediate values; this
    // waits for the fingers to stop rather than firing a request per keystroke.
    const timer = window.setTimeout(() => {
      fetchAbsencesByStaff(from, to)
        .then((next) => {
          if (alive) setAbsences(next)
        })
        .catch((e) => {
          if (!alive) return
          setAbsences({})
          setAbsencesError(
            errMessage(e, 'Could not check who is away on those dates.'),
          )
        })
        .finally(() => {
          if (alive) setAbsencesLoading(false)
        })
    }, 250)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [from, to, hasAttendees])

  const conflicts = useMemo(
    () => attendeeConflicts(staffIds, absences, range),
    [staffIds, absences, range],
  )

  const memberById = useMemo(
    () => new Map((roster ?? []).map((m) => [m.id, m])),
    [roster],
  )

  const pickable = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (roster ?? []).filter((m) => {
      // Somebody already invited stays in the list even if they later went
      // inactive, otherwise editing an old meeting would silently drop them.
      if (!m.active && !staffIds.includes(m.id)) return false
      if (!q) return true
      return (
        m.full_name.toLowerCase().includes(q) ||
        m.known_as.toLowerCase().includes(q) ||
        (m.department ?? '').toLowerCase().includes(q)
      )
    })
  }, [roster, filter, staffIds])

  function toggleAttendee(id: string) {
    setStaffIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return

    // The same validator the backend uses, so the wording of a rejection is the
    // same wherever it comes from. Absence clashes are NOT part of this: they
    // are a warning, and the form saves straight through them.
    const check = validateEvent({
      title,
      startsAt: range.startsAt,
      endsAt: range.endsAt,
      allDay,
    })
    if (!check.ok) {
      setProblems(check.errors)
      return
    }

    setProblems([])
    setBusy(true)
    try {
      await onSave(target, {
        title: title.trim(),
        // null, not undefined: emptying the field has to clear the column, and
        // an absent key would leave whatever was there before.
        description: description.trim() || null,
        starts_at: range.startsAt,
        ends_at: range.endsAt,
        all_day: allDay,
        location: location.trim() || null,
        attendeeStaffIds: staffIds,
      })
    } catch (e) {
      setProblems([errMessage(e, 'Could not save that event.')])
      setBusy(false)
    }
  }

  return (
    <section className="mt-4 rounded-xl border border-gray-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-900">
            {existing ? 'Edit event' : 'New event'}
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Times are Mauritius time. Whoever you invite is checked against the
            presence board as you go.
          </p>
        </div>
        <button
          onClick={onCancel}
          aria-label="Close the event editor"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40"
        >
          <X size={16} />
        </button>
      </div>

      <form onSubmit={submit} className="p-4">
        {problems.length > 0 && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
            <div className="flex items-start gap-2">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <div className="min-w-0">
                {problems.length === 1 ? (
                  <p>{problems[0]}</p>
                ) : (
                  <>
                    <p className="font-medium">
                      Please fix {problems.length} things:
                    </p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {problems.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        <label htmlFor={ids.title} className="block">
          <span className={LABEL_CLASS}>Title</span>
          <input
            id={ids.title}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Site visit — Grand Baie"
            disabled={busy}
            className={INPUT_CLASS}
          />
        </label>

        <label htmlFor={ids.description} className="mt-3 block">
          <span className={LABEL_CLASS}>Description (optional)</span>
          <textarea
            id={ids.description}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Anything the people coming should know"
            disabled={busy}
            className={INPUT_CLASS}
          />
        </label>

        <label className="mt-3 inline-flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={allDay}
            onChange={(e) => {
              setAllDay(e.target.checked)
              if (e.target.checked && endDate < date) setEndDate(date)
            }}
            disabled={busy}
            className="h-4 w-4 rounded border-gray-300 accent-jade-600"
          />
          All day
        </label>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label htmlFor={ids.date} className="block">
            <span className={LABEL_CLASS}>{allDay ? 'First day' : 'Date'}</span>
            <input
              id={ids.date}
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value)
                if (e.target.value && endDate < e.target.value) {
                  setEndDate(e.target.value)
                }
              }}
              disabled={busy}
              className={INPUT_CLASS}
            />
          </label>

          {allDay ? (
            <label htmlFor={ids.endDate} className="block">
              <span className={LABEL_CLASS}>Last day</span>
              <input
                id={ids.endDate}
                type="date"
                value={endDate}
                min={date}
                onChange={(e) => setEndDate(e.target.value)}
                disabled={busy}
                className={INPUT_CLASS}
              />
            </label>
          ) : (
            <>
              <label htmlFor={ids.start} className="block">
                <span className={LABEL_CLASS}>Starts</span>
                <input
                  id={ids.start}
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  disabled={busy}
                  className={INPUT_CLASS}
                />
              </label>
              <label htmlFor={ids.end} className="block">
                <span className={LABEL_CLASS}>Ends</span>
                <input
                  id={ids.end}
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  disabled={busy}
                  className={INPUT_CLASS}
                />
              </label>
            </>
          )}
        </div>

        <label htmlFor={ids.location} className="mt-3 block">
          <span className={LABEL_CLASS}>Location (optional)</span>
          <input
            id={ids.location}
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="e.g. Boardroom"
            disabled={busy}
            className={INPUT_CLASS}
          />
        </label>

        {/* Attendees */}
        <fieldset className="mt-4">
          <legend className={LABEL_CLASS}>
            Who is coming{staffIds.length > 0 ? ` (${staffIds.length})` : ''}
          </legend>

          {roster === null ? (
            <p className="text-xs text-gray-400">Loading the roster…</p>
          ) : roster.length === 0 ? (
            <p className="text-xs text-gray-500">
              Nobody is on the staff roster yet, so there is no one to invite.
              The event can still be saved.
            </p>
          ) : (
            <>
              <label htmlFor={ids.filter} className="block">
                <span className="sr-only">Search the staff roster</span>
                <input
                  id={ids.filter}
                  type="search"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Search by name or department"
                  disabled={busy}
                  className={INPUT_CLASS}
                />
              </label>

              <div className="mt-2 max-h-52 overflow-y-auto rounded-lg border border-gray-200">
                {pickable.length === 0 ? (
                  <p className="px-3 py-3 text-xs text-gray-500">
                    Nobody matches “{filter.trim()}”.
                  </p>
                ) : (
                  <ul className="divide-y divide-gray-100">
                    {pickable.map((m) => (
                      <li key={m.id}>
                        <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 transition-colors hover:bg-gray-50">
                          <input
                            type="checkbox"
                            checked={staffIds.includes(m.id)}
                            onChange={() => toggleAttendee(m.id)}
                            disabled={busy}
                            className="h-4 w-4 shrink-0 rounded border-gray-300 accent-jade-600"
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-sm text-gray-900">
                              {m.full_name}
                              {!m.active && (
                                <span className="ml-1.5 text-xs text-gray-400">
                                  (inactive)
                                </span>
                              )}
                            </span>
                            {m.department && (
                              <span className="block truncate text-xs text-gray-500">
                                {m.department}
                              </span>
                            )}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </fieldset>

        {/* The absence warning. Never a blocker — see the file header. */}
        {hasAttendees && absencesLoading && (
          <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-gray-400">
            <Loader2 size={13} className="animate-spin" />
            Checking who is away…
          </p>
        )}

        {hasAttendees && absencesError && (
          <p className="mt-3 text-xs text-gray-500">
            {absencesError} You can still save — nobody has been checked against
            the presence board.
          </p>
        )}

        {conflicts.length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-700">
            <div className="flex items-start gap-2">
              <TriangleAlert size={16} className="mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="font-medium">
                  {conflicts.length === 1
                    ? 'Someone you have invited is away'
                    : `${conflicts.length} people you have invited are away`}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {conflicts.map((c) => {
                    const m = memberById.get(c.staffId)
                    return (
                      <li key={c.staffId}>
                        {m ? memberName(m) : 'Someone'} is recorded away on{' '}
                        {dateListText(c.dates)}.
                      </li>
                    )
                  })}
                </ul>
                <p className="mt-1.5 text-xs">
                  The board records what the office was told, and it can be
                  wrong. Save anyway if you know better.
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <button type="submit" disabled={busy} className={BTN_PRIMARY}>
            {busy ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <Check size={15} />
            )}
            {existing ? 'Save changes' : 'Add to calendar'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className={BTN_QUIET}
          >
            Cancel
          </button>
        </div>
      </form>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function CalendarSkeleton() {
  return (
    <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
      <div className="h-5 w-40 animate-pulse rounded-full bg-gray-100" />
      <div className="mt-4 grid grid-cols-7 gap-1.5">
        {Array.from({ length: 21 }).map((_, i) => (
          <div key={i} className="h-14 animate-pulse rounded bg-gray-100" />
        ))}
      </div>
    </div>
  )
}
