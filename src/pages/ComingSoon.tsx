import { type LucideIcon } from 'lucide-react'

/** Placeholder screen for future features linked from the sidebar. */
export default function ComingSoon({
  title,
  icon: Icon,
}: {
  title: string
  icon: LucideIcon
}) {
  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col items-center justify-center p-6 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-jade-50 text-jade-600">
        <Icon size={30} />
      </div>
      <p className="mt-4 text-base font-medium text-gray-900">{title}</p>
      <p className="mt-1 text-sm text-gray-500">This feature is coming soon.</p>
      <p className="mt-0.5 text-xs text-gray-400">
        We're building it — check back later.
      </p>
    </div>
  )
}
