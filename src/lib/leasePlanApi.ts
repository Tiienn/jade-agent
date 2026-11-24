import { FUNCTIONS_BASE, authHeaders, browseFolder, parseJsonError, type FileResult } from './api'

import { supabase } from './supabase'

export interface LeaseReview {
  id: string
  /** Set on a review produced by editing another one, which it supersedes. */
  parentReviewId?: string
  project?: string
  unit?: string
  tenant: string
  date: string
  source: FileResult
  folder: string
  dwg: string
  pdf: string
  paper: string
  checks: string[]
  createdAt: string
}

// Enumerate the real lease folder: Graph's full-text index misses short unit codes.
// Refuse an incomplete traversal rather than silently choosing an older revision.
export async function leaseProjects(): Promise<string[]> {
  const { entries } = await browseFolder([])
  if (entries.length >= 500) throw new Error('Project listing may be incomplete. Check Browse.')
  return entries.filter(f => f.isFolder).map(f => f.name).sort((a, b) => a.localeCompare(b))
}
export async function locateLeaseDrawing(project: string, unit: string): Promise<FileResult[]> {
  if (!project || !/^[A-Z0-9][A-Z0-9 ()._-]{0,19}$/i.test(unit)) throw new Error('Choose a project and enter a valid unit number.')
  const escaped = unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = new RegExp('(?<![A-Za-z0-9])' + escaped + '(?![A-Za-z0-9]|-[A-Za-z0-9]|[.][0-9])', 'i')
  const queue = [[project]]
  const files: FileResult[] = []
  let visited = 0
  while (queue.length) {
    const batch = queue.splice(0, 4)
    visited += batch.length
    if (visited > 100) throw new Error('Too many drawing folders to verify the latest lease plan. Check the source in Browse.')
    const results = await Promise.allSettled(batch.map(path => browseFolder(path)))
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.status === 'rejected') throw result.reason
      const path = batch[i]
      const { entries } = result.value
      if (entries.length >= 500) throw new Error('Folder listing may be incomplete. Check the source folder in Browse.')
      const insideLease = /lease/i.test(path.join('/'))
      const hasLeaseFolders = entries.some(item => item.isFolder && /lease/i.test(item.name))
      for (const item of entries) {
        if (item.isFolder && (insideLease || (hasLeaseFolders ? /lease/i.test(item.name) : /cad|dwg|tenant/i.test(item.name)))) queue.push([...path, item.name])
        else if (!item.isFolder && item.extension.toLowerCase() === 'dwg' && matches.test(item.name) && (/lease/i.test(path.join('/')) || /lease/i.test(item.name))) files.push(item)
      }
    }
  }
  return files.sort((a, b) => Date.parse(b.lastModified) - Date.parse(a.lastModified) || a.name.localeCompare(b.name))
}

/** Where a reviewed plan was filed in SharePoint, once it has been. */
export interface LeasePublication {
  driveId: string
  folder: string
  items: { id: string; name: string; webUrl: string | null; size: number }[]
}
export interface LeaseJob { id: string; kind: string; status: 'uploading' | 'processing' | 'ready' | 'failed'; review: LeaseReview | null; error: string | null; created_at: string; published_at: string | null; published: LeasePublication | null }
/** A finished plan in the shared library — anyone's, not only your own. */
export interface LeaseLibraryPlan {
  id: string
  kind: string
  review: LeaseReview | null
  created_at: string
  published_at: string | null
  published: LeasePublication | null
  preparedBy: string
  mine: boolean
}
export async function leaseCloud<T>(action: string, body?: unknown): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Sign in to Jade Agent.')
  const response = await fetch(`/api/lease?action=${action}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${session.access_token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Could not complete the cloud request.')
  return data as T
}
export async function listLeaseJobs(): Promise<LeaseJob[]> {
  return (await leaseCloud<{jobs: LeaseJob[]}>('list')).jobs
}
/** Permanently delete one of your own finished or failed plans that is not filed. */
export async function deleteLeasePlan(id: string): Promise<void> {
  await leaseCloud('delete', { id })
}
export async function leaseLibrary(): Promise<LeaseLibraryPlan[]> {
  return (await leaseCloud<{plans: LeaseLibraryPlan[]}>('library')).plans
}
/**
 * File a finished plan into SharePoint. This one call does not go to
 * /api/lease: the Microsoft credentials live with the Supabase functions, so
 * the write-back does too. Filing twice is safe — the function returns the
 * first filing rather than uploading a second copy.
 */
export async function publishLeasePlan(jobId: string): Promise<{ published: LeasePublication; publishedAt: string; alreadyPublished: boolean }> {
  const res = await fetch(`${FUNCTIONS_BASE}/lease-publish`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ jobId }),
  })
  if (!res.ok) await parseJsonError(res, 'Could not file this plan to SharePoint.')
  return await res.json()
}
export async function leaseReviewFile(review: LeaseReview, kind: 'dwg' | 'pdf'): Promise<Blob> {
  const { url } = await leaseCloud<{url: string}>('file', {id: review.id, kind})
  const response = await fetch(url)
  if (!response.ok) throw new Error('Could not download the review. Try again.')
  return response.blob()
}
export async function leaseEditorPlan(review: LeaseReview): Promise<unknown> {
  const { url } = await leaseCloud<{url: string}>('file', {id: review.id, kind: 'editor'})
  const response = await fetch(url)
  if (!response.ok) throw new Error('Could not open the editor. Try again.')
  return response.json()
}
export async function waitForLease(id: string): Promise<LeaseReview> {
  for (let attempt=0; attempt<120; attempt++) {
    const job=(await listLeaseJobs()).find(j=>j.id===id)
    if (job?.status==='ready' && job.review) return job.review
    if (job?.status==='failed') throw new Error(job.error || 'The drawing could not be processed.')
    await new Promise(resolve=>setTimeout(resolve,3000))
  }
  throw new Error('Processing is taking longer than expected. Check Recent jobs before trying again.')
}
export async function saveLeaseEdits(edits: Record<string, unknown>): Promise<LeaseReview> {
  const id=crypto.randomUUID()
  await leaseCloud('create', {...edits,id,kind:'edit'})
  return waitForLease(id)
}
export async function generateLeaseReview(source: FileResult, tenant: string, date: string, project: string, unit: string): Promise<LeaseReview> {
  const latest = await locateLeaseDrawing(project, unit)
  const current = latest.find(f => f.id === source.id && f.driveId === source.driveId)
  if (!current || current.lastModified !== source.lastModified || current.size !== source.size || current.name !== source.name || latest.some(f => Date.parse(f.lastModified) > Date.parse(source.lastModified))) {
    throw new Error('The source drawing changed or a newer file exists. Locate it again before creating the review set.')
  }
  if (source.size > 24 * 1024 * 1024) throw new Error('This pilot supports DWGs up to 24 MB.')
  // One call. The server reads the drawing from SharePoint itself, so nothing
  // is downloaded here, staged in private storage, or uploaded back — and the
  // bytes the job runs on are the ones SharePoint holds for this item, not
  // whatever a browser chose to send.
  const id=crypto.randomUUID()
  await leaseCloud('create', {id,kind:'generate',source,tenant,date,project,unit})
  return waitForLease(id)
}
