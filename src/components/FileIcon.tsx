import {
  FileText,
  FileImage,
  DraftingCompass,
  File as FileGeneric,
  Folder,
} from 'lucide-react'
import type { FileResult } from '../lib/api'

type PreviewType = FileResult['previewType']

const STYLES: Record<
  PreviewType | 'folder',
  { icon: typeof FileText; className: string }
> = {
  pdf: { icon: FileText, className: 'text-red-600 bg-red-50' },
  image: { icon: FileImage, className: 'text-violet-600 bg-violet-50' },
  dwg: { icon: DraftingCompass, className: 'text-sky-600 bg-sky-50' },
  other: { icon: FileGeneric, className: 'text-gray-500 bg-gray-100' },
  folder: { icon: Folder, className: 'text-jade-600 bg-jade-50' },
}

export default function FileIcon({
  previewType,
  isFolder = false,
  size = 20,
  className = '',
}: {
  previewType: PreviewType
  isFolder?: boolean
  size?: number
  className?: string
}) {
  const key = isFolder ? 'folder' : previewType
  const { icon: Icon, className: tone } = STYLES[key]
  return (
    <span
      className={`inline-flex items-center justify-center rounded-lg ${tone} ${className}`}
      style={{ width: size + 20, height: size + 20 }}
      aria-hidden="true"
    >
      <Icon size={size} strokeWidth={1.75} />
    </span>
  )
}
