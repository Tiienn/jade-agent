import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  AlertCircle,
  BellRing,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Mail,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import { mailConnect } from '../../lib/emailApi'
import {
  configureLexpress,
  lexpressStatus,
  runLexpressMonitor,
  setLexpressEnabled,
  type LexpressStatus,
} from '../../lib/lexpressApi'

function stamp(value: string | null): string {
  if (!value) return 'Never'
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.'
}

export default function LexpressMonitorCard() {
  const [status, setStatus] = useState<LexpressStatus | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setStatus(await lexpressStatus())
    } catch (e) {
      setError(messageOf(e))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function saveCredentials(event: FormEvent) {
    event.preventDefault()
    setBusy('save')
    setError(null)
    setNotice(null)
    try {
      const result = await configureLexpress(email.trim(), password)
      setPassword('')
      setNotice(
        `Connected and enabled. ${result.baselined} existing enquiries were baselined; only later enquiries will be emailed.`,
      )
      await load()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(null)
    }
  }

  async function toggle() {
    if (!status) return
    setBusy('toggle')
    setError(null)
    setNotice(null)
    try {
      await setLexpressEnabled(!status.enabled)
      setNotice(status.enabled ? 'Automatic checks paused.' : 'Automatic checks resumed.')
      await load()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(null)
    }
  }

  async function runNow() {
    setBusy('run')
    setError(null)
    setNotice(null)
    try {
      const result = await runLexpressMonitor()
      setNotice(
        result.sent > 0
          ? result.deliveryStatus === 'confirmed'
            ? `${result.sent} new ${result.sent === 1 ? 'enquiry was' : 'enquiries were'} emailed to ${result.recipient} and confirmed in Sent Items.`
            : `${result.sent} new ${result.sent === 1 ? 'enquiry was' : 'enquiries were'} accepted by Microsoft for ${result.recipient}; Sent Items confirmation is still pending.`
          : `Checked ${result.checked} enquiries. Nothing new to send.`,
      )
      await load()
    } catch (e) {
      setError(messageOf(e))
      await load()
    } finally {
      setBusy(null)
    }
  }

  async function reconnectMailbox() {
    setBusy('mail')
    setError(null)
    try {
      const { authUrl } = await mailConnect()
      window.location.assign(authUrl)
    } catch (e) {
      setError(messageOf(e))
      setBusy(null)
    }
  }

  return (
    <section className="mt-10 border-t border-gray-200 pt-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <BellRing size={19} className="text-jade-700" />
            <h2 className="text-lg font-semibold text-gray-900">
              L&apos;Express enquiry monitor
            </h2>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-gray-500">
            Checks the professional portal hourly from 08:00 to 18:00 Mauritius
            time and emails each new enquiry to charles.li@jadegroup.mu.
          </p>
        </div>
        {status?.credentialsConfigured && (
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
              status.enabled
                ? 'bg-green-50 text-green-700'
                : 'bg-gray-100 text-gray-600'
            }`}
          >
            {status.enabled ? <CheckCircle2 size={14} /> : <Pause size={14} />}
            {status.enabled ? 'Running' : 'Paused'}
          </span>
        )}
      </div>

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle size={18} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          <CheckCircle2 size={18} className="mt-0.5 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {status?.credentialsConfigured && (
        <div className="mt-5 rounded-xl border border-gray-200 bg-white p-4">
          <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">
                Known enquiries
              </dt>
              <dd className="mt-1 font-semibold text-gray-900">{status.knownLeads}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">
                Last checked
              </dt>
              <dd className="mt-1 text-gray-700">{stamp(status.lastCheckedAt)}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">
                Last notification
              </dt>
              <dd className="mt-1 text-gray-700">{stamp(status.lastSentAt)}</dd>
              {status.lastSentAt && (
                <dd className={`mt-1 text-xs font-medium ${
                  status.lastDeliveryStatus === 'confirmed'
                    ? 'text-green-700'
                    : status.lastDeliveryStatus === 'accepted'
                      ? 'text-amber-700'
                      : 'text-gray-500'
                }`}>
                  {status.lastDeliveryStatus === 'confirmed'
                    ? 'Confirmed in Sent Items'
                    : status.lastDeliveryStatus === 'accepted'
                      ? 'Accepted by Microsoft; confirmation pending'
                      : 'Older notification — delivery was not verified'}
                </dd>
              )}
              {status.lastSentWebLink && (
                <dd className="mt-1">
                  <a
                    href={status.lastSentWebLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-semibold text-jade-700 underline"
                  >
                    Open sent email <ExternalLink size={12} />
                  </a>
                </dd>
              )}
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">
                Sending mailbox
              </dt>
              <dd className="mt-1 break-all text-gray-700">
                {status.mailboxEmail ?? 'Not connected'}
              </dd>
            </div>
          </dl>
          {status.lastError && (
            <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Last check: {status.lastError}
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={runNow}
              disabled={busy !== null}
              className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-jade-600 px-3 text-sm font-semibold text-white hover:bg-jade-700 disabled:opacity-60"
            >
              {busy === 'run' ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              Check now
            </button>
            <button
              onClick={toggle}
              disabled={busy !== null}
              className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
            >
              {status.enabled ? <Pause size={15} /> : <Play size={15} />}
              {status.enabled ? 'Pause checks' : 'Resume checks'}
            </button>
            <button
              onClick={reconnectMailbox}
              disabled={busy !== null}
              className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
            >
              <Mail size={15} />
              Reconnect Outlook
              <ExternalLink size={13} />
            </button>
          </div>
        </div>
      )}

      <form onSubmit={saveCredentials} className="mt-5 rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
          <ShieldCheck size={17} className="text-jade-700" />
          {status?.credentialsConfigured ? 'Update portal login' : 'Connect portal login'}
        </div>
        <p className="mt-1 text-xs text-gray-500">
          The password is encrypted in Supabase Vault and is never returned to this page.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label>
            <span className="mb-1.5 block text-sm font-medium text-gray-700">L&apos;Express email</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              required
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-jade-600 focus:ring-2 focus:ring-jade-600/20"
            />
          </label>
          <label>
            <span className="mb-1.5 block text-sm font-medium text-gray-700">L&apos;Express password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-jade-600 focus:ring-2 focus:ring-jade-600/20"
            />
          </label>
        </div>
        <button
          type="submit"
          disabled={busy !== null}
          className="mt-4 inline-flex min-h-[42px] items-center gap-2 rounded-lg bg-jade-600 px-4 text-sm font-semibold text-white hover:bg-jade-700 disabled:opacity-60"
        >
          {busy === 'save' && <Loader2 size={15} className="animate-spin" />}
          Save, test and enable
        </button>
      </form>
    </section>
  )
}
