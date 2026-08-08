import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  AlertCircle, // red banner
  BellOff, // "ignore sender"
  Check, // "Copied"
  ChevronDown, // collapsible chevron
  Copy,
  ExternalLink,
  Inbox, // empty states
  Loader2,
  Mail,
  PenLine, // "Write a draft"
  RefreshCw,
  Trash2, // remove a filter rule
  X, // close the mobile sheet
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useIsDesktop } from '../lib/useIsDesktop'
import { relativeTime } from '../lib/format'
import {
  ApiError,
  mailConnect,
  mailDraft,
  mailStatus,
  mailSync,
  type EmailDraft,
  type EmailMessage,
  type EmailRule,
  type MailStatus,
  type TriageVerdict,
} from '../lib/emailApi'

/** Columns of email_messages the list needs. Explicit, so a new column added
 * to the table cannot silently widen what the browser pulls down. */
const MESSAGE_COLUMNS =
  'id,user_id,conversation_id,from_email,from_name,subject,received_at,to_me,triage,triage_reason,web_link'

interface TabDef {
  value: TriageVerdict
  label: string
  empty: string
}

const TABS: TabDef[] = [
  { value: 'action', label: 'Needs you', empty: 'Nothing needs you right now.' },
  { value: 'fyi', label: 'FYI', empty: 'Nothing here.' },
  { value: 'ignore', label: 'Filtered', empty: 'Nothing filtered yet.' },
]

/**
 * mail-callback bounces back to /email?error=<code> and deliberately keeps the
 * codes coarse — a forged consent state and an expired one look identical from
 * outside. These are the reader-facing translations.
 */
const CONNECT_ERRORS: Record<string, string> = {
  denied:
    'Microsoft sign-in was cancelled, so no mailbox was connected. You can try again.',
  state:
    'That connection link had expired. Please start the connection again from this page.',
  code: 'Microsoft did not send back an authorisation code. Please try again.',
  exchange: 'Microsoft could not complete the connection. Please try again.',
  store:
    'Your mailbox was authorised but the connection could not be saved. Please try again.',
}

function errMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error && e.message) return e.message
  return fallback
}

/** Sender display name, falling back to the address, then to a placeholder. */
function senderName(m: EmailMessage): string {
  return m.from_name?.trim() || m.from_email?.trim() || 'Unknown sender'
}

export default function Email() {
  const { profile } = useAuth()
  const userId = profile?.id ?? null
  const [searchParams, setSearchParams] = useSearchParams()
  const isDesktop = useIsDesktop()

  const connectErrorCode = searchParams.get('error')

  // --- connection ---------------------------------------------------------
  const [status, setStatus] = useState<MailStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [connectedNote, setConnectedNote] = useState(false)

  // --- list ---------------------------------------------------------------
  const [tab, setTab] = useState<TriageVerdict>('action')
  const [messages, setMessages] = useState<EmailMessage[] | null>(null)
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [counts, setCounts] = useState<Record<TriageVerdict, number> | null>(
    null,
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [ignoringId, setIgnoringId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  // --- sync ---------------------------------------------------------------
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)

  // --- draft --------------------------------------------------------------
  const [draft, setDraft] = useState<EmailDraft | null>(null)
  const [draftBody, setDraftBody] = useState('')
  const [draftLoading, setDraftLoading] = useState(false)
  const [writing, setWriting] = useState(false)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // --- filtered senders ---------------------------------------------------
  const [rulesOpen, setRulesOpen] = useState(false)
  const [rules, setRules] = useState<EmailRule[] | null>(null)
  const [rulesLoading, setRulesLoading] = useState(false)
  const [rulesError, setRulesError] = useState<string | null>(null)
  const [removingRuleId, setRemovingRuleId] = useState<string | null>(null)

  const toastTimer = useRef<number | null>(null)
  const copiedTimer = useRef<number | null>(null)
  const noteTimer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current)
      if (noteTimer.current) window.clearTimeout(noteTimer.current)
    },
    [],
  )

  const showToast = useCallback((text: string) => {
    setToast(text)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 5000)
  }, [])

  const selected =
    (selectedId && messages?.find((m) => m.id === selectedId)) || null

  // -----------------------------------------------------------------------
  // Loaders
  // -----------------------------------------------------------------------

  const loadStatus = useCallback(async () => {
    setStatusLoading(true)
    setStatusError(null)
    try {
      setStatus(await mailStatus())
    } catch (e) {
      setStatus(null)
      setStatusError(
        errMessage(e, 'Could not check your mailbox connection.'),
      )
    } finally {
      setStatusLoading(false)
    }
  }, [])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  const loadCounts = useCallback(async () => {
    if (!userId) return
    try {
      const pairs = await Promise.all(
        TABS.map(async (t) => {
          const { count } = await supabase
            .from('email_messages')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('triage', t.value)
          return [t.value, count ?? 0] as const
        }),
      )
      setCounts(
        Object.fromEntries(pairs) as unknown as Record<TriageVerdict, number>,
      )
    } catch {
      // Counts are decoration — a failure here must not blank the list.
    }
  }, [userId])

  const loadMessages = useCallback(
    async (triage: TriageVerdict) => {
      if (!userId) return
      setListLoading(true)
      setListError(null)
      const { data, error } = await supabase
        .from('email_messages')
        .select(MESSAGE_COLUMNS)
        .eq('user_id', userId)
        .eq('triage', triage)
        .order('received_at', { ascending: false })
        .limit(100)
      if (error) {
        setMessages(null)
        setListError('Could not load your mail. Please try again.')
      } else {
        setMessages((data ?? []) as EmailMessage[])
      }
      setListLoading(false)
    },
    [userId],
  )

  // Load (and reload) the list whenever the mailbox, user or tab changes.
  useEffect(() => {
    if (!userId || !status?.connected) return
    setSelectedId(null)
    loadMessages(tab)
    loadCounts()
  }, [userId, status?.connected, tab, loadMessages, loadCounts])

  const loadRules = useCallback(async () => {
    if (!userId) return
    setRulesLoading(true)
    setRulesError(null)
    const { data, error } = await supabase
      .from('email_rules')
      .select('id,user_id,pattern,action,created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
    if (error) {
      setRules(null)
      setRulesError('Could not load your filtered senders.')
    } else {
      setRules((data ?? []) as EmailRule[])
    }
    setRulesLoading(false)
  }, [userId])

  useEffect(() => {
    if (rulesOpen && rules === null && !rulesLoading) loadRules()
  }, [rulesOpen, rules, rulesLoading, loadRules])

  // Pull any draft already saved for the selected message.
  useEffect(() => {
    setDraft(null)
    setDraftBody('')
    setDraftError(null)
    setCopied(false)
    if (!selectedId || !userId) {
      setDraftLoading(false)
      return
    }

    let active = true
    setDraftLoading(true)
    supabase
      .from('email_drafts')
      .select('message_id,user_id,body,register,outlook_draft_id,created_at')
      .eq('message_id', selectedId)
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) return
        if (error) {
          setDraftError('Could not load the saved draft.')
        } else if (data) {
          const row = data as EmailDraft
          setDraft(row)
          setDraftBody(row.body)
        }
        setDraftLoading(false)
      })

    return () => {
      active = false
    }
  }, [selectedId, userId])

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  const runSync = useCallback(async () => {
    setSyncing(true)
    setSyncError(null)
    try {
      await mailSync()
      const next = await mailStatus()
      setStatus(next)
      if (next.connected) {
        await Promise.all([loadMessages(tab), loadCounts()])
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'mailbox_not_connected') {
        // The mailbox went away between page load and this click — drop back
        // to the connect screen rather than showing an inbox that cannot refresh.
        setStatus({
          connected: false,
          email: null,
          lastSyncAt: null,
          lastSyncError: null,
        })
      } else {
        setSyncError(errMessage(e, 'Sync failed. Please try again.'))
      }
    } finally {
      setSyncing(false)
    }
  }, [tab, loadMessages, loadCounts])

  // ?connected=1 lands here from mail-callback. Acknowledge it once, strip the
  // param so a refresh does not re-sync, and pull the first batch of mail.
  const handledConnect = useRef(false)
  useEffect(() => {
    if (searchParams.get('connected') !== '1' || handledConnect.current) return
    handledConnect.current = true

    setConnectedNote(true)
    noteTimer.current = window.setTimeout(() => setConnectedNote(false), 8000)

    const next = new URLSearchParams(searchParams)
    next.delete('connected')
    setSearchParams(next, { replace: true })

    runSync()
    // runSync is intentionally not a dependency: this must fire exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, setSearchParams])

  async function handleConnect() {
    setConnecting(true)
    setConnectError(null)
    try {
      const { authUrl } = await mailConnect()
      window.location.href = authUrl
    } catch (e) {
      setConnectError(
        errMessage(e, 'Could not start the mailbox connection. Please try again.'),
      )
      setConnecting(false)
    }
  }

  async function handleWriteDraft() {
    if (!selectedId) return
    setWriting(true)
    setDraftError(null)
    try {
      const res = await mailDraft(selectedId)
      setDraft({
        message_id: selectedId,
        user_id: userId ?? '',
        body: res.body,
        register: res.register,
        outlook_draft_id: res.outlookDraftId,
        created_at: new Date().toISOString(),
      })
      setDraftBody(res.body)
    } catch (e) {
      setDraftError(errMessage(e, 'Could not write a draft for this message.'))
    } finally {
      setWriting(false)
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(draftBody)
      setCopied(true)
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current)
      copiedTimer.current = window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setDraftError('Could not copy. Select the text and copy it manually.')
    }
  }

  async function handleIgnoreSender(m: EmailMessage) {
    const address = m.from_email?.trim().toLowerCase()
    if (!address || !userId) return

    setIgnoringId(m.id)
    const { error } = await supabase
      .from('email_rules')
      .insert({ user_id: userId, pattern: address, action: 'ignore' })

    // 23505 is the unique (user_id, pattern) violation — the rule is already
    // there, which is precisely the state the click was asking for. Treat it
    // as success rather than making the user wonder what went wrong.
    if (error && error.code !== '23505') {
      setListError('Could not add that filter. Please try again.')
      setIgnoringId(null)
      return
    }

    setMessages((prev) => prev?.filter((x) => x.id !== m.id) ?? prev)
    setCounts((prev) =>
      prev ? { ...prev, [tab]: Math.max(0, prev[tab] - 1) } : prev,
    )
    if (selectedId === m.id) setSelectedId(null)
    setIgnoringId(null)
    showToast(`Future mail from ${address} will be filtered.`)
    // Keep the "Filtered senders" list truthful if it is already open.
    if (rulesOpen) loadRules()
  }

  async function handleRemoveRule(rule: EmailRule) {
    setRemovingRuleId(rule.id)
    const { error } = await supabase
      .from('email_rules')
      .delete()
      .eq('id', rule.id)
    if (error) {
      setRulesError('Could not remove that filter. Please try again.')
    } else {
      setRules((prev) => prev?.filter((r) => r.id !== rule.id) ?? prev)
    }
    setRemovingRuleId(null)
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  if (statusLoading) return <PageSkeleton />

  if (!status?.connected) {
    return (
      <NotConnected
        connecting={connecting}
        onConnect={handleConnect}
        banner={
          connectError ??
          statusError ??
          (connectErrorCode
            ? (CONNECT_ERRORS[connectErrorCode] ??
              'Could not connect your mailbox. Please try again.')
            : null)
        }
      />
    )
  }

  const activeTab = TABS.find((t) => t.value === tab)!
  const showEmpty =
    !listLoading && !listError && messages !== null && messages.length === 0

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col overflow-y-auto p-4 sm:p-6 lg:overflow-hidden">
      <div className="shrink-0">
        {/* Header */}
        <div className="mt-2 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-gray-900">Email</h1>
            <p className="mt-0.5 truncate text-sm text-gray-500">
              {status.email ?? 'Mailbox'} · Last synced{' '}
              {status.lastSyncAt ? relativeTime(status.lastSyncAt) : 'Never'}
            </p>
          </div>
          <button
            onClick={runSync}
            disabled={syncing}
            className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg bg-jade-600 px-3.5 text-sm font-medium text-white transition-colors hover:bg-jade-700 disabled:opacity-60"
          >
            <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        </div>

        {/* Just came back from Microsoft */}
        {connectedNote && (
          <div className="mt-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
            Mailbox connected.
          </div>
        )}

        {/* The stored connection is broken — syncing will keep failing. */}
        {status.lastSyncError && (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
            <span className="min-w-0 flex-1">
              The last sync failed: {status.lastSyncError}
            </span>
            <button
              onClick={handleConnect}
              disabled={connecting}
              className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg border border-amber-200 bg-white px-3.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-60"
            >
              {connecting && <Loader2 size={16} className="animate-spin" />}
              Reconnect mailbox
            </button>
          </div>
        )}

        {(syncError || listError || connectError) && (
          <div className="mt-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <AlertCircle size={18} className="mt-0.5 shrink-0" />
            <span>{syncError ?? listError ?? connectError}</span>
          </div>
        )}

        {/* Triage tabs */}
        <div
          role="tablist"
          aria-label="Mail triage"
          className="mt-4 flex gap-2 overflow-x-auto pb-1"
        >
          {TABS.map((t) => {
            const active = tab === t.value
            return (
              <button
                key={t.value}
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.value)}
                className={`inline-flex min-h-[44px] shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40 ${
                  active
                    ? 'border-jade-600 bg-jade-600 text-white'
                    : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                }`}
              >
                {t.label}
                <span
                  className={`min-w-[1.5rem] rounded-full px-1.5 py-0.5 text-center text-xs tabular-nums ${
                    active ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-500'
                  }`}
                >
                  {counts ? counts[t.value] : '·'}
                </span>
              </button>
            )
          })}
        </div>

        {toast && (
          <p className="mt-3 rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600">
            {toast}
          </p>
        )}
      </div>

      {/* List + draft pane */}
      <div className="mt-3 min-h-0 flex-1 lg:grid lg:grid-cols-5 lg:gap-6">
        <div className="lg:col-span-2 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
          {listLoading && <ListSkeleton />}

          {showEmpty && (
            <div className="mt-10 flex flex-col items-center text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-100 text-gray-400">
                <Inbox size={26} />
              </div>
              <p className="mt-3 text-sm font-medium text-gray-900">
                {activeTab.empty}
              </p>
            </div>
          )}

          {!listLoading && messages && messages.length > 0 && (
            <ul className="space-y-3">
              {messages.map((m) => (
                <MessageRow
                  key={m.id}
                  message={m}
                  selected={selectedId === m.id}
                  showReason={tab === 'ignore'}
                  ignoring={ignoringId === m.id}
                  onSelect={() => setSelectedId(m.id)}
                  onIgnore={() => handleIgnoreSender(m)}
                />
              ))}
            </ul>
          )}

          {tab === 'ignore' && (
            <FilteredSenders
              open={rulesOpen}
              onToggle={() => setRulesOpen((o) => !o)}
              rules={rules}
              loading={rulesLoading}
              error={rulesError}
              removingId={removingRuleId}
              onRemove={handleRemoveRule}
            />
          )}
        </div>

        {isDesktop && (
          <div className="lg:col-span-3 lg:h-full lg:min-h-0">
            <div className="flex h-full flex-col overflow-hidden rounded-xl border border-gray-200 bg-white">
              {selected ? (
                <DraftPanel
                  message={selected}
                  draft={draft}
                  body={draftBody}
                  onBodyChange={setDraftBody}
                  loading={draftLoading}
                  writing={writing}
                  error={draftError}
                  copied={copied}
                  onWrite={handleWriteDraft}
                  onCopy={handleCopy}
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-gray-400">
                  <Mail size={28} />
                  <p className="text-sm">Select a message to draft a reply</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Below lg the draft pane becomes a full-screen sheet. */}
      {selected && !isDesktop && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-white"
          role="dialog"
          aria-modal="true"
          aria-label={`Reply to ${senderName(selected)}`}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-gray-200 px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900">
              {senderName(selected)}
            </span>
            <button
              onClick={() => setSelectedId(null)}
              aria-label="Close draft"
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-900"
            >
              <X size={20} />
            </button>
          </div>
          {/* DraftPanel scrolls its own body — no second scroller here. */}
          <div className="min-h-0 flex-1">
            <DraftPanel
              message={selected}
              draft={draft}
              body={draftBody}
              onBodyChange={setDraftBody}
              loading={draftLoading}
              writing={writing}
              error={draftError}
              copied={copied}
              onWrite={handleWriteDraft}
              onCopy={handleCopy}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Not connected
// ---------------------------------------------------------------------------

function NotConnected({
  connecting,
  onConnect,
  banner,
}: {
  connecting: boolean
  onConnect: () => void
  banner: string | null
}) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl p-4 sm:p-6">
        {banner && (
          <div className="mt-2 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <AlertCircle size={18} className="mt-0.5 shrink-0" />
            <span>{banner}</span>
          </div>
        )}

        <div className="mt-10 flex flex-col items-center rounded-2xl border border-gray-200 bg-white p-6 text-center sm:p-10">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-jade-50 text-jade-700 dark:text-jade-300">
            <Mail size={26} />
          </div>
          <h1 className="mt-4 text-lg font-semibold text-gray-900">
            Connect your mailbox
          </h1>
          <p className="mt-2 max-w-md text-sm text-gray-500">
            The agent checks your mail four times a day, sorts out what actually
            needs a reply, and writes drafts in your own style — it never sends
            anything.
          </p>
          <button
            onClick={onConnect}
            disabled={connecting}
            className="mt-6 inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-jade-600 px-5 text-sm font-medium text-white transition-colors hover:bg-jade-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40 disabled:opacity-60"
          >
            {connecting && <Loader2 size={16} className="animate-spin" />}
            Connect mailbox
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Message row
// ---------------------------------------------------------------------------

function MessageRow({
  message,
  selected,
  showReason,
  ignoring,
  onSelect,
  onIgnore,
}: {
  message: EmailMessage
  selected: boolean
  showReason: boolean
  ignoring: boolean
  onSelect: () => void
  onIgnore: () => void
}) {
  function handleKeyDown(e: KeyboardEvent<HTMLLIElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect()
    }
  }

  const address = message.from_email?.trim() ?? ''

  return (
    <li
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40 sm:p-4 ${
        selected
          ? 'border-jade-600 bg-jade-50 ring-1 ring-jade-600'
          : 'border-gray-200 bg-white hover:border-gray-300'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900">
            {senderName(message)}
          </p>
          <span className="shrink-0 text-xs text-gray-400">
            {relativeTime(message.received_at)}
          </span>
        </div>
        {address && (
          <p className="mt-0.5 truncate text-xs text-gray-400" title={address}>
            {address}
          </p>
        )}
        <p
          className="mt-1 truncate text-sm text-gray-700"
          title={message.subject ?? ''}
        >
          {message.subject?.trim() || '(no subject)'}
        </p>
        {showReason && message.triage_reason && (
          <span className="mt-2 inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
            {message.triage_reason}
          </span>
        )}
      </div>

      {address && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onIgnore()
          }}
          disabled={ignoring}
          aria-label={`Ignore future mail from ${address}`}
          title="Ignore sender"
          className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40 disabled:opacity-60"
        >
          {ignoring ? (
            <Loader2 size={18} className="animate-spin" />
          ) : (
            <BellOff size={18} />
          )}
        </button>
      )}
    </li>
  )
}

// ---------------------------------------------------------------------------
// Draft panel
// ---------------------------------------------------------------------------

function DraftPanel({
  message,
  draft,
  body,
  onBodyChange,
  loading,
  writing,
  error,
  copied,
  onWrite,
  onCopy,
}: {
  message: EmailMessage
  draft: EmailDraft | null
  body: string
  onBodyChange: (next: string) => void
  loading: boolean
  writing: boolean
  error: string | null
  copied: boolean
  onWrite: () => void
  onCopy: () => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Grow the textarea to fit its content so a long draft is read in one piece
  // rather than through a small scrolling window. min-height keeps it at ~12
  // rows so the panel does not jump as the body arrives.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [body])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Who and what */}
      <div className="shrink-0 border-b border-gray-200 px-4 py-3">
        <p className="truncate text-sm font-medium text-gray-900">
          {senderName(message)}
        </p>
        {message.from_email && (
          <p className="mt-0.5 truncate text-xs text-gray-400">
            {message.from_email}
          </p>
        )}
        <p className="mt-1.5 text-sm text-gray-700">
          {message.subject?.trim() || '(no subject)'}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <AlertCircle size={18} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {loading && (
          <div className="space-y-2">
            <div className="h-4 w-1/3 animate-pulse rounded bg-gray-200" />
            <div className="h-64 animate-pulse rounded-xl bg-gray-100" />
          </div>
        )}

        {!loading && !draft && (
          <div className="flex flex-col items-start gap-3">
            <button
              onClick={onWrite}
              disabled={writing}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-jade-600 px-4 text-sm font-medium text-white transition-colors hover:bg-jade-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40 disabled:opacity-60"
            >
              {writing ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <PenLine size={16} />
              )}
              Write a draft
            </button>
            {writing && (
              <p className="text-sm text-gray-500">
                Writing in your style… this takes a few seconds.
              </p>
            )}
          </div>
        )}

        {!loading && draft && (
          <>
            {draft.register && (
              <span className="inline-flex rounded-full bg-jade-50 px-2 py-0.5 text-xs font-medium text-jade-700 dark:text-jade-300">
                {draft.register}
              </span>
            )}

            <textarea
              ref={textareaRef}
              value={body}
              onChange={(e) => onBodyChange(e.target.value)}
              rows={12}
              aria-label="Draft reply"
              spellCheck
              className="mt-3 block min-h-[19rem] w-full resize-none overflow-hidden rounded-xl border border-gray-200 bg-gray-50 p-3 font-mono text-[13px] leading-relaxed text-gray-900 outline-none transition focus:border-jade-600 focus:ring-2 focus:ring-jade-600/20"
            />

            <p className="mt-2 text-xs text-gray-500">
              Saved to your Outlook Drafts — review and send from Outlook.
            </p>

            {/*
              There is deliberately NO Send button anywhere in this page. The
              agent writes drafts and nothing else: the mailbox grant it holds
              carries no send permission, so a Send control here could not work
              even if someone added one. Sending stays a human act, in Outlook.
            */}
            <div className="mt-3 flex flex-wrap gap-2">
              {message.web_link && (
                <a
                  href={message.web_link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40"
                >
                  <ExternalLink size={16} />
                  Open in Outlook
                </a>
              )}
              <button
                onClick={onCopy}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40"
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Filtered senders (bottom of the Filtered tab)
// ---------------------------------------------------------------------------

function FilteredSenders({
  open,
  onToggle,
  rules,
  loading,
  error,
  removingId,
  onRemove,
}: {
  open: boolean
  onToggle: () => void
  rules: EmailRule[] | null
  loading: boolean
  error: string | null
  removingId: string | null
  onRemove: (rule: EmailRule) => void
}) {
  return (
    <div className="mt-4 rounded-xl border border-gray-200 bg-white">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-h-[44px] w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm font-medium text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40"
      >
        Filtered senders
        <ChevronDown
          size={18}
          className={`shrink-0 text-gray-400 transition-transform ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {open && (
        <div className="border-t border-gray-200 px-4 py-3">
          {error && <p className="text-sm text-red-700">{error}</p>}

          {loading && (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className="h-8 animate-pulse rounded bg-gray-100"
                />
              ))}
            </div>
          )}

          {!loading && rules && rules.length === 0 && (
            <p className="text-sm text-gray-500">No filtered senders yet.</p>
          )}

          {!loading && rules && rules.length > 0 && (
            <ul className="divide-y divide-gray-100">
              {rules.map((rule) => (
                <li
                  key={rule.id}
                  className="flex items-center gap-2 py-1.5 first:pt-0 last:pb-0"
                >
                  <span
                    className="min-w-0 flex-1 truncate text-sm text-gray-700"
                    title={rule.pattern}
                  >
                    {rule.pattern}
                  </span>
                  <button
                    onClick={() => onRemove(rule)}
                    disabled={removingId === rule.id}
                    aria-label={`Remove the filter for ${rule.pattern}`}
                    className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-1.5 rounded-lg text-sm font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40 disabled:opacity-60"
                  >
                    {removingId === rule.id ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <Trash2 size={16} />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

function ListSkeleton() {
  return (
    <ul className="space-y-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <li
          key={i}
          className="rounded-xl border border-gray-200 bg-white p-3 sm:p-4"
        >
          <div className="space-y-2">
            <div className="h-4 w-1/3 animate-pulse rounded bg-gray-200" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-gray-100" />
            <div className="h-4 w-4/5 animate-pulse rounded bg-gray-100" />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Whole-page skeleton while the connection status is still unknown — keeps
 * the connect card from flashing in front of an already-connected mailbox. */
function PageSkeleton() {
  return (
    <div className="mx-auto h-full w-full max-w-6xl overflow-y-auto p-4 sm:p-6">
      <div className="mt-2 space-y-2">
        <div className="h-5 w-24 animate-pulse rounded bg-gray-200" />
        <div className="h-4 w-64 animate-pulse rounded bg-gray-100" />
      </div>
      <div className="mt-4 flex gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="h-11 w-32 animate-pulse rounded-full bg-gray-100"
          />
        ))}
      </div>
      <div className="mt-3">
        <ListSkeleton />
      </div>
    </div>
  )
}
