// src/pages/bomTemplates/addon/addonTemplateGlue.js
// Load / save glue between BomTemplates' TemplateEditor and the add-on UI of the part editor, kept out of
// BomTemplates.jsx (size). State: `addonSets` = { [setKey]: { rows, dirty } } (the template's piece sets) and
// `previewAddons` (UI only, never saved). Saving rewrites every piece row of the template (saveAddonPieces is
// delete-then-insert), so it writes the loaded sets plus the edited ones, and only when a set was edited; a set never
// opened stays absent and costing keeps using its defaults. A failed load blocks writing (never saved over).
import { useState } from 'react'
import { supabase as defaultSupabase } from '../../../lib/supabase.js'
import { loadAddonPieces, saveAddonPieces, pieceRowsToSets, pieceSetsToRows } from '../../../lib/addonSave.js'
import { validatePieceRows } from '../../../lib/addonModel.js'

export const LOAD_FAILED = 'โหลดชิ้นส่วนช่องแสงของเทมเพลตไม่สำเร็จ จึงยังไม่ได้บันทึกอะไร กรุณารีโหลดหน้านี้'
export const SAVE_FAILED = 'บันทึกชิ้นส่วนช่องแสงไม่สำเร็จ (ชิ้นส่วนช่องแสงของเทมเพลตนี้อาจไม่ครบ กรุณากดบันทึกอีกครั้ง)'
export const LOADING = 'กำลังโหลดชิ้นส่วนช่องแสงของเทมเพลต กรุณารอสักครู่แล้วกดบันทึกอีกครั้ง'

export function setsFromRows(rows) {
  const out = {}
  for (const [k, list] of Object.entries(pieceRowsToSets(rows))) out[k] = { rows: list, dirty: false }
  return out
}

export const anyDirty = (addonSets) => Object.values(addonSets || {}).some((s) => s && s.dirty)

// { [setKey]: rows } of every set that has rows (loaded or edited), for pieceSetsToRows.
export function setsToSave(addonSets) {
  const out = {}
  for (const [k, s] of Object.entries(addonSets || {})) if (s && s.rows && s.rows.length) out[k] = s.rows
  return out
}

// Thai problem that must stop the save before anything is written, or null.
export function addonSaveProblem({ addonSets, status, error }) {
  if (!anyDirty(addonSets)) return null
  if (status === 'error') return `${LOAD_FAILED}: ${error || ''}`
  if (status !== 'ready') return LOADING
  return validatePieceRows(pieceSetsToRows(setsToSave(addonSets), null))
}

// Writes the piece rows when a set was edited; returns true when it wrote.
export async function saveAddonSets({ supabase = defaultSupabase, templateId, addonSets }) {
  if (!anyDirty(addonSets)) return false
  await saveAddonPieces({ supabase, templateId, rows: pieceSetsToRows(setsToSave(addonSets), templateId) })
  return true
}

export async function loadAddonSets({ supabase = defaultSupabase, templateId }) {
  const map = await loadAddonPieces({ supabase, templateIds: [templateId] })
  return setsFromRows(map[templateId] || [])
}

// TemplateEditor state. `template` with an id and a layout_kind has saved rows to load first (status 'loading' until
// load() resolves); a new / legacy template starts 'ready' with no sets.
export function useAddonTemplateState(template) {
  const [addonSets, setAddonSets] = useState({})
  const [previewAddons, setPreviewAddons] = useState([])
  const [status, setStatus] = useState(() => (template?.id && template?.layout_kind ? 'loading' : 'ready'))
  const [error, setError] = useState(null)
  const [saveError, setSaveError] = useState(null)   // last refusal / failure of the add-on save, shown in the box + zoom card
  const ready = status === 'ready'
  return {
    addonSets, previewAddons, status, error, saveError,
    // once at open (alongside loadModel) and again after a save; a failed re-load after a good save keeps the sets
    load: (templateId) => loadAddonSets({ templateId })
      .then((s) => { setAddonSets(s); setStatus('ready'); setError(null) })
      .catch((e) => { if (!ready) { setStatus('error'); setError(e.message) } }),
    problem: () => { const p = addonSaveProblem({ addonSets, status, error }); setSaveError(p); return p },
    save: (templateId) => saveAddonSets({ templateId, addonSets })
      .then((wrote) => { setSaveError(null); return wrote })
      .catch((e) => { setSaveError(`${SAVE_FAILED}: ${e.message}`); throw e }),
    editorProps: {
      addonSets, previewAddons, onPreviewAddonsChange: setPreviewAddons,
      onAddonSetsChange: ready ? setAddonSets : undefined,
      addonError: [status === 'error' ? `${LOAD_FAILED}: ${error || ''} (ชิ้นส่วนช่องแสงแก้ไม่ได้จนกว่าจะโหลดสำเร็จ)` : null, saveError].filter(Boolean).join(' · ') || null,
    },
  }
}
