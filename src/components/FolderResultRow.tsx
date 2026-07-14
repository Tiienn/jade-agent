import { Loader2, FolderClosed, ChevronRight } from 'lucide-react'
import { type FileResult } from '../lib/api'
import FileIcon from './FileIcon'

/**
 * A folder result surfaced by a search (on the Search page or in-folder search
 * on Browse). Clicking it resolves the folder's location and opens it in Browse.
 * Shared so both pages behave identically.
 */
export default function FolderResultRow({
  file,
  opening,
  onOpen,
}: {
  file: FileResult
  opening: boolean
  onOpen: () => void
}) {
  return (
    <li>
      <button
        onClick={onOpen}
        disabled={opening}
        aria-label={`Open folder ${file.name} in Browse`}
        className="flex w-full items-center gap-3 rounded-xl border border-gray-200 bg-white p-3 text-left transition-colors hover:border-gray-300 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40 disabled:opacity-60 sm:p-4"
      >
        <FileIcon previewType="other" isFolder size={20} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-gray-900">
              {file.name}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
              <FolderClosed size={11} />
              Folder
            </span>
          </div>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-jade-700 dark:text-jade-300">
          Open
          {opening ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <ChevronRight size={14} />
          )}
        </span>
      </button>
    </li>
  )
}
