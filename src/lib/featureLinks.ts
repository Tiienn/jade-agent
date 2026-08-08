import {
  BarChart3,
  Share2,
  MessageSquare,
  FileText,
  CalendarClock,
  StickyNote,
  Workflow,
  type LucideIcon,
} from 'lucide-react'

export interface FeatureLink {
  to: string
  label: string
  icon: LucideIcon
  end: boolean
}

/** Future features — shown in the sidebar, each routes to a "Coming soon" page.
 * "Email writer" used to live here; it shipped as the real /email page and is
 * now a MAIN_LINKS entry in Layout.tsx. */
export const FEATURE_LINKS: FeatureLink[] = [
  { to: '/analytics', label: 'Analytics', icon: BarChart3, end: true },
  { to: '/share', label: 'Share', icon: Share2, end: true },
  { to: '/chat', label: 'Chat', icon: MessageSquare, end: true },
  { to: '/report', label: 'Report', icon: FileText, end: true },
  { to: '/scheduled', label: 'Scheduled', icon: CalendarClock, end: true },
  { to: '/notes', label: 'Notes', icon: StickyNote, end: true },
  { to: '/automate', label: 'Automate', icon: Workflow, end: true },
]
