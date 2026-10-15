import { describe, it, expect } from 'vitest'
import {
  newAddon, addonDims, layoutAddons, refValue, extRef, setKey, defaultAddonPieces, pieceQty,
  validateAddons, validatePieceRows, sideFamilyOf, fillDefaultDeductions, isTwoButtPiece, deductionStillZero, ALIGN_LABEL, alignLabel, PIECE_KEYS, REF_INPUTS, QTY_RULES, ADDON_MODES, ADDON_KINDS, ADDON_POSITIONS,
} from './addonModel'

const MAIN = { widthMm: 1800, heightMm: 1200 }
const mk = (position, extra = {}) => ({ ...newAddon({ position, mainWidthMm: 1800, mainHeightMm: 1200 }), ...extra })

describe('newAddon / addonDims', () => {
  it('top takes the main width as its length', () => {
    expect(newAddon({ position: 'top', mainWidthMm: 1800, mainHeightMm: 1200 })).toEqual({
      mode: 'merge', kind: 'fixed', position: 'top', len_mm: 1800, thick_mm: 400, offset_mm: 0, align: 'start', rows: 1, cols: 3, fake_rows: 1, fake_cols: 1,
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

describe('layoutAddons alignment (AO-13)', () => {
  const lay = (addons) => layoutAddons({ ...MAIN, addons })
  const right1200 = (align) => mk('right', { len_mm: 1200, align })
  it("right add-on flush bottom with a 400 top add-on ⇒ y = 0, gap 400 above", () => {
    const r = lay([mk('top'), right1200('end')])
    expect(r.rects[2]).toMatchObject({ x: 1800, y: 0, w: 400, h: 1200 })
  })
  it("right add-on flush top ⇒ y = -400", () => {
    expect(lay([mk('top'), right1200('start')]).rects[2].y).toBe(-400)
  })
  it("top add-on len 1000 end with a right add-on thick 500 ⇒ x = 1300", () => {
    const r = lay([mk('top', { len_mm: 1000, align: 'end' }), mk('right', { thick_mm: 500 })])
    expect(r.rects[1].x).toBe(1800 + 500 - 1000)
  })
  it("top add-on start with a left add-on 300 ⇒ x = -300", () => {
    const r = lay([mk('top', { len_mm: 1000, align: 'start' }), mk('left', { thick_mm: 300 })])
    expect(r.rects[1].x).toBe(-300)
  })
  it('missing align reads as start; offset shifts from the flush end', () => {
    const a = { ...mk('top', { len_mm: 1000, offset_mm: 50 }) }
    delete a.align
    expect(lay([a]).rects[1].x).toBe(50)
    expect(lay([mk('top', { len_mm: 1000, align: 'end', offset_mm: 50 })]).rects[1].x).toBe(1800 - 1000 - 50)
  })
  it('add-on list order does not change any rect', () => {
    const list = [mk('top'), right1200('end'), mk('left', { thick_mm: 300, len_mm: 800, align: 'end' }), mk('bottom', { len_mm: 900, align: 'end', thick_mm: 250 }), mk('top', { thick_mm: 200, len_mm: 700, align: 'end' })]
    const base = lay(list)
    const byAddon = (r) => Object.fromEntries(r.rects.filter((x) => !x.main).map((x) => [x.i, x]))
    const perms = [[4, 3, 2, 1, 0], [2, 0, 4, 1, 3], [1, 4, 0, 3, 2]]
    for (const p of perms) {
      const shuffled = p.map((k) => list[k])
      const r = lay(shuffled)
      // same side keeps list order, so only compare when relative order of same-side add-ons is kept: the two top add-ons are 0 and 4
      const rel = p.indexOf(0) < p.indexOf(4)
      if (!rel) continue
      for (const [newI, orig] of p.entries()) {
        const { i, ...a } = byAddon(r)[newI]
        const { i: j, ...b } = byAddon(base)[orig]
        expect(a).toEqual(b)
      }
      expect(r.envelope).toEqual(base.envelope)
    }
  })
  it('alignLabel by orientation', () => {
    expect(alignLabel(mk('left'))).toEqual({ start: 'เสมอบน', end: 'เสมอล่าง' })
    expect(alignLabel(mk('top'))).toEqual({ start: 'เสมอซ้าย', end: 'เสมอขวา' })
    expect(ALIGN_LABEL.lr.end).toBe('เสมอล่าง')
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
    bad([mk('top', { align: 'middle' })])
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

describe('I-1: side family + default 2·butt deductions', () => {
  const att = () => defaultAddonPieces({ mode: 'attach', kind: 'fixed', position: null })
  const mrg = () => defaultAddonPieces({ mode: 'merge', kind: 'fixed', position: 'top', layoutKind: 'sliding_2' })
  it('isTwoButtPiece: attach frame_top/bottom/mullion/rail; merge divider/ao_bead/ao_frame_far/mullion/rail', () => {
    expect(att().filter(isTwoButtPiece).map(r => r.piece_key)).toEqual(['frame_top', 'frame_bottom', 'mullion', 'rail'])
    expect(mrg().filter(isTwoButtPiece).map(r => r.piece_key)).toEqual(['divider', 'ao_bead', 'ao_frame_far', 'mullion', 'rail'])
  })
  it('sideFamilyOf: attach frame_side; merge ao_frame_side, else ext; null when none', () => {
    expect(sideFamilyOf(att().map(r => (r.piece_key === 'frame_side' ? { ...r, profile_family: 'FS' } : r)))).toBe('FS')
    expect(sideFamilyOf(mrg().map(r => (r.piece_key === 'ext' ? { ...r, profile_family: 'EXT' } : r)))).toBe('EXT')
    expect(sideFamilyOf(mrg().map(r => ({ ...r, profile_family: r.piece_key === 'ext' ? 'EXT' : r.piece_key === 'ao_frame_side' ? 'AOS' : null })))).toBe('AOS')
    expect(sideFamilyOf(att())).toBeNull()
    expect(sideFamilyOf([])).toBeNull()
  })
  it('fillDefaultDeductions: 0 rows of the 2·butt pieces get 2·butt (attach set)', () => {
    const rows = att().map(r => (r.piece_key === 'mullion' ? { ...r, deduction_mm: 12 } : r))
    const out = fillDefaultDeductions(rows, 38.1)
    expect(Object.fromEntries(out.map(r => [r.piece_key, r.deduction_mm]))).toEqual({ frame_top: 76.2, frame_bottom: 76.2, frame_side: 0, mullion: 12, rail: 76.2 })
    expect(rows.find(r => r.piece_key === 'frame_top').deduction_mm).toBe(0)   // input untouched
  })
  it('fillDefaultDeductions: merge set, non-2·butt pieces stay 0; butt 0 / null changes nothing', () => {
    const out = fillDefaultDeductions(mrg(), 25)
    expect(Object.fromEntries(out.map(r => [r.piece_key, r.deduction_mm]))).toEqual({ ext: 0, divider: 50, main_facing: 0, ao_frame_side: 0, ao_bead: 50, ao_frame_far: 50, mullion: 50, rail: 50 })
    expect(fillDefaultDeductions(mrg(), 0)).toEqual(mrg())
    expect(fillDefaultDeductions(mrg(), null)).toEqual(mrg())
  })
  it('deductionStillZero: a 2·butt piece at 0 while the side butt > 0', () => {
    const top = att().find(r => r.piece_key === 'frame_top')
    const side = att().find(r => r.piece_key === 'frame_side')
    expect(deductionStillZero(top, 38.1)).toBe(true)
    expect(deductionStillZero({ ...top, deduction_mm: 76.2 }, 38.1)).toBe(false)
    expect(deductionStillZero(top, 0)).toBe(false)
    expect(deductionStillZero(side, 38.1)).toBe(false)
  })
})

describe('fake dividers (ซอยหลอก, owner 2026-10-15)', () => {
  const base = newAddon({ mainWidthMm: 1800, mainHeightMm: 1200 })
  it('newAddon starts without fake dividers (1 x 1)', () => {
    expect(base.fake_rows).toBe(1)
    expect(base.fake_cols).toBe(1)
  })
  it('validateAddons accepts 1..12, absent, and refuses 0 / 13 / fractions', () => {
    expect(validateAddons([base])).toBeNull()
    expect(validateAddons([{ ...base, fake_rows: undefined, fake_cols: undefined }])).toBeNull()
    expect(validateAddons([{ ...base, fake_rows: 12, fake_cols: 12 }])).toBeNull()
    expect(validateAddons([{ ...base, fake_rows: 0 }])).toMatch(/ซอยหลอกแนวนอน/)
    expect(validateAddons([{ ...base, fake_cols: 13 }])).toMatch(/ซอยหลอกแนวตั้ง/)
    expect(validateAddons([{ ...base, fake_cols: 2.5 }])).toMatch(/ซอยหลอกแนวตั้ง/)
  })
})
