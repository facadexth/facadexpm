// Attachment pages ("แบบแนบ") for a quotation that was pushed from an estimation project (Task 11, spec §7.3).
//
// ISOLATION (spec decision 14): the Quotation page is used by every tenant. This hook returns null WITHOUT ANY
// Supabase call unless the tenant has the `estimation` module and the quotation has an id; with the module it
// first looks up the link (one query) and stops there when there is no link, the link is disabled, or the mode
// shows no pages. Errors never reach the page: they become null + console.warn.
//
// hasModuleAccess is passed in by the caller (Quotations.jsx already holds it from its own useTenant()).
// useTenant() is NOT a shared context here -- every call starts its own tenant/module fetch -- so calling it
// inside this hook would add queries for every tenant, which is exactly what the isolation rule forbids.
//
// Scope (Task 11 ruling): attach_mode 'pages' and 'both' show the pages; 'thumb' (thumbnails in the item rows)
// is not built yet and shows nothing. Optional weight / glass-area rows are not supplied. Catalogue pictures
// (imageUrls) are a later task: {} here, the component shows placeholder icons.
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { resolveItemInputs } from '../../lib/estimationInherit.js'
import { planAttachmentPages, hardwareSchedule, colourLegend } from '../../lib/attachmentPages.js'

const byId = rows => Object.fromEntries((rows || []).map(r => [r.id, r]))
const uniq = arr => [...new Set((arr || []).filter(v => v != null && v !== ''))]

export function canLoadAttachments(quotation, hasModuleAccess) {
  return !!(quotation && quotation.id && typeof hasModuleAccess === 'function' && hasModuleAccess('estimation'))
}

export function showsPages(link) {
  return !!(link && link.attach_enabled && (link.attach_mode === 'pages' || link.attach_mode === 'both'))
}

// Pure: estimation openings -> RESOLVED attachment items (item contract in lib/attachmentPages.js).
// Only openings mapped in estimation_quotation_lines to an item row that still exists in this quotation are
// kept, ordered like the quotation's own rows (sort_order, then position).
export function buildAttachmentItems({ openings, lines, quotationItems, project, templatesById, typesById, packageItems }) {
  const rowOrder = new Map()
  ;(quotationItems || []).forEach((r, i) => {
    if (r && r.id) rowOrder.set(r.id, [Number.isFinite(Number(r.sort_order)) && r.sort_order !== null && r.sort_order !== '' ? Number(r.sort_order) : Infinity, i])
  })
  const rowByOpening = new Map()
  for (const l of lines || []) {
    if (l && l.opening_id && l.item_row_id && rowOrder.has(l.item_row_id)) rowByOpening.set(l.opening_id, l.item_row_id)
  }
  const out = []
  for (const o of openings || []) {
    const rowId = o && rowByOpening.get(o.id)
    if (!rowId) continue
    const template = (templatesById || {})[o.template_id] || null
    const r = resolveItemInputs(o, project, template, typesById, packageItems)
    const type = template && template.type_id ? (typesById || {})[template.type_id] : null
    out.push({
      item: {
        ...o,
        series_id: r.series_id,
        alu_finish_id: r.finish_id,
        infill_type_id: r.infill_type_id,
        hardware_set_id: r.hardware_set_id,
        no_hardware_set: !!o.no_hardware_set,
        frame_thickness_mm: r.thickness_mm,
        sash_thickness_mm: r.sash_thickness_mm,
        type_name: (type && type.name) || (template && template.name) || '',
        item_name: o.item_name || '',
      },
      order: rowOrder.get(rowId),
    })
  }
  out.sort((a, b) => (a.order[0] - b.order[0]) || (a.order[1] - b.order[1]))
  return out.map(x => x.item)
}

// Pure: catalogue rows -> the ctx the attachment component and itemSpecRows read.
export function buildAttachmentCtx({ series, finishes, infills, setRows, setItems, parts, providers }) {
  const partsById = byId(parts)
  const partsBySet = {}
  for (const si of setItems || []) {
    ;(partsBySet[si.set_id] = partsBySet[si.set_id] || []).push({ part_id: si.part_id, quantity: si.quantity, part: partsById[si.part_id] || null })
  }
  return {
    seriesById: byId(series), finishesById: byId(finishes), infillById: byId(infills),
    setsById: byId(setRows), partsBySet, providersById: byId(providers),
  }
}

// Pure: items + ctx + view -> the object the Quotation page consumes. buildExtra(n) takes the quotation's own
// measured page count (known only after its pagination); the number of attachment pages does not depend on n.
export function assembleAttachments({ items, ctx, view }) {
  const schedule = hardwareSchedule({ items, setsById: ctx.setsById, partsBySet: ctx.partsBySet, providersById: ctx.providersById })
  const legend = colourLegend(items, ctx)
  const options = { view: view || 'both' }
  const plan0 = planAttachmentPages({ items, options, totalQuotationPages: 0, schedule, legend })
  const extraPageCount = plan0.pages.length
  if (extraPageCount === 0) return null
  const imageUrls = {}
  const memo = new Map()
  const buildExtra = totalQuotationPages => {
    const n = Number.isFinite(Number(totalQuotationPages)) ? Number(totalQuotationPages) : 0
    if (!memo.has(n)) {
      const plan = planAttachmentPages({ items, options, totalQuotationPages: n, schedule, legend })
      memo.set(n, { plan, items, ctx, imageUrls, extraPageCount: plan.pages.length })
    }
    return memo.get(n)
  }
  return { plan: plan0, items, ctx, imageUrls, extraPageCount, schedule, legend, buildExtra }
}

const must = res => { if (res && res.error) throw res.error; return res ? res.data : null }

// Loads everything for one quotation. Zero queries unless canLoadAttachments(); one query (the link) when
// there is nothing to attach. Never throws.
export async function loadQuotationAttachments({ supabase: sb = supabase, quotation, hasModuleAccess }) {
  if (!canLoadAttachments(quotation, hasModuleAccess)) return null
  try {
    const links = must(await sb.from('estimation_quotation_links').select('*').eq('quotation_id', quotation.id).limit(1)) || []
    const link = links[0]
    if (!showsPages(link)) return null
    const pid = link.project_id
    const [projects, lines, openings] = await Promise.all([
      sb.from('estimation_projects').select('*').eq('id', pid).limit(1).then(must),
      sb.from('estimation_quotation_lines').select('*').eq('project_id', pid).then(must),
      sb.from('estimation_openings').select('*').eq('project_id', pid).then(must),
    ])
    const project = (projects || [])[0]
    if (!project) return null
    let quotationItems = quotation.quotation_items
    if (!Array.isArray(quotationItems)) {
      quotationItems = must(await sb.from('quotation_items').select('id, sort_order').eq('quotation_id', quotation.id).order('sort_order')) || []
    }
    const mappedIds = new Set((lines || []).map(l => l.opening_id))
    const mapped = (openings || []).filter(o => mappedIds.has(o.id))
    if (mapped.length === 0) return null
    const templateIds = uniq(mapped.map(o => o.template_id))
    const [templates, types, pkgItems] = await Promise.all([
      templateIds.length ? sb.from('bom_templates').select('*').in('id', templateIds).then(must) : [],
      sb.from('door_window_types').select('*').then(must),
      project.hardware_package_id ? sb.from('alu_hardware_package_items').select('*').eq('package_id', project.hardware_package_id).then(must) : null,
    ])
    const items = buildAttachmentItems({
      openings: mapped, lines, quotationItems, project,
      templatesById: byId(templates), typesById: byId(types), packageItems: project.hardware_package_id ? (pkgItems || []) : null,
    })
    if (items.length === 0) return null
    const seriesIds = uniq(items.map(i => i.series_id))
    const finishIds = uniq(items.map(i => i.alu_finish_id))
    const infillIds = uniq(items.map(i => i.infill_type_id))
    const setIds = uniq(items.filter(i => !i.no_hardware_set).map(i => i.hardware_set_id))
    const [series, finishes, infills, setItems] = await Promise.all([
      seriesIds.length ? sb.from('alu_series').select('*').in('id', seriesIds).then(must) : [],
      finishIds.length ? sb.from('alu_finishes').select('*').in('id', finishIds).then(must) : [],
      infillIds.length ? sb.from('infill_types').select('*').in('id', infillIds).then(must) : [],
      setIds.length ? sb.from('alu_part_set_items').select('*').in('set_id', setIds).then(must) : [],
    ])
    const partIds = uniq([...setIds, ...(setItems || []).map(r => r.part_id)])
    const parts = partIds.length ? (must(await sb.from('alu_parts').select('*').in('id', partIds)) || []) : []
    const setRows = parts.filter(p => setIds.includes(p.id))
    const providerIds = uniq(setRows.map(s => s.provider_id))
    const providers = providerIds.length ? (must(await sb.from('alu_providers').select('*').in('id', providerIds)) || []) : []
    const ctx = buildAttachmentCtx({ series, finishes, infills, setRows, setItems, parts, providers })
    return assembleAttachments({ items, ctx, view: link.attach_view })
  } catch (e) {
    console.warn('quotation attachments: not shown', e)
    return null
  }
}

// One load per quotation id (+ revision, so a re-push is picked up); concurrent callers share the promise.
const cache = new Map()
const MAX_CACHE = 20
export function attachmentsCacheKey(quotation) {
  return `${quotation.id}|${quotation.revision ?? ''}|${quotation.updated_at ?? ''}|${(quotation.quotation_items || []).length}`
}
function cachedLoad(key, load) {
  if (!cache.has(key)) {
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value)
    cache.set(key, load().catch(() => null))
  }
  return cache.get(key)
}

export function useQuotationAttachments(quotation, hasModuleAccess) {
  const enabled = canLoadAttachments(quotation, hasModuleAccess)
  const key = enabled ? attachmentsCacheKey(quotation) : null
  const [state, setState] = useState({ key: null, value: null })
  useEffect(() => {
    if (!key) return undefined
    let cancelled = false
    cachedLoad(key, () => loadQuotationAttachments({ quotation, hasModuleAccess }))
      .then(value => { if (!cancelled) setState({ key, value }) })
    return () => { cancelled = true }
    // key captures the quotation identity; hasModuleAccess is re-created every render by useTenant()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return useMemo(() => (key && state.key === key ? state.value : null), [key, state])
}
