import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  UserPlus,
  Loader2,
  AlertCircle,
  ShieldCheck,
  Lock,
  KeyRound,
  UserX,
  UserCheck,
  Check,
} from 'lucide-react'
import { adminUsers, ApiError, USERNAME_HINT, USERNAME_RE } from '../../lib/api'
import { formatDate } from '../../lib/format'
import { useAuth } from '../../context/AuthContext'
import Modal from '../../components/admin/Modal'
import ConfirmDialog from '../../components/admin/ConfirmDialog'
import PasswordField from '../../components/admin/PasswordField'

interface AdminUser {
  id: string
  username: string
  displayName: string
  role: 'admin' | 'worker'
  active: boolean
  createdAt: string
}

export default function Users() {
  const { profile } = useAuth()
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [showAdd, setShowAdd] = useState(false)
  const [resetFor, setResetFor] = useState<AdminUser | null>(null)
  /** The account waiting on a "yes, deactivate them" from the dialog. */
  const [confirm, setConfirm] = useState<AdminUser | null>(null)
  const [actionBusy, setActionBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await adminUsers<{ users: AdminUser[] }>({ action: 'list' })
      setUsers(res.users)
    } catch (err) {
      setUsers(null)
      setError(err instanceof Error ? err.message : 'Could not load users.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  /**
   * Reactivating is instant; deactivating goes through the dialog.
   *
   * There is deliberately only one control here. Accounts are no longer
   * deleted — `leave_requests` references `profiles` with `on delete restrict`
   * so that "who approved this absence" outlives the approver leaving — which
   * made the old Delete button and this toggle the same operation wearing
   * different words. The destructive-looking one is gone.
   */
  async function handleToggleActive(user: AdminUser) {
    if (user.active) {
      setConfirm(user)
      return
    }
    setActionBusy(true)
    try {
      await adminUsers({ action: 'setActive', userId: user.id, active: true })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the account.')
    } finally {
      setActionBusy(false)
    }
  }

  async function confirmDeactivate() {
    if (!confirm) return
    setActionBusy(true)
    try {
      await adminUsers({ action: 'deactivate', userId: confirm.id })
      setConfirm(null)
      await load()
    } catch (err) {
      setConfirm(null)
      setError(err instanceof Error ? err.message : 'The action could not be completed.')
    } finally {
      setActionBusy(false)
    }
  }

  return (
    <div className="mx-auto h-full max-w-5xl overflow-y-auto p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-gray-900">
            Users
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage worker accounts and admin access.
          </p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="inline-flex min-h-[44px] shrink-0 items-center gap-2 rounded-lg bg-jade-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-jade-700"
        >
          <UserPlus size={16} />
          <span className="hidden sm:inline">Add worker</span>
          <span className="sm:hidden">Add</span>
        </button>
      </div>

      {error && (
        <div className="mt-5 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle size={18} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading && (
        <div className="mt-6 space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-xl border border-gray-200 bg-white"
            />
          ))}
        </div>
      )}

      {!loading && users && users.length > 0 && (
        <ul className="mt-6 space-y-3">
          {users.map((u) => (
            <UserRow
              key={u.id}
              user={u}
              isSelf={u.id === profile?.id}
              busy={actionBusy}
              onReset={() => setResetFor(u)}
              onToggleActive={() => handleToggleActive(u)}
            />
          ))}
        </ul>
      )}

      {!loading && users && users.length === 0 && !error && (
        <p className="mt-10 text-center text-sm text-gray-500">
          No accounts yet.
        </p>
      )}

      {showAdd && (
        <AddWorkerModal
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false)
            load()
          }}
        />
      )}

      {resetFor && (
        <ResetPasswordModal
          user={resetFor}
          onClose={() => setResetFor(null)}
          onDone={() => setResetFor(null)}
        />
      )}

      {confirm && (
        <ConfirmDialog
          title={`Deactivate ${confirm.displayName}?`}
          message="They will be signed out and cannot sign in until reactivated. Nothing is deleted — their search history, leave requests and approvals are kept, and you can reactivate the account at any time."
          confirmLabel="Deactivate"
          busy={actionBusy}
          onConfirm={confirmDeactivate}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  )
}

function UserRow({
  user,
  isSelf,
  busy,
  onReset,
  onToggleActive,
}: {
  user: AdminUser
  isSelf: boolean
  busy: boolean
  onReset: () => void
  onToggleActive: () => void
}) {
  const isAdmin = user.role === 'admin'
  return (
    <li className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-gray-900">
              {user.displayName}
            </span>
            {isAdmin ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-jade-50 px-2 py-0.5 text-xs font-medium text-jade-700">
                <ShieldCheck size={11} />
                Admin
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                Worker
              </span>
            )}
            {user.active ? (
              <span className="inline-flex items-center rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
                Active
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                Deactivated
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-gray-500">
            <span className="font-mono">{user.username}</span>
            <span className="mx-1.5 text-gray-300">·</span>
            Added {formatDate(user.createdAt)}
          </p>
        </div>

        {isAdmin ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-gray-400">
            <Lock size={13} />
            Admin accounts are protected
          </span>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={onReset}
              disabled={busy}
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-60"
            >
              <KeyRound size={15} />
              Reset password
            </button>
            <button
              onClick={onToggleActive}
              disabled={busy || (user.active && isSelf)}
              title={
                user.active && isSelf
                  ? 'You cannot deactivate your own account.'
                  : undefined
              }
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-60"
            >
              {user.active ? (
                <>
                  <UserX size={15} />
                  Deactivate
                </>
              ) : (
                <>
                  <UserCheck size={15} />
                  Reactivate
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </li>
  )
}

function AddWorkerModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void
}) {
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (submitting) return
    setError(null)

    const uname = username.trim().toLowerCase()
    if (!USERNAME_RE.test(uname)) {
      setError(`Username must be ${USERNAME_HINT}`)
      return
    }
    if (!displayName.trim()) {
      setError('Enter a display name.')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }

    setSubmitting(true)
    try {
      await adminUsers({
        action: 'create',
        username: uname,
        displayName: displayName.trim(),
        password,
      })
      onCreated()
    } catch (err) {
      if (err instanceof ApiError) setError(err.message)
      else setError(err instanceof Error ? err.message : 'Could not create the account.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal title="Add worker" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-gray-700">
            Username
          </span>
          <input
            type="text"
            autoFocus
            autoCapitalize="none"
            autoCorrect="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="e.g. meera"
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base outline-none transition focus:border-jade-600 focus:ring-2 focus:ring-jade-600/20"
          />
          <span className="mt-1 block text-xs text-gray-400">{USERNAME_HINT}</span>
        </label>

        <label className="mt-4 block">
          <span className="mb-1.5 block text-sm font-medium text-gray-700">
            Display name
          </span>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g. Meera Patel"
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base outline-none transition focus:border-jade-600 focus:ring-2 focus:ring-jade-600/20"
          />
        </label>

        <div className="mt-4">
          <span className="mb-1.5 block text-sm font-medium text-gray-700">
            Password
          </span>
          <PasswordField value={password} onChange={setPassword} />
          <span className="mt-2 block text-xs text-gray-400">
            Copy this and share it with the worker — they can use it to sign in.
          </span>
        </div>

        <div className="mt-6 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] flex-1 rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg bg-jade-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-jade-700 disabled:opacity-60"
          >
            {submitting && <Loader2 size={16} className="animate-spin" />}
            {submitting ? 'Creating…' : 'Create worker'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function ResetPasswordModal({
  user,
  onClose,
  onDone,
}: {
  user: AdminUser
  onClose: () => void
  onDone: () => void
}) {
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (submitting) return
    setError(null)

    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }

    setSubmitting(true)
    try {
      await adminUsers({
        action: 'resetPassword',
        userId: user.id,
        password,
      })
      setDone(true)
    } catch (err) {
      if (err instanceof ApiError) setError(err.message)
      else setError(err instanceof Error ? err.message : 'Could not reset the password.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal title={`Reset password — ${user.displayName}`} onClose={onClose}>
      {done ? (
        <div>
          <div className="flex items-start gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2.5 text-sm text-green-700">
            <Check size={16} className="mt-0.5 shrink-0" />
            <span>
              Password updated. Share the new password below with {user.displayName}.
            </span>
          </div>
          <p className="mt-4 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-center font-mono text-sm text-gray-900">
            {password}
          </p>
          <button
            onClick={onDone}
            className="mt-5 w-full rounded-lg bg-jade-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-jade-700"
          >
            Done
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit}>
          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <span className="mb-1.5 block text-sm font-medium text-gray-700">
            New password
          </span>
          <PasswordField value={password} onChange={setPassword} />

          <div className="mt-6 flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] flex-1 rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg bg-jade-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-jade-700 disabled:opacity-60"
            >
              {submitting && <Loader2 size={16} className="animate-spin" />}
              {submitting ? 'Saving…' : 'Reset password'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  )
}
