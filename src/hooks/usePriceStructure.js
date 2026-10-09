// Loads ONE project's quotation link, quotation lines and price snapshots, filtered in SQL (.eq('project_id', id)),
// not by reading whole tables. Estimation.jsx owns the single instance and passes it down, so a send/compare in one
// tab is visible to the others after ps.refetch().
import { supabase } from '../lib/supabase.js'
import { fetchAllRows } from '../lib/fetchAllRows.js'
import { useQuery } from './useSupabase.js'

export async function fetchPriceStructure(client, projectId) {
  if (!projectId) return { link: null, lines: [], snapshots: [] }
  const [links, lines, snapshots] = await Promise.all([
    fetchAllRows(() => client.from('estimation_quotation_links').select('*').eq('project_id', projectId).order('id')),
    fetchAllRows(() => client.from('estimation_quotation_lines').select('*').eq('project_id', projectId).order('id')),
    fetchAllRows(() => client.from('estimation_price_snapshots').select('*').eq('project_id', projectId).order('created_at', { ascending: true }).order('id')),
  ])
  return { link: links[0] || null, lines, snapshots }
}

export function usePriceStructure(projectId) {
  const q = useQuery(() => fetchPriceStructure(supabase, projectId), [projectId])
  const d = q.data || {}
  return {
    link: d.link || null, lines: d.lines || [], snapshots: d.snapshots || [],
    loading: q.loading, error: q.error || null,
    refetch: q.refetch,
  }
}
