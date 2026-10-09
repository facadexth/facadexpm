// src/pages/estimation/useItemModel.js
// Everything the item popup derives from its form on each keystroke: the live (normalised) item, its cost via
// costOpening, the drawing inputs and part labels, the field options and inherited hints, the layout cards and
// the generated quotation description. Pure computation wrapped in useMemo; the popup only holds state and saves.
import { useMemo } from 'react'
import { costOpening } from '../../lib/openingCost.js'
import { resolveItemInputs, addonTemplatesForSeries, typeAvailability } from '../../lib/estimationInherit.js'
import { thicknessesForSeries, hardwareSetsForSeries } from '../../lib/estimationCatalogViews.js'
import { previewFrames, itemPreviewInputs } from '../../lib/itemPreviewSignature.js'
import { buildItemDescription } from '../../lib/descriptionFormat.js'
import { seriesLabelFull } from '../../lib/aluCatalog.js'
import { seriesChoices, finishChoices } from './projectDefaults.js'
import {
  typeTreeOf, cascadeLevels, templatesForType, addonTypeOptions, liveItem, showSashField, inheritedHardware,
  partLabels, layoutCards, descriptionContext, evaluateConstraints,
} from './itemForm.js'

const optionsOf = rows => rows.map(r => ({ value: r.id, label: r.name }))

export function useItemModel({ form, path, project, ctx, templates, constraints, infillTypes, layoutTemplates, seriesTypes }) {
  const { index, templatesById, infillTypesById, packageItems } = ctx
  const tree = useMemo(() => typeTreeOf(index.types), [index])
  const activeTemplates = useMemo(() => (templates || []).filter(t => t.active !== false), [templates])

  return useMemo(() => {
    const pj = project || {}
    const template = templatesById[form.template_id] || null
    const { item, addonPartial } = liveItem(form, pj.id)
    const addonTemplate = item.addon_template_id ? templatesById[item.addon_template_id] || null : null
    const resolved = resolveItemInputs(item, pj, template, index.types, packageItems)
    const seriesId = resolved.series_id

    let cost = null
    if (template) {
      try { cost = costOpening({ ...ctx, item, project: pj, template, addonTemplate, asOf: pj.price_as_of }) } catch { cost = null }
    }
    const frames = previewFrames({ template, addonTemplate, ctx, seriesId, thicknessMm: resolved.thickness_mm })
    const inputs = template && item.width_m > 0 && item.height_m > 0 ? itemPreviewInputs(item, template, addonTemplate, frames) : null
    const labels = template && cost ? partLabels({ components: (ctx.componentsByTemplate || {})[template.id], bom: cost.bom, index }) : null

    const { levels, leafId } = cascadeLevels(tree, path)
    const templateOptions = optionsOf(templatesForType(activeTemplates, leafId, form.template_id))
    const addonTemplates = addonTemplatesForSeries(activeTemplates, seriesId, seriesTypes)

    const thicknesses = seriesId ? thicknessesForSeries(index, seriesId) : []
    const pjSeries = pj.default_series_id ? index.series[pj.default_series_id] : null
    const inheritedOnly = resolveItemInputs({ ...item, labour_per_sqm: null, profit_pct: null }, pj, template, index.types, packageItems)
    const inherit = {
      series: pjSeries ? seriesLabelFull(pjSeries, index.providers[pjSeries.provider_id]) : '',
      thickness: pj.default_thickness_mm != null ? String(Number(pj.default_thickness_mm)) : '',
      finish: pj.default_finish_id && index.finishes[pj.default_finish_id] ? index.finishes[pj.default_finish_id].name : '',
      infill: pj.default_infill_id && infillTypesById[pj.default_infill_id] ? infillTypesById[pj.default_infill_id].name : '',
      labour: inheritedOnly.labour_per_sqm != null ? `ใช้ ${inheritedOnly.labour_per_sqm.toLocaleString('en-US')} จากโปรเจกต์/ประเภท` : 'ใช้ค่าจากเทมเพลต',
      profit: inheritedOnly.profit_pct != null ? `ใช้ ${inheritedOnly.profit_pct}% จากโปรเจกต์` : 'ไม่กำหนด',
    }
    const hwOpts = optionsOf(hardwareSetsForSeries(index, seriesId, template && template.type_id))
    const series = seriesId ? index.series[seriesId] : null

    const generatedDescription = buildItemDescription(descriptionContext({ item, resolved, index, template, infillTypesById }), pj.description_format)
    const cons = c => (constraints || []).filter(x => x.template_id === c)
    return {
      template, addonTemplate, item, addonPartial, resolved, cost, frames, inputs, labels, leafId, levels, templateOptions,
      typeWarn: path.length && !leafId ? 'เลือกประเภทให้ถึงชั้นสุดท้าย' : null,
      templateHint: leafId && !templateOptions.length ? 'ประเภทนี้ยังไม่มีเทมเพลต BOM สร้างได้ที่หน้าเทมเพลต BOM' : null,
      availability: typeAvailability(template, seriesId, seriesTypes),
      addonTemplates, addonTypeOptions: addonTypeOptions(index.types, index.types, addonTemplates),
      seriesOpts: seriesChoices(index, pj.primary_provider_id),
      finishOpts: finishChoices(index, seriesId, pj.primary_provider_id),
      infillOpts: optionsOf((infillTypes || []).filter(g => g.active !== false)),
      thicknesses, showSash: showSashField(index, seriesId, template),
      thicknessHint: !seriesId ? 'เลือกซีรีส์ก่อน' : thicknesses.length === 1 ? `ซีรีส์นี้มีความหนาเดียว (${thicknesses[0]} มม.) เลือกให้อัตโนมัติ` : `ซีรีส์นี้มี ${thicknesses.length} ความหนา`,
      inherit, hwOpts, hwOwnHint: series ? `แสดงเฉพาะชุดที่ใช้กับ ${series.name}` : 'เลือกซีรีส์ก่อน',
      hwInherit: inheritedHardware({ packageItems, index, typeId: template && template.type_id, project: pj }),
      cards: layoutCards({ layoutTemplates, mainTypeId: template && template.type_id, seriesId, seriesTypes, addonTemplates, widthM: item.width_m, heightM: item.height_m }),
      generatedDescription,
      violations: template ? evaluateConstraints(item, cons(template.id)) : [],
      addonViolations: addonTemplate ? evaluateConstraints({ width_m: item.addon_width_m, height_m: item.addon_height_m, panel_count: item.addon_panel_count }, cons(addonTemplate.id)) : [],
    }
  }, [form, path, project, ctx, tree, activeTemplates, constraints, infillTypes, layoutTemplates, seriesTypes, index, templatesById, infillTypesById, packageItems])
}
