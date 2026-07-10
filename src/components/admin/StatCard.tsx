import type { LucideIcon } from 'lucide-react'

export default function StatCard({
  label,
  value,
  icon: Icon,
  accent = false,
  hint,
}: {
  label: string
  value: number | string
  icon?: LucideIcon
  /** When true, the card is flagged in amber (e.g. zero-result searches). */
  accent?: boolean
  hint?: string
}) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        accent
          ? 'border-amber-200 bg-amber-50'
          : 'border-gray-200 bg-white'
      }`}
    >
      <div className="flex items-center justify-between">
        <span
          className={`text-xs font-medium uppercase tracking-wide ${
            accent ? 'text-amber-700' : 'text-gray-400'
          }`}
        >
          {label}
        </span>
        {Icon && (
          <Icon
            size={16}
            className={accent ? 'text-amber-500' : 'text-gray-300'}
          />
        )}
      </div>
      <p
        className={`mt-2 text-2xl font-semibold tracking-tight ${
          accent ? 'text-amber-900' : 'text-gray-900'
        }`}
      >
        {value}
      </p>
      {hint && (
        <p
          className={`mt-0.5 text-xs ${
            accent ? 'text-amber-600' : 'text-gray-400'
          }`}
        >
          {hint}
        </p>
      )}
    </div>
  )
}
