import { describe, it, expect } from 'vitest'
import {
  newAddon, addonDims, layoutAddons, refValue, extRef, setKey, defaultAddonPieces, pieceQty,
  validateAddons, validatePieceRows, PIECE_KEYS, REF_INPUTS, QTY_RULES, ADDON_MODES, ADDON_KINDS, ADDON_POSITIONS,
} from './addonModel'

const MAIN = { widthMm: 1800, heightMm: 1200 }
const mk = (position, extra = {}) => ({ ...newAddon({ position, mainWidthMm: 1800, mainHeightMm: 1200 }), ...extra })

describe('newAddon / addonDims', () => {
  it('top takes the main width as its length', () => {
    expect(newAddon({ position: 'top', mainWidthMm: 1800, mainHeightMm: 1200 })).toEqual({
      mode: 'merge', kind: 'fixed', position: 'top', len_mm: 1800, thick_mm: 400, offset_mm: 0, rows: 1, cols: 3,
    })
  })
  it('left takes the main height', () => {
    expect(mk('left').len_mm).toBe(1200)
  })
  it('addonDims swaps for left/right', () => {
    expect(addonDims(mk('top'))).toEqual({ w: 1800, h: 400 })
    expect(addonDims(mk('bottom'))).toEqual({ w: 1800, h: 400 })
    expect(addonDims(mk('left'))).toEqual({ w: 400, h: 1200 })
    expect(addonDims(mk('right'))).toEqual({ w: 400, h: 1200 })
  })
})

describe('layoutAddons', () => {
  const lay = (addons) => layoutAddons({ ...MAIN, addons })
  it('empty list: envelope is the main', () => {
    const r = lay([])
    expect(r.rects).toEqual([{ main: true, x: 0, y: 0, w: 1800, h: 1200 }])
    expect(r.envelope).toEqual({ x0: 0, y0: 0, w: 1800, h: 1200 })
  })
  it('top add-on sits above the main', () => {
    const r = lay([mk('top')])
    expect(r.rects[1]).toMatchObject({ i: 0, x: 0, y: -400, w: 1800, h: 400 })
    expect(r.envelope).toEqual({ x0: 0, y0: -400, w: 1800, h: 1600 })
  })
  it('second top add-on stacks outward', () => {
    const r = lay([mk('top'), mk('top', { thick_mm: 300 })])
    expect(r.rects[2]).toMatchObject({ i: 1, y: -700, h: 300 })
    expect(r.envelope.h).toBe(1900)
    expect(r.envelope.y0).toBe(-700)
  })
  it('bottom add-on sits below', () => {
    const r = lay([mk('bottom')])
    expect(r.rects[1].y).toBe(1200)
    expect(r.envelope).toEqual({ x0: 0, y0: 0, w: 1800, h: 1600 })
  })
  it('left and right add-ons', () => {
    const l = lay([mk('left')])
    expect(l.rects[1]).toMatchObject({ x: -400, y: 0, w: 400, h: 1200 })
    expect(l.envelope).toEqual({ x0: -400, y0: 0, w: 2200, h: 1200 })
    const r = lay([mk('right')])
    expect(r.rects[1].x).toBe(1800)
    expect(r.envelope.w).toBe(2200)
  })
})

describe('refValue / extRef / setKey', () => {
  it('top add-on refs', () => {
    const a = mk('top')
    const v = (r) => refValue(a, r, MAIN)
    expect([v('w'), v('h'), v('len'), v('mw'), v('mh'), v('tw'), v('th')]).toEqual([1800, 400, 1800, 1800, 1200, 1800, 1600])
  })
  it('right add-on widens tw', () => {
    const a = mk('right', { thick_mm: 500 })
    expect(refValue(a, 'tw', MAIN)).toBe(2300)
    expect(refValue(a, 'th', MAIN)).toBe(1200)
  })
  it('extRef', () => {
    expect(extRef('top')).toBe('th')
    expect(extRef('bottom')).toBe('th')
    expect(extRef('left')).toBe('tw')
    expect(extRef('right')).toBe('tw')
  })
  it('setKey', () => {
    expect(setKey('attach', 'fixed', 'top')).toBe('attach|fixed|')
    expect(setKey('merge', 'awning', 'left')).toBe('merge|awning|left')
  })
})

describe('defaultAddonPieces', () => {
  const by = (rows, k) => rows.find((r) => r.piece_key === k)
  it('attach set', () => {
    const rows = defaultAddonPieces({ mode: 'attach', kind: 'fixed', position: 'top', buttMm: 38.1 })
    expect(rows.map((r) => r.piece_key)).toEqual(['frame_top', 'frame_bottom', 'frame_side', 'mullion', 'rail'])
    expect(by(rows, 'frame_top')).toMatchObject({ ref_input: 'w', deduction_mm: 76.2, qty_rule: 'fixed', qty_fixed: 1 })
    expect(by(rows, 'frame_side')).toMatchObject({ ref_input: 'h', deduction_mm: 0, qty_fixed: 2 })
    expect(by(rows, 'mullion')).toMatchObject({ ref_input: 'h', qty_rule: 'cols-1' })
    expect(by(rows, 'rail')).toMatchObject({ ref_input: 'w', qty_rule: 'rows-1' })
    expect(rows.every((r) => r.position === null && r.mode === 'attach' && r.kind === 'fixed')).toBe(true)
    expect(rows.map((r) => r.sort_order)).toEqual([0, 1, 2, 3, 4])
    expect(rows[0]).toMatchObject({ profile_family: null, length_factor: 1, thickness_role: null, note: null })
  })
  it('merge sliding_2 top', () => {
    const rows = defaultAddonPieces({ mode: 'merge', kind: 'fixed', position: 'top', buttMm: 38.1 })
    expect(rows.map((r) => r.piece_key)).toEqual(PIECE_KEYS.merge)
    expect(by(rows, 'ext')).toMatchObject({ ref_input: 'th', qty_fixed: 2, profile_family: null })
    expect(by(rows, 'divider').qty_fixed).toBe(0)
    expect(by(rows, 'main_facing')).toMatchObject({ note: 'ตบเรียบ (รองคิ้วเท)', qty_fixed: 0, ref_input: 'len' })
    expect(by(rows, 'ao_bead')).toMatchObject({ qty_fixed: 1, deduction_mm: 76.2 })
    expect(by(rows, 'ao_frame_side')).toMatchObject({ ref_input: 'h', qty_fixed: 2 })
    expect(by(rows, 'rail').ref_input).toBe('len')
    expect(by(rows, 'mullion').ref_input).toBe('h')
    expect(rows.every((r) => r.position === 'top')).toBe(true)
  })
  it('merge sliding_2 bottom', () => {
    const rows = defaultAddonPieces({ mode: 'merge', kind: 'fixed', position: 'bottom', buttMm: 38.1 })
    expect(by(rows, 'ao_bead').qty_fixed).toBe(0)
    expect(by(rows, 'main_facing').note).toBe('ตบร่อง')
  })
  it('merge sliding_2 left', () => {
    const rows = defaultAddonPieces({ mode: 'merge', kind: 'fixed', position: 'left', buttMm: 38.1 })
    expect(by(rows, 'ext').ref_input).toBe('tw')
    expect(by(rows, 'divider').qty_fixed).toBe(1)
    expect(by(rows, 'rail').ref_input).toBe('w')
    for (const k of ['ao_frame_side', 'ao_bead', 'ao_frame_far', 'main_facing']) expect(by(rows, k).qty_fixed).toBe(0)
  })
  it('other layoutKind uses the spec defaults', () => {
    const rows = defaultAddonPieces({ mode: 'merge', kind: 'fixed', position: 'top', layoutKind: 'fixed_grid', buttMm: 38.1 })
    expect(by(rows, 'divider').qty_fixed).toBe(1)
    expect(by(rows, 'ext').ref_input).toBe('th')
    expect(by(rows, 'ao_bead').qty_fixed).toBe(0)
  })
  it('every default set validates', () => {
    for (const mode of ADDON_MODES) for (const kind of ADDON_KINDS) for (const position of ADDON_POSITIONS) {
      expect(validatePieceRows(defaultAddonPieces({ mode, kind, position, buttMm: 38.1 }))).toBeNull()
    }
    expect(QTY_RULES.length).toBe(6)
  })
})

describe('pieceQty', () => {
  it('rules', () => {
    expect(pieceQty({ qty_rule: 'fixed', qty_fixed: 2 }, { rows: 1, cols: 3 })).toBe(2)
    expect(pieceQty({ qty_rule: 'cols-1' }, { rows: 1, cols: 1 })).toBe(0)
    expect(pieceQty({ qty_rule: 'cols-1' }, { rows: 1, cols: 3 })).toBe(2)
    expect(pieceQty({ qty_rule: 'rows-1' }, { rows: 3, cols: 1 })).toBe(2)
    expect(pieceQty({ qty_rule: 'cols' }, { rows: 1, cols: 4 })).toBe(4)
    expect(pieceQty({ qty_rule: 'rows' }, { rows: 2, cols: 4 })).toBe(2)
    expect(pieceQty({ qty_rule: 'rows*cols' }, { rows: 2, cols: 3 })).toBe(6)
  })
})

describe('validateAddons', () => {
  const bad = (addons) => {
    const r = validateAddons(addons, MAIN)
    expect(typeof r).toBe('string')
    expect(r.length).toBeGreaterThan(0)
  }
  it('accepts defaults and empty', () => {
    expect(validateAddons([], MAIN)).toBeNull()
    expect(validateAddons([mk('top'), mk('left')], MAIN)).toBeNull()
  })
  it('rejects bad values', () => {
    bad(Array.from({ length: 7 }, () => mk('top')))
    bad([mk('top', { rows: 0 })])
    bad([mk('top', { cols: 13 })])
    bad([mk('top', { rows: 1.5 })])
    bad([mk('top', { len_mm: 0 })])
    bad([mk('top', { len_mm: NaN })])
    bad([mk('top', { len_mm: '400' })])
    bad([mk('top', { len_mm: 20001 })])
    bad([mk('top', { thick_mm: 0 })])
    bad([mk('top', { offset_mm: -1 })])
    bad([mk('top', { position: 'middle' })])
    bad([mk('top', { mode: 'glue' })])
    bad([mk('top', { kind: 'sliding' })])
  })
  it('does not mutate frozen input', () => {
    const list = Object.freeze([Object.freeze(mk('top'))])
    expect(() => validateAddons(list, MAIN)).not.toThrow()
  })
})

describe('validatePieceRows', () => {
  const good = () => defaultAddonPieces({ mode: 'attach', kind: 'fixed', position: 'top', buttMm: 38.1 })
  const bad = (rows) => {
    const r = validatePieceRows(rows)
    expect(typeof r).toBe('string')
    expect(r.length).toBeGreaterThan(0)
  }
  it('accepts good defaults', () => {
    expect(validatePieceRows(good())).toBeNull()
  })
  it('rejects bad rows', () => {
    bad(good().map((r, i) => (i === 0 ? { ...r, ref_input: 'tw' } : r)))
    const merge = defaultAddonPieces({ mode: 'merge', kind: 'fixed', position: 'top' })
    bad(merge.map((r, i) => (i === 0 ? { ...r, piece_key: 'frame_top' } : r)))
    bad(good().map((r, i) => (i === 0 ? { ...r, note: 'x'.repeat(121) } : r)))
    bad(good().map((r, i) => (i === 0 ? { ...r, length_factor: 0 } : r)))
    bad(good().map((r, i) => (i === 0 ? { ...r, deduction_mm: -1 } : r)))
    bad(good().map((r, i) => (i === 0 ? { ...r, qty_fixed: -1 } : r)))
    bad(good().map((r, i) => (i === 0 ? { ...r, qty_fixed: 1001 } : r)))
    expect(REF_INPUTS.attach).toEqual(['w', 'h'])
  })
})
