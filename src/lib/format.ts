/** Human-friendly file size, e.g. 0 B, 12 KB, 3.4 MB. */
export function humanFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exp = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  )
  const value = bytes / Math.pow(1024, exp)
  // No decimals for bytes; one decimal for larger units when not whole.
  const rounded =
    exp === 0 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)
  return `${rounded} ${units[exp]}`
}

/** Short absolute date, e.g. "10 Jul 2026". Falls back to the raw string. */
export function formatDate(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

/**
 * Compact relative time for mail: "just now", "12m ago", "2h ago",
 * "yesterday", "5 Aug", "5 Aug 2025". Deliberately hand-rolled — a date
 * library would be a lot of bytes for one line of text.
 */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return '—'

  const diffMs = Date.now() - then.getTime()
  // Clock skew (or a just-written row) can put "now" slightly in the past.
  if (diffMs < 60_000) return 'just now'

  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  // Compare calendar days, not elapsed hours: mail sent at 23:00 should read
  // "yesterday" at 08:00, not "9h ago".
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const days = Math.floor(
    (startOfToday.getTime() - new Date(then).setHours(0, 0, 0, 0)) / 86_400_000,
  )
  if (days <= 1) return 'yesterday'
  if (days < 7) return `${days}d ago`

  const sameYear = then.getFullYear() === new Date().getFullYear()
  return then.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}
