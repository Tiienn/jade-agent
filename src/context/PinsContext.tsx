import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from './AuthContext'

export interface Pin {
  id: string
  name: string
  path: string
}

interface PinsContextValue {
  pins: Pin[]
  loading: boolean
  pin: (name: string, segments: string[]) => Promise<void>
  unpin: (path: string) => Promise<void>
  isPinned: (segments: string[]) => boolean
}

const PinsContext = createContext<PinsContextValue | undefined>(undefined)

/** Serialize folder segments into the `path` key stored on a pin row.
 * Matches the encoding Browse uses before URI-encoding: segments joined with
 * '/' (segments never contain '/'). */
function pathKeyOf(segments: string[]): string {
  return segments.join('/')
}

export function PinsProvider({ children }: { children: ReactNode }) {
  const { profile } = useAuth()
  const [pins, setPins] = useState<Pin[]>([])
  const [loading, setLoading] = useState(true)

  // Load the current user's pins once the profile becomes available.
  useEffect(() => {
    let active = true

    if (!profile) {
      setPins([])
      setLoading(false)
      return
    }

    setLoading(true)
    supabase
      .from('pinned_folders')
      .select('id, name, path')
      .eq('user_id', profile.id)
      .order('created_at', { ascending: true })
      .then(({ data, error }) => {
        if (!active) return
        if (error) {
          console.error('Failed to load pinned folders:', error)
          setPins([])
        } else {
          setPins((data as Pin[]) ?? [])
        }
        setLoading(false)
      })

    return () => {
      active = false
    }
  }, [profile])

  const isPinned = useCallback(
    (segments: string[]) => {
      const key = pathKeyOf(segments)
      return pins.some((p) => p.path === key)
    },
    [pins],
  )

  const pin = useCallback(
    async (name: string, segments: string[]) => {
      if (!profile) return
      const path = pathKeyOf(segments)
      if (pins.some((p) => p.path === path)) return

      const { data, error } = await supabase
        .from('pinned_folders')
        .insert({ user_id: profile.id, name, path })
        .select('id, name, path')
        .single()

      if (error || !data) {
        console.error('Failed to pin folder:', error)
        return
      }
      // Append: created_at ascending order keeps newest last.
      setPins((prev) =>
        prev.some((p) => p.path === path) ? prev : [...prev, data as Pin],
      )
    },
    [profile, pins],
  )

  const unpin = useCallback(
    async (path: string) => {
      if (!profile) return
      const previous = pins
      // Optimistically remove.
      setPins((prev) => prev.filter((p) => p.path !== path))

      const { error } = await supabase
        .from('pinned_folders')
        .delete()
        .eq('user_id', profile.id)
        .eq('path', path)

      if (error) {
        console.error('Failed to unpin folder:', error)
        setPins(previous)
      }
    },
    [profile, pins],
  )

  const value = useMemo<PinsContextValue>(
    () => ({ pins, loading, pin, unpin, isPinned }),
    [pins, loading, pin, unpin, isPinned],
  )

  return <PinsContext.Provider value={value}>{children}</PinsContext.Provider>
}

export function usePins(): PinsContextValue {
  const ctx = useContext(PinsContext)
  if (!ctx) throw new Error('usePins must be used within a PinsProvider')
  return ctx
}
