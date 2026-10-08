// src/hooks/useAluCatalog.js
import { supabase } from '../lib/supabase.js'
import { fetchCatalogRows } from '../lib/catalogData.js'
import { useQuery } from './useSupabase.js'

export function useCatalogTable(table, orderBy = 'name', ascending = true) {
  return useQuery(() => fetchCatalogRows(supabase, table, orderBy, ascending), [table, orderBy, ascending])
}
