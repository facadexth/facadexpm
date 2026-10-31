// src/hooks/useAluCatalog.js
import { useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { fetchCatalogRows } from '../lib/catalogData.js'
import { fetchAllRows } from '../lib/fetchAllRows.js'
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
    // latest purchase prices of stock-linked parts (read-only RPC); a failure leaves those parts on catalogue prices
    let purchasePrices = []
    try {
      purchasePrices = await fetchAllRows(() => supabase.rpc('stock_item_purchase_prices', { p_item_ids: null }).order('id'))
    } catch (e) {
      console.warn('stock purchase prices not loaded', e)
    }
    return { ...Object.fromEntries(entries), purchasePrices }
  }, [])
  const index = useMemo(() => (query.data ? buildCatalogIndex(query.data) : null), [query.data])
  // Series-type links already expanded to descendants: pass THIS (never the raw table rows) to typeAvailability etc.
  const seriesTypes = useMemo(() => (index ? Object.values(index.seriesTypesBySeries).flat() : []), [index])
  return { ...query, index, seriesTypes }
}
