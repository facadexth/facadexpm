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
