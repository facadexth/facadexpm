import { describe, it, expect } from 'vitest'
import {
  LAYOUTS, startModel, pieceCount, ensureEnds, partnerEnd, setEndMode,
  validateCorners, addLine, removeLine, setPartCount, groupsOf,
} from './partModel'

const KEYS = ['frame_top', 'frame_bottom', 'frame_side', 'sash_top', 'sash_bottom', 'key_stile', 'hook_stile']

describe('startModel defaults', () => {
  const m = startModel('sliding_2')
  it('has 7 positions and expected piece counts', () => {
    expect(Object.keys(m.lines).sort()).toEqual([...KEYS].sort())
    expect(pieceCount(m, 'frame_top') + pieceCount(m, 'frame_bottom') + pieceCount(m, 'frame_side')).toBe(4)
    for (const k of ['sash_top', 'sash_bottom', 'key_stile', 'hook_stile']) expect(pieceCount(m, k)).toBe(2)
    expect(LAYOUTS.sliding_2).toBeTruthy()
  })
  it('has the decision-6 line defaults', () => {
    expect(m.lines.frame_top[0].length_rule_type).toBe('width')
    expect(m.lines.frame_side[0].length_rule_type).toBe('height')
    expect(m.lines.sash_top[0]).toMatchObject({ length_rule_type: 'width_minus', length_factor: 0.5, deduction_auto: true, thickness_role: 'sash', quantity_value: 1, profile_family: '' })
    expect(m.lines.key_stile[0]).toMatchObject({ length_rule_type: 'height_minus', deduction_auto: true, thickness_role: 'sash' })
  })
  it('default ends', () => {
    expect(m.lines.frame_top[0].ends[0][0]).toEqual({ mode: 'butt', to: { key: 'frame_side', line: 0 }, deduction_mm: null })
    expect(m.lines.frame_side[0].ends[1][1].mode).toBe('through')
    expect(m.lines.sash_top[0].ends[1][0].to).toEqual({ key: 'hook_stile', line: 0 })
    expect(m.lines.sash_top[0].ends[1][1].to).toEqual({ key: 'key_stile', line: 0 })
  })
  it('satisfies the corner rule', () => {
    expect(validateCorners(m)).toEqual([])
  })
})

describe('partnerEnd', () => {
  it('is an exact involution for every key/piece/end', () => {
    const m = startModel('sliding_2')
    for (const key of KEYS) {
      for (let piece = 0; piece < pieceCount(m, key); piece++) {
        for (const end of [0, 1]) {
          const p = partnerEnd(key, piece, end)
          expect(p).not.toBeNull()
          expect(partnerEnd(p.key, p.piece, p.end)).toEqual({ key, piece, end })
        }
      }
    }
  })
})

describe('partnerEnd explicit table', () => {
  it('matches the mockup partner()', () => {
    expect(partnerEnd('sash_bottom', 1, 0)).toEqual({ key: 'hook_stile', piece: 1, end: 1 })
    expect(partnerEnd('sash_bottom', 1, 1)).toEqual({ key: 'key_stile', piece: 1, end: 1 })
    expect(partnerEnd('sash_top', 0, 0)).toEqual({ key: 'hook_stile', piece: 0, end: 0 })
    expect(partnerEnd('key_stile', 1, 0)).toEqual({ key: 'sash_top', piece: 1, end: 1 })
    expect(partnerEnd('key_stile', 1, 1)).toEqual({ key: 'sash_bottom', piece: 1, end: 1 })
    expect(partnerEnd('hook_stile', 0, 0)).toEqual({ key: 'sash_top', piece: 0, end: 0 })
    expect(partnerEnd('hook_stile', 0, 1)).toEqual({ key: 'sash_bottom', piece: 0, end: 0 })
  })
})

describe('parts', () => {
  it('overlap fields satisfy the DB check', () => {
    for (const p of startModel('sliding_2').parts) {
      expect(['auto_hook', 'manual']).toContain(p.overlap_mode)
      expect(p.overlap_mm).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('setEndMode', () => {
  it('flips and retargets the frame partner', () => {
    const m = startModel('sliding_2')
    const n = setEndMode(m, 'frame_bottom', 0, 0, 0, 'through')
    expect(n.lines.frame_bottom[0].ends[0][0].mode).toBe('through')
    expect(n.lines.frame_side[0].ends[0][1]).toEqual({ mode: 'butt', to: { key: 'frame_bottom', line: 0 }, deduction_mm: null })
    expect(validateCorners(n)).toEqual([])
  })
  it('flips the rail when a stile end becomes butt', () => {
    const m = startModel('sliding_2')
    const n = setEndMode(m, 'key_stile', 0, 0, 0, 'butt')
    expect(n.lines.key_stile[0].ends[0][0].mode).toBe('butt')
    expect(n.lines.sash_top[0].ends[0][1]).toMatchObject({ mode: 'through', to: null })
    expect(validateCorners(n)).toEqual([])
  })
  it('does not mutate its input', () => {
    const m = startModel('sliding_2')
    const snap = JSON.parse(JSON.stringify(m))
    setEndMode(m, 'frame_bottom', 0, 0, 0, 'through')
    expect(m).toEqual(snap)
  })
  it('pairs lines by equal index only; extra lines are free-standing', () => {
    let m = startModel('sliding_2')
    m = addLine(addLine(m, 'frame_bottom'), 'frame_bottom')
    const before = JSON.parse(JSON.stringify(m.lines.frame_side))
    const n = setEndMode(m, 'frame_bottom', 2, 0, 0, 'through')
    expect(n.lines.frame_bottom[2].ends[0][0].mode).toBe('through')
    expect(n.lines.frame_side).toEqual(before)
    expect(validateCorners(n)).toEqual([])
    const k = setEndMode(m, 'frame_bottom', 0, 0, 0, 'through')
    expect(k.lines.frame_side[0].ends[0][1]).toEqual({ mode: 'butt', to: { key: 'frame_bottom', line: 0 }, deduction_mm: null })
    expect(validateCorners(k)).toEqual([])
  })
})

describe('validateCorners', () => {
  it('flags both_through and both_butt', () => {
    let m = startModel('sliding_2')
    m = JSON.parse(JSON.stringify(m))
    m.lines.frame_top[0].ends[0][0].mode = 'through'
    expect(validateCorners(m).some(i => i.reason === 'both_through' && i.key === 'frame_top' && i.piece === 0 && i.end === 0)).toBe(true)
    m.lines.frame_side[0].ends[0][0].mode = 'butt'
    m.lines.frame_top[0].ends[0][0].mode = 'butt'
    expect(validateCorners(m).some(i => i.reason === 'both_butt')).toBe(true)
  })
})

describe('ensureEnds / setPartCount', () => {
  it('adds a third pair per sash line without touching pieces 0-1', () => {
    const m = startModel('sliding_2')
    const n = setPartCount(m, 'sash', 3)
    expect(n.parts.find(p => p.key === 'sash').count).toBe(3)
    for (const k of ['sash_top', 'sash_bottom', 'key_stile', 'hook_stile']) {
      expect(n.lines[k][0].ends).toHaveLength(3)
      expect(n.lines[k][0].ends.slice(0, 2)).toEqual(m.lines[k][0].ends)
    }
    expect(m.lines.sash_top[0].ends).toHaveLength(2)
    const snap = JSON.parse(JSON.stringify(m))
    setPartCount(m, 'sash', 4)
    expect(m).toEqual(snap)
    expect(setPartCount(n, 'sash', 0).parts.find(p => p.key === 'sash').count).toBe(1)
  })
  it('new piece on later lines copies line 0 pair', () => {
    let m = addLine(startModel('sliding_2'), 'sash_top')
    m = setEndMode(m, 'sash_top', 0, 0, 0, 'through')
    const n = setPartCount(ensureEnds(m), 'sash', 3)
    expect(n.lines.sash_top[1].ends[2]).toEqual(n.lines.sash_top[0].ends[2])
  })
})

describe('addLine / removeLine', () => {
  it('addLine deep-copies ends', () => {
    const m = addLine(startModel('sliding_2'), 'frame_top')
    expect(m.lines.frame_top).toHaveLength(2)
    m.lines.frame_top[1].ends[0][0].mode = 'through'
    m.lines.frame_top[1].ends[0][0].to.line = 9
    expect(m.lines.frame_top[0].ends[0][0].mode).toBe('butt')
    expect(m.lines.frame_top[0].ends[0][0].to.line).toBe(0)
  })
  it('removeLine nulls dangling targets and never removes the last line', () => {
    let m = addLine(startModel('sliding_2'), 'frame_side')
    m = JSON.parse(JSON.stringify(m))
    m.lines.frame_top[0].ends[0][1].to = { key: 'frame_side', line: 1 }
    const n = removeLine(m, 'frame_side', 1)
    expect(n.lines.frame_side).toHaveLength(1)
    expect(n.lines.frame_top[0].ends[0][1].to).toEqual({ key: 'frame_side', line: 0 })
    expect(n.lines.frame_top[0].ends[0][0].to).toEqual({ key: 'frame_side', line: 0 })
    expect(removeLine(n, 'frame_side', 0).lines.frame_side).toHaveLength(1)
  })
  it('retargets removed/later/earlier targets', () => {
    let m = addLine(addLine(startModel('sliding_2'), 'frame_side'), 'frame_side')
    m = JSON.parse(JSON.stringify(m))
    const t = m.lines.frame_top[0].ends
    t[0][0].to = { key: 'frame_side', line: 1 }
    t[0][1].to = { key: 'frame_side', line: 2 }
    t[0][0].to = { key: 'frame_side', line: 1 }
    m.lines.frame_bottom[0].ends[0][0].to = { key: 'frame_side', line: 0 }
    const n = removeLine(m, 'frame_side', 1)
    expect(n.lines.frame_top[0].ends[0][0].to).toEqual({ key: 'frame_side', line: 0 })
    expect(n.lines.frame_top[0].ends[0][1].to).toEqual({ key: 'frame_side', line: 1 })
    expect(n.lines.frame_bottom[0].ends[0][0].to).toEqual({ key: 'frame_side', line: 0 })
  })
})

describe('groupsOf', () => {
  it('groups, rounds to 0.1 and sorts descending', () => {
    expect(groupsOf([1200, 1200, 1161.9], 1)).toEqual([{ len: 1200, n: 2 }, { len: 1161.9, n: 1 }])
    expect(groupsOf([1000.04, 1100], 2)).toEqual([{ len: 1100, n: 2 }, { len: 1000, n: 2 }])
  })
})

import {
  numOrNull, clampSelection, updateLine, updatePart, setPositionName, updateEnd, addLineAndSelect, removeLineAndSelect,
} from './partModel'

describe('editor state helpers', () => {
  it('numOrNull returns a real Number or null, never a string', () => {
    expect(numOrNull('12.5')).toBe(12.5)
    expect(numOrNull(' 0 ')).toBe(0)
    expect(numOrNull(3)).toBe(3)
    expect(numOrNull('')).toBeNull()
    expect(numOrNull('   ')).toBeNull()
    expect(numOrNull(null)).toBeNull()
    expect(numOrNull(undefined)).toBeNull()
    expect(numOrNull('abc')).toBeNull()
    expect(numOrNull(NaN)).toBeNull()
    expect(typeof numOrNull('7')).toBe('number')
  })
  it('clampSelection keeps a valid selection and repairs a stale one', () => {
    const m = startModel('sliding_2')
    expect(clampSelection(m, { key: 'sash_top', line: 0 })).toEqual({ key: 'sash_top', line: 0 })
    expect(clampSelection(m, { key: 'sash_top', line: 3 })).toEqual({ key: 'sash_top', line: 0 })
    expect(clampSelection(m, { key: 'nope', line: 0 })).toEqual({ key: 'frame_top', line: 0 })
    expect(clampSelection(null, { key: 'sash_top', line: 0 })).toEqual({ key: null, line: 0 })
  })
  it('add profile copies line 0 and selects the new line; remove selects line 0', () => {
    const m = startModel('sliding_2')
    m.lines.frame_bottom[0].profile_family = 'FB'
    const a = addLineAndSelect(m, 'frame_bottom')
    expect(a.sel).toEqual({ key: 'frame_bottom', line: 1 })
    expect(a.model.lines.frame_bottom).toHaveLength(2)
    expect(a.model.lines.frame_bottom[1]).toEqual(m.lines.frame_bottom[0])
    expect(m.lines.frame_bottom).toHaveLength(1)   // immutable
    const r = removeLineAndSelect(a.model, 'frame_bottom', 1)
    expect(r.sel).toEqual({ key: 'frame_bottom', line: 0 })
    expect(r.model.lines.frame_bottom).toHaveLength(1)
  })
  it('part count change re-fits the ends of every piece (ensureEnds)', () => {
    const m = setPartCount(startModel('sliding_2'), 'sash', 3)
    for (const k of ['sash_top', 'sash_bottom', 'key_stile', 'hook_stile']) expect(m.lines[k][0].ends).toHaveLength(3)
    expect(m.lines.frame_side[0].ends).toHaveLength(2)
    const back = setPartCount(m, 'sash', 1)
    expect(back.lines.sash_top[0].ends).toHaveLength(1)
    expect(validateCorners(back)).toEqual([])
  })
  it('updateLine / updatePart / setPositionName are immutable patches', () => {
    const m = startModel('sliding_2')
    const a = updateLine(m, 'sash_top', 0, { length_deduction_mm: 10, deduction_auto: false })
    expect(a.lines.sash_top[0]).toMatchObject({ length_deduction_mm: 10, deduction_auto: false })
    expect(m.lines.sash_top[0].deduction_auto).toBe(true)
    const b = updatePart(m, 'sash', { overlap_mode: 'manual', overlap_mm: 20 })
    expect(b.parts.find(p => p.key === 'sash')).toMatchObject({ overlap_mode: 'manual', overlap_mm: 20 })
    expect(setPositionName(m, 'key_stile', 'เสาล็อก').names.key_stile).toBe('เสาล็อก')
  })
  it('updateEnd: a new target resets the deduction; a typed deduction is stored as a number', () => {
    const m = startModel('sliding_2')
    const a = updateEnd(m, 'sash_top', 0, 0, 0, { deduction_mm: '12.5' })
    expect(a.lines.sash_top[0].ends[0][0].deduction_mm).toBe(12.5)
    const b = updateEnd(a, 'sash_top', 0, 0, 0, { to: { key: 'key_stile', line: 0 } })
    expect(b.lines.sash_top[0].ends[0][0]).toMatchObject({ to: { key: 'key_stile', line: 0 }, deduction_mm: null })
    expect(updateEnd(m, 'sash_top', 0, 0, 0, { deduction_mm: '' }).lines.sash_top[0].ends[0][0].deduction_mm).toBeNull()
  })
})

import { commitPartCount } from './partModel'

describe('commitPartCount (part count field)', () => {
  it('a blank / 0 / negative / fractional entry leaves the model untouched and keeps pieces 2+', () => {
    let m = startModel('sliding_2')
    m = updateEnd(m, 'sash_top', 0, 1, 0, { deduction_mm: 7 })   // custom setting on บานขวา
    for (const v of [null, '', 0, '0', -1, 1.5, 'x', NaN]) {
      const r = commitPartCount(m, 'sash', v)
      expect(r).toBe(m)
      expect(r.lines.sash_top[0].ends).toHaveLength(2)
      expect(r.lines.sash_top[0].ends[1][0].deduction_mm).toBe(7)
    }
  })
  it('a whole number >= 1 goes through setPartCount (ensureEnds)', () => {
    const m = startModel('sliding_2')
    expect(commitPartCount(m, 'sash', 3).lines.sash_top[0].ends).toHaveLength(3)
    expect(commitPartCount(m, 'sash', '1').lines.sash_top[0].ends).toHaveLength(1)
    expect(commitPartCount(m, 'sash', 2)).toBe(m)
  })
})

import { MAX_PART_COUNT } from './partModel'

describe('part count cap', () => {
  it('setPartCount ignores a count above MAX_PART_COUNT (10)', () => {
    expect(MAX_PART_COUNT).toBe(10)
    const m = startModel('sliding_2')
    const r = setPartCount(m, 'sash', 5000)
    expect(r.parts.find(p => p.key === 'sash').count).toBe(2)
    expect(r.lines.sash_top[0].ends).toHaveLength(2)
    expect(setPartCount(m, 'sash', 10).lines.sash_top[0].ends).toHaveLength(10)
    expect(commitPartCount(m, 'sash', 11)).toBe(m)
  })
})

// ---------------------------------------------------------------- Task 2: declarative layouts, sliding_2 frozen
import { setParams, defaultTarget } from './partModel'

// Literal snapshot of startModel('sliding_2') taken BEFORE the declarative refactor, plus the new `params: {}`.
const SLIDING_2_SNAPSHOT = {
  layout_kind: 'sliding_2',
  parts: [
    { key: 'frame', name: 'วงกบ', count: 1, overlap_mode: 'manual', overlap_mm: 0 },
    { key: 'sash', name: 'บานเลื่อน', count: 2, overlap_mode: 'auto_hook', overlap_mm: 0 },
  ],
  lines: {
    frame_top: [{ profile_family: '', length_rule_type: 'width', length_deduction_mm: 0, deduction_auto: false, length_factor: 1, quantity_value: 1, thickness_role: null, ends: [[{ mode: 'butt', to: { key: 'frame_side', line: 0 }, deduction_mm: null }, { mode: 'butt', to: { key: 'frame_side', line: 0 }, deduction_mm: null }]] }],
    frame_bottom: [{ profile_family: '', length_rule_type: 'width', length_deduction_mm: 0, deduction_auto: false, length_factor: 1, quantity_value: 1, thickness_role: null, ends: [[{ mode: 'butt', to: { key: 'frame_side', line: 0 }, deduction_mm: null }, { mode: 'butt', to: { key: 'frame_side', line: 0 }, deduction_mm: null }]] }],
    frame_side: [{ profile_family: '', length_rule_type: 'height', length_deduction_mm: 0, deduction_auto: false, length_factor: 1, quantity_value: 1, thickness_role: null, ends: [[{ mode: 'through', to: null, deduction_mm: null }, { mode: 'through', to: null, deduction_mm: null }], [{ mode: 'through', to: null, deduction_mm: null }, { mode: 'through', to: null, deduction_mm: null }]] }],
    sash_top: [{ profile_family: '', length_rule_type: 'width_minus', length_deduction_mm: 0, deduction_auto: true, length_factor: 0.5, quantity_value: 1, thickness_role: 'sash', ends: [[{ mode: 'butt', to: { key: 'hook_stile', line: 0 }, deduction_mm: null }, { mode: 'butt', to: { key: 'key_stile', line: 0 }, deduction_mm: null }], [{ mode: 'butt', to: { key: 'hook_stile', line: 0 }, deduction_mm: null }, { mode: 'butt', to: { key: 'key_stile', line: 0 }, deduction_mm: null }]] }],
    sash_bottom: [{ profile_family: '', length_rule_type: 'width_minus', length_deduction_mm: 0, deduction_auto: true, length_factor: 0.5, quantity_value: 1, thickness_role: 'sash', ends: [[{ mode: 'butt', to: { key: 'hook_stile', line: 0 }, deduction_mm: null }, { mode: 'butt', to: { key: 'key_stile', line: 0 }, deduction_mm: null }], [{ mode: 'butt', to: { key: 'hook_stile', line: 0 }, deduction_mm: null }, { mode: 'butt', to: { key: 'key_stile', line: 0 }, deduction_mm: null }]] }],
    key_stile: [{ profile_family: '', length_rule_type: 'height_minus', length_deduction_mm: 0, deduction_auto: true, length_factor: 1, quantity_value: 1, thickness_role: 'sash', ends: [[{ mode: 'through', to: null, deduction_mm: null }, { mode: 'through', to: null, deduction_mm: null }], [{ mode: 'through', to: null, deduction_mm: null }, { mode: 'through', to: null, deduction_mm: null }]] }],
    hook_stile: [{ profile_family: '', length_rule_type: 'height_minus', length_deduction_mm: 0, deduction_auto: true, length_factor: 1, quantity_value: 1, thickness_role: 'sash', ends: [[{ mode: 'through', to: null, deduction_mm: null }, { mode: 'through', to: null, deduction_mm: null }], [{ mode: 'through', to: null, deduction_mm: null }, { mode: 'through', to: null, deduction_mm: null }]] }],
  },
  names: { frame_top: 'เฟรมบน', frame_bottom: 'เฟรมล่าง', frame_side: 'เฟรมข้าง', sash_top: 'บานเลื่อนบน', sash_bottom: 'บานเลื่อนล่าง', key_stile: 'เสากุญแจ', hook_stile: 'เสาเกี่ยว' },
  params: { door: false, one_fixed: 0, fixed_side: 'left' },
}

// Every (key, piece, end) -> partner of the pre-refactor hard-coded partnerEnd, captured before the refactor.
const SLIDING_2_PARTNERS = [
  ['frame_top', 0, 0, 'frame_side', 0, 0], ['frame_top', 0, 1, 'frame_side', 1, 0],
  ['frame_bottom', 0, 0, 'frame_side', 0, 1], ['frame_bottom', 0, 1, 'frame_side', 1, 1],
  ['frame_side', 0, 0, 'frame_top', 0, 0], ['frame_side', 0, 1, 'frame_bottom', 0, 0],
  ['frame_side', 1, 0, 'frame_top', 0, 1], ['frame_side', 1, 1, 'frame_bottom', 0, 1],
  ['sash_top', 0, 0, 'hook_stile', 0, 0], ['sash_top', 0, 1, 'key_stile', 0, 0],
  ['sash_top', 1, 0, 'hook_stile', 1, 0], ['sash_top', 1, 1, 'key_stile', 1, 0],
  ['sash_bottom', 0, 0, 'hook_stile', 0, 1], ['sash_bottom', 0, 1, 'key_stile', 0, 1],
  ['sash_bottom', 1, 0, 'hook_stile', 1, 1], ['sash_bottom', 1, 1, 'key_stile', 1, 1],
  ['key_stile', 0, 0, 'sash_top', 0, 1], ['key_stile', 0, 1, 'sash_bottom', 0, 1],
  ['key_stile', 1, 0, 'sash_top', 1, 1], ['key_stile', 1, 1, 'sash_bottom', 1, 1],
  ['hook_stile', 0, 0, 'sash_top', 0, 0], ['hook_stile', 0, 1, 'sash_bottom', 0, 0],
  ['hook_stile', 1, 0, 'sash_top', 1, 0], ['hook_stile', 1, 1, 'sash_bottom', 1, 0],
]

describe('sliding_2 frozen behaviour (declarative layout)', () => {
  it('startModel deep-equals the pre-refactor snapshot plus params: {}', () => {
    expect(startModel('sliding_2')).toEqual(SLIDING_2_SNAPSHOT)
    expect(startModel('sliding_2', {})).toEqual(SLIDING_2_SNAPSHOT)
  })
  it('startModel minus params still deep-equals the snapshot minus params (Task 9 freeze proof)', () => {
    const { params: _a, ...got } = startModel('sliding_2')
    const { params: _b, ...want } = SLIDING_2_SNAPSHOT
    expect(got).toEqual(want)
  })
  it('partnerEnd(model, ...) reproduces the old table and is an exact involution', () => {
    const m = startModel('sliding_2')
    expect(partnerEnd(m, 'sash_top', 1, 0)).toEqual({ key: 'hook_stile', piece: 1, end: 0 })
    for (const [key, piece, end, pk, pp, pe] of SLIDING_2_PARTNERS) {
      const p = partnerEnd(m, key, piece, end)
      expect(p).toEqual({ key: pk, piece: pp, end: pe })
      expect(partnerEnd(m, p.key, p.piece, p.end)).toEqual({ key, piece, end })
    }
    let n = 0
    for (const key of KEYS) for (let piece = 0; piece < pieceCount(m, key); piece++) for (const end of [0, 1]) {
      const p = partnerEnd(m, key, piece, end)
      expect(partnerEnd(m, p.key, p.piece, p.end)).toEqual({ key, piece, end })
      n++
    }
    expect(n).toBe(SLIDING_2_PARTNERS.length)
  })
  it('pieceCount without params equals the old numbers (and follows the part count)', () => {
    const m = startModel('sliding_2')
    delete m.params   // a model saved before params existed
    expect(Object.fromEntries(KEYS.map(k => [k, pieceCount(m, k)]))).toEqual({ frame_top: 1, frame_bottom: 1, frame_side: 2, sash_top: 2, sash_bottom: 2, key_stile: 2, hook_stile: 2 })
    expect(pieceCount(setPartCount(m, 'sash', 3), 'key_stile')).toBe(3)
    expect(pieceCount(setPartCount(m, 'frame', 2), 'frame_side')).toBe(4)
  })
  it('defaultTarget(model, key, end) gives the default butt target', () => {
    const m = startModel('sliding_2')
    expect(defaultTarget(m, 'frame_top', 0)).toEqual({ key: 'frame_side', line: 0 })
    expect(defaultTarget(m, 'frame_bottom', 1)).toEqual({ key: 'frame_side', line: 0 })
    expect(defaultTarget(m, 'sash_top', 0)).toEqual({ key: 'hook_stile', line: 0 })
    expect(defaultTarget(m, 'sash_bottom', 1)).toEqual({ key: 'key_stile', line: 0 })
  })
  it('setParams merges params immutably and re-runs ensureEnds', () => {
    const m = startModel('sliding_2')
    const broken = JSON.parse(JSON.stringify(m))
    broken.lines.sash_top[0].ends.length = 1
    const r = setParams(broken, { foo: 3 })
    expect(r.params).toEqual({ door: false, one_fixed: 0, fixed_side: 'left', foo: 3 })
    expect(r.lines.sash_top[0].ends).toEqual(m.lines.sash_top[0].ends)
    expect(broken.params).toEqual({ door: false, one_fixed: 0, fixed_side: 'left' })
    expect(broken.lines.sash_top[0].ends).toHaveLength(1)
    expect(setParams(r, { bar: 1 }).params).toEqual({ door: false, one_fixed: 0, fixed_side: 'left', foo: 3, bar: 1 })
  })
})

// ---------------------------------------------------------------- Task 6: enabled positions, validParams, glassParts
import { glassParts, partnerEnd as partnerEnd6, validateCorners as validateCorners6, startModel as start6, setParams as setParams6, pieceCount as pieceCount6 } from './partModel'

describe('enabled positions (swing_door sill)', () => {
  it('sill yes: the sill position exists with joints to both frame sides', () => {
    const m = start6('swing_door', { sill: 'yes' })
    expect(Object.keys(m.lines)).toContain('sill')
    expect(m.names.sill).toBe('ธรณี (วงกบล่าง)')
    expect(m.lines.frame_side[0].ends.map((p) => p[1].mode)).toEqual(['through', 'through'])
    expect(m.lines.sill[0].ends[0].map((e) => e.mode)).toEqual(['butt', 'butt'])
    expect(partnerEnd6(m, 'sill', 0, 0)).toEqual({ key: 'frame_side', piece: 0, end: 1 })
  })
  it('sill no: no lines, no name, the frame sides have a free bottom end, no corner issues', () => {
    const m = start6('swing_door', { sill: 'no' })
    expect(m.lines.sill).toBeUndefined()
    expect(m.names.sill).toBeUndefined()
    expect(partnerEnd6(m, 'frame_side', 0, 1)).toBeNull()
    expect(m.lines.frame_side[0].ends.map((p) => p[1])).toEqual([{ mode: 'through', to: null, deduction_mm: null }, { mode: 'through', to: null, deduction_mm: null }])
    expect(validateCorners6(m)).toEqual([])
  })
  it('setParams toggles it both ways: removed on no, recreated with the default line on yes', () => {
    const yes = start6('swing_door', { sill: 'yes' })
    const no = setParams6(yes, { sill: 'no' })
    expect(no.lines.sill).toBeUndefined()
    expect(no.names.sill).toBeUndefined()
    expect(yes.lines.sill).toBeDefined()   // input untouched
    const back = setParams6(no, { sill: 'yes' })
    expect(back.lines.sill).toHaveLength(1)
    expect(back.lines.sill[0].profile_family).toBe('ธรณีสวิง')
    expect(back.lines.sill[0].ends).toHaveLength(1)
    expect(back.names.sill).toBe('ธรณี (วงกบล่าง)')
    expect(validateCorners6(back)).toEqual([])
  })
  it('an owner-edited sill line survives an unrelated setParams while enabled', () => {
    let m = start6('swing_door', { sill: 'yes' })
    m.lines.sill[0].profile_family = 'X'
    m = setParams6(m, { open: 'in' })
    expect(m.lines.sill[0].profile_family).toBe('X')
  })
})

describe('validParams', () => {
  it('folding_door with nL + nR = 0 throws layout_params_invalid in startModel and in setParams, before any division', () => {
    expect(() => start6('folding_door', { nL: 0, nR: 0 })).toThrow('layout_params_invalid')
    const ok = start6('folding_door', { nL: 1, nR: 0 })
    expect(() => setParams6(ok, { nL: 0 })).toThrow('layout_params_invalid')
    expect(pieceCount6(ok, 'leaf_top')).toBe(1)
  })
  it('layouts without validParams are unaffected', () => {
    expect(() => start6('sliding_2')).not.toThrow()
  })
})

describe('glassParts', () => {
  it('lists the glass parts with piece index and width rule; frameless_door has one glass part of `leaves` pieces', () => {
    const m = start6('frameless_door', { leaves: 2 })
    expect(glassParts(m)).toEqual([
      { part: 'leaf', idx: 0, widthRule: { auto: 'frame_sides', divisor: 2 }, widthMm: null },
      { part: 'leaf', idx: 1, widthRule: { auto: 'frame_sides', divisor: 2 }, widthMm: null },
    ])
  })
  it('with the opening: (W - 2 b(frame_side)) / leaves', () => {
    const m = start6('frameless_door', { leaves: 2 })
    m.lines.frame_side[0].profile_family = 'S'
    expect(glassParts(m, { widthMm: 1800, buttOf: () => 45 }).map((g) => g.widthMm)).toEqual([855, 855])
    expect(glassParts(setParams6(m, { leaves: 1 }), { widthMm: 900, buttOf: (f) => (f === 'S' ? 40 : 0) }).map((g) => g.widthMm)).toEqual([820])
  })
  it('width is null when the frame side has no butt distance; layouts with no glass give []', () => {
    const m = start6('frameless_door', { leaves: 1 })
    expect(glassParts(m, { widthMm: 900, buttOf: () => null })[0].widthMm).toBeNull()
    expect(glassParts(start6('sliding_2'))).toEqual([])
  })
})

// ---------------------------------------------------------------- R-6a: byEnd partners index per piece
describe('byEnd partners with more than one piece (folding_door 2+2)', () => {
  const m = () => start6('folding_door', { nL: 2, nR: 2 })
  it('partnerEnd maps horizontal piece p end e <-> vertical piece p*2+e', () => {
    expect(partnerEnd6(m(), 'leaf_top', 2, 0)).toEqual({ key: 'leaf_side', piece: 4, end: 0 })
    expect(partnerEnd6(m(), 'leaf_top', 2, 1)).toEqual({ key: 'leaf_side', piece: 5, end: 0 })
    expect(partnerEnd6(m(), 'leaf_side', 5, 1)).toEqual({ key: 'leaf_bottom', piece: 2, end: 1 })
    expect(partnerEnd6(m(), 'leaf_side', 4, 0)).toEqual({ key: 'leaf_top', piece: 2, end: 0 })
  })
  it('full involution over every position, piece and end', () => {
    const model = m()
    let n = 0
    for (const key of Object.keys(model.lines)) {
      for (let piece = 0; piece < pieceCount6(model, key); piece++) {
        for (const end of [0, 1]) {
          const pt = partnerEnd6(model, key, piece, end)
          if (!pt) continue
          expect(partnerEnd6(model, pt.key, pt.piece, pt.end)).toEqual({ key, piece, end })
          n++
        }
      }
    }
    expect(n).toBeGreaterThan(0)
  })
  it('setEndMode on leaf_top piece 2 end 0 flips leaf_side piece 4 and leaves piece 0 alone; corners valid', () => {
    const next = setEndMode(m(), 'leaf_top', 0, 2, 0, 'through')
    expect(next.lines.leaf_top[0].ends[2][0].mode).toBe('through')
    expect(next.lines.leaf_side[0].ends[4][0]).toMatchObject({ mode: 'butt', to: { key: 'leaf_top', line: 0 } })
    expect(next.lines.leaf_side[0].ends[0][0].mode).toBe('through')
    expect(validateCorners6(next)).toEqual([])
  })
})

describe('expression part counts are not editable (fix round 1, spec §6)', () => {
  it('setPartCount / commitPartCount return the same model for a part whose layout count is an expression', () => {
    const m = startModel('awning_grid', { rows: 2, cols: 2 })
    expect(setPartCount(m, 'sash', 5)).toBe(m)
    expect(commitPartCount(m, 'sash', 5)).toBe(m)
    expect(m.parts.find(p => p.key === 'sash').count).toBe('rows*cols')
    const n = startModel('sliding_n')
    expect(setPartCount(n, 'sash_mid', 4)).toBe(n)   // R-F1: the middle sashes' count is 'n-2'
    // a literal-count part is still editable
    expect(setPartCount(startModel('sliding_2'), 'sash', 3).parts.find(p => p.key === 'sash').count).toBe(3)
  })
})

// ---------------------------------------------------------------- Task 9: sliding_2 options (door / one_fixed / sill guard)
import { presentPositions as present9, startModel as start9, setParams as setParams9, pieceCount as pieceCount9 } from './partModel'

describe('sliding_2 options (Task 9)', () => {
  it('default params: no sill_guard, same positions as before', () => {
    const m = start9('sliding_2')
    expect(m.lines.sill_guard).toBeUndefined()
    expect(present9(m)).toEqual(['frame_top', 'frame_bottom', 'frame_side', 'sash_top', 'sash_bottom', 'key_stile', 'hook_stile'])
  })
  it('one_fixed 1: sill_guard (ธรณีกันบานเลื่อน) exists with one free piece on the frame part', () => {
    const m = start9('sliding_2', { one_fixed: 1 })
    expect(m.names.sill_guard).toBe('ธรณีกันบานเลื่อน')
    expect(pieceCount9(m, 'sill_guard')).toBe(1)
    expect(m.lines.sill_guard[0]).toMatchObject({ profile_family: 'ธรณีกันบานเลื่อน', length_rule_type: 'width_minus', deduction_auto: true, length_factor: 0.5, thickness_role: 'sash' })
    expect(m.lines.sill_guard[0].ends).toEqual([[{ mode: 'through', to: null, deduction_mm: null }, { mode: 'through', to: null, deduction_mm: null }]])
  })
  it('setParams toggles sill_guard on and off; the rest of the model is untouched', () => {
    const m = start9('sliding_2')
    const on = setParams9(m, { one_fixed: 1 })
    expect(on.lines.sill_guard).toHaveLength(1)
    const off = setParams9(on, { one_fixed: 0 })
    expect(off.lines).toEqual(m.lines)
    expect(off.names).toEqual(m.names)
  })
})
