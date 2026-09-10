// ============================================================
// useUserRole — fetch current user's role from user_roles table
// Returns: { role, user, loading, isAtLeast }
// ============================================================
import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase.js'

// Role hierarchy: higher number = more access
const HIERARCHY = { OWNER: 3, ADMIN: 2, WORKER: 1 }

export function useUserRole() {
  const [role, setRole]       = useState(null)
  const [user, setUser]       = useState(null)
  const [loading, setLoading] = useState(true)
  // Only the very FIRST fetch should show as "loading" -- every later
  // call comes from onAuthStateChange re-validating the session, which
  // Supabase fires automatically on tab refocus/token refresh (e.g.
  // returning from a native file/photo picker, or just switching apps
  // and back). ProtectedPage unmounts its children while loading=true,
  // so flipping this back to true on a routine background revalidation
  // was silently tearing down whatever page/form the user had open --
  // found via the Android document-scan investigation, where the file
  // picker's own return-to-tab was enough to trigger this and lose the
  // selection every time.
  const hasLoadedOnce = useRef(false)

  const fetchRole = useCallback(async () => {
    if (!hasLoadedOnce.current) setLoading(true)
    const { data: { session } } = await supabase.auth.getSession()

    if (!session?.user) {
      setUser(null)
      setRole(null)
      setLoading(false)
      hasLoadedOnce.current = true
      return
    }

    setUser(session.user)

    const { data } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_email', session.user.email)
      .single()

    // Default to WORKER if no role found
    setRole(data?.role ?? 'WORKER')
    setLoading(false)
    hasLoadedOnce.current = true
  }, [])

  useEffect(() => {
    fetchRole()
    const { data: { subscription } } = supabase.auth.onAuthStateChange(() => {
      fetchRole()
    })
    return () => subscription.unsubscribe()
  }, [fetchRole])

  /**
   * Returns true if the current user's role is >= minRole in the hierarchy.
   * OWNER >= ADMIN >= WORKER
   * canEdit = isAtLeast('ADMIN')
   * canViewHR = isAtLeast('WORKER')
   */
  const isAtLeast = (minRole) => {
    return (HIERARCHY[role] ?? 0) >= (HIERARCHY[minRole] ?? 0)
  }

  return { role, user, loading, isAtLeast }
}
