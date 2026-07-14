import { type Category } from './api'

/** Shared category filter list, used by the Search page and in-folder search. */
export const CATEGORIES: { value: Category; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pdf', label: 'PDF' },
  { value: 'dwg', label: 'DWG' },
  { value: 'images', label: 'Images' },
  { value: 'plan', label: 'Plans' },
  { value: 'word', label: 'Word' },
  { value: 'excel', label: 'Excel' },
  { value: 'psd', label: 'PSD' },
]
