// Pure planning/data helpers for the quotation attachment pages ("แบบแนบ").
// No React, no Supabase.

export const ITEMS_PER_PAGE = 4
export const LEGEND_SHARES_PAGE_MAX_ROWS = 10
export const APPROVAL_NOTE = 'ยี่ห้ออื่นที่เทียบเท่าต้องได้รับการอนุมัติ'

const itemNo = it => it?.opening_no ?? it?.item_no ?? it?.no ?? ''
const isNum = v => v != null && v !== '' && Number.isFinite(Number(v))

// The saved SVG is stored text, so it is cleaned before dangerouslySetInnerHTML.
export function sanitizeSvg(svg) {
  if (typeof svg !== 'string' || !/<svg[\s>/]/i.test(svg)) return ''
  let s = svg
  s = s.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '').replace(/<script\b[^>]*\/?>/gi, '')
  s = s.replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, '').replace(/<\/?foreignObject\b[^>]*>/gi, '')
  s = s.replace(/<(iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, '')
  // on* event attributes (quoted or bare)
  s = s.replace(/\s+on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  // javascript: / data:text/html URLs in any attribute value
  s = s.replace(/\s+([a-z:_-]*(?:href|src|action)[a-z:_-]*)\s*=\s*(?:"\s*(?:javascript|vbscript|data\s*:\s*text\/html)[^"]*"|'\s*(?:javascript|vbscript|data\s*:\s*text\/html)[^']*')/gi, '')
  s = s.replace(/javascript\s*:/gi, '')
  return s
}

// Views a frame shows for an item, honouring options.view; missing SVGs are skipped.
export function itemViews(item, view = 'both') {
  const out = sanitizeSvg(item?.preview_svg_out)
  const inn = sanitizeSvg(item?.preview_svg_in)
  const v = []
  if ((view === 'both' || view === 'out') && out) v.push({ side: 'out', svg: out })
  if ((view === 'both' || view === 'in') && inn) v.push({ side: 'in', svg: inn })
  return v
}

export function planAttachmentPages({ items = [], options = {}, firstPageNo, totalQuotationPages = 0, hardwareRowCount = 0 } = {}) {
  const view = options?.view || 'both'
  const start = firstPageNo ?? totalQuotationPages + 1
  const framed = (items || []).map(it => {
    const views = itemViews(it, view)
    return { ...it, views, noPreview: views.length === 0 }
  })
  const pages = []
  let no = start
  for (let i = 0; i < framed.length; i += ITEMS_PER_PAGE) {
    pages.push({ kind: 'items', pageNo: no++, items: framed.slice(i, i + ITEMS_PER_PAGE) })
  }
  if (framed.length > 0) {
    const rows = Number(hardwareRowCount) || 0
    if (rows > 0) {
      const share = rows <= LEGEND_SHARES_PAGE_MAX_ROWS
      pages.push({ kind: 'hardware', pageNo: no++, withColours: share })
      if (!share) pages.push({ kind: 'colours', pageNo: no++ })
    } else {
      pages.push({ kind: 'colours', pageNo: no++ })
    }
  }
  const lastQuotation = Math.max(totalQuotationPages, start - 1)
  return { pages, totalPages: lastQuotation + pages.length }
}

export function hardwareSchedule({ items = [], setsById = {}, partsBySet = {}, providersById = {} } = {}) {
  const order = []
  const nos = {}
  for (const it of items || []) {
    const id = it?.hardware_set_id
    if (!id || it.no_hardware_set || !setsById[id]) continue
    if (!nos[id]) { nos[id] = []; order.push(id) }
    nos[id].push(itemNo(it))
  }
  const sets = order.map(id => {
    const set = setsById[id]
    return {
      setId: id,
      name: set.name,
      brand: providersById[set.provider_id]?.name || '',
      parts: (partsBySet[id] || []).map(r => ({
        partId: r.part_id ?? r.part?.id,
        name: r.part?.name ?? '',
        quantity: r.quantity,
        unit: r.part?.unit ?? '',
        imagePath: r.part?.image_path ?? null,
      })),
      itemNos: nos[id],
    }
  })
  return { sets, needsApprovalNote: sets.length > 0, approvalNote: APPROVAL_NOTE }
}

export const hardwareRowCount = sched => (sched?.sets || []).reduce((n, s) => n + (s.parts.length || 1), 0)

export function colourLegend(items = [], ctx = {}) {
  const map = new Map()
  for (const it of items || []) {
    const id = it?.alu_finish_id
    if (!id) continue
    if (!map.has(id)) {
      const f = ctx?.finishesById?.[id]
      map.set(id, { finishId: id, name: f?.name ?? '—', hex: f?.color_hex || null, itemNos: [] })
    }
    map.get(id).itemNos.push(itemNo(it))
  }
  return [...map.values()]
}

export function itemSpecRows(item, ctx = {}) {
  const it = item || {}
  const series = ctx?.seriesById?.[it.series_id]
  const finish = ctx?.finishesById?.[it.alu_finish_id]
  const infill = ctx?.infillById?.[it.infill_type_id]
  const set = it.no_hardware_set ? null : ctx?.setsById?.[it.hardware_set_id]
  const mm = m => Math.round(Number(m) * 1000)
  const fr = isNum(it.frame_thickness_mm) ? Number(it.frame_thickness_mm) : (isNum(series?.thickness_mm) ? Number(series.thickness_mm) : null)
  const sa = isNum(it.sash_thickness_mm) ? Number(it.sash_thickness_mm) : null
  let thickness = '—'
  if (fr != null && sa != null) thickness = `${fr}/${sa} มม.`
  else if (fr != null || sa != null) thickness = `${fr ?? sa} มม.`
  return {
    size: isNum(it.width_m) && isNum(it.height_m) ? `${mm(it.width_m)} × ${mm(it.height_m)} มม.` : '—',
    aluminium: { series: series?.name || '—', thickness, colour: finish?.name || '—' },
    glass: { code: infill?.code || '', name: infill?.name || '—' },
    hardwareSet: set?.name || '—',
  }
}
