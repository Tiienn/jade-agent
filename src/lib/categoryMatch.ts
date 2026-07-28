import type { Category, FileResult } from './api'

/**
 * Does this file belong to the given category filter?
 *
 * KEEP IN SYNC with the category switch in
 * `supabase/functions/search/index.ts` (`normalSearch`). The two can't share
 * code — that one runs on Deno/edge, this one in the browser — so any change to
 * the category → extension mapping in either place must be mirrored in the
 * other.
 *
 * Note: this returns a *file-type* verdict only. Callers decide what to do with
 * folders; Browse deliberately keeps folders visible under every category so
 * users can keep navigating while filtering (the backend search endpoint drops
 * them instead, which is fine — different context).
 */
export function matchesCategory(file: FileResult, category: Category): boolean {
  switch (category) {
    case 'pdf':
      return file.extension === 'pdf'
    case 'dwg':
      return file.extension === 'dwg' || file.extension === 'dxf'
    case 'images':
      return file.previewType === 'image'
    case 'plan':
      return (
        file.name.toLowerCase().includes('plan') ||
        file.path
          .split('/')
          .some((seg) => seg.trim().toLowerCase().startsWith('plan'))
      )
    case 'word':
      return (
        file.extension === 'doc' ||
        file.extension === 'docx' ||
        file.extension === 'rtf'
      )
    case 'excel':
      return (
        file.extension === 'xls' ||
        file.extension === 'xlsx' ||
        file.extension === 'xlsm' ||
        file.extension === 'csv'
      )
    case 'psd':
      return file.extension === 'psd' || file.extension === 'psb'
    default:
      return true // 'all'
  }
}

/**
 * Filter a plain folder listing by category. Folders always survive the filter
 * so the user can keep browsing deeper while a file-type filter is applied.
 */
export function filterEntriesByCategory(
  entries: FileResult[],
  category: Category,
): FileResult[] {
  if (category === 'all') return entries
  return entries.filter(
    (entry) => entry.isFolder || matchesCategory(entry, category),
  )
}
