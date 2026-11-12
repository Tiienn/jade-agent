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
  CalendarCheck, // "nothing waiting on you"
  Check, // decision recorded
  Inbox, // no requests of your own yet
  Loader2,
  Send,
  TriangleAlert, // overlap warnings
  UserCog, // "your login is not on the roster"
  X,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import {
  cancelLeave,
  datesBetween,
  decideLeave,
  fetchLeaveRequests,
  fetchStaffRecords,
  LeaveApiError,
  submitLeave,
  workingDays,
  type DecideLeaveResult,
  type LeaveDayPart,
  type LeaveRequest,
  type LeaveStatus,
  type LeaveType,
  type StaffRecord,
  type SubmitLeaveResult,
} from '../lib/leaveApi'
import {
  addDays,
  fetchPresence,
  mauritiusToday,
  type PresenceRow,
} from '../lib/presenceApi'

// ---------------------------------------------------------------------------
// Presentation of the two enums
// ---------------------------------------------------------------------------

/** Written the way the office writes them, not the way the column spells them. */
const TYPE_LABEL: Record<LeaveType, string> = {
  sick: 'Sick leave',
  local_leave: 'Local leave',
  vacation_leave: 'Vacation leave',
  permission: 'Permission',
}

/** The order the request form offers them in: commonest first. */
const TYPE_ORDER = Object.keys(TYPE_LABEL) as LeaveType[]

interface StatusMeta {
  label: string
  chip: string
}

/*
 * Colour carries meaning and nothing else, exactly as on the presence board:
 * amber for "somebody still has to act", jade for settled and agreed, red for
 * refused, plain grey for withdrawn. Only the jade tint needs a `dark:`
 * variant — the neutral, amber and red ramps are re-mapped under `.dark` in
 * index.css and flip on their own.
 */
const STATUS_META: Record<LeaveStatus, StatusMeta> = {
  pending: {
    label: 'Pending',
    chip: 'border-amber-200 bg-amber-50 text-amber-700',
  },
  approved: {
    label: 'Approved',
    chip: 'border-gray-200 bg-jade-50 text-jade-700 dark:text-jade-300',
  },
  declined: {
    label: 'Declined',
    chip: 'border-red-200 bg-red-50 text-red-700',
  },
  cancelled: {
    label: 'Cancelled',
    chip: 'border-gray-200 bg-gray-100 text-gray-600',
  },
}

const DAY_PART_LABEL: Record<LeaveDayPart, string> = {
  full: 'Full day',
  am: 'Morning only',
  pm: 'Afternoon only',
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` is a calendar date, not an instant — parse and format it as UTC
 * so the browser's timezone cannot shift it by a day. */
function dayText(iso: string, opts: Intl.DateTimeFormatOptions): string {
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' })
}

/** "Wed 12 Aug 2026", or "12 Aug – 16 Aug 2026" for a range. */
function rangeText(start: string, end: string): string {
  if (start === end) {
    return dayText(start, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })
  }
  return `${dayText(start, { day: 'numeric', month: 'short' })} – ${dayText(end, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })}`
}

/** A timestamp, shown as the day it happened. */
function stampText(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

/** "1 working day" / "3.5 working days" / "0 working days". */
function daysText(count: number): string {
  const n = Number.isInteger(count) ? String(count) : count.toFixed(1)
  return `${n} working day${count === 1 ? '' : 's'}`
}

/** "12, 13 and 16 Aug" — dates a reader can check against their own calendar. */
function dateListText(days: string[]): string {
  const parts = days.map((d) => dayText(d, { day: 'numeric', month: 'short' }))
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

function errMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-jade-600 focus:ring-2 focus:ring-jade-600/20 disabled:opacity-60'

const BTN_PRIMARY =
  'inline-flex min-h-[38px] items-center justify-center gap-1.5 rounded-lg bg-jade-600 px-3.5 text-sm font-medium text-white transition-colors hover:bg-jade-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40 disabled:opacity-60'

const BTN_QUIET =
  'inline-flex min-h-[38px] items-center justify-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40 disabled:opacity-60'

const BTN_DANGER =
  'inline-flex min-h-[38px] items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-white px-3.5 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40 disabled:opacity-60'

const LABEL_CLASS = 'mb-1 block text-xs font-medium text-gray-700'

type Tab = 'request' | 'mine' | 'queue'

/** What a decision did, kept after the request has left the queue so the
 * confirmation — and the reminder that nothing was sent — does not vanish the
 * instant the list refreshes. */
interface Outcome {
  requestId: string
  who: string
  decision: 'approved' | 'declined'
  result: DecideLeaveResult
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Leave() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'

  const [staff, setStaff] = useState<StaffRecord[] | null>(null)
  const [requests, setRequests] = useState<LeaveRequest[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [tab, setTab] = useState<Tab>('request')
  /** Set once the user picks a tab themselves, so the queue is only ever
   * auto-opened on the first load and never yanks them away later. */
  const tabPicked = useRef(false)

  const [outcomes, setOutcomes] = useState<Outcome[]>([])
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

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [nextStaff, nextRequests] = await Promise.all([
        fetchStaffRecords(),
        fetchLeaveRequests(),
      ])
      setStaff(nextStaff)
      setRequests(nextRequests)
    } catch (e) {
      setStaff(null)
      setRequests(null)
      setError(errMessage(e, 'Could not load leave requests.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  /** Reload after a mutation without flashing the whole page back to skeletons. */
  const refresh = useCallback(async () => {
    try {
      setRequests(await fetchLeaveRequests())
    } catch (e) {
      setError(errMessage(e, 'Could not refresh leave requests.'))
    }
  }, [])

  // --- derived ------------------------------------------------------------

  const byStaffId = useMemo(
    () => new Map((staff ?? []).map((s) => [s.id, s])),
    [staff],
  )
  const byProfileId = useMemo(
    () =>
      new Map(
        (staff ?? [])
          .filter((s) => s.profile_id)
          .map((s) => [s.profile_id as string, s]),
      ),
    [staff],
  )

  /** The roster row this login is linked to, if any. Most logins are not
   * linked yet — that is the common case, not an edge case. */
  const me = useMemo(
    () => (profile ? (staff ?? []).find((s) => s.profile_id === profile.id) ?? null : null),
    [staff, profile],
  )
  // An inactive roster row cannot act: current_staff_id() in the database
  // filters on `active`, so the backend would refuse anyway. Say so instead of
  // offering a form that will fail.
  const myStaffId = me?.active ? me.id : null

  const mine = useMemo(() => {
    const all = requests ?? []
    return all
      .filter(
        (r) =>
          (myStaffId !== null && r.requester_staff_id === myStaffId) ||
          r.submitted_by_profile_id === profile?.id,
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
  }, [requests, myStaffId, profile?.id])

  /** Oldest first — the next thing in a queue is the one waiting longest. */
  const queue = useMemo(() => {
    const all = requests ?? []
    return all
      .filter(
        (r) =>
          r.status === 'pending' &&
          ((myStaffId !== null && r.approver_staff_id === myStaffId) ||
            // Requests with nobody to route to fall to the admins.
            (isAdmin && r.approver_staff_id === null)),
      )
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
  }, [requests, myStaffId, isAdmin])

  /** Managers and admins get the decision queue. A non-manager who somehow has
   * a request routed to them still gets it — otherwise it would be invisible
   * and undecidable. */
  const canDecide = isAdmin || !!me?.is_manager || queue.length > 0

  // Open a manager on their queue the first time the page loads with something
  // waiting. Only once, and never over a tab they chose themselves.
  useEffect(() => {
    if (loading || tabPicked.current) return
    if (queue.length > 0) {
      tabPicked.current = true
      setTab('queue')
    }
  }, [loading, queue.length])

  // Overlap context for the queue: which of the requested days already show an
  // absence on the board. Fetched for the span the queue covers, in one go.
  const [presence, setPresence] = useState<PresenceRow[]>([])
  const span = useMemo(() => {
    if (queue.length === 0) return null
    let from = queue[0].start_date
    let to = queue[0].end_date
    for (const r of queue) {
      if (r.start_date < from) from = r.start_date
      if (r.end_date > to) to = r.end_date
    }
    return { from, to }
  }, [queue])

  useEffect(() => {
    if (!span) {
      setPresence([])
      return
    }
    let live = true
    fetchPresence(span.from, span.to)
      .then((rows) => {
        if (live) setPresence(rows)
      })
      .catch(() => {
        // An overlap hint is extra context, not the decision itself. Losing it
        // must not turn a working queue into an error page — the card simply
        // shows no warning.
        if (live) setPresence([])
      })
    return () => {
      live = false
    }
  }, [span])

  const overlapsFor = useCallback(
    (request: LeaveRequest): string[] => {
      if (presence.length === 0) return []
      const taken = new Set(
        presence
          .filter((p) => p.staff_id === request.requester_staff_id)
          .map((p) => p.on_date),
      )
      return datesBetween(request.start_date, request.end_date).filter((d) =>
        taken.has(d),
      )
    },
    [presence],
  )

  const nameOf = useCallback(
    (staffId: string | null): string | null =>
      staffId ? byStaffId.get(staffId)?.full_name ?? null : null,
    [byStaffId],
  )

  /** Who decided, resolved through the roster. Non-admins cannot read other
   * people's `profiles` rows, so an unresolvable id simply goes unnamed rather
   * than showing a uuid. */
  const deciderName = useCallback(
    (profileId: string | null): string | null =>
      profileId ? byProfileId.get(profileId)?.full_name ?? null : null,
    [byProfileId],
  )

  // --- actions ------------------------------------------------------------

  const handleCancel = useCallback(
    async (request: LeaveRequest) => {
      const result = await cancelLeave(request.id)
      await refresh()
      showToast(
        result.presenceRowsRemoved > 0
          ? `Request cancelled. ${result.presenceRowsRemoved} day${
              result.presenceRowsRemoved === 1 ? '' : 's'
            } removed from the attendance board.`
          : 'Request cancelled.',
      )
    },
    [refresh, showToast],
  )

  const handleDecide = useCallback(
    async (
      request: LeaveRequest,
      decision: 'approved' | 'declined',
      note: string,
    ) => {
      const result = await decideLeave(request.id, decision, note)
      setOutcomes((prev) => [
        ...prev.filter((o) => o.requestId !== request.id),
        {
          requestId: request.id,
          who: nameOf(request.requester_staff_id) ?? 'this person',
          decision,
          result,
        },
      ])
      await refresh()
    },
    [nameOf, refresh],
  )

  const tabs: { value: Tab; label: string; count?: number }[] = [
    { value: 'request', label: 'Request leave' },
    { value: 'mine', label: 'My requests', count: mine.length },
    ...(canDecide
      ? [
          {
            value: 'queue' as Tab,
            label: 'Awaiting your decision',
            count: queue.length,
          },
        ]
      : []),
  ]

  return (
    <div className="mx-auto h-full w-full max-w-5xl overflow-y-auto p-4 sm:p-6">
      {/* Header */}
      <div className="mt-2 min-w-0">
        <h1 className="text-lg font-semibold text-gray-900">Leave</h1>
        <p className="mt-0.5 text-sm text-gray-500">
          Ask for time off, and see what has been decided. Approved leave shows
          up on the{' '}
          <Link
            to="/attendance"
            className="font-medium text-jade-700 underline-offset-2 hover:underline dark:text-jade-300"
          >
            attendance board
          </Link>
          .
        </p>
      </div>

      {/* Sections */}
      <div
        role="tablist"
        aria-label="Leave sections"
        className="mt-4 flex gap-2 overflow-x-auto pb-1"
      >
        {tabs.map((t) => {
          const active = tab === t.value
          return (
            <button
              key={t.value}
              role="tab"
              aria-selected={active}
              onClick={() => {
                tabPicked.current = true
                setTab(t.value)
              }}
              className={`inline-flex min-h-[38px] shrink-0 items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40 ${
                active
                  ? 'border-jade-600 bg-jade-600 text-white'
                  : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
              }`}
            >
              {t.label}
              {t.count !== undefined && t.count > 0 && (
                <span
                  className={`tabular-nums text-xs ${
                    active ? 'text-white/80' : 'text-gray-400'
                  }`}
                >
                  {t.count}
                </span>
              )}
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

      {toast && (
        <p className="mt-3 rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600">
          {toast}
        </p>
      )}

      {loading && <LeaveSkeleton />}

      {!loading && !error && tab === 'request' && (
        <RequestSection
          linked={myStaffId !== null}
          inactive={!!me && !me.active}
          isAdmin={isAdmin}
          onFiled={refresh}
        />
      )}

      {!loading && !error && tab === 'mine' && (
        <MyRequests
          requests={mine}
          myStaffId={myStaffId}
          nameOf={nameOf}
          deciderName={deciderName}
          onCancel={handleCancel}
        />
      )}

      {!loading && !error && tab === 'queue' && canDecide && (
        <DecisionQueue
          queue={queue}
          outcomes={outcomes}
          byStaffId={byStaffId}
          overlapsFor={overlapsFor}
          onDecide={handleDecide}
          onDismissOutcome={(id) =>
            setOutcomes((prev) => prev.filter((o) => o.requestId !== id))
          }
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 1 — Request leave
// ---------------------------------------------------------------------------

function RequestSection({
  linked,
  inactive,
  isAdmin,
  onFiled,
}: {
  linked: boolean
  inactive: boolean
  isAdmin: boolean
  onFiled: () => Promise<void>
}) {
  /** The backend is the authority on this, not the roster read: a link can be
   * made or removed while the page is open. Either source flipping it true
   * replaces the form with the explanation. */
  const [notOnRoster, setNotOnRoster] = useState(false)

  if (!linked || notOnRoster) {
    return <NotOnRoster inactive={inactive} isAdmin={isAdmin} />
  }

  return (
    <RequestForm
      onFiled={onFiled}
      onNotOnRoster={() => setNotOnRoster(true)}
    />
  )
}

function NotOnRoster({
  inactive,
  isAdmin,
}: {
  inactive: boolean
  isAdmin: boolean
}) {
  return (
    <section className="mt-4 rounded-xl border border-gray-200 bg-white px-4 py-8">
      <div className="mx-auto flex max-w-md flex-col items-center text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-100 text-gray-400">
          <UserCog size={26} />
        </div>
        <p className="mt-3 text-sm font-medium text-gray-900">
          {inactive
            ? 'Your staff record is not active'
            : 'Your login is not linked to a staff member yet'}
        </p>
        <p className="mt-1 text-sm text-gray-500">
          {inactive
            ? 'Leave is filed against an active person on the staff roster. An administrator can reactivate your record on the attendance board.'
            : 'Leave requests are routed to your department manager, and that comes from the staff roster — so your login has to be linked to your name there first. An administrator can do it in a couple of clicks.'}
        </p>
        <p className="mt-3 text-sm text-gray-500">
          Nothing is lost in the meantime: absences already announced by email
          still appear on the attendance board.
        </p>
        {isAdmin && (
          <Link
            to="/attendance"
            className={`mt-4 ${BTN_QUIET}`}
          >
            Open the staff roster
          </Link>
        )}
      </div>
    </section>
  )
}

function RequestForm({
  onFiled,
  onNotOnRoster,
}: {
  onFiled: () => Promise<void>
  onNotOnRoster: () => void
}) {
  const ids = {
    type: useId(),
    start: useId(),
    end: useId(),
    reason: useId(),
    part: useId(),
  }

  const today = mauritiusToday()

  const [leaveType, setLeaveType] = useState<LeaveType>('local_leave')
  const [startDate, setStartDate] = useState(today)
  const [endDate, setEndDate] = useState(today)
  const [dayPart, setDayPart] = useState<LeaveDayPart>('full')
  const [reason, setReason] = useState('')

  const [busy, setBusy] = useState(false)
  const [problems, setProblems] = useState<string[]>([])
  const [result, setResult] = useState<SubmitLeaveResult | null>(null)

  const singleDay = startDate !== '' && startDate === endDate
  // A half day is by definition one day — the backend rejects "AM, 12th to the
  // 16th" outright — so the choice is disabled rather than silently ignored,
  // and any half already picked reverts to a full day.
  useEffect(() => {
    if (!singleDay) setDayPart('full')
  }, [singleDay])

  /*
   * Sick leave is the one kind that is genuinely filed after the fact — you
   * ring in ill and put it in the app when you are back — so it may reach back
   * a month. Everything else is asked for in advance, and "today in Mauritius"
   * is the floor: the office lives on Mauritius time, not the timezone of
   * whatever laptop this is being typed on.
   */
  const minStart = leaveType === 'sick' ? addDays(today, -31) : today

  function keepDatesOrdered(nextStart: string, nextEnd: string) {
    setStartDate(nextStart)
    setEndDate(nextEnd < nextStart ? nextStart : nextEnd)
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setProblems([])
    setResult(null)

    // Cheap client-side checks. The server validates properly and reports
    // every problem at once; these two only exist so the obvious mistakes do
    // not need a round trip.
    const local: string[] = []
    if (!startDate || !endDate) local.push('Choose a start and an end date.')
    if (startDate && endDate && endDate < startDate) {
      local.push('The end date cannot be before the start date.')
    }
    if (local.length > 0) {
      setProblems(local)
      return
    }

    setBusy(true)
    try {
      const res = await submitLeave({
        leaveType,
        startDate,
        endDate,
        dayPart,
        reason: reason.trim() || undefined,
      })
      setResult(res)
      setReason('')
      await onFiled()
    } catch (e) {
      if (e instanceof LeaveApiError && e.code === 'not_on_roster') {
        onNotOnRoster()
        return
      }
      if (e instanceof LeaveApiError && e.errors.length > 0) {
        setProblems(e.errors)
        return
      }
      setProblems([errMessage(e, 'Could not file that leave request.')])
    } finally {
      setBusy(false)
    }
  }

  const days = workingDays(startDate, endDate, dayPart)

  return (
    <div className="mt-4 space-y-4">
      {result && <FiledNotice result={result} onDismiss={() => setResult(null)} />}

      <section className="rounded-xl border border-gray-200 bg-white">
        <div className="border-b border-gray-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">Request leave</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            It goes to your department manager to approve. Nothing reaches the
            attendance board until they do.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="p-4">
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

          <div className="grid gap-3 sm:grid-cols-3">
            <label htmlFor={ids.type} className="block sm:col-span-3">
              <span className={LABEL_CLASS}>Type of leave</span>
              <select
                id={ids.type}
                value={leaveType}
                onChange={(e) => setLeaveType(e.target.value as LeaveType)}
                disabled={busy}
                className={INPUT_CLASS}
              >
                {TYPE_ORDER.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>

            <label htmlFor={ids.start} className="block">
              <span className={LABEL_CLASS}>First day</span>
              <input
                id={ids.start}
                type="date"
                value={startDate}
                min={minStart}
                onChange={(e) => keepDatesOrdered(e.target.value, endDate)}
                disabled={busy}
                className={INPUT_CLASS}
              />
            </label>

            <label htmlFor={ids.end} className="block">
              <span className={LABEL_CLASS}>Last day</span>
              <input
                id={ids.end}
                type="date"
                value={endDate}
                min={startDate || minStart}
                onChange={(e) => setEndDate(e.target.value)}
                disabled={busy}
                className={INPUT_CLASS}
              />
            </label>

            <fieldset
              className="block"
              aria-describedby={singleDay ? undefined : `${ids.part}-hint`}
            >
              <legend className={LABEL_CLASS}>Half day</legend>
              <select
                id={ids.part}
                value={dayPart}
                onChange={(e) => setDayPart(e.target.value as LeaveDayPart)}
                disabled={busy || !singleDay}
                className={INPUT_CLASS}
              >
                {(Object.keys(DAY_PART_LABEL) as LeaveDayPart[]).map((p) => (
                  <option key={p} value={p}>
                    {DAY_PART_LABEL[p]}
                  </option>
                ))}
              </select>
              {!singleDay && (
                <span
                  id={`${ids.part}-hint`}
                  className="mt-1 block text-xs text-gray-400"
                >
                  Only for a single day.
                </span>
              )}
            </fieldset>
          </div>

          <label htmlFor={ids.reason} className="mt-3 block">
            <span className={LABEL_CLASS}>Reason (optional)</span>
            <textarea
              id={ids.reason}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="Anything your manager should know"
              disabled={busy}
              className={INPUT_CLASS}
            />
          </label>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="submit" disabled={busy} className={BTN_PRIMARY}>
              {busy ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Send size={15} />
              )}
              {busy ? 'Sending…' : 'Send request'}
            </button>
            <span className="text-xs text-gray-500">
              {rangeText(startDate, endDate)} · {daysText(days)}
            </span>
          </div>
        </form>
      </section>
    </div>
  )
}

/** What happened to the request just filed: who it went to, and any days that
 * already show an absence. */
function FiledNotice({
  result,
  onDismiss,
}: {
  result: SubmitLeaveResult
  onDismiss: () => void
}) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white">
      <div className="flex items-start gap-3 px-4 py-3">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-jade-50 text-jade-700 dark:text-jade-300">
          <Check size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-900">Request sent</p>
          <p className="mt-0.5 text-sm text-gray-500">
            {result.approverName
              ? `${result.approverName} will decide it.`
              : 'Nobody is set as your manager, so an administrator will decide it.'}
            {result.approverReason ? ` ${result.approverReason}` : ''}
          </p>
        </div>
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40"
        >
          <X size={16} />
        </button>
      </div>

      {result.overlaps.length > 0 && (
        <div className="flex items-start gap-2 border-t border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" />
          <p className="min-w-0">
            Worth a look: {dateListText(result.overlaps)} already show an absence
            for you on the board. Your request was still filed.
          </p>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// 2 — My requests
// ---------------------------------------------------------------------------

function MyRequests({
  requests,
  myStaffId,
  nameOf,
  deciderName,
  onCancel,
}: {
  requests: LeaveRequest[]
  myStaffId: string | null
  nameOf: (staffId: string | null) => string | null
  deciderName: (profileId: string | null) => string | null
  onCancel: (request: LeaveRequest) => Promise<void>
}) {
  if (requests.length === 0) {
    return (
      <div className="mt-10 flex flex-col items-center text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-100 text-gray-400">
          <Inbox size={26} />
        </div>
        <p className="mt-3 text-sm font-medium text-gray-900">
          No requests yet
        </p>
        <p className="mt-1 max-w-sm text-sm text-gray-500">
          Anything you ask for shows up here, with who it went to and what they
          decided.
        </p>
      </div>
    )
  }

  return (
    <ul className="mt-4 space-y-3">
      {requests.map((r) => (
        <MyRequestCard
          key={r.id}
          request={r}
          forSomeoneElse={r.requester_staff_id !== myStaffId}
          requesterName={nameOf(r.requester_staff_id)}
          approverName={nameOf(r.approver_staff_id)}
          decidedBy={deciderName(r.decided_by_profile_id)}
          onCancel={onCancel}
        />
      ))}
    </ul>
  )
}

function MyRequestCard({
  request,
  forSomeoneElse,
  requesterName,
  approverName,
  decidedBy,
  onCancel,
}: {
  request: LeaveRequest
  forSomeoneElse: boolean
  requesterName: string | null
  approverName: string | null
  decidedBy: string | null
  onCancel: (request: LeaveRequest) => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const meta = STATUS_META[request.status]
  const days = workingDays(request.start_date, request.end_date, request.day_part)
  const decidedOn = stampText(request.decided_at)

  async function handleCancel() {
    setBusy(true)
    setErr(null)
    try {
      await onCancel(request)
    } catch (e) {
      setErr(errMessage(e, 'That request could not be cancelled.'))
      setBusy(false)
    }
  }

  return (
    <li className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-gray-900">
              {TYPE_LABEL[request.leave_type]}
            </span>
            <span
              className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${meta.chip}`}
            >
              {meta.label}
            </span>
            {forSomeoneElse && requesterName && (
              <span className="text-xs text-gray-500">for {requesterName}</span>
            )}
          </div>
          <p className="mt-0.5 text-sm text-gray-500">
            {rangeText(request.start_date, request.end_date)}
            {request.day_part !== 'full' &&
              ` · ${DAY_PART_LABEL[request.day_part]}`}
            {` · ${daysText(days)}`}
          </p>
          {request.reason && (
            <p className="mt-1 text-xs text-gray-500">{request.reason}</p>
          )}
          <p className="mt-1 text-xs text-gray-400">
            {request.status === 'pending'
              ? approverName
                ? `Waiting on ${approverName}`
                : 'Waiting on an administrator — nobody is set as the approver'
              : `Filed ${stampText(request.created_at) ?? ''}`.trim()}
          </p>
        </div>

        {request.status === 'pending' && (
          <div className="flex shrink-0 flex-wrap gap-2">
            {confirming ? (
              <>
                <button
                  onClick={handleCancel}
                  disabled={busy}
                  className={BTN_DANGER}
                >
                  {busy && <Loader2 size={15} className="animate-spin" />}
                  Cancel it
                </button>
                <button
                  onClick={() => setConfirming(false)}
                  disabled={busy}
                  className={BTN_QUIET}
                >
                  Keep it
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirming(true)}
                className={BTN_QUIET}
                aria-label={`Cancel the ${TYPE_LABEL[
                  request.leave_type
                ].toLowerCase()} request for ${rangeText(
                  request.start_date,
                  request.end_date,
                )}`}
              >
                Cancel request
              </button>
            )}
          </div>
        )}
      </div>

      {(request.status === 'approved' || request.status === 'declined') && (
        <div className="mt-3 rounded-lg bg-gray-100 px-3 py-2 text-xs text-gray-600">
          <p>
            {request.status === 'approved' ? 'Approved' : 'Declined'}
            {decidedBy ? ` by ${decidedBy}` : ''}
            {decidedOn ? ` on ${decidedOn}` : ''}.
          </p>
          {request.decision_note && (
            <p className="mt-1 text-gray-500">“{request.decision_note}”</p>
          )}
        </div>
      )}

      {err && <p className="mt-2 text-xs text-red-700">{err}</p>}
    </li>
  )
}

// ---------------------------------------------------------------------------
// 3 — Awaiting your decision
// ---------------------------------------------------------------------------

function DecisionQueue({
  queue,
  outcomes,
  byStaffId,
  overlapsFor,
  onDecide,
  onDismissOutcome,
}: {
  queue: LeaveRequest[]
  outcomes: Outcome[]
  byStaffId: Map<string, StaffRecord>
  overlapsFor: (request: LeaveRequest) => string[]
  onDecide: (
    request: LeaveRequest,
    decision: 'approved' | 'declined',
    note: string,
  ) => Promise<void>
  onDismissOutcome: (requestId: string) => void
}) {
  return (
    <div className="mt-4 space-y-3">
      {outcomes.map((o) => (
        <OutcomeNotice
          key={o.requestId}
          outcome={o}
          onDismiss={() => onDismissOutcome(o.requestId)}
        />
      ))}

      {queue.length === 0 ? (
        <div className="mt-10 flex flex-col items-center text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-jade-50 text-jade-700 dark:text-jade-300">
            <CalendarCheck size={26} />
          </div>
          <p className="mt-3 text-sm font-medium text-gray-900">
            Nothing waiting on you
          </p>
          <p className="mt-1 max-w-sm text-sm text-gray-500">
            Leave requests routed to you appear here, oldest first.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {queue.map((r) => {
            const person = byStaffId.get(r.requester_staff_id)
            return (
              <QueueCard
                key={r.id}
                request={r}
                requesterName={person?.full_name ?? 'Someone on the roster'}
                department={person?.department ?? null}
                unassigned={r.approver_staff_id === null}
                overlaps={overlapsFor(r)}
                onDecide={onDecide}
              />
            )
          })}
        </ul>
      )}
    </div>
  )
}

function QueueCard({
  request,
  requesterName,
  department,
  unassigned,
  overlaps,
  onDecide,
}: {
  request: LeaveRequest
  requesterName: string
  department: string | null
  unassigned: boolean
  overlaps: string[]
  onDecide: (
    request: LeaveRequest,
    decision: 'approved' | 'declined',
    note: string,
  ) => Promise<void>
}) {
  const noteId = useId()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<'approved' | 'declined' | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const days = workingDays(request.start_date, request.end_date, request.day_part)

  async function decide(decision: 'approved' | 'declined') {
    if (busy) return
    setBusy(decision)
    setErr(null)
    try {
      await onDecide(request, decision, note)
      // On success this card leaves the queue and an outcome notice takes its
      // place, so there is nothing to reset here.
    } catch (e) {
      setErr(errMessage(e, 'That decision could not be recorded.'))
      setBusy(null)
    }
  }

  return (
    <li className="rounded-xl border border-gray-200 bg-white">
      <div className="px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-gray-900">
                {requesterName}
              </span>
              <span className="inline-flex rounded-full border border-gray-200 bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                {TYPE_LABEL[request.leave_type]}
              </span>
              {unassigned && (
                <span className="inline-flex rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                  No manager set
                </span>
              )}
            </div>
            {department && (
              <p className="mt-0.5 text-xs text-gray-500">{department}</p>
            )}
            <p className="mt-1 text-sm text-gray-500">
              {rangeText(request.start_date, request.end_date)}
              {request.day_part !== 'full' &&
                ` · ${DAY_PART_LABEL[request.day_part]}`}
              {` · ${daysText(days)}`}
            </p>
            <p className="mt-1 text-xs text-gray-400">
              Asked {stampText(request.created_at) ?? 'recently'}
            </p>
          </div>
        </div>

        {request.reason ? (
          <p className="mt-2 rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600">
            {request.reason}
          </p>
        ) : (
          <p className="mt-2 text-xs text-gray-400">No reason given.</p>
        )}
      </div>

      {overlaps.length > 0 && (
        <div className="flex items-start gap-2 border-t border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" />
          <p className="min-w-0">
            {dateListText(overlaps)} already show an absence for {requesterName}{' '}
            on the board.
          </p>
        </div>
      )}

      <div className="border-t border-gray-200 px-4 py-3">
        <label htmlFor={noteId} className="block">
          <span className={LABEL_CLASS}>Note (optional)</span>
          <input
            id={noteId}
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Goes to them with the decision"
            disabled={busy !== null}
            className={INPUT_CLASS}
          />
        </label>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={() => decide('approved')}
            disabled={busy !== null}
            className={BTN_PRIMARY}
          >
            {busy === 'approved' && (
              <Loader2 size={15} className="animate-spin" />
            )}
            Approve
          </button>
          <button
            onClick={() => decide('declined')}
            disabled={busy !== null}
            className={BTN_DANGER}
          >
            {busy === 'declined' && (
              <Loader2 size={15} className="animate-spin" />
            )}
            Decline
          </button>
        </div>

        {err && <p className="mt-2 text-xs text-red-700">{err}</p>}
      </div>
    </li>
  )
}

/**
 * What a decision actually did — and, just as importantly, what it did not do.
 * The drafts are written into Outlook Drafts and nothing is sent, so the
 * manager has to be told to go and press Send. Saying "emails have gone out"
 * here would be false, and quietly saying nothing would be worse.
 */
function OutcomeNotice({
  outcome,
  onDismiss,
}: {
  outcome: Outcome
  onDismiss: () => void
}) {
  const { result, who, decision } = outcome
  const drafted = [
    result.drafts.allStaff ? 'one to all staff' : null,
    result.drafts.requester ? `one to ${who}` : null,
  ].filter((x): x is string => x !== null)

  return (
    <section className="rounded-xl border border-gray-200 bg-white">
      <div className="flex items-start gap-3 px-4 py-3">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-jade-50 text-jade-700 dark:text-jade-300">
          <Check size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-900">
            {decision === 'approved' ? 'Approved' : 'Declined'} — {who}
          </p>
          {decision === 'approved' && (
            <p className="mt-0.5 text-sm text-gray-500">
              {result.rowsWritten > 0
                ? `${result.rowsWritten} day${
                    result.rowsWritten === 1 ? '' : 's'
                  } added to the attendance board.`
                : 'Nothing was added to the attendance board — the request covered no working days.'}
            </p>
          )}
          {drafted.length > 0 ? (
            <p className="mt-1 text-sm text-gray-500">
              {drafted.length === 1 ? 'A draft' : 'Two drafts'} (
              {drafted.join(', ')}){' '}
              {drafted.length === 1 ? 'is' : 'are'} waiting in your Outlook
              Drafts folder.{' '}
              <span className="font-medium text-gray-900">
                Nothing has been sent — open Outlook and press Send.
              </span>
            </p>
          ) : (
            <p className="mt-1 text-sm text-gray-500">
              No email drafts were written, so nothing has been sent.
            </p>
          )}
          {result.draftWarnings.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 rounded-lg bg-amber-50 px-3 py-2 pl-7 text-xs text-amber-700">
              {result.draftWarnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </div>
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40"
        >
          <X size={16} />
        </button>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function LeaveSkeleton() {
  return (
    <div className="mt-4 space-y-3">
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i} className="rounded-xl border border-gray-200 bg-white">
          <div className="border-b border-gray-200 px-4 py-3">
            <div className="h-5 w-32 animate-pulse rounded-full bg-gray-100" />
          </div>
          <div className="space-y-2 p-4">
            <div className="h-4 w-2/5 animate-pulse rounded bg-gray-200" />
            <div className="h-3 w-1/4 animate-pulse rounded bg-gray-100" />
          </div>
        </div>
      ))}
    </div>
  )
}
