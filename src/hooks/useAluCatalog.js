// src/hooks/useAluCatalog.js
import { useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { fetchCatalogRows } from '../lib/catalogData.js'
import { useQuery } from './useSupabase.js'
import { ESTIMATION_CATALOG_TABLES } from '../lib/estimationCatalogTables.js'
import { buildCatalogIndex } from '../lib/aluCatalogPricing.js'

export function useCatalogTable(table, orderBy = 'name', ascending = true) {
  return useQuery(() => fetchCatalogRows(supabase, table, orderBy, ascending), [table, orderBy, ascending])
}

// Loads every catalog table once (paged past the 1000-row cap) so the estimation screens can price
// openings on every keystroke without further queries. `index` is null until the data has arrived.
export function useEstimationCatalog() {
  const query = useQuery(async () => {
    const entries = await Promise.all(
      Object.entries(ESTIMATION_CATALOG_TABLES).map(async ([key, table]) => [key, await fetchCatalogRows(supabase, table, 'id')]),
    )
    return Object.fromEntries(entries)
  }, [])
  const index = useMemo(() => (query.data ? buildCatalogIndex(query.data) : null), [query.data])
  return { ...query, index }
}
