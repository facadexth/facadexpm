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
  const data = useMemo(() => q.data || {}, [q.data])   // one object per load: costing memos depend on its identity
  // loaded: a first load finished. useQuery keeps the last data while it refetches, so after that the map stays the last
  // loaded one until replaced (callers must not treat a refetch as "no add-ons").
  return { itemAddonsByOpening: data, loaded: !ids.length || q.data != null, loading: ids.length ? q.loading : false, error: q.error, refetch: q.refetch }
}
