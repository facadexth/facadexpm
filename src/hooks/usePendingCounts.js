// Counts of things waiting for action (pending_counts() in the database).
// Loaded when the app opens, whenever the tab regains focus, and once a minute
// while it is open. The counts only appear while someone has the app open; the
// LINE messages are what reach a phone when it is not.
import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'

const REFRESH_MS = 60_000

export function usePendingCounts(enabled = true) {
  const [counts, setCounts] = useState(null)
  const aliveRef = useRef(true)

  const refetch = useCallback(async () => {
    const { data, error } = await supabase.rpc('pending_counts')
    // A failed refresh keeps the last good numbers instead of blanking the badges.
    if (!error && data && aliveRef.current) setCounts(data)
  }, [])

  useEffect(() => {
    aliveRef.current = true
    if (!enabled) { setCounts(null); return () => { aliveRef.current = false } }
    refetch()
    const timer = setInterval(() => { if (document.visibilityState === 'visible') refetch() }, REFRESH_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') refetch() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      aliveRef.current = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [enabled, refetch])

  return { counts, refetch }
}
