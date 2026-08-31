import { describe, it, expect } from 'vitest'
import { applyDateFilter } from './expenseFilters.js'

// Fake PostgREST-style query builder: records every call, returns itself
// so chaining works exactly like the real supabase-js builder.
function fakeQuery() {
  const calls = []
  const builder = {
    calls,
    or:  (arg) => { calls.push(['or', arg]); return builder },
    gte: (col, val) => { calls.push(['gte', col, val]); return builder },
    lte: (col, val) => { calls.push(['lte', col, val]); return builder },
  }
  return builder
}

describe('applyDateFilter — plain column fields (date, billing_date)', () => {
  it('applies gte/lte on the given column when both from and to are set', () => {
    const q = applyDateFilter(fakeQuery(), 'date', '2026-01-01', '2026-12-31')
    expect(q.calls).toEqual([
      ['gte', 'date', '2026-01-01'],
      ['lte', 'date', '2026-12-31'],
    ])
  })

  it('applies only gte when to is omitted', () => {
    const q = applyDateFilter(fakeQuery(), 'billing_date', '2026-01-01', undefined)
    expect(q.calls).toEqual([['gte', 'billing_date', '2026-01-01']])
  })

  it('applies only lte when from is omitted', () => {
    const q = applyDateFilter(fakeQuery(), 'billing_date', undefined, '2026-12-31')
    expect(q.calls).toEqual([['lte', 'billing_date', '2026-12-31']])
  })

  it('applies no filter when neither from nor to is set', () => {
    const q = applyDateFilter(fakeQuery(), 'date', undefined, undefined)
    expect(q.calls).toEqual([])
  })
})

describe('applyDateFilter — "due" field (COALESCE(check_date, due_date, date), matching payment_forecast)', () => {
  it('encodes three mutually exclusive coalesce-priority branches for both from and to', () => {
    const q = applyDateFilter(fakeQuery(), 'due', '2026-01-01', '2026-12-31')
    expect(q.calls).toEqual([
      ['or', [
        'and(check_date.not.is.null,check_date.gte.2026-01-01,check_date.lte.2026-12-31)',
        'and(check_date.is.null,due_date.not.is.null,due_date.gte.2026-01-01,due_date.lte.2026-12-31)',
        'and(check_date.is.null,due_date.is.null,date.gte.2026-01-01,date.lte.2026-12-31)',
      ].join(',')],
    ])
  })

  it('applies only the from-side bound in each branch when to is omitted', () => {
    const q = applyDateFilter(fakeQuery(), 'due', '2026-01-01', undefined)
    expect(q.calls).toEqual([
      ['or', [
        'and(check_date.not.is.null,check_date.gte.2026-01-01)',
        'and(check_date.is.null,due_date.not.is.null,due_date.gte.2026-01-01)',
        'and(check_date.is.null,due_date.is.null,date.gte.2026-01-01)',
      ].join(',')],
    ])
  })

  it('applies no filter when neither from nor to is set', () => {
    const q = applyDateFilter(fakeQuery(), 'due', undefined, undefined)
    expect(q.calls).toEqual([])
  })

  it('never falls back to a plain gte/lte on a literal "due" column', () => {
    const q = applyDateFilter(fakeQuery(), 'due', '2026-01-01', '2026-12-31')
    expect(q.calls.every(([method]) => method === 'or')).toBe(true)
  })
})
