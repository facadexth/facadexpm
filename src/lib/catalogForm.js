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

// `row` = the stored row being edited (null when adding). A field flagged omitWhenAbsent
// (a column added by a later migration) is left out of the payload when blank and the row
// never had the key, so environments without the column keep saving.
export function buildPayload(fields, form, row = null) {
  const payload = {}
  for (const f of fields) {
    const v = form[f.key]
    if (f.omitWhenAbsent && isBlank(v) && !(row && f.key in row)) continue
    if (f.type === 'checkbox') payload[f.key] = !!v
    else if (f.type === 'number') payload[f.key] = isBlank(v) ? (f.blankAs !== undefined ? f.blankAs : null) : parseFloat(v)
    else payload[f.key] = isBlank(v) ? null : (typeof v === 'string' ? v.trim() : v)
  }
  return payload
}

export function missingRequired(fields, form) {
  return fields.filter(f => f.required && f.type !== 'checkbox' && isBlank(form[f.key])).map(f => f.label)
}

// Number fields flagged nonNegative: first Thai error message, or null.
export function invalidNumbers(fields, form) {
  for (const f of fields) {
    if (f.type !== 'number' || !f.nonNegative || isBlank(form[f.key])) continue
    const s = String(form[f.key]).trim()
    const n = Number(s)
    if (s === '' || !Number.isFinite(n) || n < 0) return `${f.label} ต้องเป็นตัวเลขที่ไม่ติดลบ`
  }
  return null
}

// `row` is the row being edited (null when adding) for option lists that must exclude it.
export function resolveOptions(field, form, row = null) {
  const o = field.options
  if (!o) return []
  return typeof o === 'function' ? o(form, row) : o
}

// Pickers offer active rows only, but editing an old record must still show
// the (now inactive) row it points at.
export function optionList(rows, labelFn, keepId = null) {
  return (rows || [])
    .filter(r => r.active !== false || r.id === keepId)
    .map(r => ({ value: r.id, label: labelFn(r) }))
}

// duplicateMessage lets a table say what "duplicate" means for it.
export function friendlyDbError(error, duplicateMessage) {
  if (!error) return 'เกิดข้อผิดพลาด'
  switch (error.code) {
    case '23505': return duplicateMessage || 'มีข้อมูลนี้อยู่แล้ว (ซ้ำ) กรุณาตรวจสอบรายการเดิม'
    case '23503': return 'ทำรายการไม่ได้ เพราะมีข้อมูลอื่นผูกอยู่'
    case '23502': return 'กรุณากรอกค่าที่จำเป็นให้ครบ'
    case '23514': return 'ค่าที่กรอกไม่ถูกต้อง (เช่น ติดลบ หรือเกินช่วงที่กำหนด)'
    case '42501': return 'ไม่มีสิทธิ์ทำรายการนี้'
    default: return error.message || 'เกิดข้อผิดพลาด'
  }
}
