import { describe, it, expect } from 'vitest'
import { boqRemainingInPhase, boqCardCandidates, bulkCardRows } from './boqPhaseCards.js'

const boq = [
  { id: 'b1', code: '1', description: 'กระจก', unit: 'ตร.ม.', planned_qty: 26, sort_order: 1 },
  { id: 'b2', code: '2', description: 'ประตู', unit: 'ชุด', planned_qty: 1, sort_order: 2 },
  { id: 'b3', code: '3', description: 'บันได', unit: null, planned_qty: 2, sort_order: 3 },
]
const tasks = [
  { id: 't1', boq_item_id: 'b1', phase_id: 'install', planned_qty: 26 },
  { id: 't2', boq_item_id: 'b1', phase_id: 'make', planned_qty: 20 },
  { id: 't3', boq_item_id: 'b1', phase_id: 'make', subtask_id: 'st1', planned_qty: 2.5 },
  { id: 't4', boq_item_id: 'b2', phase_id: 'install', planned_qty: 1 },
  { id: 't5', boq_item_id: null, phase_id: 'install', planned_qty: null },
]

describe('boqRemainingInPhase', () => {
  it('counts cards of that phase only (subtask cards carry the phase)', () => {
    expect(boqRemainingInPhase(boq[0], 'make', tasks)).toBe(3.5)
    expect(boqRemainingInPhase(boq[0], 'install', tasks)).toBe(0)
    expect(boqRemainingInPhase(boq[0], 'finish', tasks)).toBe(26)
  })
  it('ignores the card being edited', () => {
    expect(boqRemainingInPhase(boq[0], 'install', tasks, 't1')).toBe(26)
  })
  it('null without an item', () => {
    expect(boqRemainingInPhase(null, 'make', tasks)).toBeNull()
  })
})

describe('boqCardCandidates', () => {
  const cells = { b1: { make: 40, install: 40, finish: 20 }, b2: { make: 0, install: 100, finish: 0 }, b3: { make: 0, install: 50, finish: 50 } }
  it('lists items with pct > 0 in the phase, remaining per phase, full ones flagged; count = those still open', () => {
    const r = boqCardCandidates({ phaseId: 'install', boqItems: boq, cells, tasks })
    expect(r.rows.map((x) => [x.item.id, x.remaining, x.full])).toEqual([['b1', 0, true], ['b2', 0, true], ['b3', 2, false]])
    expect(r.count).toBe(1)
  })
  it('an item with pct 0 in the phase is not listed', () => {
    const r = boqCardCandidates({ phaseId: 'make', boqItems: boq, cells, tasks })
    expect(r.rows.map((x) => x.item.id)).toEqual(['b1'])
    expect(r.count).toBe(1)
  })
  it('no cells (site not in BOQ mode) -> nothing', () => {
    expect(boqCardCandidates({ phaseId: 'make', boqItems: boq, cells: null, tasks }).count).toBe(0)
    expect(boqCardCandidates({ phaseId: 'make', boqItems: boq, cells: {}, tasks }).count).toBe(0)
  })
})

describe('bulkCardRows', () => {
  it('builds the phase_tasks insert rows: BOQ description, quantity mode, remaining qty, not_started, running sort_order', () => {
    const rows = bulkCardRows({
      siteId: 's1', phaseId: 'install', nextSortOrder: 4,
      picks: [{ item: boq[2], qty: 2 }, { item: boq[0], qty: '5' }],
    })
    expect(rows).toEqual([
      { site_id: 's1', phase_id: 'install', subtask_id: null, name: 'บันได', zone: null, due_date: null, sort_order: 4, status: 'not_started', progress_mode: 'quantity', boq_item_id: 'b3', planned_qty: 2 },
      { site_id: 's1', phase_id: 'install', subtask_id: null, name: 'กระจก', zone: null, due_date: null, sort_order: 5, status: 'not_started', progress_mode: 'quantity', boq_item_id: 'b1', planned_qty: 5 },
    ])
  })
  it('drops picks with no positive qty', () => {
    expect(bulkCardRows({ siteId: 's1', phaseId: 'p', nextSortOrder: 1, picks: [{ item: boq[0], qty: 0 }, { item: boq[1], qty: '' }] })).toEqual([])
  })
})
