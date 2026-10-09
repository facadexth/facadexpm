// src/lib/openingPayload.js
// The item form's state <-> the estimation_openings row. Pure. "Inherit" is NULL (spec Decision 1); infill and
// hardware set also carry an explicit "none" flag because NULL already means inherit. Quantity is NOT here:
// it is set on the project page (owner), so an edit never resets it.

const numOrNull = v => {
  if (v === null || v === undefined || String(v).trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const intOr = (v, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 1 ? n : d }
const str = v => (v === null || v === undefined ? '' : String(v))

export function emptyForm() {
  return {
    opening_no: '', item_name: '', item_description: '', template_id: '',
    series_id: '', alu_finish_id: '', thickness_mm: '', sash_thickness_mm: '',
    infill_type_id: '', no_infill: false, hardware_set_id: '', no_hardware_set: false,
    width_m: '', height_m: '', panel_count: '1',
    has_addon: false, addon_template_id: '', addon_width_m: '', addon_height_m: '', addon_panel_count: '1', addon_position: 'top', addon_offset_m: '',
    labour_per_sqm: '', profit_pct: '', extra_lines: [],
  }
}

export function formFromOpening(o) {
  return {
    opening_no: str(o.opening_no), item_name: str(o.item_name), item_description: str(o.item_description), template_id: str(o.template_id),
    series_id: str(o.series_id), alu_finish_id: str(o.alu_finish_id), thickness_mm: str(o.thickness_mm), sash_thickness_mm: str(o.sash_thickness_mm),
    infill_type_id: str(o.infill_type_id), no_infill: !!o.no_infill, hardware_set_id: str(o.hardware_set_id), no_hardware_set: !!o.no_hardware_set,
    width_m: str(o.width_m), height_m: str(o.height_m), panel_count: str(o.panel_count || 1),
    has_addon: !!o.addon_template_id, addon_template_id: str(o.addon_template_id), addon_width_m: str(o.addon_width_m), addon_height_m: str(o.addon_height_m),
    addon_panel_count: str(o.addon_panel_count || 1), addon_position: o.addon_position || 'top', addon_offset_m: str(o.addon_offset_m),
    labour_per_sqm: str(o.labour_per_sqm), profit_pct: str(o.profit_pct), extra_lines: Array.isArray(o.extra_lines) ? o.extra_lines : [],
  }
}

// previews: { out, in, sig } | null  (null leaves the saved snapshot columns out of the payload entirely)
export function buildOpeningPayload(form, { projectId, previews = null, savedAt = null } = {}) {
  const addon = form.has_addon && form.addon_template_id
  const payload = {
    project_id: projectId,
    opening_no: String(form.opening_no).trim(),
    item_name: String(form.item_name).trim() || null,
    item_description: String(form.item_description).trim() || null,
    template_id: form.template_id,
    series_id: form.series_id || null,
    alu_finish_id: form.alu_finish_id || null,
    thickness_mm: numOrNull(form.thickness_mm),
    sash_thickness_mm: numOrNull(form.sash_thickness_mm),
    no_infill: !!form.no_infill,
    infill_type_id: form.no_infill ? null : (form.infill_type_id || null),
    no_hardware_set: !!form.no_hardware_set,
    hardware_set_id: form.no_hardware_set ? null : (form.hardware_set_id || null),
    width_m: numOrNull(form.width_m),
    height_m: numOrNull(form.height_m),
    panel_count: intOr(form.panel_count, 1),
    addon_template_id: addon ? form.addon_template_id : null,
    addon_width_m: addon ? numOrNull(form.addon_width_m) : null,
    addon_height_m: addon ? numOrNull(form.addon_height_m) : null,
    addon_panel_count: addon ? intOr(form.addon_panel_count, 1) : 1,
    addon_position: addon ? form.addon_position || 'top' : null,
    addon_offset_m: addon ? numOrNull(form.addon_offset_m) : null,
    labour_per_sqm: numOrNull(form.labour_per_sqm),
    profit_pct: numOrNull(form.profit_pct),
    extra_lines: (form.extra_lines || []).map(l => ({ description: String(l.description || ''), amount: Number(l.amount) || 0 })),
  }
  if (previews) {
    payload.preview_svg_out = previews.out || null
    payload.preview_svg_in = previews.in || null
    payload.preview_sig = previews.sig || null
    payload.preview_saved_at = savedAt
  }
  return payload
}

// Why the form cannot be saved yet (the first problem, as Thai text), or null when it can.
export function validateForm(form) {
  if (!String(form.opening_no).trim()) return 'กรอกเลขช่อง'
  if (!form.template_id) return 'เลือก template'
  if (!(numOrNull(form.width_m) > 0) || !(numOrNull(form.height_m) > 0)) return 'กรอกขนาดกว้างและสูงให้มากกว่า 0'
  for (const k of ['thickness_mm', 'sash_thickness_mm']) {
    const n = numOrNull(form[k])
    if (n !== null && n <= 0) return 'ความหนาต้องมากกว่า 0'
  }
  if (form.has_addon) {
    if (!form.addon_template_id) return 'เลือก template ของชุดต่อเติม'
    if (!(numOrNull(form.addon_width_m) > 0) || !(numOrNull(form.addon_height_m) > 0)) return 'กรอกขนาดชุดต่อเติมให้มากกว่า 0'
    const off = numOrNull(form.addon_offset_m)
    if (off !== null && off < 0) return 'ระยะขอบของชุดต่อเติมต้องไม่ติดลบ'
  }
  const labour = numOrNull(form.labour_per_sqm)
  if (labour !== null && labour < 0) return 'ค่าแรงต้องไม่ติดลบ'
  const profit = numOrNull(form.profit_pct)
  if (profit !== null && (profit < 0 || profit > 1000)) return 'กำไร (%) ต้องอยู่ระหว่าง 0 ถึง 1000'
  return null
}
