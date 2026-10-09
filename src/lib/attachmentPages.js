// Pure planning/data helpers for the quotation attachment pages ("แบบแนบ").
// No React, no Supabase.
//
// ITEM CONTRACT: the caller (Task 11) supplies RESOLVED items, not raw DB rows. Beyond the row's own id
// fields (series_id, alu_finish_id, infill_type_id, hardware_set_id, no_hardware_set, opening_no, quantity,
// width_m, height_m, preview_svg_out/in) it must provide resolved `frame_thickness_mm` / `sash_thickness_mm`
// (item -> project via resolveItemInputs in src/lib/estimationInherit.js), `type_name`, `item_name`, and
// optionally `weightKg`, `glassAreaSqm`, `extraNote` (rows are omitted when absent).

export const ITEMS_PER_PAGE = 4
export const APPROVAL_NOTE = 'ยี่ห้ออื่นที่เทียบเท่าต้องได้รับการอนุมัติ'

const itemNo = it => it?.opening_no ?? it?.item_no ?? it?.no ?? ''
const isNum = v => v != null && v !== '' && Number.isFinite(Number(v))

// Stored SVG text is untrusted. It is never injected as markup: the component shows it through
// <img src="data:image/svg+xml,..."> (scripts cannot run in an image). safeSvgDataUri is defence in
// depth: anything that is not a plain drawing is rejected (null -> placeholder), never repaired.
const BAD_SVG = [
  /<\s*script/i, /<\s*foreignObject/i, /<\s*iframe/i, /<\s*style/i, /<\s*use[\s/>]/i, /<\s*image/i,
  /<\s*a[\s/>]/i, /<\s*animate/i, /<\s*set[\s/>]/i, /<\s*link/i, /<\s*object/i, /<\s*embed/i,
  /<\s*(?:video|audio|img|source|meta|base|form|input|button|textarea|handler|listener)/i,
  /(?:^|[^a-z0-9])on[a-z]+\s*=/i, /javascript\s*:/i, /vbscript\s*:/i, /data\s*:\s*text\/html/i, /@import/i,
  /&#/, /&colon;/i, /&tab;/i, /&newline;/i, /\bsrcdoc\b/i, /url\s*\(\s*['"]?\s*(?:https?:|\/\/|data:)/i,
]
export function safeSvgDataUri(svg) {
  if (typeof svg !== 'string') return null
  const t = svg.trim()
  if (!/^<svg[\s>/]/i.test(t)) return null
  if (BAD_SVG.some(re => re.test(t))) return null
  if (/(?:href|src)\s*=\s*["']?\s*(?:https?:|\/\/)/i.test(t)) return null
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(t)
}

// Views a frame shows for an item, honouring options.view; missing/unsafe SVGs are skipped.
export function itemViews(item, view = 'both') {
  const out = safeSvgDataUri(item?.preview_svg_out)
  const inn = safeSvgDataUri(item?.preview_svg_in)
  const v = []
  if ((view === 'both' || view === 'out') && out) v.push({ side: 'out', src: out })
  if ((view === 'both' || view === 'in') && inn) v.push({ side: 'in', src: inn })
  return v
}

export const HARDWARE_ROWS_PER_PAGE = 14

const legendRows = n => Math.ceil(n / 2) + 2

// Page plan. The caller passes the schedule (hardwareSchedule()) and legend (colourLegend()); the pages carry
// exactly what must be rendered, so the component never recomputes anything.
export function planAttachmentPages({ items = [], options = {}, firstPageNo, totalQuotationPages = 0, schedule = null, legend = [] } = {}) {
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
    const sets = schedule?.sets || []
    const colours = legend || []
    // pack whole sets into pages of HARDWARE_ROWS_PER_PAGE part rows; an oversize set is split
    const hw = []
    let cur = null
    const fresh = () => { cur = { rows: 0, sets: [] }; hw.push(cur) }
    for (const s of sets) {
      const n = Math.max(1, s.parts.length)
      if (n > HARDWARE_ROWS_PER_PAGE) {
        if (cur && cur.sets.length) cur = null
        for (let i = 0; i < s.parts.length; i += HARDWARE_ROWS_PER_PAGE) {
          fresh()
          const chunk = s.parts.slice(i, i + HARDWARE_ROWS_PER_PAGE)
          cur.sets.push({ ...s, parts: chunk, continued: i > 0 })
          cur.rows = chunk.length
        }
        cur = hw[hw.length - 1]
        continue
      }
      if (!cur || cur.rows + n > HARDWARE_ROWS_PER_PAGE) fresh()
      cur.sets.push(s)
      cur.rows += n
    }
    let ownColours = colours.length > 0
    hw.forEach((h, idx) => {
      const last = idx === hw.length - 1
      const share = last && colours.length > 0 && h.rows + legendRows(colours.length) <= HARDWARE_ROWS_PER_PAGE
      if (share) ownColours = false
      pages.push({
        kind: 'hardware', pageNo: no++, hardwareSets: h.sets, first: idx === 0, last,
        schedule: { needsApprovalNote: !!schedule?.needsApprovalNote && last, approvalNote: schedule?.approvalNote, noSetItemNos: last ? (schedule?.noSetItemNos || []) : [], intro: idx === 0 },
        withColours: share, colours: share ? colours : undefined,
      })
    })
    if (hw.length === 0 && (schedule?.noSetItemNos || []).length > 0) {
      // no set used at all: nothing to schedule
    }
    if (ownColours) pages.push({ kind: 'colours', pageNo: no++, colours })
  }
  const lastQuotation = Math.max(totalQuotationPages, start - 1)
  return { pages, totalPages: lastQuotation + pages.length }
}

export function hardwareSchedule({ items = [], setsById = {}, partsBySet = {}, providersById = {} } = {}) {
  const order = []
  const uses = {}
  const noSetItemNos = []
  for (const it of items || []) {
    const id = it?.hardware_set_id
    if (!id || it.no_hardware_set || !setsById[id]) { if (it?.no_hardware_set || !id) noSetItemNos.push(itemNo(it)); continue }
    if (!uses[id]) { uses[id] = []; order.push(id) }
    uses[id].push({ no: itemNo(it), quantity: it.quantity ?? null, typeName: it.type_name || '' })
  }
  const sets = order.map(id => {
    const set = setsById[id]
    return {
      setId: id,
      code: set.code || '',
      name: set.name,
      brand: providersById[set.provider_id]?.name || '',
      parts: (partsBySet[id] || []).map(r => ({
        partId: r.part_id ?? r.part?.id,
        name: r.part?.name ?? '',
        quantity: r.quantity,
        unit: r.part?.unit ?? '',
        imagePath: r.part?.image_path ?? null,
      })),
      uses: uses[id],
      itemNos: uses[id].map(u => u.no),
    }
  })
  return { sets, noSetItemNos, needsApprovalNote: sets.length > 0, approvalNote: APPROVAL_NOTE }
}

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

const fmtNum = n => { const x = Number(n); return Number.isInteger(x) ? String(x) : String(Math.round(x * 100) / 100) }

export function itemSpecRows(item, ctx = {}) {
  const it = item || {}
  const series = ctx?.seriesById?.[it.series_id]
  const finish = ctx?.finishesById?.[it.alu_finish_id]
  const infill = ctx?.infillById?.[it.infill_type_id]
  const set = it.no_hardware_set ? null : ctx?.setsById?.[it.hardware_set_id]
  const mm = m => Math.round(Number(m) * 1000)
  const fr = isNum(it.frame_thickness_mm) ? Number(it.frame_thickness_mm) : null
  const sa = isNum(it.sash_thickness_mm) ? Number(it.sash_thickness_mm) : null
  let thickness = '—'
  if (fr != null && sa != null && fr !== sa) thickness = `กรอบ ${fmtNum(fr)} / บาน ${fmtNum(sa)} มม.`
  else if (fr != null || sa != null) thickness = `หนา ${fmtNum(fr ?? sa)} มม.`
  const brand = set ? ctx?.providersById?.[set.provider_id]?.name : ''
  const hardwareSet = set ? [set.code, set.name].filter(Boolean).join(' · ') + (brand ? ` (ยี่ห้อ ${brand})` : '') : '—'
  const parts = set ? (ctx?.partsBySet?.[it.hardware_set_id] || []).map(r => `${r.part?.name ?? ''} × ${fmtNum(r.quantity)}`).filter(s => s.trim() !== '×') : []
  const out = {
    size: isNum(it.width_m) && isNum(it.height_m) ? `${mm(it.width_m)} × ${mm(it.height_m)} มม.` : '—',
    aluminium: { series: series?.name || '—', thickness, colour: finish?.name || '—' },
    glass: { code: infill?.code || '', name: infill?.name || '—' },
    hardwareSet,
    hardwareParts: parts.join(' · '),
  }
  if (isNum(it.weightKg)) out.weight = `${Number(it.weightKg).toFixed(2)} กก./ชุด`
  if (isNum(it.glassAreaSqm)) out.glassArea = `${Number(it.glassAreaSqm).toFixed(2)} ตร.ม./ชุด`
  if (it.extraNote) out.extraNote = String(it.extraNote)
  return out
}
