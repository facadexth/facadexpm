// src/lib/stickers.test.js
import { describe, it, expect } from 'vitest'
import { stickerModel, notchText, roleTh, endLabel, issuedOffcutCodes, isOffcutKept, shortDate, stickerPages, PAPERS, NEW_OFFCUT_CODE, NO_DIE_TEXT, finishFontMm } from './stickers.js'
import { glyphPoints, qrDataUrl } from './stickerRender.js'

const pc = (len, o = {}) => ({ length_m: len, opening_no: 'W-01', item_id: 'i1', item_name: '', role_name: 'กรอบบานตั้ง', end_a: 'square', end_b: 'square', notch: null, kerf_style: 'square', ...o })
const groupA = () => ({
  key: 'A|F', profile_id: 'A', finish_id: 'F', die_no: 'F7980', name: 'กรอบบาน', finish_name: 'อบขาว', length_m: 6.4,
  offcutBars: [{ length_m: 1.2, left_m: 0.19, pieces: [pc(1, { opening_no: 'W-02', item_id: 'i2' })], offcut: { id: 'o1', code: 'OC-0003', length_m: 1.2 } }],
  bars: [
    { length_m: 6.4, left_m: 0.394, pieces: [pc(3, { end_a: 'miter45', end_b: 'miter45' }), pc(3)] },
    { length_m: 6.4, left_m: 0.02, pieces: [pc(3.2, { end_a: 'notch', notch: { joint_name: 'บากรับกรอบนอน', width_mm: 20, depth_mm: 8 } }), pc(3.17)] },
  ],
  unplaced: [],
  newOffcuts: [
    { key: 'A|F#OC-0003', bar_ref: 'OC-0003', length_m: 0.19, end_a: 'square', keep: false },
    { key: 'A|F#1', bar_ref: '1', length_m: 0.394, end_a: 'square', keep: false },
  ],
})
const groupB = () => ({
  key: 'B|F', profile_id: 'B', finish_id: 'F', die_no: null, name: 'ซอย', finish_name: 'อบขาว', length_m: 6.4, offcutBars: [],
  bars: [{ length_m: 6.4, left_m: 2.4, pieces: [pc(4, { role_name: 'Horizontal rail', end_b: 'miter45' })] }], unplaced: [],
  newOffcuts: [{ key: 'B|F#1', bar_ref: '1', length_m: 2.4, end_a: 'miter45', keep: true }],
})
const plan = () => ({ signature: 'S', groups: [groupA(), groupB()] })
const args = o => ({ plan: plan(), projectName: 'PARLLEL TROPICAL', projectId: 'pj1', items: {}, codes: null, date: new Date(2026, 9, 27), ...o })

describe('stickerModel', () => {
  it('lists stickers in cutting order: stock-offcut bars first, each bar\'s pieces then its remainder', () => {
    const s = stickerModel(args())
    expect(s.map(x => `${x.kind}:${x.footR}`)).toEqual([
      'piece:OC-0003 · 1/6', 'offcut:OC-0003 · 27/10/69',
      'piece:เส้น 1 · 2/6', 'piece:เส้น 1 · 3/6', 'offcut:เส้น 1 · 27/10/69',
      'piece:เส้น 2 · 4/6', 'piece:เส้น 2 · 5/6',
      'piece:เส้น 1 · 6/6', 'offcut:เส้น 1 · 27/10/69',
    ])
  })
  it('a piece sticker carries the item, part, length, die no., finish, ends, project and the item QR', () => {
    const p = stickerModel(args())[2]
    expect(p).toMatchObject({ kind: 'piece', title: 'W-01 · กรอบบานตั้ง', length_mm: 3000, die: 'F7980', finish: 'อบขาว', ends: ['miter45', 'miter45'], notchText: null,
      footL: 'PARLLEL TROPICAL', qr: '#tab=estimation&project=pj1&item=i1', groupKey: 'A|F' })
    expect(p.sub).toBeUndefined()
  })
  it('the QR falls back to items[opening_no] when the piece has no item id', () => {
    const pl = plan(); pl.groups[0].offcutBars[0].pieces[0].item_id = null
    expect(stickerModel(args({ plan: pl, items: { 'W-02': 'op-2' } }))[0].qr).toBe('#tab=estimation&project=pj1&item=op-2')
  })
  it('a notched piece shows the joint name and size', () => {
    expect(stickerModel(args())[5]).toMatchObject({ ends: ['notch', 'square'], notchText: 'บากรับกรอบนอน 20×8', length_mm: 3200 })
  })
  it('grid roles are shown in Thai', () => {
    expect(stickerModel(args())[7].title).toBe('W-01 · ซอยนอน')
  })
  it('before issue every remainder has a sticker with the placeholder code and no QR', () => {
    const offs = stickerModel(args()).filter(x => x.kind === 'offcut')
    expect(offs.map(o => [o.offKey, o.code, o.qr, o.keepDefault])).toEqual([
      ['A|F#OC-0003', NEW_OFFCUT_CODE, null, false], ['A|F#1', NEW_OFFCUT_CODE, null, false], ['B|F#1', NEW_OFFCUT_CODE, null, true],
    ])
    expect(offs[2]).toMatchObject({ title: 'เศษ → เข้าสต็อก', length_mm: 2400, die: null, finish: 'ซอย · อบขาว', ends: ['miter45', 'square'], footL: 'จาก PARLLEL TROPICAL' })
    expect(offs[0]).toMatchObject({ die: 'F7980', finish: 'กรอบบาน · อบขาว' })
  })
  it('after issue only kept remainders have a sticker, with the real code and the offcut QR', () => {
    const offs = stickerModel(args({ codes: { 'A|F#1': 'OC-0010', 'B|F#1': 'OC-0011' } })).filter(x => x.kind === 'offcut')
    expect(offs.map(o => [o.offKey, o.code, o.qr])).toEqual([
      ['A|F#1', 'OC-0010', '#tab=estimation&offcut=OC-0010'], ['B|F#1', 'OC-0011', '#tab=estimation&offcut=OC-0011'],
    ])
  })
  it('no plan gives no stickers', () => {
    expect(stickerModel(args({ plan: null }))).toEqual([])
  })
})

describe('notchText', () => {
  it('joint name plus size', () => expect(notchText({ joint_name: 'บากรับกรอบนอน', width_mm: 20, depth_mm: 8 })).toBe('บากรับกรอบนอน 20×8'))
  it('null sizes: the joint name only', () => expect(notchText({ joint_name: 'บากรับกรอบนอน', width_mm: null, depth_mm: null })).toBe('บากรับกรอบนอน'))
  it('no name and no size: บาก', () => expect(notchText({ joint_name: null, width_mm: null, depth_mm: null })).toBe('บาก'))
  it('one size missing: never prints null', () => expect(notchText({ joint_name: null, width_mm: 20, depth_mm: null })).toBe('บาก'))
  it('no notch: null', () => expect(notchText(null)).toBeNull())
})

describe('labels', () => {
  it('maps the English grid roles and leaves Thai names alone', () => {
    expect(roleTh('Horizontal rail')).toBe('ซอยนอน')
    expect(roleTh('Vertical mullion')).toBe('ซอยตั้ง')
    expect(roleTh('กรอบบน')).toBe('กรอบบน')
  })
  it('end labels', () => {
    expect([endLabel('square'), endLabel('miter45'), endLabel('notch')]).toEqual(['90°', '45°', 'บาก'])
  })
  it('short date in the Buddhist year', () => expect(shortDate(new Date(2026, 0, 5))).toBe('05/01/69'))
})

describe('issuedOffcutCodes / isOffcutKept', () => {
  const rows = [
    { source_plan_id: 'cp1', plan_key: 'A|F#1', code: 'OC-0010', status: 'in_stock' },
    { source_plan_id: 'cp1', plan_key: 'B|F#1', code: 'OC-0011', status: 'used' },
    { source_plan_id: 'cp2', plan_key: 'A|F#1', code: 'OC-0020', status: 'in_stock' },
    { source_plan_id: null, plan_key: null, code: 'OC-0001', status: 'in_stock' },
  ]
  it('maps the plan\'s offcuts by key, any status', () => {
    expect(issuedOffcutCodes(rows, 'cp1')).toEqual({ 'A|F#1': 'OC-0010', 'B|F#1': 'OC-0011' })
    expect(issuedOffcutCodes(rows, null)).toEqual({})
    expect(issuedOffcutCodes(null, 'cp1')).toEqual({})
  })
  it('issued: kept iff it has a code; live: the default unless flipped', () => {
    const o = { key: 'A|F#1', keep: true }
    expect(isOffcutKept(o, { codes: { 'A|F#1': 'OC-1' } })).toBe(true)
    expect(isOffcutKept(o, { codes: {} })).toBe(false)
    expect(isOffcutKept(o, { flipped: new Set() })).toBe(true)
    expect(isOffcutKept(o, { flipped: new Set(['A|F#1']) })).toBe(false)
    expect(isOffcutKept({ key: 'x', keep: false }, { flipped: new Set(['x']) })).toBe(true)
    expect(isOffcutKept(null, {})).toBe(false)
  })
})

describe('stickerPages', () => {
  it('one per page on a roll, 24 per page on A4', () => {
    const s = Array.from({ length: 30 }, (_, i) => i)
    expect(stickerPages(s, PAPERS.roll50x30)).toHaveLength(30)
    expect(stickerPages(s, PAPERS.a4x24).map(p => p.length)).toEqual([24, 6])
  })
})

describe('stickerRender (node-safe parts)', () => {
  it('glyph outline: square ends are vertical, 45° ends slant, a notch cuts a step', () => {
    const sq = glyphPoints('square', 'square')
    expect(sq).toHaveLength(4)
    expect(sq[0][0]).toBe(sq[1][0])
    const mi = glyphPoints('miter45', 'miter45')
    expect(mi[0][0] - mi[1][0]).toBe(mi[0][1] - mi[1][1]) // 45°: run = rise
    expect(glyphPoints('notch', 'square')).toHaveLength(6)
    expect(glyphPoints('notch', 'notch')).toHaveLength(8)
  })
  it('QR as a PNG data URL', async () => {
    expect(await qrDataUrl('https://changpm.app/#tab=estimation&offcut=OC-0001')).toMatch(/^data:image\/png;base64,/)
  })
})

describe('die no. and finish line', () => {
  it('a profile without a die no. gives die null (the sticker shows NO_DIE_TEXT)', () => {
    expect(NO_DIE_TEXT).toBe('ไม่มีรหัส')
    const s = stickerModel(args()).filter(x => x.groupKey === 'B|F')
    expect(s.every(x => x.die === null)).toBe(true)
  })
  it('finishFontMm: the largest size that fits 2 lines, never under 1.4 mm', () => {
    expect(finishFontMm('')).toBe(2.2)
    expect(finishFontMm('POWDER COATING WHITE')).toBe(2.2)
    expect(finishFontMm('x'.repeat(60))).toBe(1.9)
    expect(finishFontMm('x'.repeat(80))).toBe(1.4)
    expect(finishFontMm('x'.repeat(300))).toBe(1.4)
  })
})
