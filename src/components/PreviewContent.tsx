import { useEffect, useRef, useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { fetchFileBlob, type FileResult } from '../lib/api'
import FileIcon from './FileIcon'

export default function PreviewContent({
  file,
  onDownload,
  downloading = false,
}: {
  file: FileResult
  onDownload: (file: FileResult) => void
  downloading?: boolean
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const urlRef = useRef<string | null>(null)

  const canPreview =
    file.previewType === 'pdf' || file.previewType === 'image'

  useEffect(() => {
    setObjectUrl(null)
    if (!canPreview) return
    let cancelled = false
    setLoading(true)
    setError(null)

    fetchFileBlob(file.driveId, file.id, 'preview')
      .then((blob) => {
        if (cancelled) return
        const url = URL.createObjectURL(blob)
        urlRef.current = url
        setObjectUrl(url)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Could not load preview.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current)
        urlRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id, file.driveId, canPreview])

  return (
    <div className="relative h-full bg-gray-100">
      {canPreview && loading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 size={28} className="animate-spin text-gray-400" />
        </div>
      )}

      {canPreview && error && (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <FileIcon previewType={file.previewType} size={28} />
          <p className="text-sm text-gray-600">{error}</p>
        </div>
      )}

      {canPreview && !error && objectUrl && file.previewType === 'pdf' && (
        <iframe
          src={objectUrl}
          title={file.name}
          className="h-full w-full border-0"
        />
      )}

      {canPreview && !error && objectUrl && file.previewType === 'image' && (
        <div className="flex h-full items-center justify-center overflow-auto p-4">
          <img
            src={objectUrl}
            alt={file.name}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      )}

      {!canPreview && (
        <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
          <FileIcon previewType={file.previewType} size={32} />
          <div>
            <p className="text-sm font-medium text-gray-900">{file.name}</p>
            <p className="mt-1 text-sm text-gray-500">
              Preview not available for this file type.
            </p>
          </div>
          <button
            onClick={() => onDownload(file)}
            disabled={downloading}
            className="inline-flex items-center gap-1.5 rounded-lg bg-jade-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-jade-700 disabled:opacity-60"
          >
            {downloading ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Download size={16} />
            )}
            Download
          </button>
        </div>
      )}
    </div>
  )
}
