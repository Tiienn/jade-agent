import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertCircle,
  AlertTriangle,
  ExternalLink,
  FileText,
  Loader2,
  MailCheck,
  Sparkles,
  UploadCloud,
  X,
} from 'lucide-react'
import { mailStatus } from '../lib/emailApi'
import {
  ApiError,
  analyseInvoices,
  createInvoiceDraft,
  type InvoiceAnalysis,
} from '../lib/invoiceApi'

const MAX_FILES = 4
const MAX_FILE_BYTES = 2_900_000
const MAX_TOTAL_BYTES = 8 * 1024 * 1024

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError || error instanceof Error) return error.message
  return fallback
}

function bytesLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function validateSelection(files: File[]): string | null {
  if (files.length > MAX_FILES) return 'Choose no more than four invoices.'
  let total = 0
  for (const file of files) {
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      return `${file.name} is not a PDF.`
    }
    if (file.size > MAX_FILE_BYTES) return `${file.name} is too large. Keep each invoice under 2.9 MB.`
    total += file.size
  }
  if (total > MAX_TOTAL_BYTES) return 'Keep the four invoices under 8 MB together.'
  return null
}

export default function Invoices() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<File[]>([])
  const [analysis, setAnalysis] = useState<InvoiceAnalysis | null>(null)
  const [toRecipients, setToRecipients] = useState('')
  const [ccRecipients, setCcRecipients] = useState('')
  const [bccRecipients, setBccRecipients] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [mailConnected, setMailConnected] = useState<boolean | null>(null)
  const [busy, setBusy] = useState<'analyse' | 'draft' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [draftCreated, setDraftCreated] = useState(false)
  const [styleLearned, setStyleLearned] = useState(false)

  useEffect(() => {
    mailStatus()
      .then((status) => setMailConnected(status.connected))
      .catch(() => setMailConnected(null))
  }, [])

  function replaceFiles(next: File[]) {
    const selectionError = validateSelection(next)
    if (selectionError) {
      setError(selectionError)
      return
    }
    setFiles(next)
    setAnalysis(null)
    setToRecipients('')
    setCcRecipients('')
    setBccRecipients('')
    setSubject('')
    setBody('')
    setDraftCreated(false)
    setStyleLearned(false)
    setDraftError(null)
    setError(null)
  }

  function removeFile(index: number) {
    replaceFiles(files.filter((_, fileIndex) => fileIndex !== index))
    if (inputRef.current) inputRef.current.value = ''
  }

  async function handleAnalyse() {
    if (files.length === 0) {
      setError('Choose your invoice PDFs first.')
      return
    }
    setBusy('analyse')
    setError(null)
    setDraftError(null)
    setDraftCreated(false)
    setStyleLearned(false)
    try {
      const result = await analyseInvoices(files)
      setAnalysis(result)
      setToRecipients(result.recipientEmail)
      setCcRecipients('')
      setBccRecipients('')
      setSubject(result.subject)
      setBody(result.body)
    } catch (err) {
      setError(messageOf(err, 'Jade could not read the invoices.'))
    } finally {
      setBusy(null)
    }
  }

  async function handleCreateDraft() {
    setBusy('draft')
    setDraftError(null)
    setDraftCreated(false)
    setStyleLearned(false)
    try {
      const result = await createInvoiceDraft(
        files,
        toRecipients,
        ccRecipients,
        bccRecipients,
        subject,
        body,
        analysis?.body ?? body,
      )
      setDraftCreated(true)
      setStyleLearned(result.styleLearned)
    } catch (err) {
      setDraftError(messageOf(err, 'Could not create the Outlook draft.'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
        <div className="mt-2">
          <h1 className="text-lg font-semibold text-gray-900">Invoice email</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Give Jade up to four invoices. It will prepare one Outlook draft for your review.
          </p>
        </div>

        {mailConnected === false && (
          <div className="mt-4 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">
            <AlertTriangle size={19} className="mt-0.5 shrink-0" />
            <p>
              Connect your mailbox on the <Link to="/email" className="font-semibold underline">Email page</Link> before creating a draft.
            </p>
          </div>
        )}

        {error && (
          <div className="mt-4 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            <AlertCircle size={19} className="mt-0.5 shrink-0" />
            <p>{error}</p>
          </div>
        )}

        <section className="mt-5 rounded-2xl border border-gray-200 bg-white p-4 sm:p-5">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-jade-50 text-jade-700 dark:text-jade-300">
              <UploadCloud size={20} />
            </span>
            <div>
              <h2 className="font-semibold text-gray-900">1. Add invoices</h2>
              <p className="text-sm text-gray-500">PDF only · maximum four · under 2.9 MB each</p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault()
              replaceFiles(Array.from(event.dataTransfer.files).slice(0, MAX_FILES + 1))
            }}
            className="mt-4 flex min-h-36 w-full flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-300 bg-gray-50 px-5 text-center transition hover:border-jade-500 hover:bg-jade-50"
          >
            <UploadCloud size={28} className="text-jade-600" />
            <span className="mt-2 text-sm font-semibold text-gray-900">Choose or drop invoice PDFs</span>
            <span className="mt-1 text-xs text-gray-500">Your files are not stored in Jade Agent.</span>
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            className="sr-only"
            onChange={(event) => replaceFiles(Array.from(event.target.files ?? []))}
          />

          {files.length > 0 && (
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {files.map((file, index) => (
                <div key={`${file.name}-${file.lastModified}`} className="flex items-center gap-3 rounded-lg border border-gray-200 p-3">
                  <FileText size={19} className="shrink-0 text-red-500" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-gray-900">{file.name}</p>
                    <p className="text-xs text-gray-400">{bytesLabel(file.size)}</p>
                  </div>
                  <button type="button" onClick={() => removeFile(index)} aria-label={`Remove ${file.name}`} className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700">
                    <X size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={handleAnalyse}
            disabled={files.length === 0 || busy !== null}
            className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-jade-600 px-4 py-2 text-sm font-semibold text-white hover:bg-jade-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === 'analyse' ? <Loader2 size={17} className="animate-spin" /> : <Sparkles size={17} />}
            {busy === 'analyse' ? 'Reading invoices…' : 'Prepare email'}
          </button>
        </section>

        {analysis && (
          <section className="mt-5 rounded-2xl border border-gray-200 bg-white p-4 sm:p-5">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-jade-50 text-jade-700 dark:text-jade-300">
                <Sparkles size={19} />
              </span>
              <div>
                <h2 className="font-semibold text-gray-900">2. Review the email</h2>
                <p className="text-sm text-gray-500">Jade read {analysis.invoices.length} invoice{analysis.invoices.length === 1 ? '' : 's'}{analysis.clientName ? ` for ${analysis.clientName}` : ''}.</p>
              </div>
            </div>

            {analysis.warnings.length > 0 && (
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">
                <p className="font-semibold">Please check:</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {analysis.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                </ul>
              </div>
            )}

            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {analysis.invoices.map((invoice, index) => (
                <div key={`${invoice.filename}-${index}`} className="rounded-lg bg-gray-50 p-3 text-sm">
                  <p className="truncate font-medium text-gray-900">{invoice.filename}</p>
                  <p className="mt-1 text-gray-500">
                    {[invoice.invoiceNumber, invoice.invoiceDate, [invoice.currency, invoice.total].filter(Boolean).join(' ')].filter(Boolean).join(' · ') || 'Details need checking'}
                  </p>
                </div>
              ))}
            </div>

            <div className="mt-5 space-y-4">
              <label className="block">
                <span className="text-sm font-medium text-gray-700">To</span>
                <input
                  type="email"
                  multiple
                  value={toRecipients}
                  onChange={(event) => setToRecipients(event.target.value)}
                  placeholder="client@example.com, accounts@example.com"
                  className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900"
                />
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="text-sm font-medium text-gray-700">Cc</span>
                  <input
                    type="email"
                    multiple
                    value={ccRecipients}
                    onChange={(event) => setCcRecipients(event.target.value)}
                    placeholder="Optional"
                    className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900"
                  />
                </label>
                <label className="block">
                  <span className="text-sm font-medium text-gray-700">Bcc</span>
                  <input
                    type="email"
                    multiple
                    value={bccRecipients}
                    onChange={(event) => setBccRecipients(event.target.value)}
                    placeholder="Optional"
                    className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900"
                  />
                </label>
              </div>
              <p className="-mt-2 text-xs text-gray-500">
                Separate multiple addresses with commas. Bcc recipients stay hidden from everyone else.
              </p>
              <label className="block">
                <span className="text-sm font-medium text-gray-700">Subject</span>
                <input type="text" value={subject} onChange={(event) => setSubject(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900" />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-gray-700">Message</span>
                <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={10} className="mt-1 w-full resize-y rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm leading-6 text-gray-900" />
                <span className="mt-1.5 block text-xs text-gray-500">
                  When you edit Jade's suggestion and create the draft, Jade privately learns that writing style for future invoice emails.
                </span>
              </label>
            </div>

            <button
              type="button"
              onClick={handleCreateDraft}
              disabled={busy !== null || mailConnected === false || !toRecipients.trim() || !subject.trim() || !body.trim()}
              className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-jade-600 px-4 py-2 text-sm font-semibold text-white hover:bg-jade-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === 'draft' ? <Loader2 size={17} className="animate-spin" /> : <MailCheck size={17} />}
              {busy === 'draft' ? 'Creating Outlook draft…' : `Create draft with ${files.length} attachment${files.length === 1 ? '' : 's'}`}
            </button>

            {draftError && (
              <div role="alert" className="mt-4 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                <AlertCircle size={19} className="mt-0.5 shrink-0" />
                <div>
                  <p className="font-semibold">The draft was not created.</p>
                  <p className="mt-1">{draftError}</p>
                </div>
              </div>
            )}

            {draftCreated && (
              <div role="status" className="mt-4 rounded-xl border border-green-200 bg-green-50 p-5 text-green-700">
                <div className="flex items-start gap-3">
                  <MailCheck size={22} className="mt-0.5 shrink-0" />
                  <div>
                    <p className="font-semibold">Draft created with {files.length} invoice{files.length === 1 ? '' : 's'} attached.</p>
                    <p className="mt-1 text-sm">No Outlook app is needed. Open the draft in Outlook on the web, review it, then press Send.</p>
                    {styleLearned && <p className="mt-1 text-sm">Jade also learned from your edits for future invoice emails.</p>}
                    <a
                      href="https://outlook.office.com/mail/drafts"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-lg bg-green-700 px-3 py-2 text-sm font-semibold text-white hover:bg-green-800"
                    >
                      Open Outlook Web Drafts <ExternalLink size={15} />
                    </a>
                  </div>
                </div>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
