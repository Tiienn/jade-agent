import { useCallback, useEffect, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

interface Peer { device_id: string; revision: string; updated_at: number }
function deviceId(): string {
  // Tabs in one browser count as one device. Separate browsers count separately.
  try {
    const saved = localStorage.getItem('jade-share-device:v1')
    if (saved) return saved
    const id = crypto.randomUUID()
    localStorage.setItem('jade-share-device:v1', id)
    return id
  } catch { return crypto.randomUUID() }
}

export function useShareConnection(userId: string | undefined, revision: string, refresh: () => Promise<void>) {
  const [device] = useState(deviceId)
  const [peers, setPeers] = useState<Peer[]>([])
  const [connected, setConnected] = useState(false)
  const channelRef = useRef<RealtimeChannel | null>(null)
  const subscribed = useRef(false)
  const latest = useRef({ revision, refresh })
  latest.current = { revision, refresh }

  useEffect(() => {
    if (!userId) return
    let active = true
    const channel = supabase.channel(`share:${userId}`, {
      config: { private: true, presence: { key: crypto.randomUUID() } },
    })
    channelRef.current = channel
    const track = () => channel.track({ device_id: device, revision: latest.current.revision, updated_at: Date.now() })
    channel.on('presence', { event: 'sync' }, () => {
      if (!active) return
      const state = Object.values(channel.presenceState<Peer>()).flat()
      // A reloaded page can briefly overlap its old presence entry. Use the
      // freshest snapshot per device so the old tab cannot hold sync back.
      const newest = new Map<string, Peer>()
      for (const peer of state) {
        if (typeof peer.device_id !== 'string' || peer.device_id === device) continue
        const previous = newest.get(peer.device_id)
        if (!previous || (peer.updated_at ?? 0) >= (previous.updated_at ?? 0)) newest.set(peer.device_id, peer)
      }
      const others = Array.from(newest.values())
      setPeers(others)
      if (others.some(peer => peer.revision && peer.revision !== latest.current.revision)) {
        void latest.current.refresh()
      }
    }).on('broadcast', { event: 'changed' }, () => { void latest.current.refresh() })
    // Authorize the private room before the first subscription, including a
    // newly restored session whose auth event has not reached Realtime yet.
    void supabase.realtime.setAuth().then(() => {
      if (!active) return
      channel.subscribe(status => {
        if (!active) return
        subscribed.current = status === 'SUBSCRIBED'
        setConnected(subscribed.current)
        if (subscribed.current) {
          void track()
          void latest.current.refresh()
        } else setPeers([])
      })
    }).catch(() => { if (active) { setConnected(false); setPeers([]) } })
    const offline = () => { setConnected(false); setPeers([]) }
    const leave = () => { if (subscribed.current) void channel.untrack() }
    const resume = () => {
      if (!active || !navigator.onLine) return
      if (subscribed.current) { setConnected(true); void track() }
      void latest.current.refresh()
    }
    const visible = () => { if (document.visibilityState === 'visible') resume() }
    window.addEventListener('pagehide', leave)
    window.addEventListener('pageshow', resume)
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('offline', offline)
    return () => {
      active = false
      subscribed.current = false
      channelRef.current = null
      window.removeEventListener('offline', offline)
      window.removeEventListener('pagehide', leave)
      window.removeEventListener('pageshow', resume)
      window.removeEventListener('online', resume)
      document.removeEventListener('visibilitychange', visible)
      void supabase.removeChannel(channel)
    }
  }, [userId, device])

  useEffect(() => {
    if (subscribed.current) void channelRef.current?.track({ device_id: device, revision, updated_at: Date.now() })
  }, [revision, device])

  const notifyChanged = useCallback(() => {
    if (subscribed.current) void channelRef.current?.send({ type: 'broadcast', event: 'changed', payload: {} })
  }, [])
  const peerCount = new Set(peers.map(peer => peer.device_id)).size
  return {
    notifyChanged, connected, peerCount,
    synced: connected && !!revision && peerCount > 0 && peers.every(peer => peer.revision === revision),
  }
}
