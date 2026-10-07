import { describe, it, expect } from 'vitest'
import {
  emptyTaxInvoiceForm, emptyLine, formFromInvoice, toRpcPayload, validateFormForSave,
  poRowsFor, computeAutoVat, applyLineChange, reconcileBaseManual, missingPoIds,
} from './taxInvoiceForm.js'

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
    // conservative until the lookups are loaded: a saved base counts as typed; reconcileBaseManual() relaxes it
    expect(f.lines[0].base_manual).toBe(true)
    expect(f.lines[1].base_manual).toBe(false)
    expect(f.lines.every(l => l.base_stale === false)).toBe(true)
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

describe('poRowsFor (stale PO data after a supplier change)', () => {
  const res = { supplierId: 'A', rows: [{ id: 'p1' }] }
  it('returns the rows only for the supplier they were fetched for', () => {
    expect(poRowsFor(res, 'A')).toEqual([{ id: 'p1' }])
    expect(poRowsFor(res, 'B')).toBeNull()          // stale data from supplier A while B loads
    expect(poRowsFor({ supplierId: '', rows: [] }, 'A')).toBeNull()   // the nil-supplier result
  })
  it('no supplier or no result -> null; an empty supplier result is a real empty list', () => {
    expect(poRowsFor(res, '')).toBeNull()
    expect(poRowsFor(null, 'A')).toBeNull()
    expect(poRowsFor({ supplierId: 'B', rows: [] }, 'B')).toEqual([])
  })
})

describe('computeAutoVat', () => {
  it('7% of the net, 2dp; blank / invalid -> empty', () => {
    expect(computeAutoVat('2000')).toBe('140')
    expect(computeAutoVat(100.5)).toBe('7.04')
    expect(computeAutoVat('')).toBe('')
    expect(computeAutoVat('abc')).toBe('')
    expect(computeAutoVat('-5')).toBe('')
  })
})

describe('applyLineChange (base quantity never goes stale silently)', () => {
  const itemById = new Map([['X', { id: 'X', base_unit: 'kg', unit_conversion_mode: 'plain' }], ['Y', { id: 'Y', base_unit: 'kg', unit_conversion_mode: 'plain' }]])
  const unitFactors = [{ inventory_item_id: 'Y', unit_name: 'bag', factor_to_base: 25 }]
  const lk = { itemById, unitFactors, commonSite: 'S1' }
  const base = { ...emptyLine(), description: 'a', qty: '2', unit: 'kg', unit_price: '10' }

  it('choosing an item fills the site (common site) and the base qty from the conversion', () => {
    const l = applyLineChange(base, { inventory_item_id: 'X' }, lk)
    expect(l).toMatchObject({ inventory_item_id: 'X', site_id: 'S1', base_qty: '2', base_manual: false, base_stale: false })
  })
  it('qty change recomputes an automatic base', () => {
    const l = applyLineChange(applyLineChange(base, { inventory_item_id: 'X' }, lk), { qty: '5' }, lk)
    expect(l.base_qty).toBe('5')
  })
  it('alternate unit with a factor converts: 2 bag x 25 = 50', () => {
    const l = applyLineChange({ ...base, unit: 'bag' }, { inventory_item_id: 'Y' }, lk)
    expect(l.base_qty).toBe('50')
  })
  it('a typed base survives a qty change but is flagged stale (never silent)', () => {
    const typed = { ...applyLineChange(base, { inventory_item_id: 'X' }, lk), base_qty: '7', base_manual: true }
    const l = applyLineChange(typed, { qty: '9' }, lk)
    expect(l).toMatchObject({ base_qty: '7', base_manual: true, base_stale: true })
    expect(applyLineChange(typed, { unit: 'bag' }, lk).base_stale).toBe(true)
  })
  it('changing the stock item drops the typed base and recomputes', () => {
    const typed = { ...applyLineChange(base, { inventory_item_id: 'X' }, lk), base_qty: '7', base_manual: true, base_stale: true }
    const l = applyLineChange(typed, { inventory_item_id: 'Y' }, lk)
    expect(l).toMatchObject({ base_qty: '2', base_manual: false, base_stale: false })
  })
  it('unconverted unit leaves the base blank for the user to type', () => {
    const l = applyLineChange({ ...base, unit: 'เส้น' }, { inventory_item_id: 'X' }, lk)
    expect(l.base_qty).toBe('')
  })
  it('removing the item clears the stock fields', () => {
    const l = applyLineChange({ ...base, inventory_item_id: 'X', site_id: 'S1', base_qty: '2', base_manual: true }, { inventory_item_id: '' }, lk)
    expect(l).toMatchObject({ site_id: '', base_qty: '', base_manual: false, base_stale: false })
  })
  it('a quick-created item that is not in the lookups yet leaves base blank until it is (recalc later)', () => {
    const l = applyLineChange(base, { inventory_item_id: 'NEW' }, { ...lk, itemById: new Map() })
    expect(l.inventory_item_id).toBe('NEW')
    expect(l.base_qty).toBe('')
  })
})

describe('reconcileBaseManual', () => {
  const itemById = new Map([['X', { id: 'X', base_unit: 'kg', unit_conversion_mode: 'plain' }]])
  const mk = base_qty => ({ ...emptyLine(), qty: '2', unit: 'kg', inventory_item_id: 'X', site_id: 'S', base_qty: String(base_qty), base_manual: true })
  it('saved base equal to the auto-computed one is not manual', () => {
    expect(reconcileBaseManual([mk(2)], { itemById, unitFactors: [] })[0].base_manual).toBe(false)
  })
  it('saved base that differs stays manual', () => {
    expect(reconcileBaseManual([mk(3)], { itemById, unitFactors: [] })[0].base_manual).toBe(true)
  })
  it('lines without lookups or without a stock item are unchanged', () => {
    expect(reconcileBaseManual([mk(2)], { itemById: new Map(), unitFactors: [] })[0].base_manual).toBe(true)
    const plain = { ...emptyLine(), base_manual: false }
    expect(reconcileBaseManual([plain], { itemById, unitFactors: [] })[0]).toBe(plain)
  })
})

describe('missingPoIds', () => {
  it('lists selected POs that are not in the loaded rows (never dropped silently)', () => {
    expect(missingPoIds(['a', 'b', 'c'], [{ id: 'a' }, { id: 'c' }])).toEqual(['b'])
  })
  it('rows not loaded yet -> nothing is reported', () => {
    expect(missingPoIds(['a'], null)).toEqual([])
  })
})
