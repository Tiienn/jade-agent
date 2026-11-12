import type { TransferProgress } from '../lib/shareApi'
import { humanFileSize } from '../lib/format'

export default function TransferBar({ label, progress }: { label: string; progress: TransferProgress }) {
  const percent = progress.total > 0 ? Math.min(100, Math.floor(progress.loaded / progress.total * 100)) : 0
  return (
    <div className="mt-2 w-full space-y-1">
      <div className="flex justify-between gap-3 text-xs text-gray-500">
        <span>{label}</span><span>{humanFileSize(progress.loaded)} / {humanFileSize(progress.total)} · {percent}%</span>
      </div>
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
        className="h-2 overflow-hidden rounded-full bg-gray-100">
        <div className="h-full rounded-full bg-jade-600" style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}
