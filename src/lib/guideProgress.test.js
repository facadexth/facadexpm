import { describe, it, expect } from 'vitest'
import { computeGuide, isStepDone, GUIDE_STEPS } from './guideProgress.js'

const company = { company_name: 'บริษัท ก', address: '1 ถนน', tax_id: '0105500000000' }

describe('isStepDone', () => {
  it('company needs name, address, tax id and a bank account', () => {
    expect(isStepDone('company', { tenant: company, bankAccounts: 0 })).toBe(false)
    expect(isStepDone('company', { tenant: company, bankAccounts: 1 })).toBe(true)
    expect(isStepDone('company', { tenant: { ...company, bank_account_no: '123' }, bankAccounts: 0 })).toBe(true)
    expect(isStepDone('company', { tenant: { ...company, tax_id: '  ' }, bankAccounts: 1 })).toBe(false)
    expect(isStepDone('company', { tenant: null, bankAccounts: 1 })).toBe(false)
  })
  it('record steps follow real counts', () => {
    expect(isStepDone('client', { clients: 0 })).toBe(false)
    expect(isStepDone('client', { clients: 2 })).toBe(true)
    expect(isStepDone('invoice', { invoices: 1 })).toBe(true)
    expect(isStepDone('line', { lineConnected: true })).toBe(true)
    expect(isStepDone('nope', {})).toBe(false)
  })
  it('missing facts never throw', () => {
    expect(() => GUIDE_STEPS.forEach(s => isStepDone(s.id, undefined))).not.toThrow()
  })
})

describe('computeGuide', () => {
  it('fresh tenant: only signup is done, next is company', () => {
    const g = computeGuide({}, () => true)
    expect(g.done).toBe(1)
    expect(g.total).toBe(6) // 7 steps minus the optional LINE one
    expect(g.next.id).toBe('company')
    expect(g.complete).toBe(false)
  })
  it('steps without the package module are locked and left out of the percentage', () => {
    const g = computeGuide({}, k => k !== 'invoices')
    const inv = g.steps.find(s => s.id === 'invoice')
    expect(inv.locked).toBe(true)
    expect(inv.done).toBe(false)
    expect(g.total).toBe(5)
  })
  it('optional LINE step does not block completion', () => {
    const facts = { tenant: company, bankAccounts: 1, clients: 1, quotations: 1, sites: 1, invoices: 1, lineConnected: false }
    const g = computeGuide(facts, () => true)
    expect(g.complete).toBe(true)
    expect(g.pct).toBe(100)
    expect(g.steps.find(s => s.id === 'line').done).toBe(false)
  })
  it('a locked module is never marked done even if data exists', () => {
    const g = computeGuide({ invoices: 3 }, k => k !== 'invoices')
    expect(g.steps.find(s => s.id === 'invoice').done).toBe(false)
  })
})
