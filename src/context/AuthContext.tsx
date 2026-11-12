import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

export interface Profile {
  id: string
  username: string
  display_name: string
  role: 'admin' | 'worker'
  active: boolean
}

interface AuthContextValue {
  session: Session | null
  profile: Profile | null
  loading: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

const DISABLED_MESSAGE =
  'This account has been disabled. Contact your administrator.'

/** Map a username to the synthetic email used by Supabase Auth. */
export function usernameToEmail(username: string): string {
  return `${username.trim().toLowerCase()}@workers.jadegroup.app`
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

async function loadProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, display_name, role, active')
    .eq('id', userId)
    .single()
  if (error) return null
  return data as Profile
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    let revision = 0
    // Auth callbacks run under the auth client's lock. Defer profile requests
    // until the callback returns so token refresh cannot deadlock getSession.
    function syncSession(next: Session | null) {
      if (!active) return
      const currentRevision = ++revision
      setSession(next)
      if (!next) {
        setProfile(null)
        setLoading(false)
        return
      }
      window.setTimeout(() => {
        if (!active || currentRevision !== revision) return
        void loadProfile(next.user.id).then(nextProfile => {
          if (!active || currentRevision !== revision) return
          setProfile(nextProfile)
          setLoading(false)
        })
      }, 0)
    }
    void supabase.auth.getSession().then(({ data }) => {
      if (revision === 0) syncSession(data.session)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => {
      syncSession(next)
    })

    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [])

  const logout = useCallback(async () => {
    await supabase.auth.signOut()
    setProfile(null)
    setSession(null)
  }, [])

  const login = useCallback(
    async (username: string, password: string) => {
      const email = usernameToEmail(username)
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      })
      if (error) {
        throw new Error('Incorrect username or password.')
      }

      const userId = data.user?.id
      const nextProfile = userId ? await loadProfile(userId) : null

      if (nextProfile && nextProfile.active === false) {
        await supabase.auth.signOut()
        setProfile(null)
        setSession(null)
        throw new Error(DISABLED_MESSAGE)
      }

      setSession(data.session)
      setProfile(nextProfile)
    },
    [],
  )

  const value = useMemo<AuthContextValue>(
    () => ({ session, profile, loading, login, logout }),
    [session, profile, loading, login, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
