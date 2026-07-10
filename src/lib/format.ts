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
