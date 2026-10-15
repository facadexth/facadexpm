// Persistence for inline add-ons ("ช่องแสง"): template piece sets (bom_template_addon_pieces) and per-opening
// add-ons (estimation_item_addons). Pure row mappers plus delete-then-insert savers, mirroring partSave.js saveModel.
// NOT atomic: the delete and the insert are separate requests, so a failure between them leaves the template (or
// opening) with no rows until the user saves again. Validation runs first so a bad payload never reaches the delete.
import { validateAddons, validatePieceRows, setKey } from './addonModel.js'

export const PIECE_COLUMNS = ['mode', 'kind', 'position', 'piece_key', 'profile_family', 'ref_input', 'length_factor', 'deduction_mm', 'qty_rule', 'qty_fixed', 'thickness_role', 'note', 'sort_order']
const PIECES = 'bom_template_addon_pieces'
const ITEMS = 'estimation_item_addons'
const CHUNK = 200

const bySort = (a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0)

export function pieceRowsToSets(rows) {
  const sets = {}
  for (const r of [...(rows || [])].sort(bySort)) {
    // eslint-disable-next-line no-unused-vars
    const { id, tenant_id, template_id, created_at, ...rest } = r
    const k = setKey(r.mode, r.kind, r.position)
    ;(sets[k] = sets[k] || []).push(rest)
  }
  return sets
}

export function pieceSetsToRows(sets, templateId) {
  const out = []
  for (const list of Object.values(sets || {})) {
    list.forEach((r, i) => {
      const row = { template_id: templateId }
      for (const c of PIECE_COLUMNS) row[c] = r[c] === undefined ? null : r[c]
      row.length_factor = Number(r.length_factor)
      row.deduction_mm = Number(r.deduction_mm)
      row.qty_fixed = r.qty_fixed == null ? null : Number(r.qty_fixed)
      row.sort_order = i
      if (r.mode === 'attach') row.position = null
      out.push(row)
    })
  }
  return out
}

async function insertChunks(supabase, table, rows) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase.from(table).insert(rows.slice(i, i + CHUNK))
    if (error) throw new Error(error.message)
  }
}

export async function saveAddonPieces({ supabase, templateId, rows }) {
  const problem = validatePieceRows(rows)
  if (problem) throw new Error(problem)
  {
    const { error } = await supabase.from(PIECES).delete().eq('template_id', templateId)
    if (error) throw new Error(error.message)
  }
  await insertChunks(supabase, PIECES, rows)
}

async function readIn(supabase, table, col, ids) {
  const { data, error } = await supabase.from(table).select('*').in(col, ids)
  if (error) throw new Error(error.message)
  return data || []
}

export async function loadAddonPieces({ supabase, templateIds }) {
  const ids = templateIds || []
  const out = {}
  if (!ids.length) return out
  for (const id of ids) out[id] = []
  for (const r of await readIn(supabase, PIECES, 'template_id', ids)) if (out[r.template_id]) out[r.template_id].push(r)
  for (const id of ids) out[id].sort(bySort)
  return out
}

const m6 = (mm) => Math.round((Number(mm) / 1000) * 1e6) / 1e6 // no integer rounding: 1723.8 mm -> 1.7238 m (brief test case)
const toMm = (m) => Math.round(Number(m) * 1000 * 1000) / 1000

export function itemAddonsFromRows(rows) {
  return [...(rows || [])].sort(bySort).map(r => ({
    id: r.id, mode: r.mode, kind: r.kind, position: r.position,
    len_mm: toMm(r.len_m), thick_mm: toMm(r.thick_m), offset_mm: toMm(r.offset_m),
    rows: Number(r.rows), cols: Number(r.cols),
  }))
}

export function itemAddonsToRows(addons, openingId) {
  return (addons || []).map((a, i) => ({
    opening_id: openingId, mode: a.mode, kind: a.kind, position: a.position,
    len_m: m6(a.len_mm), thick_m: m6(a.thick_mm), offset_m: m6(a.offset_mm || 0),
    rows: Number(a.rows), cols: Number(a.cols), sort_order: i,
  }))
}

export async function saveItemAddons({ supabase, openingId, addons, main }) {
  const problem = validateAddons(addons, main)
  if (problem) throw new Error(problem)
  const rows = itemAddonsToRows(addons, openingId)
  {
    const { error } = await supabase.from(ITEMS).delete().eq('opening_id', openingId)
    if (error) throw new Error(error.message)
  }
  await insertChunks(supabase, ITEMS, rows)
}

export async function loadItemAddons({ supabase, openingIds }) {
  const ids = openingIds || []
  const grouped = {}
  if (!ids.length) return grouped
  for (const id of ids) grouped[id] = []
  for (const r of await readIn(supabase, ITEMS, 'opening_id', ids)) if (grouped[r.opening_id]) grouped[r.opening_id].push(r)
  const out = {}
  for (const id of ids) out[id] = itemAddonsFromRows(grouped[id])
  return out
}
