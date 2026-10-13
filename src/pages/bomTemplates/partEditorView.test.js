// Pure view helpers of the part editor for every layout kind (Task 10): part tabs, part counts, the clamp warning,
// visible inputs (only_when / fixed_by_type / estimator), "เสร็จแล้ว" per part, assigned-position badge, issue texts.
import { describe, it, expect } from 'vitest'
import { startModel } from '../../lib/partModel.js'
import {
  partTabs, partCountOf, clampedParts, CLAMP_TEXT, inputVisible, visibleInputs, toggleDone, isDone, assignedCount, ISSUE_TEXT,
} from './partEditorView.js'
import { REASON_TEXT } from '../../lib/reasonText.js'

describe('partTabs', () => {
  it('awning 2 × 2: ทั้งชุด, วงกบ, ซอยกลาง and one tab per sash (4)', () => {
    const tabs = partTabs(startModel('awning_grid', { rows: 2, cols: 2 }))
    expect(tabs.map(t => t.label)).toEqual(['ทั้งชุด', 'วงกบ', 'ซอยกลาง', 'บานกระทุ้ง 1', 'บานกระทุ้ง 2', 'บานกระทุ้ง 3', 'บานกระทุ้ง 4'])
    expect(tabs[0]).toMatchObject({ partKey: null, partIdx: null })
    expect(tabs[1]).toMatchObject({ partKey: 'frame', partIdx: 0 })
    expect(tabs[6]).toMatchObject({ partKey: 'sash', partIdx: 3 })
  })
  it('parts without positions (glass / panel) and parts with count 0 have no tab', () => {
    expect(partTabs(startModel('frameless_wall')).map(t => t.partKey)).toEqual([null, 'frame'])
    // curtain wall without awning cells: no บานกระทุ้ง tab, no spandrel (panel) tab
    expect(partTabs(startModel('curtain_wall')).map(t => t.partKey)).toEqual([null, 'frame'])
  })
  it('sliding_n with n = 3 gives three sash tabs (R-F1: บานซ้าย / บานกลาง / บานขวา; n = 4 numbers the middle ones)', () => {
    expect(partTabs(startModel('sliding_n', { n: 3 })).filter(t => t.partKey?.startsWith('sash')).map(t => t.label)).toEqual(['บานซ้าย', 'บานกลาง', 'บานขวา'])
    expect(partTabs(startModel('sliding_n', { n: 4 })).filter(t => t.partKey?.startsWith('sash')).map(t => t.label)).toEqual(['บานซ้าย', 'บานกลาง 1', 'บานกลาง 2', 'บานขวา'])
    expect(partTabs(startModel('sliding_n', { n: 2 })).filter(t => t.partKey?.startsWith('sash')).map(t => t.label)).toEqual(['บานซ้าย', 'บานขวา'])
  })
})

describe('partCountOf / clampedParts', () => {
  it('a literal count is editable, an expression count is computed and clamped at 10', () => {
    expect(partCountOf(startModel('sliding_2'), 'sash')).toEqual({ count: 2, raw: 2, expr: false })
    expect(partCountOf(startModel('awning_grid', { rows: 2, cols: 3 }), 'sash')).toEqual({ count: 6, raw: 6, expr: true })
    expect(partCountOf(startModel('awning_grid', { rows: 4, cols: 4 }), 'sash')).toEqual({ count: 10, raw: 16, expr: true })
  })
  it('clampedParts lists only parts above MAX_PART_COUNT', () => {
    expect(clampedParts(startModel('awning_grid', { rows: 2, cols: 2 }))).toEqual([])
    expect(clampedParts(startModel('awning_grid', { rows: 4, cols: 4 }))).toEqual([{ key: 'sash', name: 'บานกระทุ้ง', raw: 16, used: 10 }])
    expect(CLAMP_TEXT).toBe('จำนวนบานเกิน 10 — คิดราคาที่ 10 บาน')
  })
})

describe('inputs panel', () => {
  it('only_when shows an input only while every listed param equals its value', () => {
    const hinge = { key: 'hinge', only_when: { n: 1 } }
    expect(inputVisible(hinge, { n: 1 })).toBe(true)
    expect(inputVisible(hinge, { n: 2 })).toBe(false)
    expect(inputVisible(hinge, { n: '1' })).toBe(true)
    expect(inputVisible({ key: 'open' }, {})).toBe(true)
  })
  it('template: every input except cells (fixed_by_type included, read-only in the UI)', () => {
    expect(visibleInputs('casement_n', { n: 1 }).map(i => i.key)).toEqual(['n', 'hinge', 'open'])
    expect(visibleInputs('casement_n', { n: 2 }).map(i => i.key)).toEqual(['n', 'open'])
    expect(visibleInputs('curtain_wall', {}).map(i => i.key)).toEqual(['rows', 'cols', 'spandrel', 'k', 'unitized'])
  })
  it('item: estimator inputs that the type does not fix, no cells', () => {
    expect(visibleInputs('awning_grid', { rows: 2, cols: 2 }, { item: true }).map(i => i.key)).toEqual(['open'])
    expect(visibleInputs('sliding_n', { n: 2 }, { item: true }).map(i => i.key)).toEqual(['n'])
    expect(visibleInputs('swing_door', { leaves: 1 }, { item: true }).map(i => i.key)).toEqual(['hinge', 'open', 'sill'])
    expect(visibleInputs('swing_door', { leaves: 2 }, { item: true }).map(i => i.key)).toEqual(['open', 'sill'])
    expect(visibleInputs('curtain_wall', {}, { item: true }).map(i => i.key)).toEqual(['rows', 'cols', 'spandrel', 'k'])
  })
})

describe('เสร็จแล้ว per part', () => {
  it('toggleDone adds / removes the part key in model.done without touching the input', () => {
    const m = startModel('awning_grid')
    const a = toggleDone(m, 'sash')
    expect(m.done).toBeUndefined()
    expect(a.done).toEqual(['sash'])
    expect(isDone(a, 'sash')).toBe(true)
    expect(isDone(a, 'frame')).toBe(false)
    expect(toggleDone(a, 'sash').done).toEqual([])
  })
})

describe('assignedCount', () => {
  it('counts present positions whose first line has a family', () => {
    const m = startModel('fixed_grid')
    expect(assignedCount(m)).toEqual({ done: 5, total: 5 })
    m.lines.mullion[0].profile_family = ''
    expect(assignedCount(m)).toEqual({ done: 4, total: 5 })
  })
})

describe('issue texts', () => {
  it('no_profile_width has Thai text in the editor and in reasonText', () => {
    expect(ISSUE_TEXT.no_profile_width).toMatch(/ความกว้างโปรไฟล์/)
    expect(REASON_TEXT.no_profile_width).toMatch(/ความกว้างโปรไฟล์/)
  })
})
