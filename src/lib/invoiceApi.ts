import { ApiError, FUNCTIONS_BASE, authHeaders, parseJsonError } from './api'

export interface InvoiceSummary {
  filename: string
  invoiceNumber: string
  invoiceDate: string
  currency: string
  total: string
}

export interface InvoiceAnalysis {
  clientName: string
  recipientEmail: string
  subject: string
  body: string
  invoices: InvoiceSummary[]
  warnings: string[]
}

async function postInvoices<T>(
  fields: Record<string, string>,
  files: File[],
  fallback: string,
): Promise<T> {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  for (const file of files) form.append('invoices', file, file.name)

  const headers = await authHeaders()
  delete headers['Content-Type'] // The browser must add the multipart boundary.
  const response = await fetch(`${FUNCTIONS_BASE}/invoice-draft`, {
    method: 'POST',
    headers,
    body: form,
  })
  if (!response.ok) await parseJsonError(response, fallback)
  return (await response.json()) as T
}

export function analyseInvoices(files: File[]): Promise<InvoiceAnalysis> {
  return postInvoices<InvoiceAnalysis>(
    { action: 'analyse' },
    files,
    'Jade could not read the invoices.',
  )
}

export function createInvoiceDraft(
  files: File[],
  toRecipients: string,
  ccRecipients: string,
  bccRecipients: string,
  subject: string,
  body: string,
  originalBody: string,
): Promise<{ draftId: string; attachmentCount: number; styleLearned: boolean }> {
  return postInvoices(
    {
      action: 'createDraft',
      toRecipients,
      ccRecipients,
      bccRecipients,
      subject,
      body,
      originalBody,
    },
    files,
    'Could not create the Outlook draft.',
  )
}

export { ApiError }
