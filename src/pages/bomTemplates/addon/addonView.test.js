import { describe, it, expect } from 'vitest'
import { zoomPieces, overviewAddonRects, setRowsFor, editSetRow, allPieceRows, pieceTableRows, addonEffects, addonSummary } from './addonView.js'
import { newAddon, defaultAddonPieces, setKey, pieceQty, ADDON_POSITIONS, ADDON_MODES, PIECE_KEYS } from '../../../lib/addonModel.js'
import { startModel } from '../../../lib/partModel.js'

const EPS = 1e-6
const overlap = (a, b) => a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS
const addon = (mode, position, rows = 1, cols = 3) => ({ ...newAddon({ mode, position, mainWidthMm: 1800, mainHeightMm: 1200 }), rows, cols })
const withQty = (rows, q) => rows.map(r => ({ ...r, qty_rule: 'fixed', qty_fixed: q[r.piece_key] ?? r.qty_fixed }))
const qty = (r, a) => Number(pieceQty(r, a)) || 0

function check(a, rows, scale = 0.25) {
  const ps = zoomPieces({ addon: a, rows, scale })
  const W = (a.position === 'top' || a.position === 'bottom' ? a.len_mm : a.thick_mm) * scale
  const H = (a.position === 'top' || a.position === 'bottom' ? a.thick_mm : a.len_mm) * scale
  for (const p of ps) {
    expect(p.w).toBeGreaterThan(0)
    expect(p.h).toBeGreaterThan(0)
    expect(p.x).toBeGreaterThanOrEqual(-EPS)
    expect(p.y).toBeGreaterThanOrEqual(-EPS)
    expect(p.x + p.w).toBeLessThanOrEqual(W + EPS)
    expect(p.y + p.h).toBeLessThanOrEqual(H + EPS)
  }
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    if (overlap(ps[i], ps[j])) throw new Error(`overlap ${JSON.stringify(ps[i])} ${JSON.stringify(ps[j])} (${a.mode} ${a.position} ${a.rows}x${a.cols})`)
  }
  const keys = new Set(ps.map(p => p.key))
  for (const r of rows) {
    if (qty(r, a) > 0) expect(keys.has(r.piece_key), `${r.piece_key} missing (${a.mode} ${a.position})`).toBe(true)
    else expect(keys.has(r.piece_key), `${r.piece_key} drawn with qty 0`).toBe(false)
  }
  return ps
}

describe('zoomPieces', () => {
  for (const mode of ADDON_MODES) for (const position of ADDON_POSITIONS) {
    it(`${mode} ${position}: inside, no overlap, every key with qty > 0 (rows 1-3 × cols 1-4)`, () => {
      for (let rows = 1; rows <= 3; rows++) for (let cols = 1; cols <= 4; cols++) {
        const a = addon(mode, position, rows, cols)
        for (const layoutKind of ['sliding_2', 'fixed_grid']) check(a, defaultAddonPieces({ mode, kind: 'fixed', position, layoutKind }))
        // every piece of the mode present at once
        const all = withQty(defaultAddonPieces({ mode, kind: 'fixed', position }), Object.fromEntries(PIECE_KEYS[mode].map(k => [k, 2])))
        check(a, all)
      }
    })
  }
  it('merge with ext qty 2 shows two stubs along the main', () => {
    const a = addon('merge', 'top')
    const ps = check(a, defaultAddonPieces({ mode: 'merge', kind: 'fixed', position: 'top' }))
    const ext = ps.filter(p => p.key === 'ext')
    expect(ext).toHaveLength(2)
    expect(ext.map(p => p.qtyIndex).sort()).toEqual([0, 1])
    expect(ext.every(p => p.h > p.w)).toBe(true)   // stubs run across the strip, beside the main's frame sides
  })
  it('attach has four frame pieces', () => {
    const ps = check(addon('attach', 'right'), defaultAddonPieces({ mode: 'attach', kind: 'fixed', position: 'right' }))
    expect(ps.filter(p => p.key.startsWith('frame_'))).toHaveLength(4)
  })
  it('grid follows the qty: cols − 1 mullions, rows − 1 rails', () => {
    const ps = check(addon('attach', 'top', 3, 4), defaultAddonPieces({ mode: 'attach', kind: 'fixed', position: null }))
    expect(new Set(ps.filter(p => p.key === 'mullion').map(p => p.qtyIndex)).size).toBe(3)
    expect(new Set(ps.filter(p => p.key === 'rail').map(p => p.qtyIndex)).size).toBe(2)
  })
  it('empty / bad input gives no pieces and never throws', () => {
    expect(zoomPieces({ addon: null, rows: [], scale: 1 })).toEqual([])
    expect(zoomPieces({ addon: { ...addon('merge', 'top'), len_mm: 0 }, rows: defaultAddonPieces({ mode: 'merge', kind: 'fixed', position: 'top' }), scale: 1 })).toEqual([])
  })
})

describe('overviewAddonRects', () => {
  const box = { w: 520, h: 360, frameX: 58, frameY: 18, frameW: 420, frameH: 280, scale: 420 / 1800 }
  it('none: viewBox is the box', () => {
    expect(overviewAddonRects({ box, addons: [], widthMm: 1800, heightMm: 1200 })).toEqual({ rects: [], viewBox: { x: 0, y: 0, w: 520, h: 360 } })
  })
  it('a top add-on sits above the frame, viewBox grows to hold it', () => {
    const r = overviewAddonRects({ box, addons: [addon('merge', 'top')], widthMm: 1800, heightMm: 1200 })
    expect(r.rects[0].y + r.rects[0].h).toBeCloseTo(18)
    expect(r.rects[0].w).toBeCloseTo(420)
    expect(r.viewBox.y).toBeLessThan(r.rects[0].y)
    expect(r.viewBox.h).toBeGreaterThan(360)
  })
  it('the inside view mirrors left / right', () => {
    const out = overviewAddonRects({ box, addons: [addon('attach', 'left')], widthMm: 1800, heightMm: 1200 }).rects[0]
    const inn = overviewAddonRects({ box, addons: [addon('attach', 'left')], widthMm: 1800, heightMm: 1200, view: 'in' }).rects[0]
    expect(out.x + out.w).toBeCloseTo(58)
    expect(inn.x).toBeCloseTo(58 + 420)
  })
})

describe('piece sets', () => {
  const a = addon('merge', 'top')
  const key = setKey('merge', 'fixed', 'top')
  it('a set never opened shows the defaults, flagged', () => {
    const s = setRowsFor({}, a, 'sliding_2')
    expect(s.isDefault).toBe(true)
    expect(s.rows).toEqual(defaultAddonPieces({ mode: 'merge', kind: 'fixed', position: 'top', layoutKind: 'sliding_2', buttMm: 0 }))
  })
  it('the first edit copies the defaults and marks the set dirty; inputs are untouched', () => {
    const sets = {}
    const next = editSetRow(sets, a, 'sliding_2', 0, { profile_family: 'FS' })
    expect(sets).toEqual({})
    expect(next[key].dirty).toBe(true)
    expect(next[key].rows[0].profile_family).toBe('FS')
    expect(next[key].rows).toHaveLength(8)
    const again = editSetRow(next, a, 'sliding_2', 1, { deduction_mm: 5 })
    expect(again[key].rows[0].profile_family).toBe('FS')
    expect(again[key].rows[1].deduction_mm).toBe(5)
    expect(next[key].rows[1].deduction_mm).toBe(0)
  })
  it('allPieceRows flattens only the sets with rows', () => {
    const sets = { [key]: { rows: [{ piece_key: 'ext' }], dirty: true }, x: { rows: [], dirty: false } }
    expect(allPieceRows(sets)).toEqual([{ piece_key: 'ext' }])
  })
})

describe('piece table and effects (numbers from expandAddons)', () => {
  const model = startModel('sliding_2')
  const main = { widthMm: 1800, heightMm: 1200 }
  const buttOf = f => ({ FS: 38.1, DV: 20 }[f] ?? null)
  it('unresolved text when the family is missing', () => {
    const a = addon('attach', 'top')
    const t = pieceTableRows({ addon: a, rows: defaultAddonPieces({ mode: 'attach', kind: 'fixed', position: null }), main, buttOf, layoutKind: 'sliding_2', model })
    const top = t.find(r => r.key === 'frame_top')
    expect(top.length).toBe(null)
    expect(top.unresolved).toBe('ยังไม่ได้เลือกอลูมิเนียม จึงยังคิดความยาวไม่ได้')
    expect(t.find(r => r.key === 'mullion').qty).toBe(2)
  })
  it('a family gives length × qty from the lib', () => {
    const a = addon('attach', 'top')
    const rows = defaultAddonPieces({ mode: 'attach', kind: 'fixed', position: null }).map(r => ({ ...r, profile_family: 'FS', deduction_mm: r.piece_key === 'frame_top' ? 76.2 : r.deduction_mm }))
    const t = pieceTableRows({ addon: a, rows, main, buttOf, layoutKind: 'sliding_2', model })
    expect(t.find(r => r.key === 'frame_top')).toMatchObject({ length: 1723.8, qty: 1, unresolved: null })
    expect(t.find(r => r.key === 'frame_side')).toMatchObject({ length: 400, qty: 2 })
  })
  it('ext / main_facing show the effect text, not a length', () => {
    const a = addon('merge', 'top')
    const rows = defaultAddonPieces({ mode: 'merge', kind: 'fixed', position: 'top' }).map(r => (r.piece_key === 'ext' ? { ...r, profile_family: 'FS' } : r))
    const t = pieceTableRows({ addon: a, rows, main, buttOf, layoutKind: 'sliding_2', model })
    expect(t.find(r => r.key === 'ext').effect).toContain('1,600.0')
    expect(t.find(r => r.key === 'ext').effect).toContain('FS')
    expect(t.find(r => r.key === 'main_facing').effect).toContain('ตบเรียบ (รองคิ้วเท)')
  })
  it('effects list overrides by position name, notes and issues in Thai', () => {
    const a = addon('merge', 'top')
    const key = setKey('merge', 'fixed', 'top')
    const rows = defaultAddonPieces({ mode: 'merge', kind: 'fixed', position: 'top' }).map(r => (r.piece_key === 'ext' ? { ...r, profile_family: 'FS' } : r))
    const e = addonEffects({ addons: [a], addonSets: { [key]: { rows, dirty: true } }, main, buttOf, layoutKind: 'sliding_2', model })
    expect(e.overrides[0]).toMatchObject({ name: 'เฟรมข้าง', lengthMm: 1600, family: 'FS' })
    expect(e.notes[0].text).toBe('ตบเรียบ (รองคิ้วเท)')
    expect(e.issues.some(i => i.text === 'ยังไม่ได้เลือกอลูมิเนียม จึงยังคิดความยาวไม่ได้' && i.name.includes('ช่องแสง 1'))).toBe(true)
  })
  it('addonSummary is one Thai line', () => {
    expect(addonSummary(addon('merge', 'top'))).toBe('ร่วมวงกบ · ติดตาย · บน · 1,800 × 400 มม. · 1 ชั้น × 3 ช่อง')
  })
})
