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

const EMPTY_ROWS = []

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
  // Makes the package's rows equal `rows` ([{ type_id, hardware_set_id|null }]) by diff: insert new types,
  // update changed sets by row id, and delete removed types LAST, only after every insert/update succeeded.
  async function saveItems(packageId, rows) {
    const wanted = new Map()
    for (const r of rows || []) wanted.set(r.type_id, r.hardware_set_id || null)   // last one wins
    const { data: existing, error: le } = await supabase.from('alu_hardware_package_items')
      .select('id, type_id, hardware_set_id').eq('package_id', packageId)
    if (le) throw le
    const have = new Map((existing || []).map(r => [r.type_id, r]))
    const toInsert = [...wanted].filter(([t]) => !have.has(t))
      .map(([type_id, hardware_set_id]) => ({ package_id: packageId, type_id, hardware_set_id }))
    if (toInsert.length) {
      const { error } = await supabase.from('alu_hardware_package_items').insert(toInsert)
      if (error) throw error
    }
    for (const [t, setId] of wanted) {
      const row = have.get(t)
      if (!row || (row.hardware_set_id || null) === setId) continue
      const { error } = await supabase.from('alu_hardware_package_items').update({ hardware_set_id: setId }).eq('id', row.id)
      if (error) throw error
    }
    const removed = (existing || []).filter(r => !wanted.has(r.type_id)).map(r => r.id)
    if (removed.length) {
      const { error } = await supabase.from('alu_hardware_package_items').delete().in('id', removed)
      if (error) throw error
    }
    it.refetch && it.refetch()
  }
  return { packages: pk.data || EMPTY_ROWS, items: it.data || EMPTY_ROWS, loading: pk.loading || it.loading, error: pk.error || it.error, savePackage, saveItems }
}
