import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ChevronRight, FolderClosed, AlertCircle } from 'lucide-react'
import {
  browseFolder,
  fetchFileBlob,
  ApiError,
  type FileResult,
} from '../lib/api'
import { useIsDesktop } from '../lib/useIsDesktop'
import FileIcon from '../components/FileIcon'
import FileRow from '../components/FileRow'
import PreviewModal from '../components/PreviewModal'
import PreviewPane from '../components/PreviewPane'

const ROOT_LABEL = 'Project'

/** Parse the ?path= query into folder segments. */
function parsePath(param: string | null): string[] {
  if (!param) return []
  return param
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        return s
      }
    })
}

function encodePath(path: string[]): string {
  return path.map(encodeURIComponent).join('/')
}

export default function Browse() {
  const [searchParams, setSearchParams] = useSearchParams()
  const path = parsePath(searchParams.get('path'))
  const pathKey = path.join('/')

  const [entries, setEntries] = useState<FileResult[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<FileResult | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const isDesktop = useIsDesktop()

  /** Navigate to a folder path (drives the URL, which drives the fetch). */
  const navigateTo = useCallback(
    (next: string[]) => {
      const q = encodePath(next)
      setSearchParams(q ? { path: q } : {}, { replace: false })
    },
    [setSearchParams],
  )

  const loadFolder = useCallback(async (segs: string[]) => {
    setLoading(true)
    setError(null)
    setSelected(null)
    setExpanded(false)
    try {
      const res = await browseFolder(segs)
      setEntries(res.entries)
    } catch (err) {
      setEntries(null)
      if (err instanceof ApiError) setError(err.message)
      else setError(err instanceof Error ? err.message : 'Could not open folder.')
    } finally {
      setLoading(false)
    }
  }, [])

  // Re-fetch whenever the path (from the URL) changes.
  useEffect(() => {
    loadFolder(pathKey ? pathKey.split('/') : [])
    // pathKey is the serialized path; splitting it back is safe (segments
    // never contain '/').
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathKey, loadFolder])

  function openFolder(name: string) {
    navigateTo([...path, name])
  }

  /** Jump to a breadcrumb level. index 0 = project root. */
  function goToCrumb(index: number) {
    navigateTo(path.slice(0, index))
  }

  function handleSelect(file: FileResult) {
    if (file.isFolder) return
    setSelected(file)
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

  const hasEntries = !loading && !!entries && entries.length > 0

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col overflow-y-auto p-4 sm:p-6 lg:overflow-hidden">
      <div className="mx-auto w-full max-w-6xl shrink-0">
        {/* Heading */}
        <div className="mt-2">
          <h1 className="text-lg font-semibold text-gray-900">Browse folders</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Click through the Marketing / Project library.
          </p>
        </div>

        {/* Breadcrumb */}
        <nav
          aria-label="Folder path"
          className="mt-4 flex flex-wrap items-center gap-1 text-sm"
        >
          <button
            onClick={() => goToCrumb(0)}
            className={`rounded px-1.5 py-0.5 font-medium ${
              path.length === 0
                ? 'text-gray-900'
                : 'text-jade-700 hover:bg-jade-50 dark:text-jade-300'
            }`}
          >
            {ROOT_LABEL}
          </button>
          {path.map((seg, i) => {
            const last = i === path.length - 1
            return (
              <span key={i} className="flex items-center gap-1">
                <ChevronRight size={14} className="text-gray-300" />
                <button
                  onClick={() => goToCrumb(i + 1)}
                  className={`rounded px-1.5 py-0.5 ${
                    last
                      ? 'font-medium text-gray-900'
                      : 'text-jade-700 hover:bg-jade-50 dark:text-jade-300'
                  }`}
                >
                  {seg}
                </button>
              </span>
            )
          })}
        </nav>

        {/* Error banner */}
        {error && (
          <div className="mt-5 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <AlertCircle size={18} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Loading skeleton */}
        {loading && (
          <div className="mt-4 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
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

        {/* Empty folder */}
        {!loading && entries && entries.length === 0 && !error && (
          <div className="mt-10 flex flex-col items-center text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-100 text-gray-400">
              <FolderClosed size={26} />
            </div>
            <p className="mt-3 text-sm font-medium text-gray-900">
              This folder is empty
            </p>
          </div>
        )}
      </div>

      {/* Entries + preview pane */}
      {hasEntries && (
        <div className="mt-3 min-h-0 flex-1 lg:grid lg:grid-cols-5 lg:gap-6">
          <ul className="space-y-3 lg:col-span-2 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
            {entries!.map((entry) =>
              entry.isFolder ? (
                <BrowseFolderRow
                  key={entry.id}
                  file={entry}
                  onOpen={() => openFolder(entry.name)}
                />
              ) : (
                <FileRow
                  key={entry.id}
                  file={entry}
                  selected={selected?.id === entry.id}
                  downloading={downloadingId === entry.id}
                  onSelect={() => handleSelect(entry)}
                  onDownload={() => handleDownload(entry)}
                  showPath={false}
                />
              ),
            )}
          </ul>

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

/** Clickable folder row that navigates into the folder. */
function BrowseFolderRow({
  file,
  onOpen,
}: {
  file: FileResult
  onOpen: () => void
}) {
  return (
    <li>
      <button
        onClick={onOpen}
        className="flex w-full items-center gap-3 rounded-xl border border-gray-200 bg-white p-3 text-left transition-colors hover:border-gray-300 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40 sm:p-4"
      >
        <FileIcon previewType="other" isFolder size={20} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900">
          {file.name}
        </span>
        <ChevronRight size={18} className="shrink-0 text-gray-400" />
      </button>
    </li>
  )
}
