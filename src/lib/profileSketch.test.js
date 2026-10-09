import { describe, it, expect } from 'vitest'
import { profileSketchSvg } from './profileSketch.js'

describe('profileSketchSvg', () => {
  it('draws a closed box (two rects) or an open channel (a polyline + two hooks) with the size as text', () => {
    const box = profileSketchSvg({ width_mm: 101.6, depth_mm: 44.45, wall_mm: 1.5, shape: 'box' })
    expect(box).toContain('101.6 x 44.45 mm')
    expect((box.match(/<rect /g) || []).length).toBe(2)
    const u = profileSketchSvg({ width_mm: 101.6, depth_mm: 44.45, wall_mm: 1.5, shape: 'u' })
    expect(u).toContain('<polyline')
    expect((u.match(/<rect /g) || []).length).toBe(2)
  })
  it('missing or non-positive dimensions give an empty string; a missing wall still draws', () => {
    expect(profileSketchSvg({ width_mm: 0, depth_mm: 10 })).toBe('')
    expect(profileSketchSvg({ width_mm: 10 })).toBe('')
    expect(profileSketchSvg({ width_mm: 40, depth_mm: 40 })).toContain('<svg')
  })
  it('never produces NaN, even with a wall thicker than the section', () => {
    expect(profileSketchSvg({ width_mm: 10, depth_mm: 10, wall_mm: 50, shape: 'box' })).not.toContain('NaN')
  })
})
