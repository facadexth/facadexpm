// ============================================================
// useUserRole — fetch current user's role from user_roles table
// Returns: { role, user, loading, isAtLeast }
// ============================================================
import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase.js'

// Role hierarchy: higher number = more access
const HIERARCHY = { OWNER: 3, ADMIN: 2, WORKER: 1 }

// User-scoped bootstrap cache for the last known-good role. A failed
// user_roles fetch (network blip, proxy/CDN error page, expired JWT,
// rate limit -- see fetchRole below) must never be treated as "no role
// row exists": that silently downgrades an ADMIN/OWNER to WORKER and
// hides every tab App.jsx gates behind minRole: 'ADMIN' (Quotations,
// Invoices, Sites, Expenses...). Serving the cache instead keeps the
// user's real role across a transient failure. onAuthStateChange
// revalidates in the background on every tab refocus/token refresh, so
// any blip -- not just true offline -- is enough to hit this path.
const ROLE_BOOTSTRAP_PREFIX = 'role-bootstrap:'

function readRoleCache(userEmail) {
  try {
    const raw = localStorage.getItem(ROLE_BOOTSTRAP_PREFIX + userEmail)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeRoleCache(userEmail, role) {
  try {
    localStorage.setItem(ROLE_BOOTSTRAP_PREFIX + userEmail, JSON.stringify({ role }))
  } catch {
    // Private-mode/quota failure -- caching is best-effort, never fatal.
  }
}

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
    hasLoadedOnce.current = true

    let session = null
    const applyCachedFallback = () => {
      const cached = session?.user?.email ? readRoleCache(session.user.email) : null
      if (cached) setRole(cached.role)
      setLoading(false)
    }

    try {
      const { data: sessionData } = await supabase.auth.getSession()
      session = sessionData?.session ?? null

      if (!session?.user) {
        setUser(null)
        setRole(null)
        setLoading(false)
        return
      }

      setUser(session.user)

      const res = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_email', session.user.email)
        .single()

      // postgrest-js resolves rather than throws for most failures (a
      // network blip, a proxy/CDN error page, an expired JWT, a rate
      // limit), so a failed fetch can't be told apart from "no role row"
      // just by checking `!data`. The ONLY shape that genuinely proves
      // "this user has no role row" is PostgREST's own .single()-found-
      // zero-rows signal, PGRST116. Anything else means we don't know,
      // so fall back to the cache instead of guessing WORKER and
      // durably persisting that guess.
      const noRoleRowExists = !res.error || res.error.code === 'PGRST116'
      if (noRoleRowExists) {
        const resolvedRole = res.data?.role ?? 'WORKER'
        setRole(resolvedRole)
        writeRoleCache(session.user.email, resolvedRole)
        setLoading(false)
      } else {
        applyCachedFallback()
      }
    } catch {
      // Belt-and-braces for the paths that do still throw (an aborted
      // request, or auth-js calls like getSession()). Same fail-safe:
      // never guess, serve the cache, and always resolve loading so the
      // UI can't hang forever on ProtectedPage's spinner.
      applyCachedFallback()
    }
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
