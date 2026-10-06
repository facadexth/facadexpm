import { describe, it, expect, vi } from 'vitest'
import {
  matchTolerance, withinTolerance, lineAmount, evaluateMatch, wacAfterIn, wacAfterReversal,
  simulateStock, proposePos, lineBase, formSignature, previewIsCurrent, mapTaxInvoiceRpcError, CHECK_TEXT,
  GENERIC_ERROR_TEXT, isTaxInvoiceNotReady, postSummaryLines,
} from './supplierTaxInvoice.js'

describe('tolerance = min(1%, 5 baht)  (owner ruling R1)', () => {
  it('caps at 5 baht for large bases', () => { expect(matchTolerance(2000)).toBe(5) })
  it('is 1% for small bases', () => { expect(matchTolerance(100)).toBe(1) })
  it('zero base needs an exact match', () => { expect(matchTolerance(0)).toBe(0) })
  it('boundary: 5.00 passes, 5.01 fails on 2000', () => {
    expect(withinTolerance(5, 2000)).toBe(true)
    expect(withinTolerance(-5, 2000)).toBe(true)
    expect(withinTolerance(5.01, 2000)).toBe(false)
  })
  it('boundary: 1.00 passes, 1.01 fails on 100', () => {
    expect(withinTolerance(1, 100)).toBe(true)
    expect(withinTolerance(1.01, 100)).toBe(false)
  })
})

describe('lineAmount', () => {
  it('qty x price x (1 - discount), 2dp', () => {
    expect(lineAmount({ qty: 12, unit_price: 90 })).toBe(1080)
    expect(lineAmount({ qty: 3, unit_price: 33.333, discount_pct: 0 })).toBe(100)
    expect(lineAmount({ qty: 2, unit_price: 100, discount_pct: 10 })).toBe(180)
  })
})

describe('evaluateMatch compares goods value, not expenses', () => {
  it('two POs, exact', () => {
    const r = evaluateMatch({ netBeforeVat: 2000, poSubtotals: [1000, 1000], lineAmounts: [1080, 920] })
    expect(r).toMatchObject({ poSum: 2000, diff: 0, matchOk: true, linesSum: 2000, linesOk: true })
  })
  it('deposit-covered PO still matches on goods value (expense would be 0)', () => {
    const r = evaluateMatch({ netBeforeVat: 500, poSubtotals: [500], lineAmounts: [500] })
    expect(r.matchOk).toBe(true)
  })
  it('flags a large difference and a lines/net mismatch', () => {
    const r = evaluateMatch({ netBeforeVat: 500, poSubtotals: [2000], lineAmounts: [400] })
    expect(r.diff).toBe(-1500)
    expect(r.matchOk).toBe(false)
    expect(r.linesOk).toBe(false)
  })
})

describe('WAC math mirrors SQL _sti_wac_after_in / _sti_wac_after_reversal', () => {
  it('in: same as record_stock_movement purchase_in', () => {
    expect(wacAfterIn(6, 100, 12, 90)).toBeCloseTo(1680 / 18, 10)
    expect(wacAfterIn(0, 0, 10, 100)).toBe(100)
    expect(wacAfterIn(-10, 50, 10, 100)).toBe(0) // new qty 0 -> 0, like the SQL
  })
  it('reversal: exact inverse', () => {
    expect(wacAfterReversal(18, 1680 / 18, 10, 100)).toBeCloseTo(85, 10)
  })
  it('reversal to zero or below keeps WAC', () => {
    expect(wacAfterReversal(10, 100, 10, 100)).toBe(100)
    expect(wacAfterReversal(7, 100, 20, 100)).toBe(100)
  })
  it('reversal never yields a negative WAC', () => {
    expect(wacAfterReversal(10, 10, 5, 100)).toBe(0)
  })
  it('in then reversal then re-post then remove = identity', () => {
    let q = 6, w = 100
    w = wacAfterIn(q, w, 12, 90); q += 12
    w = wacAfterReversal(q, w, 10, 100); q -= 10
    expect(q).toBe(8); expect(w).toBeCloseTo(85, 9)
    // void: re-post receipt first, then remove the invoice line (ruling A3)
    w = wacAfterIn(q, w, 10, 100); q += 10
    w = wacAfterReversal(q, w, 12, 90); q -= 12
    expect(q).toBe(6); expect(w).toBeCloseTo(100, 9)
  })
})

describe('simulateStock (same scenario as SQL T4/T5)', () => {
  it('invoice items differ from PO items; lines first, then reversals', () => {
    const rows = simulateStock({
      balances: { 'X|S1': { qty: 6, wac: 100 }, 'Y|S1': { qty: 5, wac: 200 } },
      lines: [
        { inventory_item_id: 'X', site_id: 'S1', base_qty: 12, base_unit_cost: 90 },
        { inventory_item_id: 'Y', site_id: 'S1', base_qty: 4, base_unit_cost: 230 },
      ],
      reversals: [
        { inventory_item_id: 'X', site_id: 'S1', quantity: 10, unit_cost: 100 },
        { inventory_item_id: 'Y', site_id: 'S1', quantity: 5, unit_cost: 200 },
      ],
    })
    const x = rows.find(r => r.inventory_item_id === 'X')
    const y = rows.find(r => r.inventory_item_id === 'Y')
    expect(x).toMatchObject({ beforeQty: 6, addQty: 12, removeQty: 10, afterQty: 8, negative: false })
    expect(x.afterWac).toBeCloseTo(85, 9)
    expect(y.afterQty).toBe(4); expect(y.afterWac).toBeCloseTo(230, 9)
  })
  it('consumed stock: reversal below zero is reported, WAC kept (SQL T12)', () => {
    const [r] = simulateStock({
      balances: { 'X|S2': { qty: 2, wac: 100 } },
      lines: [{ inventory_item_id: 'X', site_id: 'S2', base_qty: 5, base_unit_cost: 100 }],
      reversals: [{ inventory_item_id: 'X', site_id: 'S2', quantity: 20, unit_cost: 100 }],
    })
    expect(r).toMatchObject({ beforeQty: 2, afterQty: -13, afterWac: 100, negative: true })
  })
  it('unknown balance starts at 0/0', () => {
    const [r] = simulateStock({ balances: {}, lines: [{ inventory_item_id: 'Z', site_id: 'S1', base_qty: 3, base_unit_cost: 50 }], reversals: [] })
    expect(r).toMatchObject({ beforeQty: 0, afterQty: 3, afterWac: 50 })
  })
})

describe('proposePos (PO date month, ruling A10)', () => {
  const pos = [
    { id: 'p1', supplier_id: 'A', status: 'received', date: '2026-09-03' },
    { id: 'p2', supplier_id: 'A', status: 'received', date: '2026-09-28' },
    { id: 'p3', supplier_id: 'A', status: 'received', date: '2026-08-30' },
    { id: 'p4', supplier_id: 'A', status: 'ordered',  date: '2026-09-10' },
    { id: 'p5', supplier_id: 'B', status: 'received', date: '2026-09-10' },
    { id: 'p6', supplier_id: 'A', status: 'received', date: '2026-09-15' },
  ]
  const activeLinks = new Map([['p6', { invoice_id: 'other', invoice_no: 'INV-9' }]])
  it('proposes same-supplier received POs of the month not linked elsewhere', () => {
    const r = proposePos({ pos, supplierId: 'A', invoiceDate: '2026-09-30', activeLinks, invoiceId: 'mine' })
    expect(r.proposed.map(p => p.id)).toEqual(['p1', 'p2'])
    expect(r.outsideMonth.map(p => p.id)).toEqual(['p3'])
    expect(r.linkedElsewhere.map(x => x.po.id)).toEqual(['p6'])
  })
  it('a PO linked to THIS invoice is not "elsewhere"', () => {
    const r = proposePos({ pos, supplierId: 'A', invoiceDate: '2026-09-30', activeLinks, invoiceId: 'other' })
    expect(r.proposed.map(p => p.id)).toContain('p6')
  })
  it('tolerates null inputs', () => {
    expect(proposePos({ pos: null, supplierId: 'A', invoiceDate: '', activeLinks: null })).toEqual({ proposed: [], outsideMonth: [], linkedElsewhere: [] })
  })
})

describe('lineBase (ruling A15)', () => {
  const kgItem = { id: 'X', base_unit: 'kg', unit_conversion_mode: 'plain' }   // 'plain' = the live column default
  it('same unit as base -> qty', () => {
    expect(lineBase({ qty: 12, unit: 'kg' }, kgItem, null)).toEqual({ baseQty: 12, unconverted: false })
  })
  it('alternate unit with a factor converts', () => {
    expect(lineBase({ qty: 2, unit: 'มัด' }, kgItem, { factor_to_base: 25 })).toEqual({ baseQty: 50, unconverted: false })
  })
  it('alternate unit without a factor is unconverted (user must type it)', () => {
    expect(lineBase({ qty: 2, unit: 'เส้น' }, kgItem, null).unconverted).toBe(true)
  })
  it('aluminium profile item invoiced in kg is converted 1:1', () => {
    expect(lineBase({ qty: 30, unit: 'kg' }, { base_unit: 'kg', unit_conversion_mode: 'aluminum_profile' }, null)).toEqual({ baseQty: 30, unconverted: false })
  })
  it('aluminium profile item invoiced in เส้น is unconverted', () => {
    expect(lineBase({ qty: 5, unit: 'เส้น' }, { base_unit: 'kg', unit_conversion_mode: 'aluminum_profile' }, null).unconverted).toBe(true)
  })
  it('no stock item -> null', () => {
    expect(lineBase({ qty: 1, unit: 'งาน' }, null, null)).toEqual({ baseQty: null, unconverted: false })
  })
})

describe('stale preview guard (Review Focus 2)', () => {
  const form = { supplier_id: 'A', invoice_no: 'X1', invoice_date: '2026-09-30', net_before_vat: '2000', vat: '140', match_note: '', lines: [{ description: 'a', qty: '1', unit_price: '2000' }], po_ids: ['p2', 'p1'] }
  it('same form -> current; order of po_ids does not matter', () => {
    const preview = { signature: formSignature(form) }
    expect(previewIsCurrent(preview, { ...form, po_ids: ['p1', 'p2'] })).toBe(true)
  })
  it('any edit invalidates the preview', () => {
    const preview = { signature: formSignature(form) }
    expect(previewIsCurrent(preview, { ...form, net_before_vat: '2001' })).toBe(false)
    expect(previewIsCurrent(null, form)).toBe(false)
  })
})

describe('error text', () => {
  it('maps RPC codes, longest code first', () => {
    expect(mapTaxInvoiceRpcError({ message: 'not_draft' })).toBe(CHECK_TEXT.not_draft)
    expect(mapTaxInvoiceRpcError({ message: 'match_note_required' })).toBe(CHECK_TEXT.match_note_required)
    expect(mapTaxInvoiceRpcError({ message: 'po_tax_invoiced' })).toMatch(/ใบกำกับ/)
  })
  it('maps unique violations by constraint name', () => {
    expect(mapTaxInvoiceRpcError({ code: '23505', message: 'duplicate key value violates unique constraint "sti_invoice_no_active_uq"' })).toMatch(/เลขที่ใบกำกับนี้มีอยู่แล้ว/)
    expect(mapTaxInvoiceRpcError({ code: '23505', message: 'duplicate key value violates unique constraint "stip_po_active_uq"' })).toBe(CHECK_TEXT.po_linked_elsewhere)
  })
  it('falls back to a generic Thai text and logs the raw error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(mapTaxInvoiceRpcError({ message: 'boom' })).toBe(GENERIC_ERROR_TEXT)
    expect(mapTaxInvoiceRpcError(null)).toBe(GENERIC_ERROR_TEXT)
    expect(mapTaxInvoiceRpcError({ code: '23514', message: 'violates check constraint "something_else"' })).toBe(GENERIC_ERROR_TEXT)
    expect(spy).toHaveBeenCalledWith('[supplier tax invoice] unmapped error:', { message: 'boom' })
    spy.mockRestore()
  })
  it('never leaks raw English text for the known failure classes', () => {
    const cases = [
      [{ code: '23514', message: 'new row for relation "supplier_tax_invoices" violates check constraint "sti_total_sum_check"' }, 'ยอดรวม'],
      [{ code: '23514', message: 'violates check constraint "sti_finite_check"' }, 'ยอดเงิน'],
      [{ code: '23514', message: 'violates check constraint "stii_stock_fields_check"' }, 'สต็อก'],
      [{ code: '42501', message: 'permission denied for function x' }, 'สิทธิ์'],
      [{ code: '55P03', message: 'could not obtain lock on row' }, 'ลองใหม่'],
      [{ code: '40001', message: 'could not serialize access' }, 'ลองใหม่'],
      [{ code: '57014', message: 'canceling statement due to statement timeout' }, 'นานเกินไป'],
      [{ code: 'PGRST301', message: 'JWT expired' }, 'เซสชัน'],
    ]
    for (const [err, frag] of cases) expect(mapTaxInvoiceRpcError(err)).toContain(frag)
  })
  it('reads details and hint too', () => {
    expect(mapTaxInvoiceRpcError({ message: 'x', details: 'Key (po_id)=... violates stip_po_active_uq', code: '23505' })).toBe(CHECK_TEXT.po_linked_elsewhere)
    expect(mapTaxInvoiceRpcError({ message: 'x', hint: 'not_draft' })).toBe(CHECK_TEXT.not_draft)
  })
})

describe('isTaxInvoiceNotReady', () => {
  it('matches the missing table/function codes', () => {
    for (const code of ['PGRST202', 'PGRST205', '42P01', '42883']) expect(isTaxInvoiceNotReady({ code, message: 'x' })).toBe(true)
  })
  it('matches supabase-js message patterns, also as a plain string (useQuery keeps err.message)', () => {
    expect(isTaxInvoiceNotReady("Could not find the table 'public.supplier_tax_invoices' in the schema cache")).toBe(true)
    expect(isTaxInvoiceNotReady('relation "supplier_tax_invoices" does not exist')).toBe(true)
    expect(isTaxInvoiceNotReady({ message: 'Could not find the function public.post_supplier_tax_invoice' })).toBe(true)
  })
  it('does NOT report a bad embed or an undefined column as not-ready', () => {
    expect(isTaxInvoiceNotReady({ code: 'PGRST200', message: "Could not find a relationship between 'supplier_tax_invoices' and 'suppliers' in the schema cache" })).toBe(false)
    expect(isTaxInvoiceNotReady("Could not find a relationship between 'a' and 'b' in the schema cache")).toBe(false)
    expect(isTaxInvoiceNotReady({ code: '42703', message: 'column supplier_tax_invoices.foo does not exist' })).toBe(false)
    expect(isTaxInvoiceNotReady('column "foo" of relation "supplier_tax_invoices" does not exist')).toBe(false)
    expect(isTaxInvoiceNotReady({ code: 'PGRST204', message: "Could not find the 'foo' column of 'supplier_tax_invoices' in the schema cache" })).toBe(false)
  })
  it('does not match other failures', () => {
    expect(isTaxInvoiceNotReady(null)).toBe(false)
    expect(isTaxInvoiceNotReady('')).toBe(false)
    expect(isTaxInvoiceNotReady({ code: '40P01', message: 'deadlock detected' })).toBe(false)
    expect(isTaxInvoiceNotReady('JWT expired')).toBe(false)
    expect(isTaxInvoiceNotReady({ code: '23505', message: 'duplicate key' })).toBe(false)
  })
})

describe('fail-closed on bad input', () => {
  it('withinTolerance rejects non-finite diff/base', () => {
    expect(withinTolerance(NaN, 100)).toBe(false)
    expect(withinTolerance(1, NaN)).toBe(false)
    expect(withinTolerance('', 100)).toBe(false)
    expect(withinTolerance(null, 100)).toBe(false)
    expect(withinTolerance(undefined, 100)).toBe(false)
    expect(withinTolerance(Infinity, 100)).toBe(false)
  })
  it('evaluateMatch flags blank/NaN net, PO subtotals and line amounts', () => {
    expect(evaluateMatch({ netBeforeVat: '', poSubtotals: [0], lineAmounts: [0] }).matchOk).toBe(false)
    expect(evaluateMatch({ netBeforeVat: NaN, poSubtotals: [0], lineAmounts: [0] }).matchOk).toBe(false)
    expect(evaluateMatch({ netBeforeVat: 100, poSubtotals: [NaN], lineAmounts: [100] }).matchOk).toBe(false)
    const r = evaluateMatch({ netBeforeVat: 100, poSubtotals: [100], lineAmounts: [undefined] })
    expect(r.linesOk).toBe(false)
    expect(r.matchOk).toBe(false)
    expect(r.invalid).toBe(true)
  })
})

describe('simulateStock skips non-positive / null base_qty', () => {
  it('ignores such lines', () => {
    const rows = simulateStock({
      balances: {},
      lines: [
        { inventory_item_id: 'Z', site_id: 'S1', base_qty: 0, base_unit_cost: 50 },
        { inventory_item_id: 'Z', site_id: 'S1', base_qty: null, base_unit_cost: 50 },
        { inventory_item_id: 'Z', site_id: 'S1', base_qty: -2, base_unit_cost: 50 },
      ],
      reversals: [],
    })
    expect(rows).toEqual([])
  })
})

describe('proposePos blank/invalid dates', () => {
  const pos = [
    { id: 'p1', supplier_id: 'A', status: 'received', date: '2026-09-03' },
    { id: 'p2', supplier_id: 'A', status: 'received', date: null },
  ]
  it('blank invoice date -> nothing proposed', () => {
    const r = proposePos({ pos, supplierId: 'A', invoiceDate: '', activeLinks: new Map(), invoiceId: 'x' })
    expect(r.proposed).toEqual([])
    expect(r.outsideMonth.map(p => p.id)).toEqual(['p1', 'p2'])
  })
  it('invalid invoice date -> nothing proposed', () => {
    const r = proposePos({ pos, supplierId: 'A', invoiceDate: 'garbage', activeLinks: new Map(), invoiceId: 'x' })
    expect(r.proposed).toEqual([])
  })
  it('PO with null date is outsideMonth even with a valid invoice date', () => {
    const r = proposePos({ pos, supplierId: 'A', invoiceDate: '2026-09-30', activeLinks: new Map(), invoiceId: 'x' })
    expect(r.proposed.map(p => p.id)).toEqual(['p1'])
    expect(r.outsideMonth.map(p => p.id)).toEqual(['p2'])
  })
})

describe('lineBase extra cases', () => {
  it('glass_dimension item in a non-base unit is unconverted', () => {
    expect(lineBase({ qty: 3, unit: 'แผ่น' }, { base_unit: 'sqm', unit_conversion_mode: 'glass_dimension' }, null).unconverted).toBe(true)
  })
  it('unit match is case-insensitive and trimmed', () => {
    expect(lineBase({ qty: 4, unit: ' KG ' }, { base_unit: 'kg', unit_conversion_mode: 'plain' }, null)).toEqual({ baseQty: 4, unconverted: false })
  })
})

describe('postSummaryLines (confirm dialog text)', () => {
  it('lists stock in, reversals, negatives, expense stamping and the undo rule', () => {
    const lines = postSummaryLines({
      invoiceNo: 'INV-1', stockLineCount: 2, poCount: 2,
      preview: { rows: [{ item_name: 'X', site_name: 'S2', after_qty: -13, base_unit: 'kg', negative: true }],
                 checks: [{ code: 'po_outside_month', blocking: false }] },
    })
    expect(lines).toEqual([
      'เพิ่มสต็อกจากใบกำกับ 2 รายการ',
      'กลับรายการรับเข้าสต็อกของใบสั่งซื้อ 2 ใบ',
      '⚠️ สต็อกจะติดลบ: X @ S2 = -13 kg',
      '⚠️ ' + 'ใบสั่งซื้อนอกเดือนของใบกำกับ',
      'รายจ่ายของใบสั่งซื้อไม่เปลี่ยนยอด แต่จะประทับเลขที่ใบกำกับ INV-1',
      'แก้ไขภายหลังไม่ได้ — ย้อนกลับได้ด้วย "ยกเลิกใบกำกับ" เท่านั้น',
    ])
  })
  it('de-duplicates warnings by code and skips blocking checks', () => {
    const lines = postSummaryLines({
      invoiceNo: 'A', stockLineCount: 1, poCount: 1,
      preview: { rows: [], checks: [{ code: 'po_has_deposit', blocking: false }, { code: 'po_has_deposit', blocking: false }, { code: 'no_pos', blocking: true }] },
    })
    expect(lines.filter(l => l.startsWith('⚠️'))).toEqual(['⚠️ ' + CHECK_TEXT.po_has_deposit])
  })
})
