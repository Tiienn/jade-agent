import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, AlertCircle, CheckCircle2 } from 'lucide-react'
import { adminUsers } from '../lib/api'
import Logo from '../components/Logo'

export default function Setup() {
  const navigate = useNavigate()
  const [checking, setChecking] = useState(true)
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  // Guard: if bootstrap is no longer needed (or the check fails), go to login.
  useEffect(() => {
    let active = true
    adminUsers<{ needsBootstrap: boolean }>({ action: 'bootstrapStatus' })
      .then((res) => {
        if (!active) return
        if (!res?.needsBootstrap) navigate('/login', { replace: true })
        else setChecking(false)
      })
      .catch(() => {
        if (active) navigate('/login', { replace: true })
      })
    return () => {
      active = false
    }
  }, [navigate])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (submitting) return
    setError(null)

    if (!username.trim() || !displayName.trim()) {
      setError('Fill in every field.')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }

    setSubmitting(true)
    try {
      await adminUsers({
        action: 'bootstrap',
        username: username.trim(),
        displayName: displayName.trim(),
        password,
      })
      setDone(true)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not create the admin account.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <Loader2 size={28} className="animate-spin text-gray-400" />
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo size={64} />
          <h1 className="mt-3 text-xl font-semibold tracking-tight text-gray-900">
            Create the admin account
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            This one-time setup creates the first administrator.
          </p>
        </div>

        {done ? (
          <div className="rounded-2xl border border-gray-200 bg-white p-6 text-center shadow-sm">
            <CheckCircle2 size={40} className="mx-auto text-jade-600" />
            <h2 className="mt-3 text-base font-semibold text-gray-900">
              Admin account created
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              You can now sign in with your new credentials.
            </p>
            <button
              onClick={() => navigate('/login', { replace: true })}
              className="mt-5 w-full rounded-lg bg-jade-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-jade-700"
            >
              Go to sign in
            </button>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm"
          >
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
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base outline-none transition focus:border-jade-600 focus:ring-2 focus:ring-jade-600/20"
                placeholder="admin"
              />
            </label>

            <label className="mt-4 block">
              <span className="mb-1.5 block text-sm font-medium text-gray-700">
                Display name
              </span>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base outline-none transition focus:border-jade-600 focus:ring-2 focus:ring-jade-600/20"
                placeholder="Jane Doe"
              />
            </label>

            <label className="mt-4 block">
              <span className="mb-1.5 block text-sm font-medium text-gray-700">
                Password
              </span>
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base outline-none transition focus:border-jade-600 focus:ring-2 focus:ring-jade-600/20"
                placeholder="At least 8 characters"
              />
            </label>

            <button
              type="submit"
              disabled={submitting}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-jade-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-jade-700 disabled:opacity-60"
            >
              {submitting && <Loader2 size={16} className="animate-spin" />}
              {submitting ? 'Creating…' : 'Create admin account'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
