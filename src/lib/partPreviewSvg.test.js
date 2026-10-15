import { describe, it, expect } from 'vitest'
import { partSvgString } from './partPreviewSvg.js'
import { overviewSpecs } from './partGeometry.js'
import { startModel, setEndMode } from './partModel.js'
import { safeSvgDataUri, planAttachmentPages, itemViews } from './attachmentPages.js'

const model = (() => {
  const m = startModel('sliding_2')
  for (const k of Object.keys(m.lines)) m.lines[k][0].profile_family = k === 'frame_side' || k.startsWith('frame') ? 'FR' : 'SA'
  return m
})()
const withExtra = (() => {
  const m = JSON.parse(JSON.stringify(model))
  m.lines.frame_bottom.push({ ...JSON.parse(JSON.stringify(m.lines.frame_bottom[0])), profile_family: 'TRIM' })
  return m
})()
const buttOf = () => 20
const rects = svg => [...svg.matchAll(/<rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g)].map(m => m.slice(1).map(Number))

describe('partSvgString', () => {
  it('(a) both views pass safeSvgDataUri, one <rect> per piece (+ the glass) and the dimension texts', () => {
    for (const view of ['out', 'in']) {
      const svg = partSvgString({ model: withExtra, widthMm: 1800, heightMm: 1200, view, buttOf })
      expect(safeSvgDataUri(svg)).not.toBeNull()
      expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="[\d.]+" height="[\d.]+" viewBox="[-\d. ]+">/)
      const pieces = overviewSpecs({ model: withExtra, widthMm: 1800, heightMm: 1200, view }).pieces
      expect(rects(svg)).toHaveLength(pieces.length + 1)
      expect(svg).toContain('>1.80 ม.</text>')
      expect(svg).toContain('>1.20 ม.</text>')
      expect(svg).not.toMatch(/NaN|undefined|<style|<script|marker|\son[a-z]+=/i)
      expect(svg.match(/<(\w+)/g).every(t => ['<svg', '<rect', '<line', '<text', '<polyline'].includes(t))).toBe(true)
    }
  })

  it('(b) outside and inside differ: mirrored, and the visible (last drawn) sash swaps', () => {
    const out = partSvgString({ model, widthMm: 1800, heightMm: 1200, view: 'out' })
    const inn = partSvgString({ model, widthMm: 1800, heightMm: 1200, view: 'in' })
    expect(out).not.toBe(inn)
    const po = overviewSpecs({ model, widthMm: 1800, heightMm: 1200, view: 'out' }).pieces
    const pi = overviewSpecs({ model, widthMm: 1800, heightMm: 1200, view: 'in' }).pieces
    expect(po[po.length - 1].piece).toBe(0)
    expect(pi[pi.length - 1].piece).toBe(1)
    // the rects follow the geometry's drawing order exactly (after the glass)
    const ro = rects(out).slice(1)
    expect(ro.map(r => r[0])).toEqual(po.map(p => Math.round(p.x * 100) / 100))
  })

  it('(c) a butt end shortens the drawn piece', () => {
    const through = setEndMode(setEndMode(model, 'frame_top', 0, 0, 0, 'through'), 'frame_top', 0, 0, 1, 'through')
    const butt = rects(partSvgString({ model, widthMm: 1800, heightMm: 1200 }))[1]      // frame_top is the first piece
    const full = rects(partSvgString({ model: through, widthMm: 1800, heightMm: 1200 }))[1]
    expect(butt[2]).toBeLessThan(full[2])
  })

  it('styles: double = outline (white pieces), solid = filled tones; frame and sash differ in tone', () => {
    const d = partSvgString({ model, widthMm: 1800, heightMm: 1200, style: 'double' })
    const s = partSvgString({ model, widthMm: 1800, heightMm: 1200, style: 'solid' })
    expect(d).not.toBe(s)
    expect(d).toContain('fill="#ffffff"')
    expect(new Set([...s.matchAll(/<rect [^>]*fill="(#[0-9a-f]+)"/g)].map(m => m[1])).size).toBeGreaterThanOrEqual(3)
  })

  it('returns null for no model / no size', () => {
    expect(partSvgString({ model: null, widthMm: 1800, heightMm: 1200 })).toBeNull()
    expect(partSvgString({ model, widthMm: 0, heightMm: 1200 })).toBeNull()
    expect(partSvgString({ model: {}, widthMm: 1800, heightMm: 1200 })).toBeNull()
  })

  it('is deterministic', () => {
    expect(partSvgString({ model, widthMm: 1800, heightMm: 1200, view: 'in' })).toBe(partSvgString({ model: JSON.parse(JSON.stringify(model)), widthMm: 1800, heightMm: 1200, view: 'in' }))
  })
})

describe('PE-9: the item drawing is the editor overview', () => {
  it('piece rects equal overviewSpecs (what PartPreview draws) for the same model / size / view / widthOf', () => {
    const widthOf = f => ({ FR: 50.8, SA: 44.45, TRIM: 12 }[f] ?? null)
    for (const view of ['out', 'in']) {
      const svg = partSvgString({ model: withExtra, widthMm: 2400, heightMm: 1500, view, widthOf })
      const pieces = overviewSpecs({ model: withExtra, widthMm: 2400, heightMm: 1500, view, widthOf }).pieces
      const r = v => Math.round(v * 100) / 100
      expect(rects(svg).slice(1)).toEqual(pieces.map(p => [r(p.x), r(p.y), r(p.w), r(p.h)]))
      // and widthOf really changes the drawing (true-scale bars, not the constant)
      expect(svg).not.toBe(partSvgString({ model: withExtra, widthMm: 2400, heightMm: 1500, view }))
    }
  })
})

describe('(step 5) the quotation attachment shows the part-editor drawing unchanged', () => {
  it('planAttachmentPages / itemViews keep both views of an item whose previews come from partSvgString', () => {
    const item = {
      id: 'o1', opening_no: 'W1', quantity: 1, width_m: 1.8, height_m: 1.2,
      preview_svg_out: partSvgString({ model, widthMm: 1800, heightMm: 1200, view: 'out' }),
      preview_svg_in: partSvgString({ model, widthMm: 1800, heightMm: 1200, view: 'in' }),
    }
    expect(itemViews(item).map(v => v.side)).toEqual(['out', 'in'])
    const { pages } = planAttachmentPages({ items: [item], totalQuotationPages: 1 })
    const it0 = pages[0].items[0]
    expect(it0.noPreview).toBe(false)
    expect(it0.views.map(v => v.side)).toEqual(['out', 'in'])
    expect(it0.views[0].src).toMatch(/^data:image\/svg\+xml/)
  })
})

// ---------------------------------------------------------------- Task 8: every layout kind, four styles
import { createHash } from 'node:crypto'
import { kinds, defaultParams } from './layoutRegistry.js'
import { cutLengthsByPiece } from './partPreviewSvg.js'

const SIZE8 = {
  sliding_2: [1800, 1200], fixed_grid: [1800, 1200], awning_grid: [1200, 1200], casement_n: [1500, 1200],
  sliding_n: [1800, 1200], sliding_3track: [2700, 1200], sliding_2_fixed_2: [2400, 1200],
  swing_door: [1000, 2100], frameless_door: [1000, 2100], hanging_door: [2400, 2100], folding_door: [3000, 2400],
  curtain_wall: [3600, 3000], frameless_wall: [3600, 3000],
}
const m8 = (kind, params = {}) => startModel(kind, { ...defaultParams(kind, {}), ...params })
const svg8 = (kind, params = {}, extra = {}) => { const [W, H] = SIZE8[kind]; return partSvgString({ model: m8(kind, params), widthMm: W, heightMm: H, ...extra }) }
const count = (s, re) => (s.match(re) || []).length
const filledFam = (m) => { const o = JSON.parse(JSON.stringify(m)); for (const ls of Object.values(o.lines)) for (const l of ls) l.profile_family = l.profile_family || 'X'; return o }

describe('Task 8 — partSvgString for every layout kind', () => {
  it('sliding_2 output is byte-identical to before Task 8 (pinned sha256)', () => {
    const sha = (s) => createHash('sha256').update(s).digest('hex')
    const widthOf = (f) => ({ FR: 50.8, SA: 44.45 }[f] ?? null)
    expect(sha(partSvgString({ model, widthMm: 1800, heightMm: 1200, view: 'out' }))).toBe('331d0fcb1002fd3c682af344394b55d4c8b7d5b978b5dbf705c9027e31acee4e')
    expect(sha(partSvgString({ model, widthMm: 1800, heightMm: 1200, view: 'in' }))).toBe('b020ee5a91b10850c47e8188d5b88b467d80388988b3a84a99b1efbb75cf111a')
    expect(sha(partSvgString({ model, widthMm: 1800, heightMm: 1200, view: 'out', style: 'solid' }))).toBe('bc63630ba25e6bbf1598989c703ad6760dc2856128c230b66e58aaef020697d0')
    expect(sha(partSvgString({ model, widthMm: 1800, heightMm: 1200, view: 'in', widthOf }))).toBe('00400b744d7d8191d93accb2480992d205dd1dcd9d1b5ba8e616e2b99f46cda4')
  })
  for (const kind of Object.keys(SIZE8)) {
    it(`${kind}: four styles × two views are safe, finite, deterministic strings`, () => {
      expect(kinds()).toContain(kind)
      const seen = new Set()
      for (const style of ['double', 'lengths', 'solid', 'cad']) for (const view of ['out', 'in']) {
        // adjusted (final fix wave, R-F3): 'lengths' prints cut lengths only when they are given
        const [W, H] = SIZE8[kind]
        const lengthsByPiece = style === 'lengths' ? cutLengthsByPiece({ model: filledFam(m8(kind)), buttOf: () => 20, widthOf: () => 40, widthMm: W, heightMm: H }) : null
        const s = svg8(kind, {}, { style, view, lengthsByPiece })
        expect(typeof s).toBe('string')
        expect(safeSvgDataUri(s)).not.toBeNull()
        expect(s).not.toMatch(/NaN|undefined|Infinity|<style|<script|marker|\son[a-z]+=/i)
        expect(s.match(/<(\w+)/g).every((t) => ['<svg', '<rect', '<line', '<text', '<polyline'].includes(t))).toBe(true)
        expect(s).toBe(svg8(kind, {}, { style, view, lengthsByPiece }))
        if (view === 'out') seen.add(s)
      }
      expect(seen.size).toBe(4)   // the four styles differ (a symmetric drawing may look the same from both sides)
    })
  }
  it('cad style draws lines only with non-scaling 1.3 strokes; lengths adds piece length texts', () => {
    const cad = svg8('fixed_grid', {}, { style: 'cad' })
    expect(cad).toContain('vector-effect="non-scaling-stroke"')
    expect(cad).toContain('stroke-width="1.3"')
    expect(cad).not.toMatch(/<rect [^>]*data-role="piece"[^>]*fill="#/)
    const dbl = svg8('fixed_grid', {}, { style: 'double' })
    const lengthsByPiece = cutLengthsByPiece({ model: m8('fixed_grid'), buttOf: () => 45, widthOf: () => 60, widthMm: 1800, heightMm: 1200 })
    const len = svg8('fixed_grid', {}, { style: 'lengths', lengthsByPiece })
    expect(count(len, /<text/g)).toBeGreaterThan(count(dbl, /<text/g))
    expect(len).toContain('>530</text>')
  })
  it('lengths prints the CUT length from the expansion, not the drawn one (R-F3): fixed_grid top frame 1740, never 1680', () => {
    // butt 30 / width 60: the top frame is cut 1800 − 2 × 30 = 1740 but drawn 1800 − 2 × 60 = 1680
    const opts = { model: m8('fixed_grid'), widthMm: 1800, heightMm: 1200, widthOf: () => 60 }
    const lengthsByPiece = cutLengthsByPiece({ ...opts, buttOf: () => 30 })
    expect(lengthsByPiece.frame_top).toEqual([1740])
    const s = partSvgString({ ...opts, style: 'lengths', lengthsByPiece })
    expect(s).toContain('>1740</text>')
    expect(s).not.toContain('>1680</text>')
    const fn = partSvgString({ ...opts, style: 'lengths', lengthsByPiece: (key) => (key === 'frame_top' ? 1740 : null) })
    expect(count(fn, />1740<\/text>/g)).toBe(1)
    const none = partSvgString({ ...opts, style: 'lengths' })
    expect(count(none, /<text/g)).toBe(count(partSvgString({ ...opts, style: 'double' }), /<text/g))
    expect(none).not.toMatch(/>1(740|680)<\/text>/)
  })
  it('decorative free-line strips get no cut length (hanging-door rail, curtain-wall plates)', () => {
    const hang = cutLengthsByPiece({ model: m8('hanging_door'), buttOf: () => 20, widthOf: () => 40, widthMm: 2400, heightMm: 2100 })
    expect(hang.track_rail).toBeUndefined()
    expect(hang.frame_side).toHaveLength(2)
    const cw = cutLengthsByPiece({ model: m8('curtain_wall'), buttOf: () => 20, widthOf: () => 40, widthMm: 3600, heightMm: 3000 })
    expect([cw.plate_w, cw.cover_h, cw.mullion?.length]).toEqual([undefined, undefined, 5])
  })
  it('curtain_wall with cells { "0,1": awning, "2,3": spandrel } draws one V polyline and one spandrel rect', () => {
    const s = svg8('curtain_wall', { cells: { '0,1': 'awning', '2,3': 'spandrel' } })
    expect(count(s, /<polyline/g)).toBe(1)
    expect(count(s, /data-kind="spandrel"/g)).toBe(1)
  })
  it('unitized curtain wall draws unit joints as double lines', () => {
    const s = svg8('curtain_wall', { unitized: true })
    expect(count(s, /data-kind="unit_joint"/g)).toBe(2 * (3 + 4))
  })
  it('fixed panes carry an F label; sill-less doors a dashed floor line; dashed V when opening away', () => {
    expect(svg8('fixed_grid')).toContain('>F</text>')
    expect(svg8('sliding_3track')).toContain('>F</text>')
    expect(svg8('swing_door', { sill: 'no' })).toMatch(/data-kind="floor_line"[^>]*stroke-dasharray/)
    expect(svg8('swing_door', { sill: 'yes' })).not.toContain('data-kind="floor_line"')
    expect(svg8('swing_door', { open: 'out' }, { view: 'out' })).not.toMatch(/<polyline[^>]*stroke-dasharray/)
    expect(svg8('swing_door', { open: 'in' }, { view: 'out' })).toMatch(/<polyline[^>]*stroke-dasharray/)
  })
  it('door hardware: closer box for pivot doors, patch fittings / pull / floor lock for frameless doors', () => {
    expect(svg8('swing_door', { pivot: true })).toContain('data-kind="closer"')
    const fl = svg8('frameless_door')
    for (const k of ['patch', 'pull', 'floor_lock']) expect(fl).toContain(`data-kind="${k}"`)
  })
  it('mitred sashes draw their 45° corners (4 diagonals per sash)', () => {
    expect(count(svg8('awning_grid'), /data-kind="mitre"/g)).toBe(4 * 4)
    expect(count(svg8('fixed_grid'), /data-kind="mitre"/g)).toBe(0)
  })
  it('returns null for folding_door with no leaves (hand-made model)', () => {
    const m = m8('folding_door')
    m.params = { ...m.params, nL: 0, nR: 0 }
    expect(() => partSvgString({ model: m, widthMm: 3000, heightMm: 2400 })).not.toThrow()
  })
})

// ---------------------------------------------------------------- inline add-ons (ช่องแสง) on the drawing
describe('partSvgString with inline add-ons', () => {
  const ao = (o) => ({ mode: 'merge', kind: 'fixed', position: 'top', len_mm: 1800, thick_mm: 400, offset_mm: 0, align: 'start', rows: 1, cols: 3, ...o })
  const topMerge = ao({})
  const rightAttach = ao({ mode: 'attach', position: 'right', len_mm: 1200, thick_mm: 500, rows: 2, cols: 1 })
  const draw = (addons, extra = {}) => partSvgString({ model, widthMm: 1800, heightMm: 1200, addons, ...extra })
  const viewBoxOf = (s) => s.match(/viewBox="([-\d. ]+)"/)[1].split(' ').map(Number)

  it('absent / empty add-ons leave the string byte-identical', () => {
    for (const view of ['out', 'in']) {
      const plain = partSvgString({ model, widthMm: 1800, heightMm: 1200, view })
      expect(draw(null, { view })).toBe(plain)
      expect(draw([], { view })).toBe(plain)
      expect(draw(undefined, { view, overrides: {} })).toBe(plain)
    }
  })
  it('top merge: both views safe, the overall size 1800 × 1600, viewBox grows upward, main pieces unchanged', () => {
    const plain = partSvgString({ model, widthMm: 1800, heightMm: 1200 })
    for (const view of ['out', 'in']) {
      const s = draw([topMerge], { view })
      expect(safeSvgDataUri(s)).not.toBeNull()
      expect(s).toContain('1800 × 1600')
      expect(s).not.toMatch(/NaN|undefined|Infinity|<style|<script|marker|\son[a-z]+=/i)
      expect(s.match(/<(\w+)/g).map((t) => t.slice(1)).every((t) => ['svg', 'g', 'rect', 'line', 'text', 'polyline'].includes(t))).toBe(true)
    }
    const s = draw([topMerge])
    const [, vy] = viewBoxOf(s), [, py] = viewBoxOf(plain)
    expect(vy).toBeLessThan(py)
    // every main piece rect of the plain drawing is still there, at the same place
    for (const r of plain.match(/<rect [^>]+>/g)) expect(s).toContain(r)
  })
  it('right attach 500 on 1800 × 1200: overall 2300 × 1200, viewBox grows to the right', () => {
    for (const view of ['out', 'in']) {
      const s = draw([rightAttach], { view })
      expect(safeSvgDataUri(s)).not.toBeNull()
      expect(s).toContain('2300 × 1200')
    }
    const plain = viewBoxOf(partSvgString({ model, widthMm: 1800, heightMm: 1200 }))
    const out = viewBoxOf(draw([rightAttach]))
    expect(out[2]).toBeGreaterThan(plain[2])
    // the inside view mirrors the add-on to the left
    const inn = viewBoxOf(draw([rightAttach], { view: 'in' }))
    expect(inn[0]).toBeLessThan(plain[0])
  })
  it('merge and attach draw differently; grid lines follow rows / cols; awning adds its V', () => {
    expect(draw([topMerge])).not.toBe(draw([{ ...topMerge, mode: 'attach' }]))
    expect(draw([topMerge])).not.toBe(draw([{ ...topMerge, cols: 4 }]))
    expect(draw([topMerge])).not.toBe(draw([{ ...topMerge, rows: 2 }]))
    expect(draw([topMerge])).not.toMatch(/<polyline/)
    expect(draw([{ ...topMerge, kind: 'awning' }])).toMatch(/<polyline/)
    expect(draw([topMerge], { style: 'solid' })).not.toBe(draw([topMerge]))
  })
  it('dimensions show the main unit, each add-on and the whole unit (owner 2026-10-15)', () => {
    const labels = (s) => (s.match(/>([\d.]+ ม\.)</g) || []).map((m) => m.slice(1, -1))
    // top merge 400 on 1800 x 1200: vertical chain 0.40 + 1.20, whole 1.60; horizontal 1.80 alone (main = whole)
    const top = labels(draw([topMerge]))
    expect(top.filter((l) => l === '0.40 ม.')).toHaveLength(1)
    expect(top.filter((l) => l === '1.20 ม.')).toHaveLength(1)
    expect(top.filter((l) => l === '1.60 ม.')).toHaveLength(1)
    expect(top.filter((l) => l === '1.80 ม.')).toHaveLength(1)
    // right attach 500: horizontal chain 1.80 + 0.50, whole 2.30; vertical 1.20 alone
    const right = labels(draw([rightAttach]))
    expect(right.filter((l) => l === '0.50 ม.')).toHaveLength(1)
    expect(right.filter((l) => l === '1.80 ม.')).toHaveLength(1)
    expect(right.filter((l) => l === '2.30 ม.')).toHaveLength(1)
    expect(right.filter((l) => l === '1.20 ม.')).toHaveLength(1)
    // both: 2 chains + 2 whole lines, and the whole-unit lines sit further out than the chain
    const both = draw([topMerge, rightAttach])
    expect(labels(both).sort()).toEqual(['0.40 ม.', '0.50 ม.', '1.20 ม.', '1.60 ม.', '1.80 ม.', '2.30 ม.'])
    // the inside view mirrors the chain, same labels
    expect(labels(draw([topMerge, rightAttach], { view: 'in' })).sort()).toEqual(labels(both).sort())
    // the mm drawing kinds get the same three levels
    const mm = labels(partSvgString({ model: m8('fixed_grid'), widthMm: 1800, heightMm: 1200, addons: [topMerge, rightAttach] }))
    expect(mm.sort()).toEqual(['0.40 ม.', '0.50 ม.', '1.20 ม.', '1.60 ม.', '1.80 ม.', '2.30 ม.'])
  })
  it('works for a millimetre layout kind too (safe, overall size)', () => {
    const s = partSvgString({ model: m8('fixed_grid'), widthMm: 1800, heightMm: 1200, addons: [topMerge] })
    expect(safeSvgDataUri(s)).not.toBeNull()
    expect(s).toContain('1800 × 1600')
  })
})
