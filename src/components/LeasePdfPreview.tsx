import { useEffect, useRef, useState } from 'react'

/** Render locally so browsers without a built-in PDF viewer can review the plan. */
export default function LeasePdfPreview({ url }: { url: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let disposed = false
    let destroy: (() => void) | undefined
    setLoading(true); setError('')
    void (async () => {
      const pdfjs = await import('pdfjs-dist')
      const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
      if (disposed) return
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default
      const task = pdfjs.getDocument({ url })
      destroy = () => { void task.destroy() }
      const doc = await task.promise
      const page = await doc.getPage(1)
      if (disposed || !canvas.current) return
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: 1800 / base.width })
      const target = canvas.current
      target.width = viewport.width; target.height = viewport.height
      await page.render({ canvas: target, viewport }).promise
      if (!disposed) setLoading(false)
    })().catch(() => {
      if (!disposed) { setError('Preview could not load. Download the PDF to review it.'); setLoading(false) }
    })
    return () => { disposed = true; destroy?.() }
  }, [url])
  return <div className="border-t border-gray-200 bg-gray-100 p-3">
    {loading && <p role="status" className="p-4 text-sm text-gray-600">Loading PDF preview…</p>}
    {error && <p role="alert" className="p-4 text-sm text-red-700">{error}</p>}
    <canvas ref={canvas} aria-label="Lease plan PDF preview" role="img" className="h-auto w-full bg-white" hidden={loading || !!error} />
  </div>
}
