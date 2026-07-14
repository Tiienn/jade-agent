import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Search as SearchIcon,
  Loader2,
  AlertCircle,
  Clock,
  FileSearch,
} from 'lucide-react'
import {
  searchFiles,
  fetchFileBlob,
  resolveFolderPath,
  ApiError,
  type Category,
  type FileResult,
  type ParsedQuery,
} from '../lib/api'
import { CATEGORIES } from '../lib/categories'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useIsDesktop } from '../lib/useIsDesktop'
import FileRow from '../components/FileRow'
import FolderResultRow from '../components/FolderResultRow'
import PreviewModal from '../components/PreviewModal'
import PreviewPane from '../components/PreviewPane'

const CATEGORY_LABEL: Record<Category, string> = {
  all: 'All',
  pdf: 'PDF',
  dwg: 'DWG',
  images: 'Images',
  plan: 'Plans',
  word: 'Word',
  excel: 'Excel',
  psd: 'PSD',
}

interface RecentSearch {
  query: string
  result_count: number
  created_at: string
}

export default function Search() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<Category>('all')
  const [results, setResults] = useState<FileResult[] | null>(null)
  const [parsed, setParsed] = useState<ParsedQuery | null>(null)
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recent, setRecent] = useState<RecentSearch[]>([])
  const [selected, setSelected] = useState<FileResult | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const isDesktop = useIsDesktop()

  // Track the latest search query so we can re-run it when the category changes.
  const lastQueryRef = useRef<string>('')

  const loadRecent = useCallback(async () => {
    if (!profile) return
    const { data } = await supabase
      .from('search_logs')
      .select('query,result_count,created_at')
      .eq('user_id', profile.id)
      .order('created_at', { ascending: false })
      .limit(5)
    if (data) setRecent(data as RecentSearch[])
  }, [profile])

  useEffect(() => {
    loadRecent()
  }, [loadRecent])

  const runSearch = useCallback(
    async (rawQuery: string, cat: Category) => {
      const q = rawQuery.trim()
      if (!q) return
      lastQueryRef.current = q
      setLoading(true)
      setError(null)
      setSelected(null)
      setExpanded(false)
      try {
        // 'all' is the default — let the backend parser extract a category
        // from the text. A specific pill overrides it.
        const categoryArg = cat === 'all' ? undefined : cat
        const res = await searchFiles(q, categoryArg)
        setResults(res.results)
        setParsed(res.parsed)
        setCount(res.count)
        loadRecent()
      } catch (err) {
        setResults(null)
        setParsed(null)
        setCount(0)
        if (err instanceof ApiError) setError(err.message)
        else setError(err instanceof Error ? err.message : 'Search failed.')
      } finally {
        setLoading(false)
      }
    },
    [loadRecent],
  )

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    runSearch(query, category)
  }

  function handleCategory(next: Category) {
    setCategory(next)
    // Re-run with the new category if a search is already on screen.
    if (lastQueryRef.current) runSearch(lastQueryRef.current, next)
  }

  function handleRecent(q: string) {
    setQuery(q)
    runSearch(q, category)
  }

  async function handleDownload(file: FileResult) {
    setDownloadingId(file.id)
    try {
      const blob = await fetchFileBlob(file.driveId, file.id, 'download')
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = file.name
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not download this file.',
      )
    } finally {
      setDownloadingId(null)
    }
  }

  function handleSelect(file: FileResult) {
    if (file.isFolder) return
    setSelected(file)
  }

  async function openInBrowse(file: FileResult) {
    setOpeningId(file.id)
    try {
      const path = await resolveFolderPath(file.driveId, file.id)
      const q = path.map(encodeURIComponent).join('/')
      navigate(q ? `/browse?path=${q}` : '/browse')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open this folder.')
    } finally {
      setOpeningId(null)
    }
  }

  const showEmptyState = !loading && results === null && !error
  const hasResults = !loading && !!results && results.length > 0

  return (
    <div
      className={`mx-auto flex h-full w-full max-w-3xl flex-col overflow-y-auto p-4 sm:p-6 lg:overflow-hidden ${
        hasResults ? 'lg:max-w-6xl' : ''
      }`}
    >
      <div className="mx-auto w-full max-w-3xl shrink-0">
        {/* Search bar */}
        <form onSubmit={handleSubmit} className="mt-2">
          <div className="relative">
            <SearchIcon
              size={20}
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <input
              type="text"
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Try: RT 1D pdf"
              aria-label="Search files"
              className="w-full rounded-xl border border-gray-300 bg-white py-3.5 pl-12 pr-28 text-base text-gray-900 shadow-sm outline-none transition focus:border-jade-600 focus:ring-2 focus:ring-jade-600/20"
            />
            <button
              type="submit"
              disabled={loading}
              className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1.5 rounded-lg bg-jade-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-jade-700 disabled:opacity-60"
            >
              {loading ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <SearchIcon size={16} />
              )}
              <span className="hidden sm:inline">Search</span>
            </button>
          </div>

          {/* Category filter chips */}
          <div className="mt-3 flex flex-wrap gap-2">
            {CATEGORIES.map((c) => {
              const active = category === c.value
              return (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => handleCategory(c.value)}
                  className={`inline-flex min-h-[44px] items-center rounded-full border px-4 text-sm font-medium transition-colors ${
                    active
                      ? 'border-jade-600 bg-jade-600 text-white'
                      : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                  }`}
                  aria-pressed={active}
                >
                  {c.label}
                </button>
              )
            })}
          </div>
        </form>

        {/* Recent searches */}
        {recent.length > 0 && (
          <div className="mt-5">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-gray-400">
              <Clock size={13} />
              Recent
            </div>
            <div className="flex flex-wrap gap-2">
              {recent.map((r, i) => (
                <button
                  key={`${r.query}-${i}`}
                  onClick={() => handleRecent(r.query)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-600 transition-colors hover:border-gray-300 hover:bg-gray-50"
                  title={`${r.result_count} result${r.result_count === 1 ? '' : 's'}`}
                >
                  <span className="max-w-[180px] truncate">{r.query}</span>
                  <span className="text-xs text-gray-400">{r.result_count}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Error banner */}
        {error && (
          <div className="mt-6 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <AlertCircle size={18} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Parsed summary */}
        {!loading && parsed && !error && (
          <div className="mt-6 text-sm text-gray-500">
            <ParsedSummary parsed={parsed} count={count} />
          </div>
        )}

        {/* Loading skeleton */}
        {loading && (
          <div className="mt-4 space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-4"
              >
                <div className="h-10 w-10 shrink-0 animate-pulse rounded-lg bg-gray-200" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-2/3 animate-pulse rounded bg-gray-200" />
                  <div className="h-3 w-1/3 animate-pulse rounded bg-gray-100" />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Zero results */}
        {!loading && results && results.length === 0 && !error && (
          <div className="mt-10 flex flex-col items-center text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-100 text-gray-400">
              <FileSearch size={26} />
            </div>
            <p className="mt-3 text-sm font-medium text-gray-900">
              No files found
            </p>
            <p className="mt-1 max-w-xs text-sm text-gray-500">
              Check the unit name or try another category.
            </p>
          </div>
        )}

        {/* Initial empty state */}
        {showEmptyState && (
          <div className="mt-16 flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-jade-50 text-jade-600">
              <FileSearch size={30} />
            </div>
            <p className="mt-4 text-base font-medium text-gray-900">
              Search company files
            </p>
            <p className="mt-1 max-w-sm text-sm text-gray-500">
              Type a short query like{' '}
              <span className="font-medium text-gray-700">RT 1D pdf</span> or{' '}
              <span className="font-medium text-gray-700">AH tower plan</span>{' '}
              and press search.
            </p>
          </div>
        )}
      </div>

      {/* Results + preview pane */}
      {!loading && results && results.length > 0 && (
        <div className="mt-3 min-h-0 flex-1 lg:grid lg:grid-cols-5 lg:gap-6">
          <ul className="space-y-3 lg:col-span-2 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
            {results.map((file) =>
              file.isFolder ? (
                <FolderResultRow
                  key={file.id}
                  file={file}
                  opening={openingId === file.id}
                  onOpen={() => openInBrowse(file)}
                />
              ) : (
                <FileRow
                  key={file.id}
                  file={file}
                  selected={selected?.id === file.id}
                  downloading={downloadingId === file.id}
                  onSelect={() => handleSelect(file)}
                  onDownload={() => handleDownload(file)}
                />
              ),
            )}
          </ul>

          {/* Desktop preview pane */}
          {isDesktop && (
            <PreviewPane
              selected={selected}
              downloadingId={downloadingId}
              onDownload={handleDownload}
              onExpand={() => setExpanded(true)}
            />
          )}
        </div>
      )}

      {/* Full-screen preview: always on mobile; on desktop only when expanded */}
      {selected && (!isDesktop || expanded) && (
        <PreviewModal
          file={selected}
          onClose={() => {
            setExpanded(false)
            if (!isDesktop) setSelected(null)
          }}
          onDownload={handleDownload}
          downloading={downloadingId === selected.id}
        />
      )}
    </div>
  )
}

function ParsedSummary({
  parsed,
  count,
}: {
  parsed: ParsedQuery
  count: number
}) {
  const parts: string[] = []
  if (parsed.buildingName) parts.push(parsed.buildingName)
  else if (parsed.buildingCode) parts.push(parsed.buildingCode)
  if (parsed.keyword) parts.push(`“${parsed.keyword}”`)
  if (parsed.category && parsed.category !== 'all')
    parts.push(CATEGORY_LABEL[parsed.category])

  return (
    <p>
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && <span className="mx-1.5 text-gray-300">·</span>}
          <span className="text-gray-700">{p}</span>
        </span>
      ))}
      {parts.length > 0 && <span className="mx-1.5 text-gray-300">·</span>}
      <span className="font-medium text-gray-900">
        {count} result{count === 1 ? '' : 's'}
      </span>
    </p>
  )
}
