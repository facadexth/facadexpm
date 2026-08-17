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

describe('applyDateFilter — "due" field (OR across due_date/check_date)', () => {
  it('ORs due_date and check_date for both from and to', () => {
    const q = applyDateFilter(fakeQuery(), 'due', '2026-01-01', '2026-12-31')
    expect(q.calls).toEqual([
      ['or', 'due_date.gte.2026-01-01,check_date.gte.2026-01-01'],
      ['or', 'due_date.lte.2026-12-31,check_date.lte.2026-12-31'],
    ])
  })

  it('applies only the from-side OR when to is omitted', () => {
    const q = applyDateFilter(fakeQuery(), 'due', '2026-01-01', undefined)
    expect(q.calls).toEqual([['or', 'due_date.gte.2026-01-01,check_date.gte.2026-01-01']])
  })

  it('never falls back to a plain gte/lte on a literal "due" column', () => {
    const q = applyDateFilter(fakeQuery(), 'due', '2026-01-01', '2026-12-31')
    expect(q.calls.every(([method]) => method === 'or')).toBe(true)
  })
})
