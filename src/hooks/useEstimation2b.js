// src/hooks/useEstimation2b.js
// Data loading for the Phase 2b screens. Every table is loaded whole (the screens compute on every keystroke).
import { useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { fetchCatalogRows } from '../lib/catalogData.js'
import { useQuery } from './useSupabase.js'
import { useCatalogTable } from './useAluCatalog.js'
import { mergeSettings } from '../lib/estimationSettings.js'

// One row per tenant; `settings` is always complete (defaults fill any gap), `row` is the stored row or null.
export function useEstimationSettings() {
  const q = useQuery(() => fetchCatalogRows(supabase, 'estimation_settings', 'id'), [])
  const row = q.data && q.data[0] ? q.data[0] : null
  const settings = useMemo(() => mergeSettings(row), [row])
  return { ...q, row, settings }
}

// No upsert (house rule): look the row up, then insert or update.
export async function saveEstimationSettings(existingRow, values) {
  const { error } = existingRow
    ? await supabase.from('estimation_settings').update(values).eq('id', existingRow.id)
    : await supabase.from('estimation_settings').insert(values)
  if (error) throw error
}

export const useLayoutTemplates = () => useCatalogTable('estimation_layout_templates', 'name')
export const useTemplateJoints = () => useCatalogTable('bom_template_joints', 'sort_order')
export const useProjectStock = () => useCatalogTable('estimation_project_stock', 'id')

// Groups rows by template_id: { [templateId]: rows[] } (the shape costOpening expects).
export function groupByTemplate(rows) {
  const m = {}
  for (const r of rows || []) (m[r.template_id] = m[r.template_id] || []).push(r)
  return m
}


// Project hardware packages (Ruling 20): raw rows only, so create/update/delete helpers never see expanded rows.
export function useHardwarePackages() {
  const pk = useCatalogTable('alu_hardware_packages', 'name')
  const it = useCatalogTable('alu_hardware_package_items', 'id')
  // No upsert (house rule): insert or update by id.
  async function savePackage(values) {
    const { id, ...rest } = values
    const { data, error } = id
      ? await supabase.from('alu_hardware_packages').update(rest).eq('id', id).select().single()
      : await supabase.from('alu_hardware_packages').insert(rest).select().single()
    if (error) throw error
    pk.refetch && pk.refetch()
    return data
  }
  // Replaces the package's rows with `rows` ([{ type_id, hardware_set_id|null }]).
  async function saveItems(packageId, rows) {
    const { error: de } = await supabase.from('alu_hardware_package_items').delete().eq('package_id', packageId)
    if (de) throw de
    if (rows && rows.length) {
      const { error } = await supabase.from('alu_hardware_package_items')
        .insert(rows.map(r => ({ package_id: packageId, type_id: r.type_id, hardware_set_id: r.hardware_set_id || null })))
      if (error) throw error
    }
    it.refetch && it.refetch()
  }
  return { packages: pk.data || [], items: it.data || [], loading: pk.loading || it.loading, error: pk.error || it.error, savePackage, saveItems }
}
