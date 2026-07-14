import { useEffect, useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { Loader2, AlertCircle } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { adminUsers } from '../lib/api'
import Logo from '../components/Logo'

export default function Login() {
  const { session, loading: authLoading, login } = useAuth()
  const navigate = useNavigate()

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checkingBootstrap, setCheckingBootstrap] = useState(true)

  // First-run bootstrap check. Silently ignore failures (backend may be undeployed).
  useEffect(() => {
    let active = true
    adminUsers<{ needsBootstrap: boolean }>({ action: 'bootstrapStatus' })
      .then((res) => {
        if (active && res?.needsBootstrap) {
          navigate('/setup', { replace: true })
        }
      })
      .catch(() => {
        /* stay on login */
      })
      .finally(() => {
        if (active) setCheckingBootstrap(false)
      })
    return () => {
      active = false
    }
  }, [navigate])

  if (!authLoading && session) {
    return <Navigate to="/" replace />
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (submitting) return
    setError(null)
    if (!username.trim() || !password) {
      setError('Enter your username and password.')
      return
    }
    setSubmitting(true)
    try {
      await login(username, password)
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo size={64} />
          <h1 className="mt-3 text-xl font-semibold tracking-tight text-gray-900">
            Jade Agent
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Sign in to search company files
          </p>
        </div>

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
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 outline-none transition focus:border-jade-600 focus:ring-2 focus:ring-jade-600/20"
              placeholder="your.username"
            />
          </label>

          <label className="mt-4 block">
            <span className="mb-1.5 block text-sm font-medium text-gray-700">
              Password
            </span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 outline-none transition focus:border-jade-600 focus:ring-2 focus:ring-jade-600/20"
              placeholder="••••••••"
            />
          </label>

          <button
            type="submit"
            disabled={submitting || checkingBootstrap}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-jade-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-jade-700 disabled:opacity-60"
          >
            {submitting && <Loader2 size={16} className="animate-spin" />}
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
