// Supplier tax invoice form <-> RPC payload mapping (pure; the component only holds state).
// The RPCs do not validate shapes before use, so the payload is built exactly and never carries
// NaN / Infinity / '' as a number (those become null, or are stopped by validateFormForSave first).

let keySeq = 0
const nextKey = () => ++keySeq

const isBlank = v => v === '' || v == null
/** '' / null / non-finite -> null, otherwise the number. */
const num = v => {
  if (isBlank(v)) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export const emptyLine = () => ({ key: nextKey(), description: '', qty: '1', unit: '', unit_price: '', discount_pct: '0', inventory_item_id: '', site_id: '', base_qty: '', base_manual: false })

export function emptyTaxInvoiceForm(today) {
  return { supplier_id: '', invoice_no: '', invoice_date: today, net_before_vat: '', vat: '', match_note: '', lines: [], po_ids: [] }
}

/** row = a full invoice row (useSupplierTaxInvoice), items and pos embedded. */
export function formFromInvoice(row) {
  return {
    supplier_id: row.supplier_id, invoice_no: row.invoice_no, invoice_date: row.invoice_date,
    net_before_vat: String(row.net_before_vat ?? ''), vat: String(row.vat ?? ''), match_note: row.match_note || '',
    lines: [...(row.supplier_tax_invoice_items || [])].sort((a, b) => a.sort_order - b.sort_order).map(i => ({
      key: nextKey(), description: i.description, qty: String(i.qty), unit: i.unit || '', unit_price: String(i.unit_price),
      discount_pct: String(i.discount_pct ?? 0), inventory_item_id: i.inventory_item_id || '', site_id: i.site_id || '',
      base_qty: i.base_qty != null ? String(i.base_qty) : '', base_manual: i.base_qty != null,
    })),
    po_ids: (row.supplier_tax_invoice_pos || []).filter(l => l.active).map(l => l.po_id),
  }
}

export function toRpcPayload(form) {
  return {
    header: {
      supplier_id: form.supplier_id, invoice_no: String(form.invoice_no || '').trim(), invoice_date: form.invoice_date,
      net_before_vat: num(form.net_before_vat), vat: num(form.vat) ?? 0, match_note: String(form.match_note || '').trim(),
    },
    items: (form.lines || []).map(l => {
      const stock = !!l.inventory_item_id
      return {
        description: String(l.description || '').trim(), qty: num(l.qty), unit: String(l.unit || '').trim(),
        unit_price: num(l.unit_price) ?? 0, discount_pct: num(l.discount_pct) ?? 0,
        inventory_item_id: stock ? l.inventory_item_id : null, site_id: stock ? (l.site_id || null) : null,
        base_qty: stock ? num(l.base_qty) : null,
      }
    }),
    poIds: [...(form.po_ids || [])],
  }
}

const badNumber = v => !isBlank(v) && num(v) === null

export function validateFormForSave(form) {
  const errs = []
  if (!form.supplier_id) errs.push('เลือกซัพพลายเออร์')
  if (!String(form.invoice_no || '').trim()) errs.push('กรอกเลขที่ใบกำกับ')
  if (!form.invoice_date) errs.push('กรอกวันที่ใบกำกับ')
  if (isBlank(form.net_before_vat) || num(form.net_before_vat) === null || !(num(form.net_before_vat) >= 0)) errs.push('กรอกยอดก่อน VAT')
  if (badNumber(form.vat) || (num(form.vat) ?? 0) < 0) errs.push('VAT ไม่ถูกต้อง')
  ;(form.lines || []).forEach((l, i) => {
    const n = i + 1
    if (!String(l.description || '').trim() || !(num(l.qty) > 0)) errs.push(`รายการที่ ${n}: กรอกรายละเอียดและจำนวนมากกว่า 0`)
    else if (badNumber(l.unit_price) || (num(l.unit_price) ?? 0) < 0 || badNumber(l.discount_pct) || (num(l.discount_pct) ?? 0) < 0 || (num(l.discount_pct) ?? 0) > 100) {
      errs.push(`รายการที่ ${n}: ราคาหรือส่วนลดไม่ถูกต้อง`)
    } else if (l.inventory_item_id && (!l.site_id || !(num(l.base_qty) > 0))) errs.push(`รายการที่ ${n}: เลือกไซท์งาน และกรอกจำนวนในหน่วยหลัก`)
  })
  return errs
}
