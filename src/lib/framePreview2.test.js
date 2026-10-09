// src/lib/framePreview2.test.js  (Phase 2b additions; the Phase 2a tests in framePreview.test.js must still pass unchanged)
import { describe, it, expect } from 'vitest'
import { buildFramePreview, previewSvgString, previewSignature } from './framePreview.js'

const tpl = (o = {}) => ({ grid_row_weights: [1], ...o })
const base = { template: tpl(), width_m: 2, height_m: 2, panel_count: 1 }
const withAddon = (o = {}) => ({ ...base, addon: { template: tpl(), width_m: 1, height_m: 0.5, panel_count: 1, ...o } })

describe('add-on position and offset', () => {
  it('top (default) centres the add-on on the main unit; offset_m moves it along the side from the left', () => {
    const c = buildFramePreview(withAddon())
    const [a, m] = c.units
    expect(a.outer.x + a.outer.w / 2).toBeCloseTo(m.outer.x + m.outer.w / 2)
    const o = buildFramePreview(withAddon({ offset_m: 0 }))
    expect(o.units[0].outer.x).toBeCloseTo(o.units[1].outer.x)
    const o2 = buildFramePreview(withAddon({ offset_m: 0.5 }))
    expect(o2.units[0].outer.x - o2.units[1].outer.x).toBeCloseTo(0.5 * o2.scale)
  })
  it('bottom puts the add-on below and touching; left/right put it beside and touching', () => {
    const b = buildFramePreview(withAddon({ position: 'bottom' }))
    expect(b.units[0].outer.y).toBeCloseTo(b.units[1].outer.y + b.units[1].outer.h)
    const l = buildFramePreview(withAddon({ position: 'left', width_m: 0.5, height_m: 1 }))
    expect(l.units[0].outer.x + l.units[0].outer.w).toBeCloseTo(l.units[1].outer.x)
    const r = buildFramePreview(withAddon({ position: 'right', width_m: 0.5, height_m: 1 }))
    expect(r.units[0].outer.x).toBeCloseTo(r.units[1].outer.x + r.units[1].outer.w)
  })
  it('everything stays inside the view box, whatever the position', () => {
    for (const position of ['top', 'bottom', 'left', 'right']) {
      const p = buildFramePreview(withAddon({ position, width_m: 3, height_m: 1.5, offset_m: 0.4 }))
      for (const u of p.units) {
        expect(u.outer.x).toBeGreaterThanOrEqual(-1e-6)
        expect(u.outer.y).toBeGreaterThanOrEqual(-1e-6)
        expect(u.outer.x + u.outer.w).toBeLessThanOrEqual(p.viewBox.width + 1e-6)
        expect(u.outer.y + u.outer.h).toBeLessThanOrEqual(p.viewBox.height + 1e-6)
      }
    }
  })
  it('an unknown position falls back to top; the add-on also reports its own width dimension', () => {
    const d = buildFramePreview(withAddon({ position: 'diagonal' }))
    expect(d.units[0].outer.y).toBeLessThan(d.units[1].outer.y)
    const p = buildFramePreview(withAddon())
    expect(p.dims.filter(d => d.unit === 'addon').map(d => [d.kind, d.text]).sort()).toEqual([['height', '0.50 ม.'], ['width', '1.00 ม.']])
  })
})

describe('joint seams and main axis', () => {
  it('draws four seams per unit; vertical main = vertical seams at the inner edge, horizontal main = horizontal seams', () => {
    const v = buildFramePreview(base).units[0]
    expect(v.seams).toHaveLength(4)
    expect(v.seams.every(s => s.x1 === s.x2 && s.y1 !== s.y2)).toBe(true)
    const h = buildFramePreview({ ...base, main_axis: 'horizontal' }).units[0]
    expect(h.seams.every(s => s.y1 === s.y2 && s.x1 !== s.x2)).toBe(true)
    expect(v.seams[0].x1).toBeCloseTo(v.inner.x)
  })
})

describe('frame width from the profile', () => {
  it('frame_mm sets the drawn frame at scale; without it the Phase 2a 4..10 px rule applies', () => {
    const p = buildFramePreview({ ...base, frame_mm: 44.45 })
    const u = p.units[0]
    expect(u.inner.x - u.outer.x).toBeCloseTo((44.45 / 1000) * p.scale)
    const wide = buildFramePreview({ ...base, frame_mm: 400 }).units[0]
    expect(wide.inner.w).toBeGreaterThan(0)
    const none = buildFramePreview(base).units[0]
    expect(none.inner.x - none.outer.x).toBeLessThanOrEqual(10)
  })
})

describe('inside view', () => {
  it('mirrors left-right: an add-on on the right in the outside view appears on the left inside; dimension text is unchanged', () => {
    const out = buildFramePreview(withAddon({ position: 'right', width_m: 0.5, height_m: 1 }))
    const inn = buildFramePreview({ ...withAddon({ position: 'right', width_m: 0.5, height_m: 1 }), view: 'in' })
    expect(inn.view).toBe('in')
    expect(out.units[0].outer.x).toBeGreaterThan(out.units[1].outer.x)
    expect(inn.units[0].outer.x).toBeLessThan(inn.units[1].outer.x)
    expect(inn.dims.map(d => d.text)).toEqual(out.dims.map(d => d.text))
    expect(inn.viewBox).toEqual(out.viewBox)
  })
  it('a unit keeps its size when mirrored', () => {
    const out = buildFramePreview(base).units[0]
    const inn = buildFramePreview({ ...base, view: 'in' }).units[0]
    expect(inn.outer.w).toBeCloseTo(out.outer.w)
    expect(inn.outer.h).toBeCloseTo(out.outer.h)
  })
})

describe('decoration and part labels', () => {
  it('slide kind with 2+ panels gets a handle and an arrow; swing gets a dashed arc and a knob; fixed gets nothing', () => {
    expect(buildFramePreview({ ...base, template: tpl({ preview_kind: 'slide' }), panel_count: 2 }).units[0].decor.map(d => d.type)).toEqual(['line', 'polyline'])
    expect(buildFramePreview({ ...base, template: tpl({ preview_kind: 'swing' }) }).units[0].decor.map(d => d.type)).toEqual(['polyline', 'circle'])
    expect(buildFramePreview({ ...base, template: tpl({ preview_kind: 'slide' }), panel_count: 1 }).units[0].decor).toEqual([])
    expect(buildFramePreview(base).units[0].decor).toEqual([])
  })
  it('part labels are placed on the four bars and move to the mirrored side inside', () => {
    const labels = { top: 'T', bottom: 'B', left: 'L', right: 'R' }
    const out = buildFramePreview({ ...base, part_labels: labels })
    expect(out.labels.map(l => l.side).sort()).toEqual(['bottom', 'left', 'right', 'top'])
    const inn = buildFramePreview({ ...base, part_labels: labels, view: 'in' })
    const x = (p, side) => p.labels.find(l => l.side === side).x
    expect(x(out, 'left')).toBeLessThan(x(out, 'right'))
    expect(x(inn, 'left')).toBeGreaterThan(x(inn, 'right'))
    expect(buildFramePreview(base).labels).toEqual([])
  })
})

describe('previewSvgString', () => {
  it('returns a self-contained svg with no css variables, the dimension text, and escapes label text', () => {
    const p = buildFramePreview({ ...base, part_labels: { top: 'A<B&C' } })
    const svg = previewSvgString(p, { style: 'double' })
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg).not.toMatch(/var\(--/)
    expect(svg).toContain('2.00 ม.')
    expect(svg).toContain('A&lt;B&amp;C')
  })
  it('cad has no fills, solid uses the finish colour, null preview gives an empty string', () => {
    const p = buildFramePreview(base)
    expect(previewSvgString(p, { style: 'cad' })).toContain('fill="none" stroke="#1f2328" stroke-width="1.2"')
    expect(previewSvgString(p, { style: 'solid', finishColor: '#2b2f33' })).toContain('fill="#2b2f33"')
    expect(previewSvgString(null)).toBe('')
  })
})

describe('previewSignature', () => {
  it('changes with any input that changes the drawing and is stable otherwise', () => {
    const a = { template_id: 't', width_m: 2, height_m: 1.5, panel_count: 2 }
    expect(previewSignature(a)).toBe(previewSignature({ ...a }))
    expect(previewSignature(a)).not.toBe(previewSignature({ ...a, width_m: 2.1 }))
    expect(previewSignature(a)).not.toBe(previewSignature({ ...a, addon_position: 'bottom' }))
    expect(previewSignature(a)).not.toBe(previewSignature({ ...a, main_axis: 'horizontal' }))
  })
})

describe('fix round 1: svg safety, signature completeness, empty offset', () => {
  it('finishColor is validated before it reaches an attribute', () => {
    const p = buildFramePreview(base)
    const bad = previewSvgString(p, { style: 'solid', finishColor: '" onload="x' })
    expect(bad).not.toContain('onload')
    expect(bad).toContain('fill="#f4f4f2"')
    expect(previewSvgString(p, { style: 'solid', finishColor: '#2b2f33' })).toContain('fill="#2b2f33"')
  })
  it('signature tells centred from offset 0 and sees frame widths', () => {
    const a = { template_id: 't', width_m: 2, height_m: 1.5, panel_count: 2 }
    expect(previewSignature({ ...a, addon_offset_m: null })).not.toBe(previewSignature({ ...a, addon_offset_m: 0 }))
    expect(previewSignature({ ...a, addon_offset_m: '' })).toBe(previewSignature({ ...a, addon_offset_m: null }))
    expect(previewSignature({ ...a, frame_mm: 40 })).not.toBe(previewSignature({ ...a, frame_mm: 44.45 }))
    expect(previewSignature({ ...a, addon_frame_mm: 40 })).not.toBe(previewSignature({ ...a, addon_frame_mm: 44.45 }))
    expect(previewSignature({ ...a, frame_mm: 40 })).toBe(previewSignature({ ...a, frame_mm: 40 }))
  })
  it('an empty-string offset centres the add-on like null', () => {
    const e = buildFramePreview(withAddon({ offset_m: '' }))
    const n = buildFramePreview(withAddon({ offset_m: null }))
    expect(e.units[0].outer.x).toBeCloseTo(n.units[0].outer.x)
    expect(e.units[0].outer.x).toBeCloseTo(e.units[1].outer.x + (e.units[1].outer.w - e.units[0].outer.w) / 2)
  })
  it('a mirrored preview serialises without NaN or undefined', () => {
    const svg = previewSvgString(buildFramePreview({ ...withAddon({ position: 'right' }), view: 'in', template: tpl({ preview_kind: 'swing' }), part_labels: { left: 'L' } }))
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).not.toMatch(/NaN|undefined/)
  })
})
