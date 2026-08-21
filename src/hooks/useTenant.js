// ============================================================
// useTenant — fetch current user's tenant + enabled modules
// Returns: { tenant, enabledModules, loading, isTrialActive, trialDaysRemaining, hasModuleAccess, refetch }
// ============================================================
import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase.js'

export function useTenant() {
  const [tenant, setTenant] = useState(null)
  const [enabledModules, setEnabledModules] = useState([])
  const [loading, setLoading] = useState(true)

  const fetchTenant = useCallback(async () => {
    setLoading(true)
    const { data: { session } } = await supabase.auth.getSession()

    if (!session?.user) {
      setTenant(null)
      setEnabledModules([])
      setLoading(false)
      return
    }

    const { data: roleRow } = await supabase
      .from('user_roles')
      .select('tenant_id')
      .eq('user_email', session.user.email)
      .single()

    if (!roleRow?.tenant_id) {
      setTenant(null)
      setEnabledModules([])
      setLoading(false)
      return
    }

    const [{ data: tenantRow }, { data: moduleRows }] = await Promise.all([
      supabase.from('tenants').select('*').eq('id', roleRow.tenant_id).single(),
      supabase.from('tenant_modules').select('module_key').eq('tenant_id', roleRow.tenant_id),
    ])

    setTenant(tenantRow ?? null)
    setEnabledModules((moduleRows || []).map(r => r.module_key))
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchTenant()
    const { data: { subscription } } = supabase.auth.onAuthStateChange(() => {
      fetchTenant()
    })
    return () => subscription.unsubscribe()
  }, [fetchTenant])

  const isTrialActive = tenant ? new Date(tenant.trial_ends_at) > new Date() : false

  const trialDaysRemaining = tenant
    ? Math.max(0, Math.ceil((new Date(tenant.trial_ends_at) - new Date()) / 86400000))
    : 0

  /**
   * moduleKey === null/undefined means a core feature — always accessible.
   */
  const hasModuleAccess = (moduleKey) => {
    if (!moduleKey) return true
    if (isTrialActive) return true
    return enabledModules.includes(moduleKey)
  }

  return { tenant, enabledModules, loading, isTrialActive, trialDaysRemaining, hasModuleAccess, refetch: fetchTenant }
}
