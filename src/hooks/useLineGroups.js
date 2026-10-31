// The tenant's linked LINE groups plus the package cap (null = unlimited).
// Any failing query (e.g. tables not live yet) degrades to no groups / no cap.
import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase.js'
import { useTenant } from './useTenant.js'

export function useLineGroups() {
  const { tenant } = useTenant()
  const [groups, setGroups] = useState([])
  const [limit, setLimit] = useState(null)
  const [loading, setLoading] = useState(true)

  const refetch = useCallback(async () => {
    if (!tenant?.id) return
    setLoading(true)
    try {
      const { data, error } = await supabase.from('line_groups')
        .select('id, group_id, label, is_notify, created_at').order('created_at')
      setGroups(error ? [] : (data || []))
      if (tenant.package_id) {
        const { data: pkg, error: pe } = await supabase.from('packages')
          .select('max_line_groups').eq('id', tenant.package_id).maybeSingle()
        setLimit(pe || pkg?.max_line_groups == null ? null : pkg.max_line_groups)
      } else {
        setLimit(null)
      }
    } catch {
      setGroups([])
    } finally {
      setLoading(false)
    }
  }, [tenant?.id, tenant?.package_id])

  useEffect(() => { refetch() }, [refetch])

  return { groups, limit, loading, refetch }
}
