// src/pages/estimation/quickQuote.js
// Pure helpers of the quick calculator ("ลองคิดราคา"): the choices, the throw-away item built from them and the
// per-set cost at the project's price date and today. Nothing here saves anything: the item is a plain object.
import { selectableTypes, typeLabel } from '../../lib/typeTree.js'
import { bomTemplatesForType } from '../../lib/layoutTemplates.js'
import { emptyForm, buildOpeningPayload } from '../../lib/openingPayload.js'
import { thicknessesForSeries } from '../../lib/estimationCatalogViews.js'
import { costOpening } from '../../lib/openingCost.js'
import { seriesChoices, finishChoices } from './projectDefaults.js'
import { reconcileItemForm, showSashField } from './itemForm.js'

export const emptyQuick = () => ({ template_id: '', series_id: '', alu_finish_id: '', thickness_mm: '', sash_thickness_mm: '', width_m: '', height_m: '', panel_count: '1' })

// Templates grouped by leaf type: [{ label: 'ประตู › บานเลื่อน', options: [{ value, label }] }] (types without a template left out).
export function quickTemplateGroups(index, templates) {
  return selectableTypes(index.types)
    .map(t => ({ label: typeLabel(index.types, t.id), options: bomTemplatesForType(templates, t.id).map(x => ({ value: x.id, label: x.name })) }))
    .filter(g => g.options.length)
}
export const quickSeriesOptions = index => seriesChoices(index, null)          // all active series, "ชื่อซีรีส์ · โรงรีด"
export const quickFinishOptions = (index, seriesId) => finishChoices(index, seriesId, null)   // colours of the series' extruder
export const quickThicknessOptions = (index, seriesId) => (seriesId ? thicknessesForSeries(index, seriesId) : []).map(t => ({ value: String(t), label: String(t) }))
export const quickShowSash = (index, seriesId, template) => showSashField(index, seriesId, template)

// The form after a change: a colour of another extruder is dropped, a single thickness is filled, a shown sash
// holds a real number (Ruling 21: never an "equal to frame" option) and a hidden one is blank.
export function reconcileQuick(prev, next, { index, template }) {
  const has = (opts, v) => v !== '' && opts.some(o => o.value === String(v))
  const thick = quickThicknessOptions(index, next.series_id)
  const clean = { ...next }
  if (!has(quickFinishOptions(index, next.series_id), clean.alu_finish_id)) clean.alu_finish_id = ''
  if (!has(thick, clean.thickness_mm)) clean.thickness_mm = ''
  if (!has(thick, clean.sash_thickness_mm) || !quickShowSash(index, next.series_id, template)) clean.sash_thickness_mm = ''
  const f = reconcileItemForm({ ...emptyForm(), ...prev }, { ...emptyForm(), ...clean }, { index, project: {}, template, isNew: true })
  return { ...clean, thickness_mm: f.thickness_mm, sash_thickness_mm: f.sash_thickness_mm }
}

// What is still missing before a price can be shown (Thai), or null. Sizes are millimetres.
export function quickMissing(q, template, showSash) {
  if (!template) return 'เลือกเทมเพลต'
  if (!q.series_id) return 'เลือกซีรีส์'
  if (!q.alu_finish_id) return 'เลือกสี'
  if (q.thickness_mm === '') return 'เลือกความหนา'
  if (showSash && q.sash_thickness_mm === '') return 'เลือกความหนากรอบบาน'
  if (!(Number(q.width_m) > 0) || !(Number(q.height_m) > 0)) return 'กรอกกว้างและสูง (มม.)'
  return null
}

// The throw-away item: a plain object in the shape of an estimation_openings row, in metres. Hardware, infill,
// labour and profit stay blank = inherited from the project (hardware by the package for the template's type).
export function buildQuickItem(q) {
  const { project_id, ...item } = buildOpeningPayload({ ...emptyForm(), ...q, opening_no: 'quick' }, { projectId: null })
  return { ...item, id: 'quick' }
}

// Cost per set at each date (project date, and today when different): [{ key, label, asOf, cost|null }].
export function quickCosts({ q, template, project, ctx, today }) {
  const item = buildQuickItem(q)
  const dates = [{ key: 'project', label: 'ตามราคาของโปรเจกต์', asOf: project.price_as_of }]
  if (today && today !== project.price_as_of) dates.push({ key: 'today', label: 'ตามราคาวันนี้', asOf: today })
  return dates.map(d => {
    let cost = null
    try { cost = costOpening({ ...ctx, item, project, template, addonTemplate: null, asOf: d.asOf }) } catch { cost = null }
    return { ...d, cost }
  })
}

export const quickMoney = v => Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
