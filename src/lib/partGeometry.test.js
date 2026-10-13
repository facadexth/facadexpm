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

// ---------------------------------------------------------------- Task 8: every layout kind
import { startModel as start8, setEndMode as setEnd8 } from './partModel'
import { kinds, defaultParams, LAYOUTS as LAYOUTS8 } from './layoutRegistry'
import { expandParts } from './partExpand'
import { pieceLabel } from './partGeometry'

// the accepted mockup's default size per kind (docs/reference/type-previews-mockup.html TYPES[].def)
const SIZE8 = {
  sliding_2: [1800, 1200], fixed_grid: [1800, 1200], awning_grid: [1200, 1200], casement_n: [1500, 1200],
  sliding_n: [1800, 1200], sliding_3track: [2700, 1200], sliding_2_fixed_2: [2400, 1200],
  swing_door: [1000, 2100], frameless_door: [1000, 2100], hanging_door: [2400, 2100], folding_door: [3000, 2400],
  curtain_wall: [3600, 3000], frameless_wall: [3600, 3000],
}
const filled8 = (kind, params = {}) => {
  const m = start8(kind, { ...defaultParams(kind, {}), ...params })
  for (const k of Object.keys(m.lines)) for (const l of m.lines[k]) if (!l.profile_family) l.profile_family = 'X'
  return m
}
const expandedPieces = (m) => expandParts({ model: m, buttOf: () => 20, widthOf: () => 40 }).components.reduce((a, c) => a + c.quantity_value, 0)
const toMm = (box, p) => ({ x: (p.x - box.frameX) / box.scale, y: (p.y - box.frameY) / box.scale, w: p.w / box.scale, h: p.h / box.scale })
const ov8 = (m, view = 'out', extra = {}) => { const [W, H] = SIZE8[m.layout_kind]; return overviewSpecs({ model: m, widthMm: W, heightMm: H, view, ...extra }) }

describe('Task 8 — overviewSpecs for every layout kind', () => {
  it('the matrix covers all 13 registered kinds', () => {
    expect(Object.keys(SIZE8).sort()).toEqual(kinds().sort())
    expect(kinds()).toHaveLength(13)
  })
  for (const kind of Object.keys(SIZE8)) {
    describe(kind, () => {
      it('piece count equals the expander piece count (sum of quantity_value)', () => {
        const m = filled8(kind)
        const total = expandedPieces(m)
        expect(total).toBeGreaterThan(0)
        for (const view of ['out', 'in']) expect(ov8(m, view).pieces).toHaveLength(total)
      })
      it('every piece lies inside [0,W]×[0,H] (hanging_door tracks within [-0.25W, 1.25W]) with finite numbers', () => {
        const m = filled8(kind)
        const [W, H] = SIZE8[kind]
        for (const view of ['out', 'in']) {
          const o = ov8(m, view)
          for (const p of o.pieces) {
            const q = toMm(o.box, p)
            for (const v of Object.values(q)) expect(Number.isFinite(v)).toBe(true)
            const track = kind === 'hanging_door' && p.part === 'track'
            expect(q.x).toBeGreaterThanOrEqual((track ? -0.25 * W : 0) - 1e-6)
            expect(q.x + q.w).toBeLessThanOrEqual((track ? 1.25 * W : W) + 1e-6)
            expect(q.y).toBeGreaterThanOrEqual(-1e-6)
            expect(q.y + q.h).toBeLessThanOrEqual(H + 1e-6)
            expect(q.w).toBeGreaterThan(0)
            expect(q.h).toBeGreaterThan(0)
          }
        }
      })
      it('no two pieces of different part instances on the same track overlap', () => {
        const o = ov8(filled8(kind))
        const tracked = o.pieces.filter((p) => p.track != null)
        for (let i = 0; i < tracked.length; i++) for (let j = i + 1; j < tracked.length; j++) {
          const a = tracked[i], b = tracked[j]
          if (a.track !== b.track || a.part !== b.part || a.partIdx === b.partIdx) continue
          expect(overlapArea(a, b)).toBeLessThan(1e-6)
        }
      })
      it('pieces carry part / partIdx / track / mitre; mitre exactly on mitred parts', () => {
        const m = filled8(kind)
        const layout = LAYOUTS8[kind]
        for (const p of ov8(m).pieces) {
          const part = layout.parts.find((x) => x.key === layout.positions[p.key].part)
          expect(p.part).toBe(part.key)
          expect(Number.isInteger(p.partIdx)).toBe(true)
          expect(p.mitre).toBe(part.corner === 'mitre' && layout.positions[p.key].corner !== 'free')
        }
      })
      it('returns glass / symbols / hardwareMarks / dims arrays with finite numbers', () => {
        const o = ov8(filled8(kind))
        for (const k of ['glass', 'symbols', 'hardwareMarks', 'dims']) expect(Array.isArray(o[k])).toBe(true)
        expect(o.dims.length).toBeGreaterThanOrEqual(2)
        for (const g of [...o.glass, ...o.symbols]) for (const k of ['x', 'y', 'w', 'h']) if (g[k] !== undefined) expect(Number.isFinite(g[k])).toBe(true)
      })
    })
  }
})

describe('Task 8 — layout specifics', () => {
  it('fixed_grid: transoms span mullion face to mullion face even when an end is set to butt (R-3a)', () => {
    let m = filled8('fixed_grid')
    m = setEnd8(m, 'transom', 0, 0, 1, 'butt')
    const { pieces } = ov8(m)
    const mull = pieces.filter((p) => p.key === 'mullion').sort((a, b) => a.x - b.x)
    const tr = pieces.filter((p) => p.key === 'transom').sort((a, b) => a.x - b.x)
    expect(tr).toHaveLength(3)
    expect(tr[0].x + tr[0].w).toBeCloseTo(mull[0].x, 9)
    expect(tr[1].x).toBeCloseTo(mull[0].x + mull[0].w, 9)
    expect(tr[1].x + tr[1].w).toBeCloseTo(mull[1].x, 9)
    // drawing constants: frame 45, mullion 60 → cell width (1800 − 90 − 120) / 3 = 530
    expect(tr[0].w).toBeCloseTo(530, 9)
    expect(mull[0].h).toBeCloseTo(1110, 9)
  })
  it('fixed_grid: six fixed glass cells with F', () => {
    const { glass } = ov8(filled8('fixed_grid'))
    expect(glass).toHaveLength(6)
    expect(glass.every((g) => g.fixed && g.kind === 'glass')).toBe(true)
  })
  it('awning_grid: mitred sashes, V apex top on each sash', () => {
    const o = ov8(filled8('awning_grid'))
    expect(o.pieces.filter((p) => p.part === 'sash').every((p) => p.mitre)).toBe(true)
    const v = o.symbols.filter((s) => s.kind === 'v_hinge')
    expect(v).toHaveLength(4)
    expect(v.every((s) => s.hinge === 'top' && s.dashed === false)).toBe(true)
  })
  it('casement_n n=2: hinges left,right; the inside view mirrors them and flips dashed', () => {
    const m = filled8('casement_n')
    const h = (view) => ov8(m, view).symbols.filter((s) => s.kind === 'v_hinge').sort((a, b) => a.x - b.x).map((s) => [s.hinge, s.dashed])
    expect(h('out')).toEqual([['left', false], ['right', false]])
    expect(h('in')).toEqual([['left', true], ['right', true]])
    const o = ov8(m, 'in'), out = ov8(m, 'out')
    const s0in = o.symbols.find((s) => s.partIdx === 0), s0out = out.symbols.find((s) => s.partIdx === 0)
    expect(s0in.hinge).toBe('right')
    expect(s0in.x).toBeCloseTo(1500 - s0out.x - s0out.w, 9)
  })
  it('sliding_n: tracks alternate, the front track is drawn last, arrows point to the middle', () => {
    const o = ov8(filled8('sliding_n'))
    const sashes = o.pieces.filter((p) => p.part === 'sash')
    expect(sashes.at(-1).track).toBe(1)
    const dirs = o.symbols.filter((s) => s.kind === 'slide').sort((a, b) => a.x - b.x).map((s) => s.dir)
    expect(dirs).toEqual([1, -1])
  })
  it('sliding_3track: the fixed sash gets F and no arrow; sliding sashes point toward it, mirrored when fixed_side = right', () => {
    for (const [side, dir] of [['left', -1], ['right', 1]]) {
      const o = ov8(filled8('sliding_3track', { fixed_side: side }))
      const fixed = o.glass.filter((g) => g.fixed)
      expect(fixed).toHaveLength(1)
      const slides = o.symbols.filter((s) => s.kind === 'slide')
      expect(slides).toHaveLength(2)
      expect(slides.every((s) => s.dir === dir)).toBe(true)
      expect(o.symbols.filter((s) => s.kind === 'none')).toHaveLength(1)
      // the fixed pane sits on the fixed side
      const xs = o.glass.map((g) => g.x)
      expect(fixed[0].x).toBe(side === 'left' ? Math.min(...xs) : Math.max(...xs))
    }
  })
  it('sliding_2_fixed_2: outer two fixed with F, inner two slide toward their fixed neighbour', () => {
    const o = ov8(filled8('sliding_2_fixed_2'))
    expect(o.glass.filter((g) => g.fixed)).toHaveLength(2)
    expect(o.symbols.filter((s) => s.kind === 'slide').sort((a, b) => a.x - b.x).map((s) => s.dir)).toEqual([-1, 1])
  })
  it('swing_door: sill-less draws a floor dashed line, pivot draws the door closer in the head, hinged draws 3 hinge ticks', () => {
    const kinds8 = (m) => ov8(m).hardwareMarks.map((h) => h.kind)
    expect(kinds8(filled8('swing_door', { sill: 'no' }))).toContain('floor_line')
    expect(kinds8(filled8('swing_door', { sill: 'yes' }))).not.toContain('floor_line')
    const piv = ov8(filled8('swing_door', { pivot: true }))
    const closer = piv.hardwareMarks.find((h) => h.kind === 'closer')
    const head = piv.pieces.find((p) => p.key === 'frame_top')
    expect(closer.y).toBeGreaterThanOrEqual(head.y)
    expect(closer.y + closer.h).toBeLessThanOrEqual(head.y + head.h + 1e-9)
    expect(kinds8(filled8('swing_door')).filter((k) => k === 'hinge')).toHaveLength(3)
    expect(kinds8(filled8('swing_door'))).toContain('handle')
  })
  it('frameless_door: frameless glass leaf, patch fittings flush top and bottom on the hinge side, pull handle and floor lock', () => {
    const o = ov8(filled8('frameless_door'))
    const leaf = o.glass.find((g) => g.kind === 'frameless')
    expect(leaf).toBeTruthy()
    const patches = o.hardwareMarks.filter((h) => h.kind === 'patch')
    expect(patches).toHaveLength(2)
    expect(Math.min(...patches.map((p) => p.y))).toBeCloseTo(leaf.y, 9)
    expect(Math.max(...patches.map((p) => p.y + p.h))).toBeCloseTo(leaf.y + leaf.h, 9)
    expect(patches.every((p) => p.x === leaf.x)).toBe(true)   // hinge left
    const k = o.hardwareMarks.map((h) => h.kind)
    expect(k).toContain('pull')
    expect(k).toContain('floor_lock')
    expect(k).toContain('floor_line')
  })
  it('hanging_door: the rail runs past the opening, two leaves slide outward', () => {
    const o = ov8(filled8('hanging_door', { leaves: 2 }))
    const rail = o.pieces.find((p) => p.key === 'track_rail')
    expect(rail.x).toBeCloseTo(-600, 9)
    expect(rail.w).toBeCloseTo(3600, 9)
    expect(o.symbols.filter((s) => s.kind === 'slide').sort((a, b) => a.x - b.x).map((s) => s.dir)).toEqual([-1, 1])
  })
  it('folding_door nL 2 nR 1: alternating V per side, two arrows, a split line', () => {
    const o = ov8(filled8('folding_door', { nL: 2, nR: 1 }))
    const v = o.symbols.filter((s) => s.kind === 'fold').sort((a, b) => a.x - b.x)
    expect(v.map((s) => s.hinge)).toEqual(['left', 'right', 'right'])
    expect(o.symbols.filter((s) => s.kind === 'arrow').map((s) => s.dir).sort()).toEqual([-1, 1])
    expect(o.symbols.filter((s) => s.kind === 'split')).toHaveLength(1)
    const o2 = ov8(filled8('folding_door', { nL: 3, nR: 0 }))
    expect(o2.symbols.filter((s) => s.kind === 'split')).toHaveLength(0)
    expect(o2.symbols.filter((s) => s.kind === 'arrow')).toHaveLength(1)
  })
  it('curtain_wall: cells follow cellKinds (awning = mitred sash + V top, spandrel = spandrel glass); unitized adds rows+cols unit joints', () => {
    const m = filled8('curtain_wall', { cells: { '0,1': 'awning', '2,3': 'spandrel' } })
    const o = ov8(m)
    expect(o.glass.filter((g) => g.kind === 'spandrel')).toHaveLength(1)
    expect(o.symbols.filter((s) => s.kind === 'v_hinge' && s.hinge === 'top')).toHaveLength(1)
    expect(o.pieces.filter((p) => p.part === 'awning')).toHaveLength(4)
    expect(o.hardwareMarks.filter((h) => h.kind === 'unit_joint')).toHaveLength(0)
    const u = ov8(filled8('curtain_wall', { unitized: true }))
    expect(u.hardwareMarks.filter((h) => h.kind === 'unit_joint')).toHaveLength(3 + 4)
  })
  it('frameless_wall: cols frameless panes and cols-1 silicone joints', () => {
    const o = ov8(filled8('frameless_wall'))
    expect(o.glass.filter((g) => g.kind === 'frameless')).toHaveLength(3)
    expect(o.hardwareMarks.filter((h) => h.kind === 'silicone')).toHaveLength(2)
  })
  it('widthOf draws true widths in mm', () => {
    const o = ov8(filled8('fixed_grid'), 'out', { widthOf: (f) => (f === 'กล่องเรียบ' ? 70 : null) })
    expect(o.pieces.find((p) => p.key === 'frame_side').w).toBeCloseTo(70, 9)
    expect(o.pieces.find((p) => p.key === 'mullion').w).toBeCloseTo(60, 9)
  })
  it('folding_door with nL + nR = 0 in a hand-made model returns finite empty-ish specs', () => {
    const m = filled8('folding_door')
    m.params = { ...m.params, nL: 0, nR: 0 }
    expect(() => ov8(m)).not.toThrow()
  })
})

describe('Task 8 — zoomSpecs for the new kinds', () => {
  it('awning_grid sash 2 tab: its pieces at full opacity, the others faded to 0.25, the selected position highlighted', () => {
    const m = filled8('awning_grid')
    const z = zoomSpecs({ model: m, partKey: 'sash', partIdx: 1, selected: { key: 'sash_top', line: 0 }, view: 'out', widthMm: 1200, heightMm: 1200 })
    const mine = z.pieces.filter((p) => p.part === 'sash' && p.partIdx === 1)
    expect(mine).toHaveLength(4)
    expect(mine.every((p) => p.opacity === 1)).toBe(true)
    expect(z.pieces.filter((p) => !(p.part === 'sash' && p.partIdx === 1)).every((p) => p.opacity === 0.25)).toBe(true)
    expect(z.pieces.filter((p) => p.selected).map((p) => `${p.key}:${p.partIdx}`)).toEqual(['sash_top:1'])
    expect(z.title).toContain('บานกระทุ้ง 2')
    expect(z.markers.length).toBe(2)
    expect(z.markers.every((k) => k.mode === 'mitre')).toBe(true)
  })
  it('the whole-set tab (no partKey) fades nothing; the frame tab fades sashes and grid', () => {
    const m = filled8('awning_grid')
    const all = zoomSpecs({ model: m, partKey: null, selected: null, view: 'out', widthMm: 1200, heightMm: 1200 })
    expect(all.pieces.every((p) => p.opacity === 1)).toBe(true)
    const fr = zoomSpecs({ model: m, partKey: 'frame', selected: { key: 'frame_top', line: 0 }, view: 'out', widthMm: 1200, heightMm: 1200 })
    expect(fr.pieces.filter((p) => p.part !== 'frame').every((p) => p.opacity === 0.25)).toBe(true)
    expect(fr.markers.map((k) => k.mode)).toEqual(['butt', 'butt'])
  })
  it('does not mutate the model', () => {
    const m = filled8('curtain_wall', { cells: { '0,0': 'awning' } })
    const snap = JSON.stringify(m)
    ov8(m, 'in')
    zoomSpecs({ model: m, partKey: 'awning', partIdx: 0, selected: { key: 'sash_side', line: 0 }, view: 'in', widthMm: 3600, heightMm: 3000 })
    expect(JSON.stringify(m)).toBe(snap)
  })
})

describe('Task 8 — pieceLabel adapter', () => {
  it('sliding_2 keeps its legacy wording; other kinds read partModel.pieceLabel (pieceNames, labels)', () => {
    const s2 = start8('sliding_2')
    expect(pieceLabel(s2, LAYOUTS8.sliding_2, 'sash_top', 1)).toBe('บานขวา')
    expect(pieceLabel(s2, LAYOUTS8.sliding_2, 'frame_side', 0)).toBe('ซ้าย')
    expect(pieceLabel(s2, LAYOUTS8.sliding_2, 'frame_top', 0)).toBe('')
    const f2 = start8('sliding_2_fixed_2')
    expect(pieceLabel(f2, LAYOUTS8.sliding_2_fixed_2, 'stile_b', 1)).toBe('เสากุญแจตัวผู้')
    const g = start8('fixed_grid')
    expect(pieceLabel(g, LAYOUTS8.fixed_grid, 'transom', 2)).toBe('ชิ้นที่ 3')
    expect(pieceLabel(g, LAYOUTS8.fixed_grid, 'frame_top', 0)).toBe('')
    expect(ov8(filled8('sliding_2_fixed_2')).pieces.find((p) => p.key === 'stile_b' && p.piece === 1).label).toBe('เสาขวาของบาน เสากุญแจตัวผู้')
  })
})

describe('Task 10 — curtain-wall cell click targets', () => {
  it('overviewSpecs returns one cell per grid cell with its row, column and kind, mirrored for the inside view', async () => {
    const { cycleCellKind } = await import('./partModel')
    const m = cycleCellKind(filled8('curtain_wall', { rows: 2, cols: 3 }), 0, 1)
    const o = ov8(m)
    expect(o.cells).toHaveLength(6)
    expect(o.cells.find(c => c.r === 0 && c.c === 1).kind).toBe('awning')
    expect(o.cells.filter(c => c.kind === 'glass')).toHaveLength(5)
    const W = o.box.frameW
    const out = o.cells.find(c => c.r === 1 && c.c === 0)
    const inn = ov8(m, 'in').cells.find(c => c.r === 1 && c.c === 0)
    expect(inn.x).toBeCloseTo(W - out.x - out.w, 6)
    expect(ov8(filled8('fixed_grid')).cells).toEqual([])
  })
})
