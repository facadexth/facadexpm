import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PHASE_TEMPLATE, parsePhaseTemplate, serializePhaseTemplate, templateTotal, templateProblems,
  moveTemplateRow, templateToPhaseRows, compareWeightsWithTemplate,
} from './phaseTemplate.js'
import { PHASE_TEMPLATE } from './ganttTimeline.js'

describe('parsePhaseTemplate', () => {
  it('falls back to the built-in 7 phases when the setting is missing, invalid JSON, not an array or empty', () => {
    expect(parsePhaseTemplate(null)).toEqual(DEFAULT_PHASE_TEMPLATE)
    expect(parsePhaseTemplate('')).toEqual(DEFAULT_PHASE_TEMPLATE)
    expect(parsePhaseTemplate('{nope')).toEqual(DEFAULT_PHASE_TEMPLATE)
    expect(parsePhaseTemplate('{"a":1}')).toEqual(DEFAULT_PHASE_TEMPLATE)
    expect(parsePhaseTemplate('[]')).toEqual(DEFAULT_PHASE_TEMPLATE)
    expect(DEFAULT_PHASE_TEMPLATE.map((r) => r.weight)).toEqual([5, 15, 5, 30, 30, 10, 5])
    expect(DEFAULT_PHASE_TEMPLATE.map((r) => r.name)).toEqual(PHASE_TEMPLATE.map((r) => r.name))
  })
  it('reads rows, trims names, drops blank names, orders by sort_order and treats a bad weight as 0 (same as the DB)', () => {
    const raw = JSON.stringify([
      { name: ' ติดตั้ง ', sort_order: 2, weight: '40' },
      { name: 'ผลิต', sort_order: 1, weight: 40 },
      { name: '  ', sort_order: 3, weight: 20 },
      { name: 'เก็บงาน', sort_order: 4, weight: 'x' },
    ])
    expect(parsePhaseTemplate(raw)).toEqual([
      { name: 'ผลิต', sort_order: 1, weight: 40 },
      { name: 'ติดตั้ง', sort_order: 2, weight: 40 },
      { name: 'เก็บงาน', sort_order: 3, weight: 0 },
    ])
  })
})

describe('serializePhaseTemplate', () => {
  it('writes name / sort_order / weight only, renumbered 1..n', () => {
    const rows = [{ name: 'ผลิต', weight: '60', sort_order: 9, extra: 1 }, { name: ' ติดตั้ง', weight: 40, sort_order: 2 }]
    expect(JSON.parse(serializePhaseTemplate(rows))).toEqual([
      { name: 'ผลิต', sort_order: 1, weight: 60 }, { name: 'ติดตั้ง', sort_order: 2, weight: 40 },
    ])
  })
})

describe('templateTotal / templateProblems', () => {
  it('totals the weights (strings included) to 2 dp', () => {
    expect(templateTotal([{ weight: '33.33' }, { weight: 33.33 }, { weight: 33.34 }])).toBe(100)
    expect(templateTotal([{ weight: '' }, { weight: 'abc' }])).toBe(0)
  })
  it('a valid template has no problems', () => {
    expect(templateProblems(DEFAULT_PHASE_TEMPLATE)).toEqual([])
  })
  it('reports a total that is not 100, a blank name, a duplicate name and a negative weight', () => {
    expect(templateProblems([{ name: 'ผลิต', weight: 60 }])).toContain('รวมต้องได้ 100% (ตอนนี้ 60%)')
    expect(templateProblems([{ name: '', weight: 100 }])).toContain('ชื่อเฟสว่าง')
    expect(templateProblems([{ name: 'ผลิต', weight: 50 }, { name: 'ผลิต ', weight: 50 }])).toContain('ชื่อเฟสซ้ำ: ผลิต')
    expect(templateProblems([{ name: 'ผลิต', weight: 110 }, { name: 'ติดตั้ง', weight: -10 }])).toContain('น้ำหนักต้องไม่ติดลบ')
    expect(templateProblems([])).toContain('ต้องมีอย่างน้อย 1 เฟส')
  })
})

describe('moveTemplateRow', () => {
  it('moves a row up or down and renumbers, no move past the ends', () => {
    const rows = [{ name: 'a', sort_order: 1 }, { name: 'b', sort_order: 2 }, { name: 'c', sort_order: 3 }]
    expect(moveTemplateRow(rows, 2, -1).map((r) => `${r.name}${r.sort_order}`)).toEqual(['a1', 'c2', 'b3'])
    expect(moveTemplateRow(rows, 0, 1).map((r) => r.name)).toEqual(['b', 'a', 'c'])
    expect(moveTemplateRow(rows, 0, -1)).toBe(rows)
    expect(moveTemplateRow(rows, 2, 1)).toBe(rows)
  })
})

describe('templateToPhaseRows', () => {
  it('gives the site_phases insert shape used by the Gantt "apply template" button', () => {
    expect(templateToPhaseRows([{ name: 'ผลิต', sort_order: 1, weight: 60 }, { name: 'ติดตั้ง', sort_order: 2, weight: 40 }]))
      .toEqual([{ name: 'ผลิต', sort_order: 1, billing_weight_pct: 60 }, { name: 'ติดตั้ง', sort_order: 2, billing_weight_pct: 40 }])
    expect(templateToPhaseRows(DEFAULT_PHASE_TEMPLATE)).toEqual(PHASE_TEMPLATE)
  })
})

describe('compareWeightsWithTemplate', () => {
  const tpl = [{ name: 'ผลิต', sort_order: 1, weight: 40 }, { name: 'ติดตั้ง', sort_order: 2, weight: 40 }, { name: 'เก็บงานรอบสุดท้าย', sort_order: 3, weight: 20 }]
  it('matches contract phases by trimmed name; unmatched, VO and issue phases are left out of the update', () => {
    const phases = [
      { id: 'p1', name: 'ผลิต ', billing_weight_pct: 30, sort_order: 1 },
      { id: 'p2', name: 'ติดตั้ง', billing_weight_pct: 30, sort_order: 2 },
      { id: 'p3', name: 'ส่งมอบงาน', billing_weight_pct: 40, sort_order: 3 },
      { id: 'p4', name: 'ผลิต', billing_weight_pct: 0, sort_order: 4, is_vo: true },
      { id: 'p5', name: 'ติดตั้ง', billing_weight_pct: 0, sort_order: 5, is_issue_phase: true },
    ]
    const r = compareWeightsWithTemplate(phases, tpl)
    expect(r.rows).toEqual([
      { phaseId: 'p1', name: 'ผลิต ', current: 30, template: 40, changed: true },
      { phaseId: 'p2', name: 'ติดตั้ง', current: 30, template: 40, changed: true },
      { phaseId: 'p3', name: 'ส่งมอบงาน', current: 40, template: null, changed: false },
    ])
    expect(r.updates).toEqual([{ id: 'p1', billing_weight_pct: 40 }, { id: 'p2', billing_weight_pct: 40 }])
    expect(r.totalAfter).toBe(120)
  })
  it('an already-matching phase is not an update', () => {
    const r = compareWeightsWithTemplate([{ id: 'p1', name: 'ผลิต', billing_weight_pct: 40 }], tpl)
    expect(r.rows[0].changed).toBe(false)
    expect(r.updates).toEqual([])
  })
})
