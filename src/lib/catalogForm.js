// Pure helpers behind CatalogCrud: form <-> payload conversion, option lists
// and readable database errors.

const isBlank = v => v === '' || v == null || (typeof v === 'string' && v.trim() === '')

export function emptyForm(fields, defaults = {}) {
  const form = {}
  for (const f of fields) {
    if (f.key in defaults) form[f.key] = defaults[f.key]
    else if (f.default !== undefined) form[f.key] = f.default
    else form[f.key] = f.type === 'checkbox' ? false : ''
  }
  return form
}

export function formFromRow(fields, row) {
  const form = {}
  for (const f of fields) {
    const v = row[f.key]
    form[f.key] = f.type === 'checkbox' ? !!v : (v == null ? '' : v)
  }
  return form
}

export function buildPayload(fields, form) {
  const payload = {}
  for (const f of fields) {
    const v = form[f.key]
    if (f.type === 'checkbox') payload[f.key] = !!v
    else if (f.type === 'number') payload[f.key] = isBlank(v) ? (f.blankAs !== undefined ? f.blankAs : null) : parseFloat(v)
    else payload[f.key] = isBlank(v) ? null : (typeof v === 'string' ? v.trim() : v)
  }
  return payload
}

export function missingRequired(fields, form) {
  return fields.filter(f => f.required && f.type !== 'checkbox' && isBlank(form[f.key])).map(f => f.label)
}

export function resolveOptions(field, form) {
  const o = field.options
  if (!o) return []
  return typeof o === 'function' ? o(form) : o
}

// Pickers offer active rows only, but editing an old record must still show
// the (now inactive) row it points at.
export function optionList(rows, labelFn, keepId = null) {
  return (rows || [])
    .filter(r => r.active !== false || r.id === keepId)
    .map(r => ({ value: r.id, label: labelFn(r) }))
}

export function friendlyDbError(error) {
  if (!error) return 'เกิดข้อผิดพลาด'
  switch (error.code) {
    case '23505': return 'มีข้อมูลนี้อยู่แล้ว (ซ้ำ) เช่น ชื่อเดียวกัน หรือราคาของวันที่เดียวกัน'
    case '23503': return 'ทำรายการไม่ได้ เพราะมีข้อมูลอื่นผูกอยู่'
    case '23502': return 'กรุณากรอกค่าที่จำเป็นให้ครบ'
    case '23514': return 'ค่าที่กรอกไม่ถูกต้อง (เช่น ติดลบ หรือเกินช่วงที่กำหนด)'
    case '42501': return 'ไม่มีสิทธิ์ทำรายการนี้'
    default: return error.message || 'เกิดข้อผิดพลาด'
  }
}
