import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import {
  AlertCircle, // error banner
  Check, // "linked" confirmation
  ChevronLeft,
  ChevronRight,
  KeyRound, // "create a login"
  Loader2,
  Plus, // "add person"
  Sun, // "Everyone is in" empty state
  Trash2,
  TriangleAlert, // "Needs your attention"
  UserPlus, // add an unmatched name to the roster
  Users as UsersIcon,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { USERNAME_HINT, USERNAME_RE } from '../lib/api'
import PasswordField from '../components/admin/PasswordField'
import {
  addDays,
  addNameToRoster,
  createLoginForStaff,
  createStaffMember,
  deleteStaffMember,
  fetchLoginAccounts,
  fetchPresence,
  fetchRoster,
  firstName,
  linkLoginToStaff,
  linkNameToStaff,
  mauritiusToday,
  normaliseName,
  suggestMatch,
  suggestUsername,
  updateStaffMember,
  workWeek,
  type DayPart,
  type LoginAccount,
  type PresenceRow,
  type PresenceStatus,
  type StaffMember,
  type StaffMemberInput,
} from '../lib/presenceApi'

// ---------------------------------------------------------------------------
// Presentation of the two enums
// ---------------------------------------------------------------------------

interface StatusMeta {
  label: string
  /** Column heading inside the week grid, where space is tight. */
  short: string
  /** Chip on the day board. */
  chip: string
  /** Cell fill in the week grid. */
  cell: string
}

/*
 * Colour carries meaning and nothing else: red for illness, amber for booked
 * leave, jade for planned and expected, plain grey for the rest. This is a
 * board people glance at over coffee — it is not an alert dashboard, so most
 * rows are deliberately colourless.
 *
 * Only the jade tint needs a `dark:` variant. The neutral, red and amber ramps
 * are re-mapped under `.dark` in index.css and flip on their own.
 *
 * The order entries are written in is the order the day board reads them —
 * STATUS_ORDER below is derived from these keys, so a new status can only ever
 * be added in one place.
 */
const STATUS_META: Record<PresenceStatus, StatusMeta> = {
  sick: {
    label: 'Off sick',
    short: 'Sick',
    chip: 'border-red-200 bg-red-50 text-red-700',
    cell: 'bg-red-50 text-red-700',
  },
  local_leave: {
    label: 'On local leave',
    short: 'Leave',
    chip: 'border-amber-200 bg-amber-50 text-amber-700',
    cell: 'bg-amber-50 text-amber-700',
  },
  // Jade, not amber: annual leave is the most planned absence there is, and
  // reusing amber would make a three-week holiday glance-identical to a day of
  // local leave — the one confusion this status exists to prevent. Jade is
  // already the board's "planned, nothing to do about it" tint, it is calm
  // rather than alarming, and it stays legible in dark mode (jade-50 is
  // re-mapped under `.dark`). The label and short form carry the distinction
  // from off_site, which shares the tint.
  vacation_leave: {
    label: 'On vacation',
    short: 'Vacation',
    chip: 'border-gray-200 bg-jade-50 text-jade-700 dark:text-jade-300',
    cell: 'bg-jade-50 text-jade-700 dark:text-jade-300',
  },
  permission: {
    label: 'On permission',
    short: 'Permission',
    chip: 'border-gray-200 bg-gray-100 text-gray-600',
    cell: 'bg-gray-100 text-gray-600',
  },
  late: {
    label: 'Arriving late',
    short: 'Late',
    chip: 'border-gray-200 bg-gray-100 text-gray-600',
    cell: 'bg-gray-100 text-gray-600',
  },
  off_site: {
    label: 'Off site',
    short: 'Off site',
    chip: 'border-gray-200 bg-jade-50 text-jade-700 dark:text-jade-300',
    cell: 'bg-jade-50 text-jade-700 dark:text-jade-300',
  },
  other: {
    label: 'Away',
    short: 'Away',
    chip: 'border-gray-200 bg-gray-100 text-gray-600',
    cell: 'bg-gray-100 text-gray-600',
  },
}

/**
 * Reading order of the groups on the day board: the order STATUS_META is
 * written in. Derived rather than repeated — STATUS_META is exhaustive by its
 * `Record<PresenceStatus, …>` type, so a status can never be styled but left
 * out of the ordering (which would drop its whole group off the board).
 */
const STATUS_ORDER = Object.keys(STATUS_META) as PresenceStatus[]

/** Lower-cased, punctuation flattened to single spaces: "Arriving late." and
 * "arriving  late" compare equal. */
function noteKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/** "on vacation" → "vacation". The status labels are phrases ("Off sick", "On
 * local leave") while notes are usually written bare, so both sides are
 * compared with and without the leading preposition. */
function withoutLeadIn(key: string): string {
  return key.replace(/^(?:on|off|is|are)\s+/, '')
}

/**
 * The note the row should actually show, or null when there is nothing left to
 * say.
 *
 * `note` exists for genuinely extra detail — "left office - emergency", or why
 * the extractor was unsure — and that must keep showing. But for the simple
 * absences the extractor fills it with the status in words, so a `late` row
 * whose note is "arriving late" renders "Arriving late · part day · arriving
 * late". The note is therefore dropped only when, ignoring case, punctuation,
 * spacing and a leading "on"/"off", it says exactly what the status label (or
 * its short form, or the status key itself) already says. Matching is exact on
 * that normalised form rather than by containment: "sick until Friday"
 * mentions the label but carries real information, so it stays.
 */
function visibleNote(row: PresenceRow): string | null {
  const note = row.note?.trim()
  if (!note) return null

  const meta = STATUS_META[row.status]
  const alreadySaid = new Set(
    [meta.label, meta.short, row.status].flatMap((text) => {
      const key = noteKey(text)
      return [key, withoutLeadIn(key)]
    }),
  )

  const key = noteKey(note)
  return alreadySaid.has(key) || alreadySaid.has(withoutLeadIn(key))
    ? null
    : note
}

/** A full-day absence is the default, so it gets no badge — only the partial
 * days are worth a reader's attention. */
function dayPartLabel(part: DayPart): string | null {
  if (part === 'am') return 'AM'
  if (part === 'pm') return 'PM'
  if (part === 'partial') return 'part day'
  return null
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` is a calendar date, not an instant — parse and format it as UTC
 * so the browser's timezone cannot shift it by a day. */
function boardDate(iso: string, opts: Intl.DateTimeFormatOptions): string {
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

/** Name as the board shows it: the roster spelling once resolved. */
function displayName(row: PresenceRow): string {
  return row.staff?.full_name ?? row.raw_name
}

/** Prefill for "add this person": "kavi ramdin" → "Kavi Ramdin". Already-capital
 * spellings are left alone, and the field stays editable either way. */
function titleCase(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/(^|[\s'’-])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase())
}

function errMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-jade-600 focus:ring-2 focus:ring-jade-600/20'

const BTN_PRIMARY =
  'inline-flex min-h-[38px] items-center justify-center gap-1.5 rounded-lg bg-jade-600 px-3.5 text-sm font-medium text-white transition-colors hover:bg-jade-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40 disabled:opacity-60'

const BTN_QUIET =
  'inline-flex min-h-[38px] items-center justify-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40 disabled:opacity-60'

type View = 'day' | 'week' | 'roster'

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Report() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'

  const [date, setDate] = useState<string>(() => mauritiusToday())
  const [view, setView] = useState<View>('day')

  const [rows, setRows] = useState<PresenceRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [roster, setRoster] = useState<StaffMember[] | null>(null)
  const [rosterLoading, setRosterLoading] = useState(false)
  const [rosterError, setRosterError] = useState<string | null>(null)

  /** Every login on the system, so the roster can say who signs in as whom. */
  const [accounts, setAccounts] = useState<LoginAccount[] | null>(null)
  const [accountsLoading, setAccountsLoading] = useState(false)
  const [accountsError, setAccountsError] = useState<string | null>(null)

  /** Names linked or added during this visit. Presence rows are written by the
   * backend and cannot be rewritten from here, so a row keeps needs_review until
   * the next sync — this map lets the section say so instead of going quiet. */
  const [resolved, setResolved] = useState<Record<string, string>>({})
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

  // One fetch covers both views: the Mon–Fri week around the selected date,
  // widened if the date itself falls on a weekend.
  const week = useMemo(() => workWeek(date), [date])
  const rangeStart = date < week[0] ? date : week[0]
  const rangeEnd = date > week[4] ? date : week[4]

  const loadPresence = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setRows(await fetchPresence(rangeStart, rangeEnd))
    } catch (e) {
      setRows(null)
      setError(errMessage(e, 'Could not load the presence board.'))
    } finally {
      setLoading(false)
    }
  }, [rangeStart, rangeEnd])

  useEffect(() => {
    loadPresence()
  }, [loadPresence])

  // The roster is only needed for the admin tools (linking names, the roster
  // panel). Everyone else gets names and departments from the presence join.
  const loadRoster = useCallback(async () => {
    setRosterLoading(true)
    setRosterError(null)
    try {
      setRoster(await fetchRoster())
    } catch (e) {
      setRoster(null)
      setRosterError(errMessage(e, 'Could not load the staff roster.'))
    } finally {
      setRosterLoading(false)
    }
  }, [])

  // Logins are only readable by an admin (the edge function says so), and only
  // the roster panel shows them, so this is the same admin-only fetch.
  const loadAccounts = useCallback(async () => {
    setAccountsLoading(true)
    setAccountsError(null)
    try {
      setAccounts(await fetchLoginAccounts())
    } catch (e) {
      setAccounts(null)
      setAccountsError(errMessage(e, 'Could not load the list of logins.'))
    } finally {
      setAccountsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!isAdmin) return
    loadRoster()
    loadAccounts()
  }, [isAdmin, loadRoster, loadAccounts])

  // --- roster mutations ---------------------------------------------------

  const mergeMember = useCallback((m: StaffMember) => {
    setRoster((prev) => {
      const next = prev ? prev.filter((x) => x.id !== m.id) : []
      next.push(m)
      next.sort(
        (a, b) =>
          Number(b.active) - Number(a.active) ||
          a.full_name.localeCompare(b.full_name),
      )
      return next
    })
  }, [])

  const handleLink = useCallback(
    async (row: PresenceRow, memberId: string) => {
      const member = roster?.find((m) => m.id === memberId)
      if (!member) return
      const updated = await linkNameToStaff(member, row.raw_name)
      mergeMember(updated)
      setResolved((prev) => ({ ...prev, [row.id]: updated.full_name }))
      showToast(
        `“${row.raw_name}” now matches ${updated.full_name}. Future mentions resolve on their own.`,
      )
    },
    [roster, mergeMember, showToast],
  )

  const handleAddPerson = useCallback(
    async (row: PresenceRow, fullName: string, department: string) => {
      const created = await addNameToRoster(
        row.raw_name,
        fullName,
        department.trim() || null,
      )
      mergeMember(created)
      setResolved((prev) => ({ ...prev, [row.id]: created.full_name }))
      showToast(`${created.full_name} added to the roster.`)
    },
    [mergeMember, showToast],
  )

  const handleSaveMember = useCallback(
    async (id: string, patch: Partial<StaffMemberInput>) => {
      mergeMember(await updateStaffMember(id, patch))
    },
    [mergeMember],
  )

  const handleCreateMember = useCallback(
    async (input: StaffMemberInput) => {
      mergeMember(await createStaffMember(input))
    },
    [mergeMember],
  )

  const handleDeleteMember = useCallback(async (id: string) => {
    await deleteStaffMember(id)
    setRoster((prev) => prev?.filter((m) => m.id !== id) ?? prev)
  }, [])

  // --- login links --------------------------------------------------------
  //
  // Onboarding is fifteen people in one sitting, so every one of these patches
  // the rows in place instead of re-fetching: the list keeps its order, the
  // page keeps its scroll position, and the row you just finished stays where
  // you left it.

  const handleLinkAccount = useCallback(
    async (staffId: string, userId: string) => {
      await linkLoginToStaff(userId, staffId)
      setRoster(
        (prev) =>
          prev?.map((m) =>
            m.id === staffId
              ? { ...m, profile_id: userId }
              : // The backend moves a login rather than copying it, so whoever
                // held it before no longer does.
                m.profile_id === userId
                ? { ...m, profile_id: null }
                : m,
          ) ?? prev,
      )
    },
    [],
  )

  const handleUnlinkAccount = useCallback(
    async (staffId: string, userId: string) => {
      await linkLoginToStaff(userId, null)
      setRoster(
        (prev) =>
          prev?.map((m) => (m.id === staffId ? { ...m, profile_id: null } : m)) ??
          prev,
      )
    },
    [],
  )

  /**
   * Create a login for someone on the roster. Resolves to the backend's
   * `linkWarning` when the account was made but could not be attached — the
   * account exists either way, so that is a warning and never a failure.
   */
  const handleCreateLogin = useCallback(
    async (
      staffId: string,
      input: { username: string; password: string; displayName: string },
    ): Promise<string | null> => {
      const { account, linkWarning } = await createLoginForStaff({
        ...input,
        staffId,
      })
      setAccounts((prev) => (prev ? [...prev, account] : [account]))
      if (!linkWarning) {
        setRoster(
          (prev) =>
            prev?.map((m) =>
              m.id === staffId ? { ...m, profile_id: account.id } : m,
            ) ?? prev,
        )
      }
      return linkWarning
    },
    [],
  )

  // --- derived ------------------------------------------------------------

  const dayRows = useMemo(
    () => (rows ?? []).filter((r) => r.on_date === date),
    [rows, date],
  )
  const reviewRows = useMemo(
    () => dayRows.filter((r) => r.needs_review),
    [dayRows],
  )
  const groups = useMemo(
    () =>
      STATUS_ORDER.map((status) => ({
        status,
        rows: dayRows
          .filter((r) => r.status === status)
          .sort((a, b) => displayName(a).localeCompare(displayName(b))),
      })).filter((g) => g.rows.length > 0),
    [dayRows],
  )

  const today = mauritiusToday()
  const tabs: { value: View; label: string }[] = [
    { value: 'day', label: 'Day' },
    { value: 'week', label: 'Week' },
    ...(isAdmin ? [{ value: 'roster' as View, label: 'Roster' }] : []),
  ]

  return (
    <div className="mx-auto h-full w-full max-w-5xl overflow-y-auto p-4 sm:p-6">
      {/* Header */}
      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-gray-900">Who is out</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            {boardDate(date, LONG_DATE)}
            {date === today && ' · today in Mauritius'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setDate(today)}
            disabled={date === today}
            className={BTN_QUIET}
          >
            Today
          </button>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setDate(addDays(date, -1))}
              aria-label="Previous day"
              className="inline-flex h-[38px] w-[38px] items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40"
            >
              <ChevronLeft size={18} />
            </button>
            <input
              type="date"
              value={date}
              onChange={(e) => {
                if (e.target.value) setDate(e.target.value)
              }}
              aria-label="Show presence for this date"
              className="min-h-[38px] rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none transition focus:border-jade-600 focus:ring-2 focus:ring-jade-600/20"
            />
            <button
              onClick={() => setDate(addDays(date, 1))}
              aria-label="Next day"
              className="inline-flex h-[38px] w-[38px] items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40"
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
      </div>

      {/* Views */}
      <div
        role="tablist"
        aria-label="Presence views"
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
          <button onClick={loadPresence} className={BTN_QUIET}>
            Try again
          </button>
        </div>
      )}

      {toast && (
        <p className="mt-3 rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600">
          {toast}
        </p>
      )}

      {view === 'day' && (
        <>
          {loading && <BoardSkeleton />}

          {!loading && !error && reviewRows.length > 0 && (
            <NeedsAttention
              rows={reviewRows}
              roster={roster}
              rosterLoading={rosterLoading}
              rosterError={rosterError}
              isAdmin={isAdmin}
              resolved={resolved}
              onLink={handleLink}
              onAddPerson={handleAddPerson}
            />
          )}

          {!loading && !error && dayRows.length === 0 && <EveryoneIn />}

          {!loading && !error && groups.length > 0 && (
            <div className="mt-4 space-y-4">
              {groups.map((g) => (
                <StatusGroup key={g.status} status={g.status} rows={g.rows} />
              ))}
            </div>
          )}
        </>
      )}

      {view === 'week' && (
        <WeekBoard
          days={week}
          rows={rows ?? []}
          selected={date}
          loading={loading}
          hasError={!!error}
          onPickDay={(d) => {
            setDate(d)
            setView('day')
          }}
        />
      )}

      {view === 'roster' && isAdmin && (
        <RosterPanel
          roster={roster}
          loading={rosterLoading}
          error={rosterError}
          accounts={accounts}
          accountsLoading={accountsLoading}
          accountsError={accountsError}
          onReload={loadRoster}
          onReloadAccounts={loadAccounts}
          onSave={handleSaveMember}
          onCreate={handleCreateMember}
          onDelete={handleDeleteMember}
          onLinkAccount={handleLinkAccount}
          onUnlinkAccount={handleUnlinkAccount}
          onCreateLogin={handleCreateLogin}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Day board
// ---------------------------------------------------------------------------

function StatusGroup({
  status,
  rows,
}: {
  status: PresenceStatus
  rows: PresenceRow[]
}) {
  const meta = STATUS_META[status]
  return (
    <section className="rounded-xl border border-gray-200 bg-white">
      <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-2.5">
        <span
          className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${meta.chip}`}
        >
          {meta.label}
        </span>
        <span className="text-xs tabular-nums text-gray-400">{rows.length}</span>
      </div>
      <ul className="divide-y divide-gray-100">
        {rows.map((row) => (
          <PersonRow key={row.id} row={row} />
        ))}
      </ul>
    </section>
  )
}

function PersonRow({ row }: { row: PresenceRow }) {
  const badge = dayPartLabel(row.day_part)
  const dept = row.staff?.department?.trim()
  // The group heading above already shows the status label, so a note that only
  // repeats it would read as a stutter.
  const note = visibleNote(row)
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-gray-900">
          {row.staff ? (
            row.staff.full_name
          ) : (
            // Unresolved: show exactly what the email said, and say so visually.
            <em className="italic text-gray-700" title="Not matched to the roster yet">
              {row.raw_name}
            </em>
          )}
        </p>
        {dept && <p className="mt-0.5 truncate text-xs text-gray-500">{dept}</p>}
        {note && <p className="mt-1 text-xs text-gray-500">{note}</p>}
      </div>
      {badge && (
        <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
          {badge}
        </span>
      )}
    </li>
  )
}

function EveryoneIn() {
  return (
    <div className="mt-10 flex flex-col items-center text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-jade-50 text-jade-700 dark:text-jade-300">
        <Sun size={26} />
      </div>
      <p className="mt-3 text-sm font-medium text-gray-900">Everyone is in</p>
      <p className="mt-1 text-sm text-gray-500">
        No absences reported for this day.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Needs your attention
// ---------------------------------------------------------------------------

function NeedsAttention({
  rows,
  roster,
  rosterLoading,
  rosterError,
  isAdmin,
  resolved,
  onLink,
  onAddPerson,
}: {
  rows: PresenceRow[]
  roster: StaffMember[] | null
  rosterLoading: boolean
  rosterError: string | null
  isAdmin: boolean
  resolved: Record<string, string>
  onLink: (row: PresenceRow, memberId: string) => Promise<void>
  onAddPerson: (
    row: PresenceRow,
    fullName: string,
    department: string,
  ) => Promise<void>
}) {
  const departments = useMemo(
    () =>
      Array.from(
        new Set(
          (roster ?? [])
            .map((m) => m.department?.trim())
            .filter((d): d is string => !!d),
        ),
      ).sort(),
    [roster],
  )

  return (
    <section className="mt-4 overflow-hidden rounded-xl border border-amber-200 bg-white">
      <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-700">
        <TriangleAlert size={16} className="shrink-0" />
        Needs your attention
        <span className="tabular-nums font-normal">({rows.length})</span>
      </div>

      {isAdmin && rosterError && (
        <p className="border-b border-gray-200 px-4 py-2.5 text-sm text-red-700">
          {rosterError}
        </p>
      )}

      <ul className="divide-y divide-gray-100">
        {rows.map((row) => (
          <ReviewRow
            key={row.id}
            row={row}
            roster={roster}
            rosterLoading={rosterLoading}
            departments={departments}
            isAdmin={isAdmin}
            resolvedAs={resolved[row.id]}
            onLink={onLink}
            onAddPerson={onAddPerson}
          />
        ))}
      </ul>
    </section>
  )
}

function ReviewRow({
  row,
  roster,
  rosterLoading,
  departments,
  isAdmin,
  resolvedAs,
  onLink,
  onAddPerson,
}: {
  row: PresenceRow
  roster: StaffMember[] | null
  rosterLoading: boolean
  departments: string[]
  isAdmin: boolean
  resolvedAs: string | undefined
  onLink: (row: PresenceRow, memberId: string) => Promise<void>
  onAddPerson: (
    row: PresenceRow,
    fullName: string,
    department: string,
  ) => Promise<void>
}) {
  const selectId = useId()
  const nameId = useId()
  const deptId = useId()
  const listId = useId()

  const [pick, setPick] = useState('')
  const [adding, setAdding] = useState(false)
  const [fullName, setFullName] = useState(() => titleCase(row.raw_name))
  const [department, setDepartment] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Open the select on the likeliest person as soon as the roster is there, so
  // the common case is one click. Never overwrite a choice already made.
  const suggestion = useMemo(
    () => (roster ? suggestMatch(row.raw_name, roster) : null),
    [roster, row.raw_name],
  )
  useEffect(() => {
    if (suggestion) setPick((prev) => prev || suggestion.id)
  }, [suggestion])

  const note = visibleNote(row)
  const unmatched = row.staff_id === null
  const reason = unmatched
    ? `“${row.raw_name}” is not on the staff roster yet.`
    : 'Flagged by the extractor — worth a second look.'

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setErr(null)
    try {
      await action()
    } catch (e) {
      setErr(errMessage(e, 'That did not work. Please try again.'))
    } finally {
      setBusy(false)
    }
  }

  function submitNew(e: FormEvent) {
    e.preventDefault()
    if (!fullName.trim()) {
      setErr('Enter a full name.')
      return
    }
    run(() => onAddPerson(row, fullName, department))
  }

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-gray-900">
            {row.raw_name}
          </p>
          <p className="mt-0.5 text-xs text-gray-500">
            {STATUS_META[row.status].label}
            {dayPartLabel(row.day_part) ? ` · ${dayPartLabel(row.day_part)}` : ''}
            {/* Same line, same label — drop a note that only repeats it. */}
            {note ? ` · ${note}` : ''}
          </p>
          <p className="mt-1 text-xs text-gray-400">{reason}</p>
        </div>
      </div>

      {resolvedAs ? (
        <p className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-gray-100 px-2.5 py-1.5 text-xs text-gray-600">
          <Check size={14} className="shrink-0" />
          Linked to {resolvedAs}. This entry re-matches on the next sync.
        </p>
      ) : (
        isAdmin &&
        unmatched && (
          <div className="mt-2.5">
            {rosterLoading && !roster ? (
              <p className="text-xs text-gray-400">Loading the roster…</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor={selectId} className="sr-only">
                    Link “{row.raw_name}” to a roster member
                  </label>
                  <select
                    id={selectId}
                    value={pick}
                    onChange={(e) => setPick(e.target.value)}
                    disabled={busy || !roster || roster.length === 0}
                    className="min-h-[38px] max-w-full rounded-lg border border-gray-300 bg-white px-2 text-sm text-gray-900 outline-none transition focus:border-jade-600 focus:ring-2 focus:ring-jade-600/20 disabled:opacity-60"
                  >
                    <option value="">
                      {roster && roster.length > 0
                        ? 'Choose a person…'
                        : 'Nobody on the roster yet'}
                    </option>
                    {(roster ?? []).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.full_name}
                        {m.department ? ` — ${m.department}` : ''}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => pick && run(() => onLink(row, pick))}
                    disabled={busy || !pick}
                    className={BTN_PRIMARY}
                  >
                    {busy && <Loader2 size={15} className="animate-spin" />}
                    This is them
                  </button>
                  <span className="text-xs text-gray-400">or</span>
                  <button
                    onClick={() => setAdding((a) => !a)}
                    aria-expanded={adding}
                    disabled={busy}
                    className={BTN_QUIET}
                  >
                    <UserPlus size={15} />
                    New person
                  </button>
                </div>

                {adding && (
                  <form
                    onSubmit={submitNew}
                    className="mt-2.5 flex flex-wrap items-end gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3"
                  >
                    <label className="min-w-[10rem] flex-1">
                      <span className="mb-1 block text-xs font-medium text-gray-700">
                        Full name
                      </span>
                      <input
                        id={nameId}
                        type="text"
                        value={fullName}
                        onChange={(e) => setFullName(e.target.value)}
                        className={INPUT_CLASS}
                      />
                    </label>
                    <label className="min-w-[10rem] flex-1">
                      <span className="mb-1 block text-xs font-medium text-gray-700">
                        Department
                      </span>
                      <input
                        id={deptId}
                        type="text"
                        list={listId}
                        value={department}
                        onChange={(e) => setDepartment(e.target.value)}
                        placeholder="Optional"
                        className={INPUT_CLASS}
                      />
                      <datalist id={listId}>
                        {departments.map((d) => (
                          <option key={d} value={d} />
                        ))}
                      </datalist>
                    </label>
                    <button type="submit" disabled={busy} className={BTN_PRIMARY}>
                      {busy && <Loader2 size={15} className="animate-spin" />}
                      Add to roster
                    </button>
                    <button
                      type="button"
                      onClick={() => setAdding(false)}
                      className={BTN_QUIET}
                    >
                      Cancel
                    </button>
                  </form>
                )}
              </>
            )}
          </div>
        )
      )}

      {err && <p className="mt-2 text-xs text-red-700">{err}</p>}
    </li>
  )
}

// ---------------------------------------------------------------------------
// Week grid
// ---------------------------------------------------------------------------

interface WeekPerson {
  key: string
  label: string
  resolved: boolean
  cells: Record<string, PresenceRow>
}

function WeekBoard({
  days,
  rows,
  selected,
  loading,
  hasError,
  onPickDay,
}: {
  days: string[]
  rows: PresenceRow[]
  selected: string
  loading: boolean
  hasError: boolean
  onPickDay: (iso: string) => void
}) {
  const people = useMemo(() => {
    const byPerson = new Map<string, WeekPerson>()
    for (const row of rows) {
      if (!days.includes(row.on_date)) continue
      // Unresolved names have no id to group on — the written spelling is the
      // best key available, so two spellings of one person stay two rows until
      // the roster learns the alias.
      const key = row.staff_id ?? `raw:${normaliseName(row.raw_name)}`
      let person = byPerson.get(key)
      if (!person) {
        person = {
          key,
          label: displayName(row),
          resolved: !!row.staff,
          cells: {},
        }
        byPerson.set(key, person)
      }
      person.cells[row.on_date] = row
    }
    return Array.from(byPerson.values()).sort((a, b) =>
      a.label.localeCompare(b.label),
    )
  }, [rows, days])

  if (loading) return <BoardSkeleton />
  if (hasError) return null

  if (people.length === 0) {
    return (
      <div className="mt-10 flex flex-col items-center text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-jade-50 text-jade-700 dark:text-jade-300">
          <Sun size={26} />
        </div>
        <p className="mt-3 text-sm font-medium text-gray-900">
          Nobody is out this week
        </p>
        <p className="mt-1 text-sm text-gray-500">
          {boardDate(days[0], { day: 'numeric', month: 'long' })} –{' '}
          {boardDate(days[4], LONG_DATE)}
        </p>
      </div>
    )
  }

  return (
    <div className="mt-4 rounded-xl border border-gray-200 bg-white">
      {/* The grid, not the page, does the horizontal scrolling. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] border-collapse text-left">
          <caption className="sr-only">
            Absences for the week of {boardDate(days[0], LONG_DATE)}
          </caption>
          <thead>
            <tr className="border-b border-gray-200">
              <th
                scope="col"
                className="sticky left-0 z-10 bg-white px-4 py-2.5 text-xs font-medium text-gray-500"
              >
                Person
              </th>
              {days.map((d) => (
                <th key={d} scope="col" className="px-2 py-1.5 text-center">
                  <button
                    onClick={() => onPickDay(d)}
                    aria-current={d === selected ? 'date' : undefined}
                    className={`min-h-[38px] w-full rounded-lg px-2 text-xs font-medium transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40 ${
                      d === selected ? 'bg-jade-50 text-jade-700 dark:text-jade-300' : 'text-gray-500'
                    }`}
                  >
                    <span className="block">
                      {boardDate(d, { weekday: 'short' })}
                    </span>
                    <span className="block tabular-nums">
                      {boardDate(d, { day: 'numeric' })}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {people.map((p) => (
              <tr key={p.key}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 max-w-[12rem] truncate bg-white px-4 py-2 text-sm font-normal text-gray-900"
                >
                  {p.resolved ? (
                    p.label
                  ) : (
                    <em className="italic text-gray-700">{p.label}</em>
                  )}
                </th>
                {days.map((d) => {
                  const cell = p.cells[d]
                  if (!cell) {
                    return (
                      <td
                        key={d}
                        className="px-2 py-2 text-center text-xs text-gray-300"
                      >
                        <span aria-hidden="true">·</span>
                      </td>
                    )
                  }
                  const meta = STATUS_META[cell.status]
                  const part = dayPartLabel(cell.day_part)
                  return (
                    <td key={d} className="px-2 py-2 text-center">
                      <span
                        className={`inline-flex flex-col rounded-lg px-2 py-1 text-xs font-medium ${meta.cell}`}
                        title={`${meta.label}${part ? ` (${part})` : ''}`}
                      >
                        {meta.short}
                        {part && (
                          <span className="text-[10px] font-normal opacity-80">
                            {part}
                          </span>
                        )}
                      </span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Roster panel (admin only)
// ---------------------------------------------------------------------------

function RosterPanel({
  roster,
  loading,
  error,
  accounts,
  accountsLoading,
  accountsError,
  onReload,
  onReloadAccounts,
  onSave,
  onCreate,
  onDelete,
  onLinkAccount,
  onUnlinkAccount,
  onCreateLogin,
}: {
  roster: StaffMember[] | null
  loading: boolean
  error: string | null
  accounts: LoginAccount[] | null
  accountsLoading: boolean
  accountsError: string | null
  onReload: () => void
  onReloadAccounts: () => void
  onSave: (id: string, patch: Partial<StaffMemberInput>) => Promise<void>
  onCreate: (input: StaffMemberInput) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onLinkAccount: (staffId: string, userId: string) => Promise<void>
  onUnlinkAccount: (staffId: string, userId: string) => Promise<void>
  onCreateLogin: (
    staffId: string,
    input: { username: string; password: string; displayName: string },
  ) => Promise<string | null>
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [panelError, setPanelError] = useState<string | null>(null)

  const managers = useMemo(
    () => (roster ?? []).filter((m) => m.is_manager),
    [roster],
  )

  const accountById = useMemo(
    () => new Map((accounts ?? []).map((a) => [a.id, a])),
    [accounts],
  )

  /**
   * Logins nobody on the roster has claimed. Offering a taken one would only
   * earn a 409 from the backend, and a choice that cannot be made is worse
   * than one that is never shown.
   */
  const freeAccounts = useMemo(() => {
    const taken = new Set(
      (roster ?? []).map((m) => m.profile_id).filter((id): id is string => !!id),
    )
    return (accounts ?? []).filter((a) => !taken.has(a.id))
  }, [accounts, roster])

  async function guard(action: () => Promise<void>) {
    setPanelError(null)
    try {
      await action()
    } catch (e) {
      setPanelError(errMessage(e, 'That change could not be saved.'))
      throw e
    }
  }

  return (
    <section className="mt-4 rounded-xl border border-gray-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-900">Staff roster</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Departments and managers set here are what leave approvals route on,
            and a person can only file their own leave once their login is
            linked below.
          </p>
        </div>
        <button
          onClick={() => {
            setAdding(true)
            setEditingId(null)
          }}
          disabled={adding}
          className={BTN_PRIMARY}
        >
          <Plus size={15} />
          Add person
        </button>
      </div>

      {(error || panelError) && (
        <div className="flex flex-wrap items-center gap-3 border-b border-gray-200 px-4 py-3 text-sm text-red-700">
          <AlertCircle size={18} className="shrink-0" />
          <span className="min-w-0 flex-1">{error ?? panelError}</span>
          {error && (
            <button onClick={onReload} className={BTN_QUIET}>
              Try again
            </button>
          )}
        </div>
      )}

      {accountsError && (
        <div className="flex flex-wrap items-center gap-3 border-b border-gray-200 px-4 py-3 text-sm text-red-700">
          <AlertCircle size={18} className="shrink-0" />
          <span className="min-w-0 flex-1">{accountsError}</span>
          <button onClick={onReloadAccounts} className={BTN_QUIET}>
            Try again
          </button>
        </div>
      )}

      {adding && (
        <div className="border-b border-gray-200 bg-gray-50 px-4 py-3">
          <MemberForm
            member={null}
            managers={managers}
            onCancel={() => setAdding(false)}
            onSubmit={async (input) => {
              await guard(() => onCreate(input))
              setAdding(false)
            }}
          />
        </div>
      )}

      {loading && (
        <div className="space-y-2 p-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-gray-100" />
          ))}
        </div>
      )}

      {!loading && roster && roster.length === 0 && !adding && (
        <div className="flex flex-col items-center px-4 py-10 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-100 text-gray-400">
            <UsersIcon size={22} />
          </div>
          <p className="mt-3 text-sm font-medium text-gray-900">
            Nobody on the roster yet
          </p>
          <p className="mt-1 max-w-sm text-sm text-gray-500">
            Add people here, or build the roster as names come in from the day
            board's "Needs your attention" list.
          </p>
        </div>
      )}

      {!loading && roster && roster.length > 0 && (
        <ul className="divide-y divide-gray-100">
          {roster.map((m) =>
            editingId === m.id ? (
              <li key={m.id} className="bg-gray-50 px-4 py-3">
                <MemberForm
                  member={m}
                  managers={managers.filter((x) => x.id !== m.id)}
                  onCancel={() => setEditingId(null)}
                  onSubmit={async (input) => {
                    await guard(() => onSave(m.id, input))
                    setEditingId(null)
                  }}
                />
              </li>
            ) : (
              <MemberRow
                key={m.id}
                member={m}
                manager={
                  roster.find((x) => x.id === m.manager_id)?.full_name ?? null
                }
                account={m.profile_id ? accountById.get(m.profile_id) ?? null : null}
                freeAccounts={freeAccounts}
                accountsReady={accounts !== null}
                accountsLoading={accountsLoading}
                onEdit={() => {
                  setEditingId(m.id)
                  setAdding(false)
                }}
                onDelete={() => guard(() => onDelete(m.id)).catch(() => {})}
                onLinkAccount={onLinkAccount}
                onUnlinkAccount={onUnlinkAccount}
                onCreateLogin={onCreateLogin}
              />
            ),
          )}
        </ul>
      )}
    </section>
  )
}

function MemberRow({
  member,
  manager,
  account,
  freeAccounts,
  accountsReady,
  accountsLoading,
  onEdit,
  onDelete,
  onLinkAccount,
  onUnlinkAccount,
  onCreateLogin,
}: {
  member: StaffMember
  manager: string | null
  account: LoginAccount | null
  freeAccounts: LoginAccount[]
  accountsReady: boolean
  accountsLoading: boolean
  onEdit: () => void
  onDelete: () => void
  onLinkAccount: (staffId: string, userId: string) => Promise<void>
  onUnlinkAccount: (staffId: string, userId: string) => Promise<void>
  onCreateLogin: (
    staffId: string,
    input: { username: string; password: string; displayName: string },
  ) => Promise<string | null>
}) {
  const [confirming, setConfirming] = useState(false)

  const detail = [
    member.department?.trim() || null,
    manager ? `Reports to ${manager}` : null,
  ].filter(Boolean)

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-gray-900">
              {member.full_name}
            </span>
            {member.known_as && (
              <span className="text-xs text-gray-500">“{member.known_as}”</span>
            )}
            {member.is_manager && (
              <span className="rounded-full bg-jade-50 px-2 py-0.5 text-xs font-medium text-jade-700 dark:text-jade-300">
                Manager
              </span>
            )}
            {!member.active && (
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                Inactive
              </span>
            )}
          </div>
          {detail.length > 0 && (
            <p className="mt-0.5 text-xs text-gray-500">{detail.join(' · ')}</p>
          )}
          {member.aliases.length > 0 && (
            <p className="mt-0.5 text-xs text-gray-400">
              Also written: {member.aliases.join(', ')}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          <button onClick={onEdit} className={BTN_QUIET}>
            Edit
          </button>
          {confirming ? (
            <>
              <button
                onClick={() => {
                  setConfirming(false)
                  onDelete()
                }}
                className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3.5 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40"
              >
                Remove {member.full_name}?
              </button>
              <button onClick={() => setConfirming(false)} className={BTN_QUIET}>
                Keep
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              aria-label={`Remove ${member.full_name} from the roster`}
              className="inline-flex min-h-[38px] w-[38px] items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40"
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </div>

      <MemberLogin
        member={member}
        account={account}
        freeAccounts={freeAccounts}
        accountsReady={accountsReady}
        accountsLoading={accountsLoading}
        onLink={onLinkAccount}
        onUnlink={onUnlinkAccount}
        onCreate={onCreateLogin}
      />
    </li>
  )
}

/**
 * The login half of a roster row: who this person signs in as, and — for the
 * dozen or so who have no account yet — the two ways to give them one.
 *
 * Both paths are open on the row rather than behind a dialog, because this is
 * a sitting-down job: an admin goes down the list once, and a modal per person
 * would be fifteen open-and-close cycles. Everything is inside a <form>, so
 * Enter finishes the row without reaching for the mouse.
 */
function MemberLogin({
  member,
  account,
  freeAccounts,
  accountsReady,
  accountsLoading,
  onLink,
  onUnlink,
  onCreate,
}: {
  member: StaffMember
  account: LoginAccount | null
  freeAccounts: LoginAccount[]
  accountsReady: boolean
  accountsLoading: boolean
  onLink: (staffId: string, userId: string) => Promise<void>
  onUnlink: (staffId: string, userId: string) => Promise<void>
  onCreate: (
    staffId: string,
    input: { username: string; password: string; displayName: string },
  ) => Promise<string | null>
}) {
  const pickId = useId()
  const userId = useId()
  const passId = useId()

  const [pick, setPick] = useState('')
  const [creating, setCreating] = useState(false)
  const [username, setUsername] = useState(() => suggestUsername(member.full_name))
  const [password, setPassword] = useState('')
  /** Which request is in flight, so the spinner lands on the button that was
   * actually pressed — link and create can be on screen at the same time. */
  const [pending, setPending] = useState<'link' | 'unlink' | 'create' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const busy = pending !== null

  async function run(kind: 'link' | 'unlink' | 'create', action: () => Promise<void>) {
    setPending(kind)
    setErr(null)
    try {
      await action()
    } catch (e) {
      // 409 from the backend reads as a sentence ("Kavi is already linked to
      // another login. Unlink that one first.") — show it rather than burying
      // it under a generic failure.
      setErr(errMessage(e, 'That did not work. Please try again.'))
    } finally {
      setPending(null)
    }
  }

  function submitLink(e: FormEvent) {
    e.preventDefault()
    if (!pick) return
    setNotice(null)
    run('link', () => onLink(member.id, pick))
  }

  function submitCreate(e: FormEvent) {
    e.preventDefault()
    const uname = username.trim().toLowerCase()
    if (!USERNAME_RE.test(uname)) {
      setErr(`Username must be ${USERNAME_HINT}`)
      return
    }
    if (password.length < 8) {
      setErr('Password must be at least 8 characters.')
      return
    }
    setNotice(null)
    run('create', async () => {
      const warning = await onCreate(member.id, {
        username: uname,
        password,
        displayName: member.full_name,
      })
      // Whatever happened to the link, the account exists — and the password
      // has served its purpose, so it is dropped here and never shown again.
      setPassword('')
      setCreating(false)
      setNotice(
        warning ??
          `Login “${uname}” created. Share the password you copied with ${member.full_name}.`,
      )
    })
  }

  if (accountsLoading && !accountsReady) {
    return <p className="mt-2 text-xs text-gray-400">Checking logins…</p>
  }
  // The logins could not be read at all — the panel says so at the top, and a
  // per-row repeat of that would be a wall of red.
  if (!accountsReady) return null

  return (
    <div className="mt-2">
      {account ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">
            <Check size={13} className="shrink-0 text-jade-700 dark:text-jade-300" />
            Signs in as{' '}
            <span className="font-mono text-gray-900">{account.username}</span>
            {!account.active && ' · deactivated'}
          </span>
          <button
            onClick={() => run('unlink', () => onUnlink(member.id, account.id))}
            disabled={busy}
            className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-2.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40 disabled:opacity-60"
          >
            {pending === 'unlink' && (
              <Loader2 size={13} className="animate-spin" />
            )}
            Unlink
          </button>
        </div>
      ) : (
        <>
          <form
            onSubmit={submitLink}
            className="flex flex-wrap items-center gap-2"
          >
            <label htmlFor={pickId} className="text-xs text-gray-500">
              Login
            </label>
            <select
              id={pickId}
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              disabled={busy || freeAccounts.length === 0}
              className="min-h-[32px] max-w-full rounded-lg border border-gray-300 bg-white px-2 text-xs text-gray-900 outline-none transition focus:border-jade-600 focus:ring-2 focus:ring-jade-600/20 disabled:opacity-60"
            >
              <option value="">
                {freeAccounts.length > 0
                  ? 'Not linked — choose one…'
                  : 'Not linked — every login is taken'}
              </option>
              {freeAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.username}
                  {a.displayName && a.displayName !== a.username
                    ? ` — ${a.displayName}`
                    : ''}
                  {a.active ? '' : ' (deactivated)'}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={busy || !pick}
              className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg bg-jade-600 px-2.5 text-xs font-medium text-white transition-colors hover:bg-jade-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40 disabled:opacity-60"
            >
              {pending === 'link' && <Loader2 size={13} className="animate-spin" />}
              Link
            </button>
            <span className="text-xs text-gray-400">or</span>
            <button
              type="button"
              onClick={() => {
                setCreating((c) => !c)
                setErr(null)
              }}
              aria-expanded={creating}
              disabled={busy}
              className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-2.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40 disabled:opacity-60"
            >
              <KeyRound size={13} />
              Create a login
            </button>
          </form>

          {creating && (
            <form
              onSubmit={submitCreate}
              className="mt-2.5 rounded-lg border border-gray-200 bg-gray-50 p-3"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <label htmlFor={userId} className="block">
                  <span className="mb-1 block text-xs font-medium text-gray-700">
                    Username
                  </span>
                  <input
                    id={userId}
                    type="text"
                    autoCapitalize="none"
                    autoCorrect="off"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className={INPUT_CLASS}
                  />
                  <span className="mt-1 block text-xs text-gray-400">
                    {USERNAME_HINT}
                  </span>
                </label>
                <div>
                  <label
                    htmlFor={passId}
                    className="mb-1 block text-xs font-medium text-gray-700"
                  >
                    Password
                  </label>
                  <PasswordField id={passId} value={password} onChange={setPassword} />
                  <span className="mt-2 block text-xs text-gray-400">
                    Copy this before you create the account — it is not shown
                    again afterwards.
                  </span>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                <button type="submit" disabled={busy} className={BTN_PRIMARY}>
                  {pending === 'create' && (
                    <Loader2 size={15} className="animate-spin" />
                  )}
                  Create login for {firstName(member.full_name)}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCreating(false)
                    setPassword('')
                    setErr(null)
                  }}
                  className={BTN_QUIET}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </>
      )}

      {notice && <p className="mt-2 text-xs text-gray-500">{notice}</p>}
      {err && <p className="mt-2 text-xs text-red-700">{err}</p>}
    </div>
  )
}

/** Add / edit form. `member === null` means "new person". */
function MemberForm({
  member,
  managers,
  onCancel,
  onSubmit,
}: {
  member: StaffMember | null
  managers: StaffMember[]
  onCancel: () => void
  onSubmit: (input: StaffMemberInput) => Promise<void>
}) {
  const ids = {
    full: useId(),
    known: useId(),
    dept: useId(),
    manager: useId(),
  }

  const [fullName, setFullName] = useState(member?.full_name ?? '')
  const [knownAs, setKnownAs] = useState(member?.known_as ?? '')
  const [department, setDepartment] = useState(member?.department ?? '')
  const [managerId, setManagerId] = useState(member?.manager_id ?? '')
  const [isManager, setIsManager] = useState(member?.is_manager ?? false)
  const [active, setActive] = useState(member?.active ?? true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    if (!fullName.trim()) {
      setErr('Enter a full name.')
      return
    }
    setErr(null)
    setBusy(true)
    try {
      await onSubmit({
        // Left blank, `known_as` falls back to the first name in presenceApi —
        // the column is NOT NULL and is what name resolution matches on.
        full_name: fullName.trim(),
        known_as: knownAs.trim() || firstName(fullName),
        department: department.trim() || null,
        manager_id: managerId || null,
        is_manager: isManager,
        active,
      })
    } catch {
      // The panel shows the message; keep the form open so nothing is lost.
      setBusy(false)
      return
    }
    setBusy(false)
  }

  return (
    <form onSubmit={handleSubmit}>
      {err && <p className="mb-2 text-xs text-red-700">{err}</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <label htmlFor={ids.full} className="block">
          <span className="mb-1 block text-xs font-medium text-gray-700">
            Full name
          </span>
          <input
            id={ids.full}
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className={INPUT_CLASS}
          />
        </label>

        <label htmlFor={ids.known} className="block">
          <span className="mb-1 block text-xs font-medium text-gray-700">
            Known as
          </span>
          <input
            id={ids.known}
            type="text"
            value={knownAs}
            onChange={(e) => setKnownAs(e.target.value)}
            placeholder={firstName(fullName) || 'e.g. Sandy'}
            className={INPUT_CLASS}
          />
        </label>

        <label htmlFor={ids.dept} className="block">
          <span className="mb-1 block text-xs font-medium text-gray-700">
            Department
          </span>
          <input
            id={ids.dept}
            type="text"
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            placeholder="Optional"
            className={INPUT_CLASS}
          />
        </label>

        <label htmlFor={ids.manager} className="block">
          <span className="mb-1 block text-xs font-medium text-gray-700">
            Manager
          </span>
          <select
            id={ids.manager}
            value={managerId}
            onChange={(e) => setManagerId(e.target.value)}
            className={INPUT_CLASS}
          >
            <option value="">No manager</option>
            {managers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.full_name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4">
        <label className="inline-flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={isManager}
            onChange={(e) => setIsManager(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 accent-jade-600"
          />
          Is a manager
        </label>
        <label className="inline-flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 accent-jade-600"
          />
          Active
        </label>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={BTN_PRIMARY}>
          {busy && <Loader2 size={15} className="animate-spin" />}
          {member ? 'Save changes' : 'Add person'}
        </button>
        <button type="button" onClick={onCancel} className={BTN_QUIET}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function BoardSkeleton() {
  return (
    <div className="mt-4 space-y-4">
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i} className="rounded-xl border border-gray-200 bg-white">
          <div className="border-b border-gray-200 px-4 py-2.5">
            <div className="h-5 w-28 animate-pulse rounded-full bg-gray-100" />
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
