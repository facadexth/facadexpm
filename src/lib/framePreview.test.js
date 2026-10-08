// src/lib/framePreview.test.js
import { describe, it, expect } from 'vitest'
import { buildFramePreview } from './framePreview.js'

const tpl = (o = {}) => ({ grid_row_weights: [1], ...o })

describe('buildFramePreview', () => {
  it('returns null when the size is missing or not positive', () => {
    expect(buildFramePreview({ template: tpl(), width_m: 0, height_m: 2, panel_count: 1 })).toBeNull()
    expect(buildFramePreview({ template: tpl(), width_m: 2, height_m: NaN, panel_count: 1 })).toBeNull()
    expect(buildFramePreview({ template: null, width_m: 2, height_m: 2, panel_count: 1 })).toBeNull()
  })

  it('fits a 2 x 1.5 m opening into the drawing area with a double-line frame', () => {
    const p = buildFramePreview({ template: tpl(), width_m: 2, height_m: 1.5, panel_count: 1 })
    expect(p.scale).toBeCloseTo(140)                       // min(280/2, 220/1.5)
    expect(p.units).toHaveLength(1)
    const u = p.units[0]
    expect(u.outer).toEqual({ x: 40, y: 40, w: 280, h: 210 })
    expect(u.inner.x).toBeCloseTo(40 + 9.45)               // 0.045 x min(280, 210) = 9.45
    expect(u.inner.w).toBeCloseTo(280 - 2 * 9.45)
    expect(u.lines).toEqual([])                            // one panel, one row: no interior members
    expect(p.viewBox).toEqual({ width: 360, height: 290 })
  })

  it('the frame thickness is clamped to 4..10 px', () => {
    const thin = buildFramePreview({ template: tpl(), width_m: 5, height_m: 0.5, panel_count: 1 }).units[0]   // 280 x 28 px
    expect(thin.inner.x - thin.outer.x).toBeCloseTo(4)
    const big = buildFramePreview({ template: tpl(), width_m: 1, height_m: 1, panel_count: 1 }).units[0]
    expect(big.inner.x - big.outer.x).toBeLessThanOrEqual(10)
  })

  it('a very thin opening still has a positive inner box', () => {
    const u = buildFramePreview({ template: tpl(), width_m: 5, height_m: 0.1, panel_count: 1 }).units[0]       // 280 x 5.6 px
    expect(u.inner.w).toBeGreaterThan(0)
    expect(u.inner.h).toBeGreaterThan(0)
  })

  it('3 panels draw 2 vertical members, each a double line (4 lines)', () => {
    const u = buildFramePreview({ template: tpl(), width_m: 3, height_m: 2, panel_count: 3 }).units[0]
    const vertical = u.lines.filter(l => l.x1 === l.x2)
    expect(vertical).toHaveLength(4)
    expect(u.lines).toHaveLength(4)
    // the two members sit at 1/3 and 2/3 of the inner width
    const xs = [...new Set(vertical.map(l => Math.round(l.x1)))]
    expect(xs.length).toBe(4)
  })

  it('row weights [1,2] draw one horizontal member at 1/3 of the inner height', () => {
    const u = buildFramePreview({ template: tpl({ grid_row_weights: [1, 2] }), width_m: 2, height_m: 3, panel_count: 1 }).units[0]
    const horizontal = u.lines.filter(l => l.y1 === l.y2)
    expect(horizontal).toHaveLength(2)                     // one member = two lines
    const mid = u.inner.y + u.inner.h / 3
    const ys = horizontal.map(l => l.y1)
    expect(Math.min(...ys)).toBeLessThan(mid)
    expect(Math.max(...ys)).toBeGreaterThan(mid)
  })

  it('stacks an add-on above the main unit and fits both', () => {
    const p = buildFramePreview({
      template: tpl(), width_m: 2, height_m: 2, panel_count: 1,
      addon: { template: tpl(), width_m: 2, height_m: 0.5, panel_count: 2 },
    })
    expect(p.units.map(u => u.kind)).toEqual(['addon', 'main'])
    const [addon, main] = p.units
    expect(addon.outer.y).toBeLessThan(main.outer.y)
    expect(addon.outer.y + addon.outer.h).toBeCloseTo(main.outer.y)   // touching
    expect(p.scale).toBeCloseTo(Math.min(280 / 2, 220 / 2.5))
    expect(main.outer.y + main.outer.h + 40).toBeLessThanOrEqual(p.viewBox.height + 1e-6)
  })

  it('reports dimensions as text in metres', () => {
    const p = buildFramePreview({ template: tpl(), width_m: 5.45, height_m: 2.7, panel_count: 1 })
    expect(p.dims.find(d => d.kind === 'width').text).toBe('5.45 ม.')
    expect(p.dims.find(d => d.kind === 'height').text).toBe('2.70 ม.')
  })

  it('an add-on with no usable size is ignored', () => {
    const p = buildFramePreview({ template: tpl(), width_m: 2, height_m: 2, panel_count: 1, addon: { template: tpl(), width_m: 0, height_m: 0.5, panel_count: 1 } })
    expect(p.units).toHaveLength(1)
  })
})
