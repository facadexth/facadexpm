import { supabase } from '../lib/supabase.js'
import { useQuery } from './useSupabase.js'

// Teams + membership for the current tenant (RLS scopes both queries).
export function useTeams() {
  const { data, loading, refetch } = useQuery(async () => {
    const [t, m] = await Promise.all([
      supabase.from('worker_teams').select('id, name').order('name'),
      supabase.from('worker_team_members').select('worker_id, team_id'),
    ])
    if (t.error) throw t.error
    if (m.error) throw m.error
    return { teams: t.data || [], members: m.data || [] }
  })
  return { teams: data?.teams || [], members: data?.members || [], loading, refetch }
}
