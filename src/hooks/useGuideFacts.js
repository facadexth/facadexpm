// Facts for the starting guide: counts of the tenant's own records (RLS already
// limits every query to the current tenant) plus whether LINE is connected.
// Only head/count requests -- no row data comes back.
import { supabase } from '../lib/supabase.js'
import { useQuery } from './useSupabase.js'

async function count(table) {
  const { count: n, error } = await supabase.from(table).select('id', { count: 'exact', head: true })
  if (error) throw error
  return n || 0
}

async function lineConnected() {
  const [{ data: ls, error: e1 }, { count: roles, error: e2 }] = await Promise.all([
    supabase.from('line_settings').select('crew_group_id').not('crew_group_id', 'is', null).limit(1),
    supabase.from('user_roles').select('user_email', { count: 'exact', head: true }).not('line_user_id', 'is', null),
  ])
  if (e1) throw e1
  if (e2) throw e2
  return (ls?.length || 0) > 0 || (roles || 0) > 0
}

export function useGuideFacts(enabled = true) {
  return useQuery(async () => {
    if (!enabled) return null
    const [bankAccounts, clients, quotations, sites, invoices, line] = await Promise.all([
      count('bank_accounts'), count('clients'), count('quotations'), count('sites'), count('invoices'), lineConnected(),
    ])
    return { bankAccounts, clients, quotations, sites, invoices, lineConnected: line }
  }, [enabled])
}
