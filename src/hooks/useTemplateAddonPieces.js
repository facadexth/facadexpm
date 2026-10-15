// src/hooks/useTemplateAddonPieces.js
// Add-on piece rows (bom_template_addon_pieces) of the templates that have a layout_kind, for costing.
// Module gating is the same as useBomPartModel: only the estimation pages call this hook, and RLS on the table
// requires has_module_access('estimation'). A load error sets `error` and loading=false without blanking data.
import { useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { useQuery } from './useSupabase.js'
import { loadAddonPieces } from '../lib/addonSave.js'

export function useTemplateAddonPieces(templates) {
  const ids = useMemo(() => (templates || []).filter(t => t && t.layout_kind).map(t => t.id), [templates])
  const key = ids.join(',')
  const q = useQuery(() => (ids.length ? loadAddonPieces({ supabase, templateIds: ids }) : Promise.resolve({})), [key])
  return { addonPiecesByTemplate: q.data || {}, loading: ids.length ? q.loading : false, error: q.error }
}
