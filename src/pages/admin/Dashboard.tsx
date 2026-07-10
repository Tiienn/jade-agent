import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Search as SearchIcon,
  Loader2,
  AlertCircle,
  Activity,
  CalendarDays,
  Users as UsersIcon,
  SearchX,
  Filter,
} from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { adminUsers } from '../../lib/api'
import { formatDate } from '../../lib/format'
import type { Category } from '../../lib/api'
import StatCard from '../../components/admin/StatCard'

interface ParsedLog {
  buildingCode?: string | null
  buildingName?: string | null
  keyword?: string | null
  category?: Category | null
  picsMode?: boolean
}

interface SearchLog {
  id: string
  user_id: string | null
  username: string
  query: string
  parsed: ParsedLog | null
  result_count: number
  created_at: string
}

type RangeKey = 'today' | '7d' | '30d' | 'all'

const RANGES: { key: RangeKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'all', label: 'All time' },
]

const PAGE_SIZE = 100

const CATEGORY_LABEL: Record<Category, string> = {
  all: 'All',
  pdf: 'PDF',
  dwg: 'DWG',
  images: 'Images',
  plan: 'Plans',
}

function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

function daysAgo(n: number): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d
}

/** ISO lower bound for a range key, or null for "all time". */
function rangeStart(key: RangeKey): string | null {
  switch (key) {
    case 'today':
      return startOfToday().toISOString()
    case '7d':
      return daysAgo(7).toISOString()
    case '30d':
      return daysAgo(30).toISOString()
    case 'all':
      return null
  }
}

/** Short time, e.g. "14:32". */
function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export default function Dashboard() {
  const [logs, setLogs] = useState<SearchLog[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [stats, setStats] = useState<{
    today: number
    week: number
    activeWorkers: number
    zeroWeek: number
  } | null>(null)

  const [workers, setWorkers] = useState<{ username: string; displayName: string }[]>(
    [],
  )

  // Filters
  const [worker, setWorker] = useState<string>('all')
  const [range, setRange] = useState<RangeKey>('7d')
  const [zeroOnly, setZeroOnly] = useState(false)
  const [text, setText] = useState('')

  // Track the latest request so slow responses can't overwrite newer ones.
  const reqIdRef = useRef(0)
  // Mirror the current row count so "Load more" reads a fresh offset even though
  // loadLogs is only re-created when the filters change.
  const logsLenRef = useRef(0)
  useEffect(() => {
    logsLenRef.current = logs.length
  }, [logs])

  const nameByUsername = useMemo(() => {
    const map: Record<string, string> = {}
    for (const w of workers) map[w.username] = w.displayName
    return map
  }, [workers])

  // Build a filtered query for the search_logs table.
  const applyFilters = useCallback(
    (q: ReturnType<typeof supabase.from>) => {
      let query = (q as any).select(
        'id, user_id, username, query, parsed, result_count, created_at',
      )
      const start = rangeStart(range)
      if (start) query = query.gte('created_at', start)
      if (worker !== 'all') query = query.eq('username', worker)
      if (zeroOnly) query = query.eq('result_count', 0)
      const t = text.trim()
      if (t) query = query.ilike('query', `%${t}%`)
      return query
    },
    [range, worker, zeroOnly, text],
  )

  const loadLogs = useCallback(
    async (reset: boolean) => {
      const reqId = ++reqIdRef.current
      const offset = reset ? 0 : logsLenRef.current
      if (reset) setLoading(true)
      else setLoadingMore(true)
      setError(null)

      const base = applyFilters(supabase.from('search_logs'))
      const { data, error: dbError } = await base
        .order('created_at', { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1)

      // Ignore stale responses.
      if (reqId !== reqIdRef.current) return

      if (dbError) {
        setError('Could not load activity. Please try again.')
        if (reset) setLogs([])
      } else {
        const rows = (data ?? []) as SearchLog[]
        setLogs((prev) => (reset ? rows : [...prev, ...rows]))
        setHasMore(rows.length === PAGE_SIZE)
      }
      if (reset) setLoading(false)
      else setLoadingMore(false)
    },
    // logs.length is read via closure at call time for "load more"; excluded on
    // purpose so filter changes drive resets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyFilters],
  )

  // Load the worker dropdown once.
  useEffect(() => {
    adminUsers<{ users: { username: string; displayName: string }[] }>({
      action: 'list',
    })
      .then((res) =>
        setWorkers(
          res.users.map((u) => ({
            username: u.username,
            displayName: u.displayName,
          })),
        ),
      )
      .catch(() => {
        // Non-fatal: the dropdown just falls back to "All workers".
      })
  }, [])

  // Load summary stats once (fixed today / this-week windows).
  useEffect(() => {
    let active = true
    async function loadStats() {
      const todayStart = startOfToday().toISOString()
      const weekStart = daysAgo(7).toISOString()

      const [todayRes, weekRes, zeroRes, workerRows] = await Promise.all([
        supabase
          .from('search_logs')
          .select('*', { count: 'exact', head: true })
          .gte('created_at', todayStart),
        supabase
          .from('search_logs')
          .select('*', { count: 'exact', head: true })
          .gte('created_at', weekStart),
        supabase
          .from('search_logs')
          .select('*', { count: 'exact', head: true })
          .gte('created_at', weekStart)
          .eq('result_count', 0),
        supabase
          .from('search_logs')
          .select('username')
          .gte('created_at', weekStart),
      ])

      if (!active) return
      const distinct = new Set(
        (workerRows.data ?? []).map((r) => (r as { username: string }).username),
      )
      setStats({
        today: todayRes.count ?? 0,
        week: weekRes.count ?? 0,
        activeWorkers: distinct.size,
        zeroWeek: zeroRes.count ?? 0,
      })
    }
    loadStats()
    return () => {
      active = false
    }
  }, [])

  // Reload the first page whenever a filter changes (debounced for text).
  useEffect(() => {
    const handle = setTimeout(() => loadLogs(true), 250)
    return () => clearTimeout(handle)
  }, [loadLogs])

  return (
    <div>
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-gray-900">
          Activity
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Every search your team runs, newest first.
        </p>
      </div>

      {/* Summary stats */}
      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Searches today"
          value={stats ? stats.today : '—'}
          icon={Activity}
        />
        <StatCard
          label="This week"
          value={stats ? stats.week : '—'}
          icon={CalendarDays}
        />
        <StatCard
          label="Active workers"
          value={stats ? stats.activeWorkers : '—'}
          icon={UsersIcon}
          hint="this week"
        />
        <StatCard
          label="Zero results"
          value={stats ? stats.zeroWeek : '—'}
          icon={SearchX}
          accent
          hint="this week"
        />
      </div>

      {/* Filters */}
      <div className="mt-6 rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-gray-400">
          <Filter size={13} />
          Filters
        </div>

        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          {/* Worker */}
          <label className="flex flex-col gap-1 sm:flex-1 sm:min-w-[10rem]">
            <span className="text-xs font-medium text-gray-500">Worker</span>
            <select
              value={worker}
              onChange={(e) => setWorker(e.target.value)}
              className="min-h-[42px] rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none transition focus:border-jade-600 focus:ring-2 focus:ring-jade-600/20"
            >
              <option value="all">All workers</option>
              {workers.map((w) => (
                <option key={w.username} value={w.username}>
                  {w.displayName} ({w.username})
                </option>
              ))}
            </select>
          </label>

          {/* Free text */}
          <label className="flex flex-col gap-1 sm:flex-[2] sm:min-w-[12rem]">
            <span className="text-xs font-medium text-gray-500">
              Search text
            </span>
            <div className="relative">
              <SearchIcon
                size={16}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
              />
              <input
                type="text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Filter by what was typed"
                autoCapitalize="none"
                autoCorrect="off"
                className="min-h-[42px] w-full rounded-lg border border-gray-300 bg-white pl-9 pr-3 text-sm text-gray-900 outline-none transition focus:border-jade-600 focus:ring-2 focus:ring-jade-600/20"
              />
            </div>
          </label>
        </div>

        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {/* Date range presets */}
          <div className="flex flex-wrap gap-2">
            {RANGES.map((r) => {
              const activeRange = range === r.key
              return (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => setRange(r.key)}
                  aria-pressed={activeRange}
                  className={`inline-flex min-h-[38px] items-center rounded-full border px-3.5 text-sm font-medium transition-colors ${
                    activeRange
                      ? 'border-jade-600 bg-jade-600 text-white'
                      : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {r.label}
                </button>
              )
            })}
          </div>

          {/* Zero-results toggle */}
          <button
            type="button"
            onClick={() => setZeroOnly((v) => !v)}
            aria-pressed={zeroOnly}
            className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition-colors ${
              zeroOnly
                ? 'border-amber-300 bg-amber-50 text-amber-700'
                : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            <SearchX size={15} />
            Zero results only
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-5 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle size={18} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="mt-5 space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-xl border border-gray-200 bg-white"
            />
          ))}
        </div>
      )}

      {/* Results */}
      {!loading && logs.length > 0 && (
        <>
          <ul className="mt-5 space-y-3">
            {logs.map((log) => (
              <LogRow
                key={log.id}
                log={log}
                displayName={nameByUsername[log.username]}
              />
            ))}
          </ul>

          {hasMore && (
            <div className="mt-4 flex justify-center">
              <button
                onClick={() => loadLogs(false)}
                disabled={loadingMore}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-gray-300 bg-white px-5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-60"
              >
                {loadingMore && <Loader2 size={16} className="animate-spin" />}
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}

      {/* Empty state */}
      {!loading && logs.length === 0 && !error && (
        <div className="mt-10 flex flex-col items-center text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-100 text-gray-400">
            <SearchIcon size={26} />
          </div>
          <p className="mt-3 text-sm font-medium text-gray-900">
            No searches match these filters
          </p>
          <p className="mt-1 max-w-xs text-sm text-gray-500">
            Try widening the date range or clearing filters.
          </p>
        </div>
      )}
    </div>
  )
}

function LogRow({
  log,
  displayName,
}: {
  log: SearchLog
  displayName?: string
}) {
  const zero = log.result_count === 0
  const parsed = log.parsed

  // "Understood as" summary from the parsed query.
  const understood: string[] = []
  if (parsed?.buildingCode) understood.push(parsed.buildingCode)
  if (parsed?.keyword) understood.push(`“${parsed.keyword}”`)
  if (parsed?.category && parsed.category !== 'all')
    understood.push(CATEGORY_LABEL[parsed.category])

  return (
    <li
      className={`rounded-xl border bg-white p-4 ${
        zero ? 'border-l-4 border-l-amber-400 border-y-amber-100 border-r-amber-100' : 'border-gray-200'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-gray-900">
              {displayName ?? log.username}
            </span>
            {displayName && (
              <span className="font-mono text-xs text-gray-400">
                {log.username}
              </span>
            )}
          </div>

          <p className="mt-1.5 break-words font-mono text-sm text-gray-900">
            {log.query}
          </p>

          {understood.length > 0 && (
            <p className="mt-1 text-xs text-gray-400">
              Understood as{' '}
              {understood.map((u, i) => (
                <span key={i}>
                  {i > 0 && <span className="mx-1 text-gray-300">·</span>}
                  <span className="text-gray-500">{u}</span>
                </span>
              ))}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {zero ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
              <SearchX size={11} />
              No results
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
              {log.result_count} result{log.result_count === 1 ? '' : 's'}
            </span>
          )}
          <span className="text-xs text-gray-400">
            {formatDate(log.created_at)} · {formatTime(log.created_at)}
          </span>
        </div>
      </div>
    </li>
  )
}
