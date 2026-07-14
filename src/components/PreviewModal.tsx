import { useEffect } from 'react'
import { X, Download, Loader2 } from 'lucide-react'
import { type FileResult } from '../lib/api'
import FileIcon from './FileIcon'
import PreviewContent from './PreviewContent'

export default function PreviewModal({
  file,
  onClose,
  onDownload,
  downloading = false,
}: {
  file: FileResult
  onClose: () => void
  onDownload: (file: FileResult) => void
  downloading?: boolean
}) {
  // Close on Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${file.name}`}
      onClick={onClose}
    >
      <div
        className="flex h-full w-full flex-col overflow-hidden bg-white shadow-xl sm:h-[90vh] sm:max-w-6xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-3">
          <FileIcon previewType={file.previewType} size={18} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900">
            {file.name}
          </span>
          <button
            onClick={() => onDownload(file)}
            disabled={downloading}
            className="inline-flex items-center gap-1.5 rounded-lg bg-jade-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-jade-700 disabled:opacity-60"
          >
            {downloading ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Download size={16} />
            )}
            Download
          </button>
          <button
            onClick={onClose}
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-900"
            aria-label="Close preview"
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-hidden">
          <PreviewContent
            file={file}
            onDownload={onDownload}
            downloading={downloading}
          />
        </div>
      </div>
    </div>
  )
}
