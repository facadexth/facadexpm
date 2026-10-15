// src/pages/estimation/projectDefaults.js
// Pure helpers for the estimation project page (defaults form, banners, items table). No React, no Supabase.
import { thicknessesForSeries, seriesForType } from '../../lib/estimationCatalogViews.js'
import { seriesLabelFull } from '../../lib/aluCatalog.js'
import { DEFAULT_DESCRIPTION_FORMAT } from '../../lib/descriptionFormat.js'
import { mergeSettings } from '../../lib/estimationSettings.js'
import { localDateString } from '../../lib/localDate.js'
import { costOpening, partPreviewCtx } from '../../lib/openingCost.js'
import { typeAvailability } from '../../lib/estimationInherit.js'
import { missingHardwareTypeIds } from '../../lib/projectHardware.js'
import { unresolvedText } from '../../lib/reasonText.js'
import { previewFrames, itemPreviewSignature } from '../../lib/itemPreviewSignature.js'

const str = v => (v === null || v === undefined ? '' : String(v))
const numOrNull = v => {
  if (v === null || v === undefined || String(v).trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}
const byLabel = (a, b) => String(a.label).localeCompare(String(b.label), 'th')

export const DRAFT_COLUMNS = [
  'primary_provider_id', 'default_series_id', 'default_finish_id', 'default_thickness_mm', 'default_sash_thickness_mm',
  'default_infill_id', 'hardware_package_id', 'labour_per_sqm', 'profit_pct', 'description_format',
]

export function draftFromProject(p) {
  const pj = p || {}
  return {
    primary_provider_id: str(pj.primary_provider_id), default_series_id: str(pj.default_series_id), default_finish_id: str(pj.default_finish_id),
    default_thickness_mm: str(pj.default_thickness_mm), default_sash_thickness_mm: str(pj.default_sash_thickness_mm),
    default_infill_id: str(pj.default_infill_id), hardware_package_id: str(pj.hardware_package_id),
    labour_per_sqm: str(pj.labour_per_sqm), profit_pct: str(pj.profit_pct),
    description_format: Array.isArray(pj.description_format) ? [...pj.description_format] : [...DEFAULT_DESCRIPTION_FORMAT],
  }
}

// Series the owner may pick: active, and of the main extruder when one is chosen. "series · extruder" label.
export function seriesChoices(index, primaryProviderId) {
  return Object.values(index.series)
    .filter(s => s.active !== false && (!primaryProviderId || s.provider_id === primaryProviderId))
    .map(s => ({ value: s.id, label: seriesLabelFull(s, index.providers[s.provider_id]) }))
    .sort(byLabel)
}

// Colours of the series' extruder (or of the main extruder while no series is chosen).
export function finishChoices(index, seriesId, primaryProviderId) {
  const providerId = (index.series[seriesId] && index.series[seriesId].provider_id) || primaryProviderId || null
  if (!providerId) return []
  return Object.values(index.finishes)
    .filter(f => f.active !== false && f.provider_id === providerId)
    .map(f => ({ value: f.id, label: f.name })).sort(byLabel)
}

// True when at least one type of the series allows frame and sash to differ (seriesTypes = expanded links).
export function mixedThicknessAllowed(seriesTypes, seriesId) {
  return !!seriesId && (seriesTypes || []).some(l => l.series_id === seriesId && l.allow_mixed_thickness === true)
}

// Brings dependent fields back in line after any change: series must belong to the main extruder, colour to the
// series' extruder, thicknesses must be ones the series offers (a single one is selected for the owner), and the
// sash thickness exists only where a type allows mixed thickness. Returns a new draft.
export function reconcileDraft(draft, index, seriesTypes) {
  const d = { ...draft }
  const series = d.default_series_id ? index.series[d.default_series_id] : null
  if (d.default_series_id && (!series || (d.primary_provider_id && series.provider_id !== d.primary_provider_id))) d.default_series_id = ''
  const finishes = finishChoices(index, d.default_series_id, d.primary_provider_id)
  if (d.default_finish_id && !finishes.some(f => f.value === d.default_finish_id)) d.default_finish_id = ''
  const opts = d.default_series_id ? thicknessesForSeries(index, d.default_series_id) : []
  if (opts.length === 1) d.default_thickness_mm = String(opts[0])
  else if (!opts.includes(Number(d.default_thickness_mm))) d.default_thickness_mm = ''
  const mixed = mixedThicknessAllowed(seriesTypes, d.default_series_id)
  if (!mixed || !opts.includes(Number(d.default_sash_thickness_mm))) d.default_sash_thickness_mm = ''
  // Ruling 21: where the sash select is shown the saved value is a real number. Only a blank is filled (from the frame);
  // an existing sash never follows later frame changes. No frame yet = stays blank (saved as NULL).
  if (mixed && d.default_sash_thickness_mm === '' && d.default_thickness_mm !== '') d.default_sash_thickness_mm = d.default_thickness_mm
  return d
}

// What the sash select shows: the draft's sash value ('' = the "— เลือก —" placeholder).
export const sashDisplayValue = draft => draft.default_sash_thickness_mm || ''

export function validateDraft(draft) {
  const labour = numOrNull(draft.labour_per_sqm)
  if (Number.isNaN(labour) || (labour !== null && labour < 0)) return 'ค่าแรงต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป'
  const profit = numOrNull(draft.profit_pct)
  if (Number.isNaN(profit) || (profit !== null && (profit < 0 || profit > 1000))) return 'กำไร % ต้องอยู่ระหว่าง 0 ถึง 1000'
  if (!Array.isArray(draft.description_format) || !draft.description_format.length) return 'รูปแบบคำอธิบายต้องมีอย่างน้อย 1 ส่วน'
  return null
}

const NUM_COLS = new Set(['default_thickness_mm', 'default_sash_thickness_mm', 'labour_per_sqm', 'profit_pct'])
// Only the columns that differ from the saved project. Blank = NULL (labour 0 is a value).
export function buildPatch(project, draft) {
  const pj = project || {}
  const patch = {}
  for (const col of DRAFT_COLUMNS) {
    if (col === 'description_format') {
      const saved = Array.isArray(pj.description_format) ? pj.description_format : DEFAULT_DESCRIPTION_FORMAT
      if (JSON.stringify(saved) !== JSON.stringify(draft.description_format)) patch[col] = draft.description_format
    } else if (NUM_COLS.has(col)) {
      const next = numOrNull(draft[col])
      const was = numOrNull(pj[col])
      if (next !== was) patch[col] = next
    } else {
      const next = draft[col] || null
      if ((pj[col] || null) !== next) patch[col] = next
    }
  }
  return patch
}

// The insert row of a new project: the price date is the viewer's local date, never the DB default (Ruling 17).
// The factors are seeded from the tenant defaults (settings, optional); the transport total starts blank.
export const newProjectRow = (name, settings, now = new Date()) => {
  const s = mergeSettings(settings)
  return {
    name: String(name).trim(), price_as_of: localDateString(now),
    waste_pct: s.default_waste_pct, profit_pct: s.default_profit_pct, pm_pct: s.default_pm_pct, round_step: s.default_round_step, transport_total: null,
  }
}

// Whole numbers >= 1 only; blanks, fractions, 0 and negatives are refused (null).
export function parseQuantity(text) {
  const s = String(text ?? '').trim()
  if (!/^\d+$/.test(s)) return null
  const n = Number(s)
  return Number.isSafeInteger(n) && n >= 1 ? n : null
}

// Rows of the project's chosen package, or null when the project has none (legacy default then applies).
export function packageRowsFor(project, allItems) {
  if (!project || !project.hardware_package_id) return null
  return (allItems || []).filter(r => r.package_id === project.hardware_package_id)
}

// Amber banners of the hardware package: types of the project's items it does not cover, and a package of another series.
export function hardwareBanners({ project, pkg, packageItems, items, templatesById, typesById }) {
  // Only the main template gets a hardware set; add-ons are priced with __noHardware, so they never raise a banner.
  const typeIds = []
  let typelessCount = 0
  for (const it of items || []) {
    const t = it.template_id ? (templatesById || {})[it.template_id] : null
    if (!t) continue
    if (t.type_id) typeIds.push(t.type_id)
    else typelessCount += 1
  }
  const missingTypeIds = packageItems ? missingHardwareTypeIds(packageItems, typesById, typeIds) : []
  // A template with no type cannot match a package row, so its items price without a hardware set.
  const typelessTemplateItems = packageItems ? typelessCount : 0
  const wrongSeries = !!(pkg && pkg.series_id && project && project.default_series_id && pkg.series_id !== project.default_series_id)
  return { missingTypeIds, wrongSeries, typelessTemplateItems }
}

// Items whose main template or add-on type the series they will use does not offer, with the series that do.
export function availabilityIssues({ items, project, templatesById, index, seriesTypes }) {
  const out = []
  for (const item of items || []) {
    const seriesId = item.series_id || (project && project.default_series_id) || null
    if (!seriesId) continue
    for (const [which, tid] of [['main', item.template_id], ['addon', item.addon_template_id]]) {
      const t = tid ? (templatesById || {})[tid] : null
      if (!t || typeAvailability(t, seriesId, seriesTypes) !== 'not_offered') continue
      out.push({ item, which, template: t, offeredBy: seriesForType(index, t.type_id).map(s => seriesLabelFull(s, index.providers[s.provider_id])) })
    }
  }
  return out
}

export function unresolvedSummary(unresolved) {
  return (unresolved || []).map(u => `${u.name || '?'}: ${unresolvedText(u)}`).join('\n')
}

// 'unresolved' | 'old_preview' | 'ok'. Old preview = a saved drawing whose signature differs from currentSig, the
// signature the item has now (currentPreviewSigs, the same helper the item form uses when it saves the snapshot).
export function itemStatus(item, cost, currentSig) {
  if (!cost || (cost.unresolved || []).length) return 'unresolved'
  const it = item || {}
  if ((it.preview_svg_out || it.preview_svg_in) && it.preview_sig && currentSig && currentSig !== it.preview_sig) return 'old_preview'
  return 'ok'
}

// { [itemId]: signature now } for items that have a saved snapshot. costs = costItems(...) (its `resolved` gives the
// series and thickness the item inherits); base = the costOpening context (templatesById, index, components, joints,
// partModelByTemplate: a layout_kind item signs its part model exactly as snapshotFor does when the item form saves).
// Inline add-ons: partPreviewCtx carries the item's saved ones (base.itemAddonsByOpening[item.id]), signed by the same
// addonSignature helper snapshotFor uses for the form's live add-ons, so a saved item reads "ok" until its add-ons change.
export function currentPreviewSigs({ items, costs, base }) {
  const out = {}
  const byId = (base && base.templatesById) || {}
  for (const item of items || []) {
    const cost = (costs || {})[item.id]
    if (!item.preview_sig || !cost) continue
    const template = byId[item.template_id]
    if (!template) continue
    const addonTemplate = item.addon_template_id ? byId[item.addon_template_id] || null : null
    const resolved = previewFrames({ template, addonTemplate, ctx: base, seriesId: cost.resolved.series_id, thicknessMm: cost.resolved.thickness_mm })
    out[item.id] = itemPreviewSignature(item, template, addonTemplate, resolved, partPreviewCtx(base, template, cost.resolved, item))
  }
  return out
}

// { [itemId]: costOpening result } for one price date. base = the catalog/lookup part of the costOpening context.
export function costItems({ items, project, base, asOf }) {
  const out = {}
  for (const item of items || []) {
    const template = (base.templatesById || {})[item.template_id]
    if (!template) { out[item.id] = null; continue }
    const addonTemplate = item.addon_template_id ? (base.templatesById || {})[item.addon_template_id] || null : null
    try {
      out[item.id] = costOpening({ ...base, item, project, template, addonTemplate, asOf })
    } catch { out[item.id] = null }
  }
  return out
}

// listPriceChanges reads profile/grid/hardware/set lines of one BOM per item: fold the add-on's lines in.
export function bomsForStale(costs) {
  const m = {}
  for (const [id, r] of Object.entries(costs || {})) {
    if (!r) continue
    // the legacy add-on and the inline attach units (addonBoms)
    const extra = [r.addonBom, ...(r.addonBoms || []).map(a => a && a.bom)].filter(Boolean)
    m[id] = extra.length ? {
      profileLines: [r.bom, ...extra].flatMap(b => b.profileLines), gridLines: [r.bom, ...extra].flatMap(b => b.gridLines),
      hardwareLines: [r.bom, ...extra].flatMap(b => b.hardwareLines), hardwareSetLines: [r.bom, ...extra].flatMap(b => b.hardwareSetLines || []),
    } : r.bom
  }
  return m
}

// "฿123.00 / กก. (ตั้งแต่ 2026-01-01)" for a price row id; null id = no price.
export function priceRowLabel(index, id) {
  if (!id) return 'ไม่มีราคา'
  const kg = index.kgPrices.find(r => r.id === id)
  if (kg) return `${Number(kg.price_per_kg).toLocaleString('en-US', { minimumFractionDigits: 2 })} บาท/กก. (ตั้งแต่ ${kg.effective_from})`
  const pc = index.piecePrices.find(r => r.id === id)
  if (pc) return `${Number(pc.price_per_piece).toLocaleString('en-US', { minimumFractionDigits: 2 })} บาท/เส้น (ตั้งแต่ ${pc.effective_from})`
  const pt = index.partPrices.find(r => r.id === id)
  if (pt) return `${(Number(pt.list_price) * (1 - Number(pt.discount_pct || 0) / 100)).toLocaleString('en-US', { minimumFractionDigits: 2 })} บาท (ตั้งแต่ ${pt.effective_from})`
  return 'ราคาที่ถูกลบแล้ว'
}
