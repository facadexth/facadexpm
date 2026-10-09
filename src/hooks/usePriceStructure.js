// Loads a project's quotation link, quotation lines and price snapshots (filtered client-side, like the sibling hooks).
import { useMemo } from 'react'
import { useCatalogTable } from './useAluCatalog.js'

export function usePriceStructure(projectId) {
  const links = useCatalogTable('estimation_quotation_links', 'id')
  const lines = useCatalogTable('estimation_quotation_lines', 'id')
  const snaps = useCatalogTable('estimation_price_snapshots', 'created_at')
  const link = useMemo(() => (links.data || []).find(r => r.project_id === projectId) || null, [links.data, projectId])
  const lineRows = useMemo(() => (lines.data || []).filter(r => r.project_id === projectId), [lines.data, projectId])
  const snapshots = useMemo(
    () => (snaps.data || []).filter(r => r.project_id === projectId)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))),
    [snaps.data, projectId],
  )
  const refetch = () => Promise.all([links, lines, snaps].map(q => q.refetch && q.refetch()))
  return {
    link, lines: lineRows, snapshots,
    loading: links.loading || lines.loading || snaps.loading,
    error: links.error || lines.error || snaps.error || null,
    refetch,
  }
}
