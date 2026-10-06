import { describe, it, expect } from 'vitest'
import { emptyTaxInvoiceForm, emptyLine, formFromInvoice, toRpcPayload, validateFormForSave } from './taxInvoiceForm.js'

describe('taxInvoiceForm', () => {
  it('empty form uses the given date', () => {
    expect(emptyTaxInvoiceForm('2026-10-07')).toMatchObject({ invoice_date: '2026-10-07', lines: [], po_ids: [] })
  })
  it('payload: non-stock lines drop site/base; numbers are numbers', () => {
    const f = { ...emptyTaxInvoiceForm('2026-09-30'), supplier_id: 'A', invoice_no: ' INV-1 ', net_before_vat: '2000', vat: '140',
      lines: [
        { key: 1, description: 'X', qty: '12', unit: 'kg', unit_price: '90', discount_pct: '', inventory_item_id: 'X', site_id: 'S1', base_qty: '12' },
        { key: 2, description: 'ค่าขนส่ง', qty: '1', unit: '', unit_price: '920', discount_pct: '0', inventory_item_id: '', site_id: 'S1', base_qty: '5' },
      ], po_ids: ['p1'] }
    const { header, items, poIds } = toRpcPayload(f)
    expect(header).toEqual({ supplier_id: 'A', invoice_no: 'INV-1', invoice_date: '2026-09-30', net_before_vat: 2000, vat: 140, match_note: '' })
    expect(items[0]).toEqual({ description: 'X', qty: 12, unit: 'kg', unit_price: 90, discount_pct: 0, inventory_item_id: 'X', site_id: 'S1', base_qty: 12 })
    expect(items[1]).toEqual({ description: 'ค่าขนส่ง', qty: 1, unit: '', unit_price: 920, discount_pct: 0, inventory_item_id: null, site_id: null, base_qty: null })
    expect(poIds).toEqual(['p1'])
  })
  it('payload never carries NaN / Infinity / empty-string numbers', () => {
    const f = { ...emptyTaxInvoiceForm('2026-09-30'), supplier_id: 'A', invoice_no: 'X', net_before_vat: 'abc', vat: 'Infinity',
      lines: [{ key: 1, description: 'x', qty: 'NaN', unit: '', unit_price: '', discount_pct: '', inventory_item_id: 'X', site_id: 'S', base_qty: '' }] }
    const { header, items } = toRpcPayload(f)
    expect(header.net_before_vat).toBeNull()
    expect(header.vat).toBe(0)
    expect(items[0]).toMatchObject({ qty: null, unit_price: 0, discount_pct: 0, base_qty: null })
    const numeric = [header.net_before_vat, header.vat, items[0].qty, items[0].unit_price, items[0].discount_pct, items[0].base_qty]
    expect(numeric.every(v => v === null || Number.isFinite(v))).toBe(true)
    expect(numeric).not.toContain('')
  })
  it('round-trips a saved invoice row', () => {
    const row = { supplier_id: 'A', invoice_no: 'INV-1', invoice_date: '2026-09-30', net_before_vat: 2000, vat: 140, match_note: null,
      supplier_tax_invoice_items: [{ sort_order: 2, description: 'b', qty: 1, unit: null, unit_price: 5, discount_pct: 0, inventory_item_id: null, site_id: null, base_qty: null },
                                   { sort_order: 1, description: 'a', qty: 2, unit: 'kg', unit_price: 3, discount_pct: 0, inventory_item_id: 'X', site_id: 'S', base_qty: 2 }],
      supplier_tax_invoice_pos: [{ po_id: 'p1', active: true }, { po_id: 'p0', active: false }] }
    const f = formFromInvoice(row)
    expect(f.lines.map(l => l.description)).toEqual(['a', 'b'])
    expect(f.po_ids).toEqual(['p1'])
    expect(f.lines[0].base_manual).toBe(true)
    expect(f.lines[1].base_manual).toBe(false)
    expect(toRpcPayload(f).items[0]).toMatchObject({ qty: 2, base_qty: 2, inventory_item_id: 'X', site_id: 'S' })
  })
  it('validation messages', () => {
    const f = emptyTaxInvoiceForm('2026-09-30')
    expect(validateFormForSave(f)).toEqual(expect.arrayContaining(['เลือกซัพพลายเออร์', 'กรอกเลขที่ใบกำกับ', 'กรอกยอดก่อน VAT']))
    const g = { ...f, supplier_id: 'A', invoice_no: 'X', net_before_vat: '10', lines: [{ key: 1, description: 'x', qty: '1', unit_price: '10', inventory_item_id: 'X', site_id: '', base_qty: '' }] }
    expect(validateFormForSave(g)).toEqual(['รายการที่ 1: เลือกไซท์งาน และกรอกจำนวนในหน่วยหลัก'])
  })
  it('validation rejects non-finite / negative numbers', () => {
    const base = { ...emptyTaxInvoiceForm('2026-09-30'), supplier_id: 'A', invoice_no: 'X', net_before_vat: '10' }
    expect(validateFormForSave({ ...base, net_before_vat: 'NaN' })).toContain('กรอกยอดก่อน VAT')
    expect(validateFormForSave({ ...base, net_before_vat: 'Infinity' })).toContain('กรอกยอดก่อน VAT')
    expect(validateFormForSave({ ...base, net_before_vat: '-1' })).toContain('กรอกยอดก่อน VAT')
    expect(validateFormForSave({ ...base, vat: '-5' })).toContain('VAT ไม่ถูกต้อง')
    expect(validateFormForSave({ ...base, vat: 'x' })).toContain('VAT ไม่ถูกต้อง')
    const line = o => ({ ...base, lines: [{ key: 1, description: 'x', qty: '1', unit_price: '10', discount_pct: '0', inventory_item_id: '', ...o }] })
    expect(validateFormForSave(line({ qty: 'NaN' }))).toEqual(['รายการที่ 1: กรอกรายละเอียดและจำนวนมากกว่า 0'])
    expect(validateFormForSave(line({ unit_price: 'Infinity' }))).toEqual(['รายการที่ 1: ราคาหรือส่วนลดไม่ถูกต้อง'])
    expect(validateFormForSave(line({ discount_pct: '101' }))).toEqual(['รายการที่ 1: ราคาหรือส่วนลดไม่ถูกต้อง'])
    expect(validateFormForSave(line({}))).toEqual([])
  })
  it('emptyLine gives unique keys and the stock fields blank', () => {
    const a = emptyLine(), b = emptyLine()
    expect(a.key).not.toBe(b.key)
    expect(a).toMatchObject({ qty: '1', discount_pct: '0', inventory_item_id: '', site_id: '', base_qty: '', base_manual: false })
  })
})
