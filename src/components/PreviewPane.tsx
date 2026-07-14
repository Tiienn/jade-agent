import { Download, Eye, Loader2, Maximize2 } from 'lucide-react'
import { type FileResult } from '../lib/api'
import FileIcon from './FileIcon'
import PreviewContent from './PreviewContent'

/**
 * Desktop split-pane preview (lg+). Shows the selected file with an expand
 * button that opens the full-screen PreviewModal, a Download button, and the
 * preview body. Falls back to an empty state when nothing is selected.
 */
export default function PreviewPane({
  selected,
  downloadingId,
  onDownload,
  onExpand,
}: {
  selected: FileResult | null
  downloadingId: string | null
  onDownload: (file: FileResult) => void
  onExpand: () => void
}) {
  return (
    <div className="lg:col-span-3 lg:h-full lg:min-h-0">
      <div className="flex h-full flex-col overflow-hidden rounded-xl border border-gray-200 bg-white">
        {selected ? (
          <>
            <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3">
              <FileIcon previewType={selected.previewType} size={18} />
              <span
                className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900"
                title={selected.name}
              >
                {selected.name}
              </span>
              <button
                onClick={onExpand}
                aria-label="Expand preview"
                className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-600/40"
              >
                <Maximize2 size={18} />
              </button>
              <button
                onClick={() => onDownload(selected)}
                disabled={downloadingId === selected.id}
                className="inline-flex items-center gap-1.5 rounded-lg bg-jade-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-jade-700 disabled:opacity-60"
              >
                {downloadingId === selected.id ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Download size={16} />
                )}
                Download
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              <PreviewContent
                file={selected}
                onDownload={onDownload}
                downloading={downloadingId === selected.id}
              />
            </div>
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-gray-400">
            <Eye size={28} />
            <p className="text-sm">Select a file to preview it here</p>
          </div>
        )}
      </div>
    </div>
  )
}
