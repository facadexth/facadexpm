// src/hooks/useBomPartModel.js
// Part-editor models of the tenant's BOM templates, for costing (costOpening ctx.partModelByTemplate).
// Loads the four part tables whole, like the other estimation hooks (useEstimation2b.js). Module gating is the
// same as theirs: only the estimation pages (App.jsx tabs with module 'estimation') call this hook, and RLS on the
// four tables requires has_module_access('estimation'), so tenants without estimation never fetch them.
// A load error never blocks costing: templates without layout_kind do not need these rows, and a layout_kind
// template without its model is reported as no_model by costOpening.
import { useMemo } from 'react'
import { useCatalogTable } from './useAluCatalog.js'
import { partModelsByTemplate } from '../lib/partSave.js'

// templates: the bom_templates rows (their layout_kind decides which get a model); typesById: door_window_types by id
// (each template is checked against its type's layout_kind and defaulted from its layout_params; optional).
export function useBomPartModel(templates, typesById = null) {
  const parts = useCatalogTable('bom_template_parts', 'sort_order')
  const positions = useCatalogTable('bom_template_positions', 'sort_order')
  const lines = useCatalogTable('bom_template_position_profiles', 'sort_order')
  const ends = useCatalogTable('bom_template_piece_ends', 'piece_index')
  const loading = parts.loading || positions.loading || lines.loading || ends.loading
  const error = parts.error || positions.error || lines.error || ends.error
  // Models only from a complete load: half-loaded rows would turn into default models (wrong "missing profile"
  // issues); with nothing loaded a layout_kind template has no model and costOpening says no_model.
  const complete = !!(parts.data && positions.data && lines.data && ends.data) && !error
  const partModelByTemplate = useMemo(
    () => (complete ? partModelsByTemplate({ templates, typesById, parts: parts.data, positions: positions.data, lines: lines.data, ends: ends.data }) : {}),
    [complete, templates, typesById, parts.data, positions.data, lines.data, ends.data],
  )
  return {
    partModelByTemplate, loading, error,
    refetch: () => { parts.refetch && parts.refetch(); positions.refetch && positions.refetch(); lines.refetch && lines.refetch(); ends.refetch && ends.refetch() },
  }
}
