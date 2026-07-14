import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  Search as SearchIcon,
  FolderOpen,
  LayoutDashboard,
  Users as UsersIcon,
  Settings as SettingsIcon,
  LogOut,
  Menu,
  X,
  Sun,
  Moon,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../lib/useTheme'
import Logo from './Logo'

interface NavItem {
  to: string
  label: string
  icon: typeof SearchIcon
  end: boolean
}

const MAIN_LINKS: NavItem[] = [
  { to: '/', label: 'Search', icon: SearchIcon, end: true },
  { to: '/browse', label: 'Browse', icon: FolderOpen, end: true },
]

const ADMIN_LINKS: NavItem[] = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/admin/users', label: 'Users', icon: UsersIcon, end: false },
  { to: '/admin/settings', label: 'Settings', icon: SettingsIcon, end: false },
]

function navLinkClass({ isActive }: { isActive: boolean }) {
  return `relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
    isActive
      ? 'bg-jade-50 text-jade-700 dark:text-jade-300'
      : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
  }`
}

function NavLinkItem({
  item,
  onNavigate,
}: {
  item: NavItem
  onNavigate?: () => void
}) {
  const { to, label, icon: Icon, end } = item
  return (
    <NavLink to={to} end={end} onClick={onNavigate} className={navLinkClass}>
      {({ isActive }) => (
        <>
          {isActive && (
            <span
              className="absolute inset-y-1.5 left-0 w-1 rounded-r-full bg-jade-600"
              aria-hidden="true"
            />
          )}
          <Icon size={18} />
          {label}
        </>
      )}
    </NavLink>
  )
}

/** Full sidebar column — reused by the desktop rail and the mobile drawer. */
function SidebarInner({
  onNavigate,
  onClose,
}: {
  onNavigate?: () => void
  onClose?: () => void
}) {
  const { profile, logout } = useAuth()
  const { theme, toggle } = useTheme()
  const navigate = useNavigate()
  const isAdmin = profile?.role === 'admin'

  async function handleLogout() {
    onNavigate?.()
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="flex h-full flex-col">
      {/* Brand */}
      <div className="flex h-16 shrink-0 items-center justify-between px-4">
        <Link to="/" onClick={onNavigate} className="flex items-center gap-2.5">
          <Logo size={28} />
          <span className="text-base font-semibold tracking-tight text-gray-900">
            Jade File Finder
          </span>
        </Link>
        {onClose && (
          <button
            onClick={onClose}
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-900"
            aria-label="Close menu"
          >
            <X size={22} />
          </button>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-2">
        {MAIN_LINKS.map((item) => (
          <NavLinkItem key={item.to} item={item} onNavigate={onNavigate} />
        ))}
        {isAdmin && (
          <>
            <p className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-gray-400">
              Admin
            </p>
            {ADMIN_LINKS.map((item) => (
              <NavLinkItem key={item.to} item={item} onNavigate={onNavigate} />
            ))}
          </>
        )}
      </nav>

      {/* User + logout */}
      <div className="shrink-0 border-t border-gray-200 p-3">
        {profile && (
          <div className="px-2 pb-2">
            <p className="truncate text-sm font-medium text-gray-900">
              {profile.display_name}
            </p>
            <p className="text-xs capitalize text-gray-400">{profile.role}</p>
          </div>
        )}
        <button
          onClick={toggle}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900"
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          {theme === 'dark' ? 'Light mode' : 'Dark mode'}
        </button>
        <button
          onClick={handleLogout}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900"
        >
          <LogOut size={18} />
          Logout
        </button>
      </div>
    </div>
  )
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const location = useLocation()
  const drawerRef = useRef<HTMLDivElement>(null)
  const lastFocusRef = useRef<HTMLElement | null>(null)

  // Close the drawer whenever the route changes.
  useEffect(() => {
    setDrawerOpen(false)
  }, [location.pathname])

  // Keep the closed drawer out of the tab order / interaction across breakpoints.
  useEffect(() => {
    drawerRef.current?.toggleAttribute('inert', !drawerOpen)
  }, [drawerOpen])

  // Escape-to-close and focus management for the open drawer.
  useEffect(() => {
    if (!drawerOpen) return
    lastFocusRef.current = document.activeElement as HTMLElement | null
    drawerRef.current?.querySelector<HTMLElement>('a, button')?.focus()

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setDrawerOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      lastFocusRef.current?.focus?.()
    }
  }, [drawerOpen])

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 border-r border-gray-200 bg-white lg:block">
        <SidebarInner />
      </aside>

      {/* Mobile drawer backdrop */}
      <div
        className={`fixed inset-0 z-30 bg-gray-900/40 transition-opacity lg:hidden ${
          drawerOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
      />

      {/* Mobile drawer panel */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        className={`fixed inset-y-0 left-0 z-40 w-72 border-r border-gray-200 bg-white shadow-xl transition-transform lg:hidden ${
          drawerOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <SidebarInner
          onNavigate={() => setDrawerOpen(false)}
          onClose={() => setDrawerOpen(false)}
        />
      </div>

      {/* Content column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-gray-200 bg-white px-3 lg:hidden">
          <button
            onClick={() => setDrawerOpen(true)}
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 hover:text-gray-900"
            aria-label="Open menu"
            aria-expanded={drawerOpen}
          >
            <Menu size={22} />
          </button>
          <Link to="/" className="flex items-center gap-2">
            <Logo size={24} />
            <span className="text-sm font-semibold tracking-tight text-gray-900">
              Jade File Finder
            </span>
          </Link>
        </header>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {children}
        </main>
      </div>
    </div>
  )
}
