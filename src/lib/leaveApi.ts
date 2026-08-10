// Typed access for leave requests — phase 2 of the presence board.
//
// Three permission stories, and they are not the same one:
//
//   leave_requests  — READ ONLY from the browser. RLS carries a select policy
//                     and deliberately no insert/update/delete policy for any
//                     role, admins included: the approver is resolved
//                     server-side, so a client that could write would name
//                     itself its own approver. Every mutation below therefore
//                     goes through a leave-* edge function.
//   staff_directory — every authenticated user may read; only admins may
//                     write. `profile_id` (the login a roster person signs in
//                     with) is covered by the table's existing admin-only
//                     write policy, so `setStaffAccount` simply lets the RLS
//                     error surface rather than second-guessing the role.
//
// Transport is shared with api.ts — one definition of how a Jade request is
// authorised — but the error parsing is local, because the leave validator
// returns an `errors` array that `parseJsonError` would throw away. It is the
// one thing the submit form most needs: the validator deliberately reports
// every problem at once so nobody fixes a date, resubmits, and is told about
// the reason field.

import { ApiError, FUNCTIONS_BASE, authHeaders } from './api'
import { addDays } from './presenceApi'
import { supabase } from './supabase'

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The absences a person can ask for, which is a narrower list than
 * `PresenceStatus`: `late`, `off_site` and `other` are reported after the fact
 * by the office manager, never requested in advance.
 */
export type LeaveType = 'sick' | 'local_leave' | 'vacation_leave' | 'permission'

/** No `partial` here, unlike presence: "gone for some slice of the day" is an
 * observation, not something anyone requests. A half day is one day — the
 * backend rejects `am`/`pm` across a range. */
export type LeaveDayPart = 'full' | 'am' | 'pm'

export type LeaveStatus = 'pending' | 'approved' | 'declined' | 'cancelled'

/** A row of `leave_requests`. */
export interface LeaveRequest {
  id: string
  /** Who the leave is for — a roster row, not a login. */
  requester_staff_id: string
  /** Who typed it in. Differs from the above for an on-behalf-of filing. */
  submitted_by_profile_id: string
  leave_type: LeaveType
  /** Calendar date, `YYYY-MM-DD`. */
  start_date: string
  end_date: string
  day_part: LeaveDayPart
  reason: string | null
  status: LeaveStatus
  /** Frozen at submission time, so a reorganisation cannot retroactively
   * change who approved last quarter's leave. Null when nobody was resolved —
   * those fall to the admins. */
  approver_staff_id: string | null
  decided_by_profile_id: string | null
  decided_at: string | null
  decision_note: string | null
  created_at: string
}

/**
 * A roster row, including the login it is linked to.
 *
 * `profile_id` is null for most people and is expected to stay that way: there
 * are three logins against eighteen people on the roster, and site staff will
 * never have one. Anything reading this must treat "no account" as the normal
 * case, not an error.
 */
export interface StaffRecord {
  id: string
  full_name: string
  known_as: string
  department: string | null
  manager_id: string | null
  is_manager: boolean
  active: boolean
  profile_id: string | null
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A leave-* failure. Extends `ApiError` so existing `instanceof ApiError`
 * handling keeps working, and adds the validator's full problem list.
 *
 * Notable codes:
 *   `validation`     — `errors` holds every problem found, all worth showing.
 *   `not_on_roster`  — the signed-in login has no linked staff record. Common,
 *                      not exceptional: the caller should explain rather than
 *                      show a form that cannot succeed.
 */
export class LeaveApiError extends ApiError {
  errors: string[]

  constructor(
    message: string,
    status: number,
    code?: string,
    errors?: string[],
  ) {
    super(message, status, code)
    this.name = 'LeaveApiError'
    this.errors = errors ?? []
  }
}

/** POST a JSON body to a leave-* function and parse the JSON reply. */
async function postLeave<T>(
  fn: string,
  body: Record<string, unknown>,
  fallback: string,
): Promise<T> {
  const res = await fetch(`${FUNCTIONS_BASE}/${fn}`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    let message = fallback
    let code: string | undefined
    let errors: string[] | undefined
    try {
      const parsed = (await res.json()) as {
        error?: unknown
        code?: unknown
        errors?: unknown
      }
      if (typeof parsed.error === 'string' && parsed.error) message = parsed.error
      if (typeof parsed.code === 'string') code = parsed.code
      if (Array.isArray(parsed.errors)) {
        errors = parsed.errors.filter((e): e is string => typeof e === 'string')
      }
    } catch {
      // Not JSON (a gateway error page, say) — keep the fallback message.
    }
    throw new LeaveApiError(message, res.status, code, errors)
  }

  return (await res.json()) as T
}

// ---------------------------------------------------------------------------
// Edge functions
// ---------------------------------------------------------------------------

export interface SubmitLeaveInput {
  /** Omit to file for yourself. Present only for an on-behalf-of filing. */
  requesterStaffId?: string
  leaveType: LeaveType
  startDate: string
  endDate: string
  dayPart: LeaveDayPart
  reason?: string
}

export interface SubmitLeaveResult {
  requestId: string
  status: LeaveStatus
  approverId: string | null
  /** Who it routed to, in words — people should know who is deciding. */
  approverName: string | null
  /** Why it routed there ("your department manager", "no manager set"). */
  approverReason: string | null
  /** `YYYY-MM-DD` days that already show an absence. A warning, never a
   * failure: the request was still filed. */
  overlaps: string[]
}

/** File a leave request. Throws `LeaveApiError`; see the class for the codes
 * worth branching on. */
export function submitLeave(
  input: SubmitLeaveInput,
): Promise<SubmitLeaveResult> {
  return postLeave<SubmitLeaveResult>(
    'leave-submit',
    { ...input },
    'Could not file that leave request.',
  )
}

/**
 * The two Outlook drafts a decision produces.
 *
 * Only whether each was written is used by the UI — nothing is sent, and there
 * is nothing to click through to from here. Both are null when the decision
 * was a decline, or when the drafts could not be written (see
 * `draftWarnings`).
 */
export interface LeaveDrafts {
  allStaff: string | null
  requester: string | null
}

export interface DecideLeaveResult {
  requestId: string
  status: LeaveStatus
  /** Days written onto the presence board. Zero for a decline. */
  rowsWritten: number
  drafts: LeaveDrafts
  /** Things that did not work but did not stop the decision — "no email on
   * file for this person", typically. */
  draftWarnings: string[]
}

export function decideLeave(
  requestId: string,
  decision: 'approved' | 'declined',
  note?: string,
): Promise<DecideLeaveResult> {
  const body: Record<string, unknown> = { requestId, decision }
  if (note?.trim()) body.note = note.trim()
  return postLeave<DecideLeaveResult>(
    'leave-decide',
    body,
    'Could not record that decision.',
  )
}

export interface CancelLeaveResult {
  requestId: string
  status: LeaveStatus
  /** Board rows removed — non-zero when an already-approved request is pulled. */
  presenceRowsRemoved: number
}

export function cancelLeave(requestId: string): Promise<CancelLeaveResult> {
  return postLeave<CancelLeaveResult>(
    'leave-cancel',
    { requestId },
    'Could not cancel that request.',
  )
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const LEAVE_COLUMNS =
  'id,requester_staff_id,submitted_by_profile_id,leave_type,start_date,end_date,' +
  'day_part,reason,status,approver_staff_id,decided_by_profile_id,decided_at,' +
  'decision_note,created_at'

const STAFF_RECORD_COLUMNS =
  'id,full_name,known_as,department,manager_id,is_manager,active,profile_id'

/**
 * Every leave request the signed-in user may see, newest first.
 *
 * No filter is applied here on purpose: RLS already narrows this to the four
 * people with a stake in a request (requester, approver, whoever filed it, and
 * admins), and re-stating that as a client-side `.eq()` would be a second copy
 * of the rule that could drift from the policy. The page partitions the result
 * into "mine" and "awaiting my decision".
 */
export async function fetchLeaveRequests(): Promise<LeaveRequest[]> {
  const { data, error } = await supabase
    .from('leave_requests')
    .select(LEAVE_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(500)

  if (error) {
    throw new Error('Could not load leave requests. Please try again.')
  }
  return (data ?? []) as unknown as LeaveRequest[]
}

/** The whole roster with its login links, active people first. */
export async function fetchStaffRecords(): Promise<StaffRecord[]> {
  const { data, error } = await supabase
    .from('staff_directory')
    .select(STAFF_RECORD_COLUMNS)
    .order('active', { ascending: false })
    .order('full_name', { ascending: true })

  if (error) {
    throw new Error('Could not load the staff roster. Please try again.')
  }
  return (data ?? []) as unknown as StaffRecord[]
}

// ---------------------------------------------------------------------------
// Account linking (admin only — enforced by RLS, not by this file)
//
// Lives here rather than in presenceApi because it exists for leave: routing a
// request to "this person's manager" needs a way to turn the signed-in session
// into a roster row, and `staff_directory.profile_id` is that way. It is also
// the onboarding path for the fifteen people who have no login yet, which is
// why the Report roster panel calls it.
// ---------------------------------------------------------------------------

/** `staff_directory.id` → the login it is linked to. Unlinked rows are absent
 * from the map rather than present with a null, so `has()` reads as "has an
 * account". */
export async function fetchStaffAccountLinks(): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from('staff_directory')
    .select('id,profile_id')

  if (error) {
    throw new Error('Could not check which staff have a login. Please try again.')
  }

  const links = new Map<string, string>()
  for (const row of (data ?? []) as { id: string; profile_id: string | null }[]) {
    if (row.profile_id) links.set(row.id, row.profile_id)
  }
  return links
}

/** Point a roster row at a login, or pass null to unlink it. */
export async function setStaffAccount(
  staffId: string,
  profileId: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('staff_directory')
    .update({ profile_id: profileId })
    .eq('id', staffId)

  if (error) throw new Error(linkMessage(error))
}

/** The two ways this write realistically fails, in plain words. */
function linkMessage(error: { code?: string }): string {
  if (error.code === '42501') {
    return 'Only an administrator can link an account to a staff member.'
  }
  // 23505: profile_id is unique — one login is one person.
  if (error.code === '23505') {
    return 'That login is already linked to somebody else on the roster.'
  }
  return 'Could not link that account. Please try again.'
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * Working days covered by a request: Monday–Friday only, and half a day for an
 * `am`/`pm` request (which the backend guarantees is a single date).
 *
 * Public holidays are not subtracted — the app has no holiday calendar, and
 * quietly guessing at one would put a number in front of a manager that neither
 * of us could defend.
 */
export function workingDays(
  startDate: string,
  endDate: string,
  dayPart: LeaveDayPart = 'full',
): number {
  if (!startDate || !endDate || endDate < startDate) return 0

  let count = 0
  let day = startDate
  // A guard, not a business rule: a malformed date must not spin forever.
  for (let i = 0; i < 400 && day <= endDate; i++) {
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay() // 0 Sun … 6 Sat
    if (dow !== 0 && dow !== 6) count++
    day = addDays(day, 1)
  }

  if (dayPart === 'full') return count
  return count > 0 ? 0.5 : 0
}

/** Every calendar date in `[startDate, endDate]`, inclusive. */
export function datesBetween(startDate: string, endDate: string): string[] {
  if (!startDate || !endDate || endDate < startDate) return []
  const days: string[] = []
  let day = startDate
  for (let i = 0; i < 400 && day <= endDate; i++) {
    days.push(day)
    day = addDays(day, 1)
  }
  return days
}
