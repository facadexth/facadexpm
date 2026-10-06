import { describe, it, expect } from 'vitest'
import { computeReceiveSelection, openDeposits, selectionFromHint, mapReceiveRpcError, defaultAmount } from './receiveDeposits.js'

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
    expect(r.unmatched).toEqual(['ZZ9'])
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
