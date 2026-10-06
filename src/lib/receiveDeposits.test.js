import { describe, it, expect } from 'vitest'
import { computeReceiveSelection, openDeposits, selectionFromHint, mapReceiveRpcError, defaultAmount, RPC_ERROR_TEXT, canConfirmReceive, isDepositQuerySettled, unavailableDeposits, unmatchedHintText } from './receiveDeposits.js'

const dep = (id, net, vat, no = 'D' + id, supplier = 's1', apps = []) => ({
  id, deposit_invoice_no: no, expense: { supplier_id: supplier, amount_no_vat: net, vat, amount: net + vat }, applications: apps,
})

describe('openDeposits', () => {
  it('drops fully used deposits and adds remaining + supplier_id', () => {
    const r = openDeposits([dep('a', 1000, 70), dep('b', 500, 35, 'B', 's1', [{ amount_no_vat: 500, vat: 35 }])])
    expect(r.map(d => d.id)).toEqual(['a'])
    expect(r[0].remaining).toEqual({ net: 1000, vat: 70 })
  })
  it('tolerates null', () => expect(openDeposits(null)).toEqual([]))
})

describe('computeReceiveSelection', () => {
  const totals = { subtotal: 1000, vat: 70 }
  const deposits = openDeposits([dep('a', 400, 28), dep('b', 600, 42)])
  it('no selection: valid, expense for the full total', () => {
    const r = computeReceiveSelection({ deposits, supplierId: 's1', totals, selection: {} })
    expect(r.valid).toBe(true)
    expect(r.applications).toEqual([])
    expect(r.plan).toMatchObject({ netToPay: 1000, vatToPay: 70, createExpense: true })
  })
  it('partial deduction leaves a remainder expense', () => {
    const r = computeReceiveSelection({ deposits, supplierId: 's1', totals, selection: { a: { checked: true, amount: '400' } } })
    expect(r.valid).toBe(true)
    expect(r.applications).toEqual([{ deposit_id: 'a', amount_no_vat: 400 }])
    expect(r.plan).toMatchObject({ netToPay: 600, vatToPay: 42, createExpense: true })
  })
  it('full deduction creates no expense', () => {
    const r = computeReceiveSelection({ deposits, supplierId: 's1', totals, selection: { a: { checked: true, amount: '400' }, b: { checked: true, amount: '600' } } })
    expect(r.valid).toBe(true)
    expect(r.plan.createExpense).toBe(false)
  })
  it('second deposit is limited by what the first left uncovered', () => {
    const r = computeReceiveSelection({ deposits, supplierId: 's1', totals: { subtotal: 700, vat: 49 }, selection: { a: { checked: true, amount: '400' }, b: { checked: true, amount: '400' } } })
    expect(r.valid).toBe(false)
    expect(r.errors).toEqual({ b: 'exceeds_po' })
  })
  it('flags wrong supplier, zero, empty and over-remaining', () => {
    const sel = (amount) => ({ a: { checked: true, amount } })
    expect(computeReceiveSelection({ deposits, supplierId: 'other', totals, selection: sel('100') }).errors.a).toBe('wrong_supplier')
    expect(computeReceiveSelection({ deposits, supplierId: 's1', totals, selection: sel('0') }).errors.a).toBe('not_positive')
    expect(computeReceiveSelection({ deposits, supplierId: 's1', totals, selection: sel('') }).errors.a).toBe('not_positive')
    expect(computeReceiveSelection({ deposits, supplierId: 's1', totals, selection: sel('401') }).errors.a).toBe('exceeds_remaining')
  })
  it('does not split a deposit with negative remaining vat', () => {
    const bad = openDeposits([dep('x', 1000, 70, 'X', 's1', [{ amount_no_vat: 100, vat: 80 }])])
    const r = computeReceiveSelection({ deposits: bad, supplierId: 's1', totals, selection: { x: { checked: true, amount: '100' } } })
    expect(r.errors.x).toBe('bad_deposit')
    expect(r.valid).toBe(false)
  })
  it('deposit VAT larger than PO VAT is invalid', () => {
    const r = computeReceiveSelection({ deposits: openDeposits([dep('v', 1000, 100)]), supplierId: 's1', totals, selection: { v: { checked: true, amount: '1000' } } })
    expect(r.plan.overVat).toBe(true)
    expect(r.valid).toBe(false)
  })
})

describe('selectionFromHint', () => {
  const deposits = openDeposits([dep('a', 400, 28, 'DP-001')])
  it('matches by normalised ref, reports unmatched', () => {
    const r = selectionFromHint([{ ref: 'dp 001', amount_no_vat: 300 }, { ref: 'ZZ9', amount_no_vat: 5 }], deposits, 's1')
    expect(r.selection).toEqual({ a: { checked: true, amount: '300' } })
    expect(r.unmatched).toEqual([{ ref: 'ZZ9', reason: 'missing' }])
  })
  it('handles null hint', () => expect(selectionFromHint(null, deposits, 's1')).toEqual({ selection: {}, unmatched: [] }))
})

describe('mapReceiveRpcError / defaultAmount', () => {
  it('maps known codes and passes others through', () => {
    expect(mapReceiveRpcError({ message: 'not_ordered' })).toBe('ใบสั่งซื้อนี้รับของไปแล้ว')
    expect(mapReceiveRpcError({ message: 'totals_mismatch' })).toBe('ยอดใบสั่งซื้อเปลี่ยนไป กรุณาเปิดใหม่')
    expect(mapReceiveRpcError({ message: 'boom' })).toBe('boom')
  })
  it('defaultAmount is min(remaining, uncovered)', () => {
    expect(defaultAmount(400, 1000)).toBe('400')
    expect(defaultAmount(400, 150.5)).toBe('150.5')
    expect(defaultAmount(400, -5)).toBe('0')
  })
})

describe('RPC error code table', () => {
  const codes = ['not_ordered', 'deposit_exceeds_remaining', 'deposit_exceeds_po', 'deposit_wrong_supplier', 'totals_mismatch', 'deposit_not_found',
    'deposit_vat_exceeds_po', 'deposit_expense_needs_vat_split', 'bad_application', 'insufficient_privilege', 'po_not_found']
  it('covers all 11 codes', () => expect(Object.keys(RPC_ERROR_TEXT).sort()).toEqual([...codes].sort()))
  it.each(codes)('%s maps to its own Thai text, also inside a longer message', code => {
    const text = RPC_ERROR_TEXT[code]
    expect(text).toMatch(/[\u0E00-\u0E7F]/)
    expect(mapReceiveRpcError({ message: code })).toBe(text)
    expect(mapReceiveRpcError({ message: `P0001: ${code}` })).toBe(text)
  })
  it('texts are distinct', () => expect(new Set(Object.values(RPC_ERROR_TEXT)).size).toBe(codes.length))
})

describe('ready / confirm gating', () => {
  it('settled when loaded or failed, not while loading', () => {
    expect(isDepositQuerySettled(null, null)).toBe(false)
    expect(isDepositQuerySettled([], null)).toBe(true)
    expect(isDepositQuerySettled(null, 'relation does not exist')).toBe(true)
  })
  it('canConfirmReceive', () => {
    expect(canConfirmReceive(null)).toBe(false)
    expect(canConfirmReceive({ ready: false, valid: true })).toBe(false)
    expect(canConfirmReceive({ ready: true, valid: false })).toBe(false)
    expect(canConfirmReceive({ ready: true, valid: true })).toBe(true)
  })
})

describe('hint explanations and unavailable deposits', () => {
  const rows = [dep('u', 100, 7, 'DP-9', 's1', [{ amount_no_vat: 100, vat: 7 }]), dep('a1', 100, 7, 'DUP', 's1'), dep('a2', 100, 7, 'DUP', 's1')]
  const open = openDeposits(rows)
  it('used / ambiguous / missing', () => {
    const r = selectionFromHint([{ ref: 'DP9', amount_no_vat: 1 }, { ref: 'dup', amount_no_vat: 1 }, { ref: 'nope' }], open, 's1', rows)
    expect(r.selection).toEqual({})
    expect(r.unmatched.map(u => u.reason)).toEqual(['used', 'ambiguous', 'missing'])
    expect(unmatchedHintText(r.unmatched[0])).toContain('ใช้หมดแล้ว')
    expect(unmatchedHintText(r.unmatched[1])).toContain('ตรงหลายใบ')
    expect(unmatchedHintText(r.unmatched[2])).toContain('ไม่พบ')
  })
  it('lists deposits without VAT split as unavailable', () => {
    const noSplit = { id: 'n', deposit_invoice_no: 'N1', expense: { supplier_id: 's1', amount: 500, amount_no_vat: null, vat: null }, applications: [] }
    expect(openDeposits([noSplit])).toEqual([])
    expect(unavailableDeposits([noSplit, dep('a', 1, 0)])).toEqual([{ id: 'n', no: 'N1', reason: 'ใบมัดจำนี้ยังไม่แยก VAT — แก้ที่หน้ารายจ่ายก่อน' }])
  })
})

describe('more selection scenarios', () => {
  it('deposit larger than PO: default amount is the PO subtotal and covers it, no expense', () => {
    const deposits = openDeposits([dep('big', 5000, 350)])
    const totals = { subtotal: 1000, vat: 70 }
    const amount = defaultAmount(deposits[0].remaining.net, totals.subtotal)
    expect(amount).toBe('1000')
    const r = computeReceiveSelection({ deposits, supplierId: 's1', totals, selection: { big: { checked: true, amount } } })
    expect(r.valid).toBe(true)
    expect(r.lines.big).toEqual({ net: 1000, vat: 70 })
    expect(r.plan.createExpense).toBe(false)
  })
  it('VAT-inclusive PO totals (subtotal 1000, vat 70) with partial deposit', () => {
    const deposits = openDeposits([dep('a', 500, 35)])
    const r = computeReceiveSelection({ deposits, supplierId: 's1', totals: { subtotal: 1000, vat: 70 }, selection: { a: { checked: true, amount: '500' } } })
    expect(r.plan).toMatchObject({ netToPay: 500, vatToPay: 35, total: 535 })
  })
  it('partially used deposit pro-rates VAT on a partial amount and takes the rest on the final amount', () => {
    const deposits = openDeposits([dep('p', 1000, 70, 'P', 's1', [{ amount_no_vat: 400, vat: 28 }])])
    expect(deposits[0].remaining).toEqual({ net: 600, vat: 42 })
    const part = computeReceiveSelection({ deposits, supplierId: 's1', totals: { subtotal: 1000, vat: 70 }, selection: { p: { checked: true, amount: '300' } } })
    expect(part.lines.p).toEqual({ net: 300, vat: 21 })
    const rest = computeReceiveSelection({ deposits, supplierId: 's1', totals: { subtotal: 600, vat: 42 }, selection: { p: { checked: true, amount: '600' } } })
    expect(rest.lines.p).toEqual({ net: 600, vat: 42 })
    expect(rest.plan.createExpense).toBe(false)
  })
})
