import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, Download, FileUp, Loader2, RefreshCw, ShieldCheck, Trash2, Upload, Send, QrCode, Laptop, Wifi, X, RotateCcw } from 'lucide-react'
import { deleteDrop, downloadDrop, listDrops, MAX_DROP_SIZE, uploadDrop, listSharedTexts, shareText, deleteSharedText, shareRevision, MAX_SHARED_TEXT_LENGTH, type UploadCheckpoint, type DownloadCheckpoint, type SharedText, type DroppedFile, type TransferProgress } from '../lib/shareApi'
import { humanFileSize } from '../lib/format'
import { useAuth } from '../context/AuthContext'
import { useShareConnection } from '../hooks/useShareConnection'
import TransferBar from '../components/TransferBar'
import { QRCodeSVG } from 'qrcode.react'

const shareUrl = 'https://jade-file-finder-tien820-8406s-projects.vercel.app/share'

const actionClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-jade-600'
function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}

interface UploadTask {
  id: string
  name: string
  size: number
  status: 'queued' | 'uploading' | 'cancelling' | 'complete' | 'error' | 'cancelled'
  file?: File
  checkpoint: UploadCheckpoint
  attempts: number
  progress: TransferProgress
  error?: string
}
interface DownloadTask {
  status: 'downloading' | 'cancelling' | 'error' | 'cancelled'
  progress: TransferProgress
  error?: string
}
function displayDate(date: string) {
  if (!date || Number.isNaN(new Date(date).getTime())) return 'Date unavailable'
  return new Date(date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
function readDownloads(userId: string | undefined): Record<string, string> {
  if (!userId) return {}
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`jade-share-downloads:v1:${userId}`) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([path, date]) => path.startsWith(`${userId}/`) && typeof date === 'string'))
  } catch { return {} }
}

export default function Share() {
  const { session } = useAuth()
  const userId = session?.user.id
  const [texts, setTexts] = useState<SharedText[]>([])
  const [draft, setDraft] = useState('')
  const [sendingText, setSendingText] = useState(false)
  const [revision, setRevision] = useState('')
  const [showQr, setShowQr] = useState(false)
  const [uploads, setUploads] = useState<UploadTask[]>([])
  const [downloads, setDownloads] = useState<Record<string, DownloadTask>>({})
  const uploadsRef = useRef<UploadTask[]>([])
  const uploadControllers = useRef(new Map<string, AbortController>())
  const downloadCheckpoints = useRef(new Map<string, DownloadCheckpoint>())
  const downloadControllers = useRef(new Map<string, AbortController>())
  const [downloaded, setDownloaded] = useState(() => readDownloads(userId))
  const downloadedRef = useRef(downloaded)
  const actionLocks = useRef(new Set<string>())
  const textLock = useRef(false)
  const [files, setFiles] = useState<DroppedFile[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [uploading, setUploading] = useState('')
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [dragging, setDragging] = useState(false)
  const [copied, setCopied] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const uploadLock = useRef(false)
  const refreshLock = useRef(false)
  const refreshAgain = useRef(false)
  const mounted = useRef(true)
  const dragDepth = useRef(0)

  const refresh = useCallback(async () => {
    if (refreshLock.current) { refreshAgain.current = true; return }
    refreshLock.current = true
    try {
      do {
        refreshAgain.current = false
        const [nextFiles, nextTexts] = await Promise.all([listDrops(), listSharedTexts()])
        const nextRevision = await shareRevision(nextFiles, nextTexts)
        if (mounted.current) {
          setFiles(nextFiles); setTexts(nextTexts); setRevision(nextRevision); setLoadError('')
        }
      } while (refreshAgain.current && mounted.current)
    } catch (err) {
      if (mounted.current) { setLoadError(messageOf(err)); setRevision('') }
    } finally {
      refreshLock.current = false
      if (mounted.current) setLoading(false)
    }
  }, [])
  const connection = useShareConnection(userId, revision, refresh)
  const qrVisible = !connection.synced || showQr

  useEffect(() => {
    const saved = readDownloads(userId)
    downloadedRef.current = saved
    setDownloaded(saved)
  }, [userId])
  useEffect(() => { if (!connection.synced) setShowQr(false) }, [connection.synced])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 10_000)
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => {
      mounted.current = false
      for (const controller of uploadControllers.current.values()) controller.abort()
      for (const controller of downloadControllers.current.values()) controller.abort()
      downloadCheckpoints.current.clear()
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  function updateUpload(id: string, patch: Partial<UploadTask>) {
    uploadsRef.current = uploadsRef.current.map(task => task.id === id ? { ...task, ...patch } : task)
    if (mounted.current) setUploads(uploadsRef.current)
  }

  async function runUploads() {
    if (uploadLock.current) return
    uploadLock.current = true
    try {
      // One active upload keeps memory and bandwidth use bounded on phones.
      while (mounted.current) {
        const task = uploadsRef.current.find(item => item.status === 'queued')
        if (!task?.file) break
        const controller = new AbortController()
        uploadControllers.current.set(task.id, controller)
        updateUpload(task.id, { status: 'uploading', error: undefined, attempts: task.attempts + 1 })
        setUploading(`Uploading ${task.name}`)
        try {
          await uploadDrop(task.file, progress => updateUpload(task.id, { progress }), {
            signal: controller.signal, uploadId: task.id, retry: task.attempts > 0, checkpoint: task.checkpoint,
          })
          updateUpload(task.id, { status: 'complete', file: undefined, progress: { loaded: task.size, total: task.size } })
          if (mounted.current) setNotice(`${task.name} is ready on your other devices.`)
          connection.notifyChanged()
        } catch (err) {
          updateUpload(task.id, controller.signal.aborted
            ? { status: 'cancelled', error: undefined }
            : { status: 'error', error: messageOf(err) })
        } finally {
          uploadControllers.current.delete(task.id)
        }
        // Refresh after cancellation too, in case an upload finished as it was stopped.
        if (mounted.current) await refresh()
      }
    } finally {
      uploadLock.current = false
      if (mounted.current) setUploading('')
    }
  }

  function upload(selected: File[]) {
    if (!selected.length) return
    setError('')
    setNotice('')
    const tasks: UploadTask[] = selected.map(file => ({
      id: crypto.randomUUID(), name: file.name, file, size: file.size, attempts: 0, checkpoint: {},
      status: 'queued', progress: { loaded: 0, total: file.size },
    }))
    uploadsRef.current = [...uploadsRef.current, ...tasks]
    setUploads(uploadsRef.current)
    void runUploads()
  }

  function cancelUpload(task: UploadTask) {
    const current = uploadsRef.current.find(item => item.id === task.id)
    if (!current) return
    if (current.status === 'queued') {
      updateUpload(task.id, { status: 'cancelled' })
    } else if (current.status === 'uploading') {
      updateUpload(task.id, { status: 'cancelling' })
      uploadControllers.current.get(task.id)?.abort()
    }
  }

  function retryUpload(task: UploadTask) {
    const current = uploadsRef.current.find(item => item.id === task.id)
    if (!current?.file || !['error', 'cancelled'].includes(current.status)) return
    updateUpload(task.id, { status: 'queued', error: undefined })
    setNotice('')
    void runUploads()
  }

  function cancelDownload(file: DroppedFile) {
    const controller = downloadControllers.current.get(file.path)
    if (!controller || controller.signal.aborted) return
    setDownloads(prev => ({ ...prev, [file.path]: { ...prev[file.path], status: 'cancelling' } }))
    controller.abort()
  }

  async function act(file: DroppedFile, action: 'download' | 'delete') {
    if (actionLocks.current.has(file.path)) return
    if (action === 'delete' && !window.confirm(`Delete “${file.name}” from your file drop on all devices? Downloaded copies will stay on those devices.`)) return
    actionLocks.current.add(file.path)
    setBusy(prev => ({ ...prev, [file.path]: true }))
    setError('')
    const controller = action === 'download' ? new AbortController() : null
    if (controller) {
      downloadControllers.current.set(file.path, controller)
      setDownloads(prev => ({ ...prev, [file.path]: { status: 'downloading', progress: { loaded: downloadCheckpoints.current.get(file.path)?.loaded ?? 0, total: file.size } } }))
    }
    try {
      if (controller) {
        const checkpoint = downloadCheckpoints.current.get(file.path) ?? { chunks: [], loaded: 0 }
        downloadCheckpoints.current.set(file.path, checkpoint)
        await downloadDrop(file, progress => {
          if (mounted.current) setDownloads(prev => ({ ...prev, [file.path]: {
            status: controller.signal.aborted ? 'cancelling' : 'downloading', progress,
          } }))
        }, controller.signal, checkpoint)
        downloadCheckpoints.current.delete(file.path)
        if (!mounted.current) return
        const next = { ...readDownloads(userId), ...downloadedRef.current, [file.path]: new Date().toISOString() }
        const recent = Object.fromEntries(Object.entries(next).sort((a, b) => b[1].localeCompare(a[1])).slice(0, 1000))
        downloadedRef.current = recent
        setDownloaded(recent)
        try { localStorage.setItem(`jade-share-downloads:v1:${userId}`, JSON.stringify(recent)) } catch { /* Completion is still visible if storage is full. */ }
        setDownloads(prev => { const next = { ...prev }; delete next[file.path]; return next })
        setNotice(`${file.name} downloaded on this device.`)
      } else {
        await deleteDrop(file)
        downloadCheckpoints.current.delete(file.path)
        connection.notifyChanged()
        if (!mounted.current) return
        setFiles(prev => prev.filter(item => item.path !== file.path))
        setDownloads(prev => { const next = { ...prev }; delete next[file.path]; return next })
        setNotice(`Deleted ${file.name}.`)
        void refresh()
      }
    } catch (err) {
      if (!mounted.current) return
      if (controller) {
        setDownloads(prev => ({ ...prev, [file.path]: {
          status: controller.signal.aborted ? 'cancelled' : 'error',
          progress: prev[file.path]?.progress ?? { loaded: 0, total: file.size },
          error: controller.signal.aborted ? undefined : messageOf(err),
        } }))
        setNotice('')
      } else setError(`${file.name}: ${messageOf(err)}`)
    } finally {
      actionLocks.current.delete(file.path)
      downloadControllers.current.delete(file.path)
      if (mounted.current) setBusy(prev => ({ ...prev, [file.path]: false }))
    }
  }

  async function sendText() {
    if (textLock.current) return
    textLock.current = true
    setSendingText(true)
    setError('')
    try {
      await shareText(draft)
      setDraft('')
      setNotice('Text shared with your other devices.')
      connection.notifyChanged()
      await refresh()
    } catch (err) { setError(messageOf(err)) }
    finally { textLock.current = false; setSendingText(false) }
  }
  async function removeText(text: SharedText) {
    if (actionLocks.current.has(text.id) || !window.confirm('Delete this shared text from all your devices?')) return
    actionLocks.current.add(text.id)
    setBusy(prev => ({ ...prev, [text.id]: true }))
    try {
      await deleteSharedText(text.id)
      setTexts(prev => prev.filter(item => item.id !== text.id))
      connection.notifyChanged()
      await refresh()
      setNotice('Shared text deleted.')
    } catch (err) { setError(messageOf(err)) }
    finally {
      actionLocks.current.delete(text.id)
      setBusy(prev => ({ ...prev, [text.id]: false }))
    }
  }
  async function copyText(text: SharedText) {
    try { await navigator.clipboard.writeText(text.content); setNotice('Text copied to clipboard.') }
    catch { setError('Could not copy the text. Select it and copy manually.') }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setNotice('Share page link copied. Open it on your other device and sign in with the same account.')
    } catch {
      setError('Could not copy the link. Open this website and choose Share on your other device.')
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 sm:px-8 sm:py-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-gray-900">File drop</h1>
            <p className="mt-1 text-sm text-gray-500">From your phone to your laptop. From your laptop to your PC.</p>
          </div>
          <button type="button" onClick={() => void copyLink()} className={`${actionClass} border border-gray-200 bg-white`}>
            {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? 'Link copied' : 'Copy page link'}
          </button>
        </header>

        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_240px]">
          <section
            aria-label="Upload files"
            className={`flex min-h-64 flex-col items-center justify-center rounded-2xl border-2 border-dashed px-5 py-10 text-center transition-colors ${dragging ? 'border-jade-600 bg-jade-50' : 'border-gray-300 bg-white'}`}
            onDragEnter={event => {
              event.preventDefault()
              if (event.dataTransfer.types.includes('Files')) { dragDepth.current++; setDragging(true) }
            }}
            onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = uploadLock.current ? 'none' : 'copy' }}
            onDragLeave={event => { event.preventDefault(); if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false) } }}
            onDrop={event => {
              event.preventDefault()
              dragDepth.current = 0
              setDragging(false)
              void upload(Array.from(event.dataTransfer.files))
            }}
          >
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-jade-50 text-jade-600">
              {uploading ? <Loader2 size={26} className="animate-spin motion-reduce:animate-none" /> : <FileUp size={26} />}
            </div>
            <h2 className="text-lg font-semibold text-gray-900">{dragging ? 'Drop your files here' : 'Drop it here. Pick it up there.'}</h2>
            <p className="mt-2 max-w-sm text-sm text-gray-500">Drag files here, or choose photos, documents and more from this device.</p>
            <input ref={inputRef} type="file" multiple className="hidden" aria-label="Choose files to upload" disabled={!!uploading}
              onChange={event => {
                const selected = Array.from(event.target.files ?? [])
                event.target.value = ''
                void upload(selected)
              }} />
            <button type="button" onClick={() => inputRef.current?.click()} disabled={!!uploading}
              className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-lg bg-jade-600 px-5 text-sm font-medium text-white hover:bg-jade-700 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-jade-600 focus-visible:ring-offset-2">
              <Upload size={17} /> {uploading ? 'Uploading…' : 'Choose files'}
            </button>
            <p className="mt-3 text-xs text-gray-400">Up to {humanFileSize(MAX_DROP_SIZE)} per file</p>
          </section>

          <aside className="flex flex-col justify-center gap-5 text-sm">
            {connection.peerCount > 0 && <div role="status" className="rounded-xl border border-jade-200 bg-jade-50 p-4 text-center">
              <div className="mb-2 flex justify-center text-jade-600"><Laptop size={26} /></div>
              <p className="font-semibold text-gray-900">{connection.synced ? 'Devices connected' : 'Syncing devices…'}</p>
              <p className="mt-1 text-xs text-gray-500">{connection.peerCount + 1} devices online{connection.synced ? ' · Files and text are in sync' : ''}</p>
              {connection.synced && <button type="button" className={`${actionClass} mt-2`} onClick={() => setShowQr(prev => !prev)}><QrCode size={16} />{showQr ? 'Hide QR code' : 'Show QR code'}</button>}
            </div>}
            {qrVisible && <div className="text-center">
              <h2 className="font-semibold text-gray-900">Open on your phone</h2>
              <a href={shareUrl} aria-label="Open file drop on this device" className="mx-auto mt-3 block w-fit rounded-lg border border-gray-200 bg-[#ffffff] p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-jade-600">
                <QRCodeSVG value={shareUrl} size={192} level="M" marginSize={4} bgColor="#ffffff" fgColor="#000000" title="Scan to open Jade File drop" role="img" />
              </a>
              <p className="mt-3 leading-relaxed text-gray-500">Scan with your phone’s camera, then sign in with the same Jade account.</p>
            </div>}
            <p className="flex items-start gap-2 text-xs leading-relaxed text-gray-500"><ShieldCheck size={18} className="shrink-0 text-jade-600" />Only your account can access these files and text. They stay here until you delete them. Internet required.</p>
          </aside>
        </div>

        {uploads.length > 0 && <section aria-label="Upload progress" className="rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
          <p className="mb-3 text-xs text-gray-500">Retry resumes saved progress while Share stays open. Uploads resume from the last saved chunk.</p>
          <h2 className="mb-3 font-semibold text-gray-900">Uploads</h2>
          <ul className="space-y-4">{uploads.map(task => <li key={task.id}>
            <div className="flex items-start justify-between gap-3 text-sm"><span className="min-w-0 break-words font-medium text-gray-900">{task.name}</span>
              <span className={task.status === 'error' ? 'text-red-700' : 'shrink-0 text-gray-500'}>{task.status === 'complete' ? 'Uploaded' : task.status === 'queued' ? 'Waiting' : task.status === 'error' ? 'Failed' : task.status === 'cancelled' ? 'Cancelled' : task.status === 'cancelling' ? 'Cancelling…' : task.progress.loaded >= task.size ? 'Saving…' : 'Uploading…'}</span>
            </div>
            <TransferBar label={`Upload ${task.name}`} progress={task.progress} />
            {task.error && <p role="alert" className="mt-1 text-xs text-red-700">{task.error}</p>}
            <div className="mt-1 flex justify-end">
              {['queued', 'uploading', 'cancelling'].includes(task.status) && <button type="button" onClick={() => cancelUpload(task)} disabled={task.status === 'cancelling'} className={actionClass} aria-label={`Cancel upload ${task.name}`}><X size={16} />{task.status === 'cancelling' ? 'Cancelling…' : 'Cancel'}</button>}
              {['error', 'cancelled'].includes(task.status) && <button type="button" onClick={() => retryUpload(task)} className={actionClass} aria-label={`Retry upload ${task.name}`}><RotateCcw size={16} />Retry upload</button>}
            </div>
          </li>)}</ul>
        </section>}

        <section aria-label="Share text" className="rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
          <h2 className="font-semibold text-gray-900">Share text</h2>
          <p className="mt-1 text-sm text-gray-500">Send a note, link or anything you want to copy on another device.</p>
          <label htmlFor="share-text" className="sr-only">Text to share</label>
          <textarea id="share-text" value={draft} onChange={event => setDraft(event.target.value)} maxLength={MAX_SHARED_TEXT_LENGTH} disabled={sendingText}
            placeholder="Paste or type your text here…" rows={3}
            className="mt-3 w-full resize-y rounded-lg border border-gray-300 bg-white p-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-jade-600" />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-gray-400">{draft.length.toLocaleString()} / 10,000 characters</span>
            <button type="button" onClick={() => void sendText()} disabled={sendingText || !draft.trim()}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-jade-600 px-4 text-sm font-medium text-white hover:bg-jade-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-jade-600"><Send size={16} />{sendingText ? 'Sharing…' : 'Share text'}</button>
          </div>
          {texts.length > 0 && <ul className="mt-5 divide-y divide-gray-100 border-t border-gray-200">{texts.map(text => <li key={text.id} className="py-4 last:pb-0">
            <p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-sm text-gray-900">{text.content}</p>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <time dateTime={text.created_at} className="text-xs text-gray-500">Shared {displayDate(text.created_at)}</time>
              <div className="flex gap-1"><button type="button" onClick={() => void copyText(text)} className={actionClass} aria-label="Copy shared text"><Copy size={16} />Copy</button>
                <button type="button" disabled={busy[text.id]} onClick={() => void removeText(text)} className={actionClass} aria-label="Delete shared text"><Trash2 size={16} /></button></div>
            </div>
          </li>)}</ul>}
        </section>

        <div aria-live="polite" role="status" className="text-sm text-jade-700 dark:text-jade-300">
          {uploading || notice}
        </div>
        {error && <p role="alert" className="whitespace-pre-wrap break-words rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}

        <section className="overflow-hidden rounded-xl border border-gray-200 bg-white" aria-label="Your dropped files">
          <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-4 py-3 sm:px-5">
            <h2 className="font-semibold text-gray-900">Your files <span className="ml-1 text-sm font-normal text-gray-400">{files.length}</span></h2>
            <button type="button" onClick={() => void refresh()} disabled={loading} className={actionClass}><RefreshCw size={16} />Refresh</button>
          </div>
          {loadError && <div role="alert" className="border-b border-red-200 bg-red-50 p-4 text-sm text-red-700">Could not refresh your files: {loadError} Use Refresh to try again.</div>}
          {loading ? <p className="p-8 text-center text-sm text-gray-500">Loading your files…</p>
            : files.length === 0 && !loadError ? <div className="px-5 py-10 text-center"><p className="text-sm font-medium text-gray-700">Your drop is empty</p><p className="mt-1 text-sm text-gray-500">Add a file above. It will appear here on your other devices.</p></div>
            : <ul className="divide-y divide-gray-100">{files.map(file => (
              <li key={file.path} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
                <div className="min-w-0 flex-1 basis-40">
                  <p className="break-words text-sm font-medium text-gray-900">{file.name}</p>
                  <p className="mt-1 text-xs text-gray-500">{humanFileSize(file.size)} · <time dateTime={file.createdAt}>Uploaded {displayDate(file.createdAt)}</time></p>
                </div>
                <div className="flex items-center gap-1">
                  {['downloading', 'cancelling'].includes(downloads[file.path]?.status) ? (
                    <button type="button" onClick={() => cancelDownload(file)} disabled={downloads[file.path]?.status === 'cancelling'} className={actionClass} aria-label={`Cancel download ${file.name}`}><X size={17} />{downloads[file.path]?.status === 'cancelling' ? 'Cancelling…' : 'Cancel'}</button>
                  ) : (
                    <button type="button" disabled={busy[file.path]} onClick={() => void act(file, 'download')} className={`${actionClass} ${downloaded[file.path] ? 'text-jade-700 dark:text-jade-300' : ''}`}
                      aria-label={`${downloads[file.path] ? 'Retry download' : downloaded[file.path] ? 'Download again' : 'Download'} ${file.name}`}
                      title={downloads[file.path] ? 'Resume from saved progress' : downloaded[file.path] ? `Downloaded on this device ${displayDate(downloaded[file.path])}. Download again.` : 'Download to this device'}>
                      {downloads[file.path] ? <RotateCcw size={17} /> : downloaded[file.path] ? <Check size={17} /> : <Download size={17} />}<span>{downloads[file.path] ? 'Retry download' : downloaded[file.path] ? 'Downloaded' : 'Download'}</span>
                    </button>
                  )}
                  <button type="button" disabled={busy[file.path]} onClick={() => void act(file, 'delete')} className={actionClass} aria-label={`Delete ${file.name}`}><Trash2 size={17} /></button>
                </div>
                {downloads[file.path] && <div className="w-full">
                  <TransferBar label={`Download ${file.name}`} progress={downloads[file.path].progress} />
                  {downloads[file.path].status === 'cancelled' && <p role="status" className="mt-1 text-xs text-gray-500">Download cancelled.</p>}
                  {downloads[file.path].error && <p role="alert" className="mt-1 text-xs text-red-700">{downloads[file.path].error}</p>}
                </div>}
              </li>
            ))}</ul>}
          <p className="flex items-center gap-2 border-t border-gray-100 px-5 py-3 text-xs text-gray-400"><Wifi size={14} />{connection.connected ? 'Live sync is connected. Also checks every 10 seconds.' : 'Checks for changes every 10 seconds. Live device connection unavailable.'}</p>
        </section>
      </div>
    </div>
  )
}
