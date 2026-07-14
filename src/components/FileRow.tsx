import { useEffect, useState, type KeyboardEvent } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { type FileResult } from '../lib/api'
import { humanFileSize, formatDate } from '../lib/format'
import FileIcon from './FileIcon'

/**
 * A selectable file row shared by Search and Browse. Clicking (or Enter/Space)
 * selects the file for preview; the Download button acts independently.
 * `showPath` hides the redundant folder path where the location is obvious.
 */
export default function FileRow({
  file,
  selected,
  downloading,
  onSelect,
  onDownload,
  showPath = true,
}: {
  file: FileResult
  selected: boolean
  downloading: boolean
  onSelect: () => void
  onDownload: () => void
  showPath?: boolean
}) {
  // Fall back to the icon if the (short-lived) thumbnail URL fails to load.
  // Reset the error flag whenever the row's file changes.
  const [thumbError, setThumbError] = useState(false)
  useEffect(() => {
    setThumbError(false)
  }, [file.id])
  const showThumb = !!file.thumbnailUrl && !thumbError

  function handleKeyDown(e: KeyboardEvent<HTMLLIElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect()
    }
  }

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
      {showThumb ? (
        <img
          key={file.id}
          src={file.thumbnailUrl}
          alt=""
          loading="lazy"
          onError={() => setThumbError(true)}
          className="h-10 w-10 shrink-0 rounded-lg border border-gray-200 object-cover"
        />
      ) : (
        <FileIcon previewType={file.previewType} size={20} />
      )}
      <div className="min-w-0 flex-1">
        <p
          className="truncate text-sm font-medium text-gray-900"
          title={file.name}
        >
          {file.name}
        </p>
        {showPath && file.path && (
          <p className="mt-0.5 truncate text-xs text-gray-400" title={file.path}>
            {file.path}
          </p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-gray-500">
          <span>{formatDate(file.lastModified)}</span>
          <span className="text-gray-300">·</span>
          <span>{humanFileSize(file.size)}</span>
        </div>
      </div>

      <button
        onClick={(e) => {
          e.stopPropagation()
          onDownload()
        }}
        disabled={downloading}
        aria-label={`Download ${file.name}`}
        className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-jade-600 px-3 text-sm font-medium text-white transition-colors hover:bg-jade-700 disabled:opacity-60"
      >
        {downloading ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <Download size={16} />
        )}
        <span className="hidden sm:inline">Download</span>
      </button>
    </li>
  )
}
