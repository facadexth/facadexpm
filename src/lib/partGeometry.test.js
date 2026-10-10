import { describe, it, expect } from 'vitest'
import { startModel, setEndMode, addLine, setPartCount } from './partModel'
import { overviewSpecs, zoomSpecs } from './partGeometry'

const BUTT = { side: 38.1, top: 38.1, bottom: 35.8, key: 25, hook: 25 }
const buttOf = (fam) => BUTT[fam] ?? null

function model() {
  let m = startModel('sliding_2')
  const fam = { frame_top: 'top', frame_bottom: 'bottom', frame_side: 'side', sash_top: 'rail', sash_bottom: 'rail', key_stile: 'key', hook_stile: 'hook' }
  m = JSON.parse(JSON.stringify(m))
  for (const k of Object.keys(fam)) m.lines[k][0].profile_family = fam[k]
  return m
}

const EPS = 1e-9
const find = (pieces, key, piece, role = 'main', line = 0) => pieces.find((p) => p.key === key && p.piece === piece && p.role === role && p.line === line)
const overlapArea = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
const ov = (m, view = 'out', extra = {}) => overviewSpecs({ model: m, widthMm: 1800, heightMm: 1200, view, buttOf, ...extra })

describe('overviewSpecs — flush joints', () => {
  it('frame_top starts at the right edge of the left side and ends at the left edge of the right side', () => {
    const { pieces } = ov(model())
    const top = find(pieces, 'frame_top', 0), L = find(pieces, 'frame_side', 0), R = find(pieces, 'frame_side', 1)
    expect(top.x).toBeCloseTo(L.x + L.w, 9)
    expect(top.x + top.w).toBeCloseTo(R.x, 9)
    expect(L.y).toBeCloseTo(top.y, 9) // side runs through the corner
  })
  it('a sash rail starts at the right edge of the hook stile', () => {
    const { pieces } = ov(model())
    const hook = find(pieces, 'hook_stile', 0), rail = find(pieces, 'sash_top', 0), key = find(pieces, 'key_stile', 0)
    expect(rail.x).toBeCloseTo(hook.x + hook.w, 9)
    expect(rail.x + rail.w).toBeCloseTo(key.x, 9)
  })
  it("the two sashes' meeting stiles have the same x and the sashes overlap by one stile width", () => {
    const { pieces } = ov(model())
    const k0 = find(pieces, 'key_stile', 0), h1 = find(pieces, 'hook_stile', 1)
    expect(k0.x).toBeCloseTo(h1.x, 9)
    const left = find(pieces, 'hook_stile', 0), right = find(pieces, 'key_stile', 1)
    const s0w = k0.x + k0.w - left.x, s1w = right.x + right.w - h1.x
    const opening = right.x + right.w - left.x
    expect(s0w + s1w - opening).toBeCloseTo(h1.w, 9)
  })
  it('inside view mirrors x', () => {
    const m = model()
    const out = ov(m, 'out'), inn = ov(m, 'in')
    const L = out.box.frameX, R = out.box.frameX + out.box.frameW
    for (const p of out.pieces) {
      const q = find(inn.pieces, p.key, p.piece, p.role, p.line)
      expect(q.x).toBeCloseTo(L + R - p.x - p.w, 9)
      expect(q.y).toBeCloseTo(p.y, 9)
      expect(q.w).toBeCloseTo(p.w, 9)
    }
  })
  it('frame_bottom end 0 through spans the corner and the side stops at its top edge', () => {
    const m = setEndMode(model(), 'frame_bottom', 0, 0, 0, 'through')
    const { pieces, box } = ov(m)
    const bot = find(pieces, 'frame_bottom', 0), L = find(pieces, 'frame_side', 0), R = find(pieces, 'frame_side', 1)
    expect(bot.x).toBeCloseTo(box.frameX, 9)
    expect(L.y + L.h).toBeCloseTo(bot.y, 9)
    expect(overlapArea(bot, L)).toBe(0)
    expect(bot.x + bot.w).toBeCloseTo(R.x, 9) // other end still butts
    expect(R.y + R.h).toBeCloseTo(box.frameY + box.frameH, 9)
  })
  it('drawing order puts the visible sash last (outside: left sash, inside: right sash)', () => {
    const m = model()
    const last = (v) => ov(m, v).pieces.filter((p) => p.key.startsWith('sash') || p.key.endsWith('stile')).at(-1)
    expect(last('out').piece).toBe(0)
    expect(last('in').piece).toBe(1)
    const inn = ov(m, 'in').pieces
    expect(find(inn, 'hook_stile', 1).x).toBeGreaterThan(find(inn, 'key_stile', 1).x) // mirrored: right sash's hook now on its right
  })
  it('extra profiles are thin bars with their own run', () => {
    let m = addLine(model(), 'frame_bottom')
    m = JSON.parse(JSON.stringify(m))
    m.lines.frame_bottom[1].ends[0][0] = { mode: 'through', to: null, deduction_mm: null }
    const { pieces } = ov(m)
    const main = find(pieces, 'frame_bottom', 0), ex = find(pieces, 'frame_bottom', 0, 'extra', 1)
    expect(ex).toBeTruthy()
    expect(ex.h).toBeLessThan(main.h)
    expect(ex.y + ex.h).toBeCloseTo(main.y + main.h, 9)
    expect(ex.x).toBeLessThan(main.x) // runs through on its own
    expect(ex.x + ex.w).toBeCloseTo(main.x + main.w, 9)
    expect(pieces.indexOf(ex)).toBe(pieces.indexOf(main) + 1)
  })
  it('returns width/height dimension specs', () => {
    const { dims, box } = ov(model())
    expect(dims.map((d) => d.value)).toEqual([1800, 1200])
    expect(dims[0].x1).toBeCloseTo(box.frameX, 9)
    expect(dims[0].x2).toBeCloseTo(box.frameX + box.frameW, 9)
  })
  it('does not mutate the model and returns only finite numbers', () => {
    const m = model(), snap = JSON.stringify(m)
    const r = ov(m)
    zoomSpecs({ model: m, partKey: 'sash', selected: { key: 'key_stile', line: 0 }, view: 'in', widthMm: 1800, heightMm: 1200, buttOf })
    expect(JSON.stringify(m)).toBe(snap)
    for (const p of r.pieces) for (const k of ['x', 'y', 'w', 'h']) expect(Number.isFinite(p[k])).toBe(true)
  })
  it('optional widthOf scales drawn thickness and keeps joints flush', () => {
    const widthOf = (f) => ({ side: 51.3, top: 58.1, bottom: 55.6, key: 25, hook: 25, rail: 25 })[f] ?? null
    const a = ov(model()).pieces, b = ov(model(), 'out', { widthOf }).pieces
    expect(find(b, 'frame_top', 0).h).not.toBeCloseTo(find(a, 'frame_top', 0).h, 3)
    const top = find(b, 'frame_top', 0), L = find(b, 'frame_side', 0)
    expect(top.x).toBeCloseTo(L.x + L.w, 9)
    expect(find(b, 'frame_side', 0).w).toBeLessThan(find(b, 'frame_top', 0).h)
  })
})

describe('no overlap at frame corners (all 16 combinations)', () => {
  for (let mask = 0; mask < 16; mask++) {
    it(`mask ${mask.toString(2).padStart(4, '0')}`, () => {
      let m = model()
      // corners: side piece p (0 left, 1 right), end e (0 top, 1 bottom); bit set => side runs through
      for (let p = 0; p < 2; p++) for (let e = 0; e < 2; e++) {
        const bit = (mask >> (p * 2 + e)) & 1
        m = setEndMode(m, 'frame_side', 0, p, e, bit ? 'through' : 'butt')
      }
      for (const view of ['out', 'in']) {
        const { pieces, box } = ov(m, view)
        const frame = pieces.filter((x) => x.key.startsWith('frame') && x.role === 'main')
        expect(frame).toHaveLength(4)
        for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) expect(overlapArea(frame[i], frame[j])).toBeLessThan(EPS)
        // no gaps either: the four bars exactly tile the ring between outer box and opening
        const t = find(pieces, 'frame_top', 0).h, b = find(pieces, 'frame_bottom', 0).h, s = find(pieces, 'frame_side', 0).w
        const ring = box.frameW * box.frameH - (box.frameW - 2 * s) * (box.frameH - t - b)
        expect(frame.reduce((a, r) => a + r.w * r.h, 0)).toBeCloseTo(ring, 6)
      }
    })
  }
})

describe('zoomSpecs', () => {
  const z = (m, partKey, key, extra = {}) => zoomSpecs({ model: m, partKey, selected: { key, line: 0 }, view: 'out', widthMm: 1800, heightMm: 1200, buttOf, ...extra })
  it('frame zoom draws the frame only with 2 markers on the top frame and 4 on the sides', () => {
    const a = z(model(), 'frame', 'frame_top')
    expect(a.pieces.every((p) => p.key.startsWith('frame'))).toBe(true)
    expect(a.markers).toHaveLength(2)
    expect(a.markers.map((k) => k.mode)).toEqual(['butt', 'butt'])
    const b = z(model(), 'frame', 'frame_side')
    expect(b.markers).toHaveLength(4)
    expect(b.markers.every((k) => k.mode === 'through')).toBe(true)
    expect(a.opening).toBeNull()
  })
  it('frame zoom joints are flush too', () => {
    const { pieces } = z(model(), 'frame', 'frame_top')
    const top = find(pieces, 'frame_top', 0), L = find(pieces, 'frame_side', 0)
    expect(top.x).toBeCloseTo(L.x + L.w, 9)
  })
  it('sash zoom draws two sashes side by side with 4 stile markers and the opening text', () => {
    const a = z(model(), 'sash', 'key_stile')
    expect(a.pieces.every((p) => !p.key.startsWith('frame'))).toBe(true)
    expect(a.markers).toHaveLength(4)
    expect(new Set(a.markers.map((k) => `${k.piece}:${k.end}`)).size).toBe(4)
    const s0 = a.pieces.filter((p) => p.piece === 0), s1 = a.pieces.filter((p) => p.piece === 1)
    expect(Math.max(...s0.map((p) => p.x + p.w))).toBeLessThan(Math.min(...s1.map((p) => p.x)))
    expect(a.opening.widthMm).toBeCloseTo(1800 - 2 * 38.1, 9)
    expect(a.opening.heightMm).toBeCloseTo(1200 - 38.1 - 35.8, 9)
    expect(a.opening.text).toBe('ช่องเปิดวงกบ 1,723.8 × 1,126.1 มม.')
    expect(a.title).toContain('บานเลื่อน × 2')
    expect(a.title).toContain('เสากุญแจ')
    expect(a.title).toContain(a.opening.text)
    const rail = find(a.pieces, 'sash_top', 0), hook = find(a.pieces, 'hook_stile', 0)
    expect(rail.x).toBeCloseTo(hook.x + hook.w, 9)
  })
  it('markers follow a toggled end and the selected line; inside view mirrors them', () => {
    const m = setEndMode(model(), 'frame_top', 0, 0, 0, 'through')
    const a = z(m, 'frame', 'frame_top')
    expect(a.markers.map((k) => k.mode)).toEqual(['through', 'butt'])
    const inn = z(m, 'frame', 'frame_top', { view: 'in' })
    expect(inn.markers[0].x).toBeCloseTo(a.box.w - a.markers[0].x, 9)
    expect(inn.markers[0].y).toBeCloseTo(a.markers[0].y, 9)
  })
  it('derives partKey from the selection when omitted', () => {
    const a = zoomSpecs({ model: model(), selected: { key: 'hook_stile', line: 0 }, view: 'out', widthMm: 1800, heightMm: 1200, buttOf })
    expect(a.markers).toHaveLength(4)
    expect(a.opening).not.toBeNull()
  })
  it('sash count 1 draws one sash', () => {
    const m = setPartCount(model(), 'sash', 1)
    const { pieces } = ov(m)
    expect(pieces.filter((p) => p.key === 'key_stile')).toHaveLength(1)
    const a = z(m, 'sash', 'key_stile')
    expect(a.markers).toHaveLength(2)
  })
})

describe('empty-model safety and edge inputs', () => {
  const allFinite = (r) => {
    const nums = []
    for (const p of r.pieces) nums.push(p.x, p.y, p.w, p.h)
    for (const k of r.markers || []) nums.push(k.x, k.y)
    for (const d of r.dims || []) nums.push(d.x1, d.y1, d.x2, d.y2, d.tx, d.ty, d.value)
    for (const v of Object.values(r.box)) nums.push(v)
    if (r.opening) nums.push(r.opening.widthMm, r.opening.heightMm)
    return nums.every(Number.isFinite)
  }
  for (const [name, m] of [['null', null], ['undefined', undefined], ['{}', {}], ['unknown layout', { layout_kind: 'nope', lines: {}, parts: [] }], ['no parts', { layout_kind: 'sliding_2', lines: {} }]]) {
    it(`${name} model returns empty specs without throwing`, () => {
      const o = overviewSpecs({ model: m, widthMm: 1800, heightMm: 1200, view: 'out', buttOf })
      expect(o.pieces).toEqual([])
      expect(o.dims).toEqual([])
      expect(o.box.w).toBeGreaterThan(0)
      expect(o.box.h).toBeGreaterThan(0)
      const z = zoomSpecs({ model: m, selected: { key: 'frame_top', line: 0 }, view: 'in', widthMm: 1800, heightMm: 1200, buttOf })
      expect(z).toMatchObject({ pieces: [], markers: [], title: '', opening: null })
      expect(z.box.w).toBeGreaterThan(0)
    })
  }
  it('no arguments at all does not throw', () => {
    expect(overviewSpecs().pieces).toEqual([])
    expect(zoomSpecs().markers).toEqual([])
  })
  for (const [w, h] of [[0, 0], [-500, 1200], [1800, -1], [NaN, NaN], [undefined, null], ['abc', '1200'], [1, 100000], [100000, 1]]) {
    it(`odd size ${w} × ${h} gives finite output in both views and both zooms`, () => {
      for (const view of ['out', 'in']) {
        const o = overviewSpecs({ model: model(), widthMm: w, heightMm: h, view, buttOf })
        expect(o.pieces.length).toBeGreaterThan(0)
        expect(allFinite(o)).toBe(true)
        for (const [pk, key] of [['frame', 'frame_side'], ['sash', 'hook_stile']]) {
          const z = zoomSpecs({ model: model(), partKey: pk, selected: { key, line: 0 }, view, widthMm: w, heightMm: h, buttOf })
          expect(allFinite(z)).toBe(true)
          expect(z.markers).toHaveLength(4)
        }
      }
    })
  }
  it('missing lines: positions without lines draw nothing, the rest still draws', () => {
    const m = model()
    delete m.lines.frame_top
    m.lines.sash_top = []
    const o = ov(m)
    expect(o.pieces.some((p) => p.key === 'frame_top' || p.key === 'sash_top')).toBe(false)
    expect(o.pieces.some((p) => p.key === 'frame_side')).toBe(true)
    expect(allFinite(o)).toBe(true)
    const z = zoomSpecs({ model: m, selected: { key: 'frame_top', line: 0 }, view: 'out', widthMm: 1800, heightMm: 1200, buttOf })
    expect(z.markers).toEqual([])
    expect(allFinite(z)).toBe(true)
    const noLines = { ...model(), lines: {} }
    expect(ov(noLines).pieces).toEqual([])
  })
  it('missing ends on a line are treated as through and do not throw', () => {
    const m = model()
    m.lines.frame_top[0].ends = []
    const o = ov(m)
    const top = find(o.pieces, 'frame_top', 0)
    expect(top.x).toBeCloseTo(o.box.frameX, 9)
    expect(allFinite(o)).toBe(true)
  })
  it('sash count 0 draws no sash and does not throw', () => {
    const m = model()
    m.parts.find((p) => p.key === 'sash').count = 0
    for (const view of ['out', 'in']) {
      const o = ov(m, view)
      expect(o.pieces.every((p) => p.key.startsWith('frame'))).toBe(true)
      expect(allFinite(o)).toBe(true)
      const z = zoomSpecs({ model: m, partKey: 'sash', selected: { key: 'key_stile', line: 0 }, view, widthMm: 1800, heightMm: 1200, buttOf })
      expect(z.pieces).toEqual([])
      expect(z.markers).toEqual([])
      expect(allFinite(z)).toBe(true)
    }
  })
  for (const n of [3, 5]) {
    it(`sash count ${n} draws two sashes with finite numbers`, () => {
      const m = setPartCount(model(), 'sash', n)
      for (const view of ['out', 'in']) {
        const o = ov(m, view)
        expect(o.pieces.filter((p) => p.key === 'key_stile')).toHaveLength(2)
        expect(allFinite(o)).toBe(true)
        const z = zoomSpecs({ model: m, partKey: 'sash', selected: { key: 'key_stile', line: 0 }, view, widthMm: 1800, heightMm: 1200, buttOf })
        expect(z.markers).toHaveLength(4)
        expect(z.title).toContain(`× ${n}`)
        expect(allFinite(z)).toBe(true)
      }
    })
  }
})
