import { Upload } from 'tus-js-client'
import { supabase, SUPABASE_ANON_KEY, SUPABASE_URL } from './supabase'

const BUCKET = 'file-drops'
export const MAX_DROP_SIZE = 50 * 1024 * 1024

export interface DroppedFile {
  path: string
  name: string
  size: number
  createdAt: string
}

async function userFolder(): Promise<string> {
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) throw new Error('Sign in again to access your files.')
  return data.user.id
}

export async function listDrops(): Promise<DroppedFile[]> {
  const folder = await userFolder()
  const files: DroppedFile[] = []
  // Fetch every page so older files remain accessible as the drop grows.
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await supabase.storage.from(BUCKET).list(folder, {
      limit: 100, offset, sortBy: { column: 'created_at', order: 'desc' },
    })
    if (error) throw new Error(error.message)
    for (const file of data) {
      if (!file.id) continue
      const encoded = file.name.slice(file.name.indexOf('--') + 2)
      let name = encoded
      if (/^(?:[0-9a-f]{2})+$/i.test(encoded)) {
        name = new TextDecoder().decode(Uint8Array.from(encoded.match(/../g)!, byte => parseInt(byte, 16)))
      }
      files.push({ path: `${folder}/${file.name}`, name,
        size: Number(file.metadata?.size ?? 0), createdAt: file.created_at ?? '' })
    }
    if (data.length < 100) break
  }
  return files
}

export interface TransferProgress {
  loaded: number
  total: number
}
export type OnTransferProgress = (progress: TransferProgress) => void

// Checkpoints belong to the page's transfer tasks, never a different account or tab.
export interface UploadCheckpoint { url?: string }
export interface DownloadCheckpoint {
  chunks: Blob[]
  loaded: number
  etag?: string
}
export interface UploadOptions {
  signal?: AbortSignal
  uploadId?: string
  retry?: boolean
  checkpoint?: UploadCheckpoint
}

export async function uploadDrop(file: File, onProgress?: OnTransferProgress, options: UploadOptions = {}): Promise<void> {
  const { signal } = options
  signal?.throwIfAborted()
  if (file.size > MAX_DROP_SIZE) throw new Error('Files must be 50 MB or smaller.')
  if (file.size === 0) throw new Error('This file is empty. Choose a file with content.')
  const folder = await userFolder()
  signal?.throwIfAborted()
  const encoded = Array.from(new TextEncoder().encode(file.name), byte => byte.toString(16).padStart(2, '0')).join('')
  const path = `${folder}/${options.uploadId ?? crypto.randomUUID()}--${encoded}`
  const checkpoint = options.checkpoint ?? {}
  // A completed upload may have lost its final response. Reuse the task's key.
  if (options.retry) {
    const { data } = await supabase.storage.from(BUCKET).info(path)
    signal?.throwIfAborted()
    if (data && data.size === file.size) {
      checkpoint.url = undefined
      onProgress?.({ loaded: file.size, total: file.size })
      return
    }
  }
  const { data, error } = await supabase.auth.getSession()
  signal?.throwIfAborted()
  if (error || !data.session) throw new Error('Sign in again to transfer files.')
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', cancel)
      if (error) reject(error)
      else { checkpoint.url = undefined; resolve() }
    }
    const upload = new Upload(file, {
      endpoint: `${SUPABASE_URL}/storage/v1/upload/resumable`,
      uploadUrl: checkpoint.url,
      chunkSize: 6 * 1024 * 1024,
      // Create the session before sending bytes, so cancellation keeps its URL.
      uploadDataDuringCreation: false,
      storeFingerprintForResuming: false,
      retryDelays: [],
      headers: { Authorization: `Bearer ${data.session!.access_token}`, apikey: SUPABASE_ANON_KEY, 'x-upsert': 'false' },
      metadata: { bucketName: BUCKET, objectName: path, contentType: file.type || 'application/octet-stream', cacheControl: '0' },
      onAfterResponse: (request, response) => {
        const status = response.getStatus()
        // Only an expired/missing session may start over. A temporary server
        // or authorization error must leave the resumable session intact.
        if (request.getMethod() === 'HEAD' && status >= 300 && status !== 404 && status !== 410) {
          throw new Error('Could not check saved upload progress. Please retry.')
        }
      },
      onUploadUrlAvailable: () => { checkpoint.url = upload.url ?? undefined },
      onProgress: (loaded, total) => { if (!settled) onProgress?.({ loaded, total }) },
      onError: () => finish(new Error('Upload interrupted. Retry to resume from the last saved chunk.')),
      onSuccess: () => finish(),
    })
    const cancel = () => {
      // abort(false) preserves the server session; terminating would discard it.
      void upload.abort(false).then(
        () => finish(new DOMException('Transfer cancelled.', 'AbortError')),
        () => finish(new DOMException('Transfer cancelled.', 'AbortError')),
      )
    }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) { cancel(); return }
    upload.start()
  })
  signal?.throwIfAborted()
}

export async function downloadDrop(
  file: DroppedFile, onProgress?: OnTransferProgress, signal?: AbortSignal,
  checkpoint: DownloadCheckpoint = { chunks: [], loaded: 0 },
): Promise<void> {
  signal?.throwIfAborted()
  const { data, error } = await supabase.auth.getSession()
  signal?.throwIfAborted()
  if (error || !data.session) throw new Error('Sign in again to transfer files.')
  const objectPath = file.path.split('/').map(encodeURIComponent).join('/')
  onProgress?.({ loaded: checkpoint.loaded, total: file.size })
  if (checkpoint.loaded < file.size) {
    const offset = checkpoint.loaded
    const response = await fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/${BUCKET}/${objectPath}`, {
      headers: { Authorization: `Bearer ${data.session.access_token}`, apikey: SUPABASE_ANON_KEY, Range: `bytes=${offset}-` },
      signal, cache: 'no-store',
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Download interrupted (${response.status}). Retry to resume.`)
    }
    const etag = response.headers.get('etag') ?? response.headers.get('last-modified') ?? undefined
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '')
    // Never append an ignored Range response or bytes from a changed object.
    const validRange = range
      ? Number(range[1]) === offset && Number(range[2]) === file.size - 1 && Number(range[3]) === file.size
      // Storage does not expose Content-Range through CORS. Object keys are
      // immutable; verify the partial response length and its version instead.
      : Number(response.headers.get('content-length')) === file.size - offset
    if (response.status === 206 && !validRange) {
      await response.body?.cancel()
      throw new Error('Storage returned an invalid download range. Please retry.')
    }
    if (offset && response.status === 206 && (!etag || checkpoint.etag !== etag)) {
      await response.body?.cancel()
      checkpoint.chunks = []; checkpoint.loaded = 0; checkpoint.etag = undefined
      onProgress?.({ loaded: 0, total: file.size })
      throw new Error('The stored file changed. Retry to download the current copy.')
    }
    if (response.status === 200) {
      checkpoint.chunks = []; checkpoint.loaded = 0
      onProgress?.({ loaded: 0, total: file.size })
    }
    checkpoint.etag = etag
    if (!response.body) throw new Error('This browser could not read the download. Please retry.')
    const reader = response.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        // A received chunk is retained even if Cancel arrives during read().
        if (checkpoint.loaded + value.byteLength > file.size) throw new Error('Download size did not match the stored file.')
        checkpoint.chunks.push(new Blob([new Uint8Array(value)]))
        checkpoint.loaded += value.byteLength
        onProgress?.({ loaded: checkpoint.loaded, total: file.size })
        signal?.throwIfAborted()
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  signal?.throwIfAborted()
  if (checkpoint.loaded !== file.size) throw new Error('Download interrupted. Retry to receive the remaining bytes.')
  const url = URL.createObjectURL(new Blob(checkpoint.chunks))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  checkpoint.chunks = []; checkpoint.loaded = 0; checkpoint.etag = undefined
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export async function deleteDrop(file: DroppedFile): Promise<void> {
  const { error } = await supabase.storage.from(BUCKET).remove([file.path])
  if (error) throw new Error(error.message)
}

export interface SharedText {
  id: string
  user_id: string
  content: string
  created_at: string
}
export const MAX_SHARED_TEXT_LENGTH = 10000

export async function listSharedTexts(): Promise<SharedText[]> {
  const result: SharedText[] = []
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await supabase.from('shared_texts')
      .select('id, user_id, content, created_at')
      .order('created_at', { ascending: false }).order('id')
      .range(offset, offset + 99)
    if (error) throw new Error(error.message)
    result.push(...data as SharedText[])
    if (data.length < 100) return result
  }
}

export async function shareText(content: string): Promise<void> {
  if (!content.trim()) throw new Error('Enter some text to share.')
  if (Array.from(content).length > MAX_SHARED_TEXT_LENGTH) throw new Error('Text must be 10,000 characters or fewer.')
  const userId = await userFolder()
  const { error } = await supabase.from('shared_texts').insert({ user_id: userId, content })
  if (error) throw new Error(error.message)
}

export async function deleteSharedText(id: string): Promise<void> {
  const { error } = await supabase.from('shared_texts').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

export async function shareRevision(files: DroppedFile[], texts: SharedText[]): Promise<string> {
  const snapshot = JSON.stringify([files.map(file => file.path).sort(), texts.map(text => text.id).sort()])
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshot))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}
