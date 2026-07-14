import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase'

export type Category =
  | 'pdf'
  | 'dwg'
  | 'images'
  | 'plan'
  | 'word'
  | 'excel'
  | 'psd'
  | 'all'

export interface ParsedQuery {
  buildingCode: string | null
  buildingName: string | null
  keyword: string
  category: Category
  picsMode: boolean
}

export interface FileResult {
  id: string
  driveId: string
  name: string
  extension: string
  path: string
  size: number
  lastModified: string
  isFolder: boolean
  previewType: 'pdf' | 'image' | 'dwg' | 'other'
  /** For folder results: segments (relative to the project root) to open it in Browse. */
  browsePath?: string[]
  /** Short-lived image URL usable directly as an <img src> (images, often PDFs). */
  thumbnailUrl?: string
}

export interface SearchResponse {
  parsed: ParsedQuery
  count: number
  results: FileResult[]
  /** Set when a building-scoped search found nothing and results fell back to
   * the whole library. Holds the building name that was originally scoped. */
  fallbackFrom?: string
}

export interface BrowseResponse {
  path: string[]
  entries: FileResult[]
}

export type SearchErrorCode = 'NO_BUILDING' | 'NO_KEYWORD'

/** A human-readable error surfaced from the backend, plus an optional code. */
export class ApiError extends Error {
  code?: SearchErrorCode | string
  status: number
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

const FUNCTIONS_BASE = `${SUPABASE_URL}/functions/v1`

async function authHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  const token = session?.access_token ?? SUPABASE_ANON_KEY
  return {
    Authorization: `Bearer ${token}`,
    apikey: SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
  }
}

/** Headers for unauthenticated calls (bootstrapStatus / bootstrap). */
function anonHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    apikey: SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
  }
}

async function parseJsonError(res: Response, fallback: string): Promise<never> {
  let message = fallback
  let code: string | undefined
  try {
    const body = await res.json()
    if (body && typeof body.error === 'string') message = body.error
    if (body && typeof body.code === 'string') code = body.code
  } catch {
    // response was not JSON — keep the fallback message
  }
  throw new ApiError(message, res.status, code)
}

export async function searchFiles(
  query: string,
  category?: Category,
  scopePath?: string[],
): Promise<SearchResponse> {
  const body: { query: string; category?: Category; scopePath?: string[] } = {
    query,
  }
  if (category !== undefined) body.category = category
  if (scopePath !== undefined) body.scopePath = scopePath

  const res = await fetch(`${FUNCTIONS_BASE}/search`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    await parseJsonError(res, 'Search failed. Please try again.')
  }
  return (await res.json()) as SearchResponse
}

export async function browseFolder(path: string[]): Promise<BrowseResponse> {
  const res = await fetch(`${FUNCTIONS_BASE}/browse`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ path }),
  })

  if (!res.ok) {
    await parseJsonError(res, 'Could not open this folder. Please try again.')
  }
  return (await res.json()) as BrowseResponse
}

/** Resolve a folder (by id) to its Browse path segments — used to deep-link
 * a search result into Browse. */
export async function resolveFolderPath(
  driveId: string,
  itemId: string,
): Promise<string[]> {
  const res = await fetch(`${FUNCTIONS_BASE}/browse`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ driveId, itemId, resolveOnly: true }),
  })

  if (!res.ok) {
    await parseJsonError(res, 'Could not open this folder.')
  }
  return ((await res.json()) as BrowseResponse).path
}

export async function fetchFileBlob(
  driveId: string,
  itemId: string,
  mode: 'download' | 'preview',
): Promise<Blob> {
  const res = await fetch(`${FUNCTIONS_BASE}/file`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ driveId, itemId, mode }),
  })

  if (!res.ok) {
    await parseJsonError(res, 'Could not load this file.')
  }
  return await res.blob()
}

export async function adminUsers<T = unknown>(
  payload: Record<string, unknown>,
): Promise<T> {
  // bootstrapStatus / bootstrap are unauthenticated; everything else is admin-only.
  const action = payload.action
  const unauthenticated = action === 'bootstrapStatus' || action === 'bootstrap'
  const headers = unauthenticated ? anonHeaders() : await authHeaders()

  const res = await fetch(`${FUNCTIONS_BASE}/admin-users`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    await parseJsonError(res, 'Request failed. Please try again.')
  }
  return (await res.json()) as T
}
