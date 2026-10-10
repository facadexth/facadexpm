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
