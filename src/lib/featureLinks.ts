import {
  Mail,
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

/** Future features — shown in the sidebar, each routes to a "Coming soon" page. */
export const FEATURE_LINKS: FeatureLink[] = [
  { to: '/email-writer', label: 'Email writer', icon: Mail, end: true },
  { to: '/analytics', label: 'Analytics', icon: BarChart3, end: true },
  { to: '/share', label: 'Share', icon: Share2, end: true },
  { to: '/chat', label: 'Chat', icon: MessageSquare, end: true },
  { to: '/report', label: 'Report', icon: FileText, end: true },
  { to: '/scheduled', label: 'Scheduled', icon: CalendarClock, end: true },
  { to: '/notes', label: 'Notes', icon: StickyNote, end: true },
  { to: '/automate', label: 'Automate', icon: Workflow, end: true },
]
