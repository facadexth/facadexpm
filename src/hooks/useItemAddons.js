// src/hooks/useItemAddons.js
// Per-opening add-ons (estimation_item_addons) in mm, for the item editor and costing.
// Module gating as useBomPartModel (estimation pages only; RLS needs has_module_access('estimation')).
// A load error sets `error` and loading=false without blanking data.
import { useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { useQuery } from './useSupabase.js'
import { loadItemAddons } from '../lib/addonSave.js'

export function useItemAddons(openingIds) {
  const ids = useMemo(() => (openingIds || []).filter(Boolean), [openingIds])
  const key = ids.join(',')
  const q = useQuery(() => (ids.length ? loadItemAddons({ supabase, openingIds: ids }) : Promise.resolve({})), [key])
  return { itemAddonsByOpening: q.data || {}, loading: ids.length ? q.loading : false, error: q.error, refetch: q.refetch }
}
