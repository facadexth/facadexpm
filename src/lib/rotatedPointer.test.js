import { describe, it, expect } from 'vitest'
import { rotatedChartClientPoint } from './rotatedPointer.js'

// recharts: scaledX = (clientX - rect.left) / (rect.width / offsetWidth)
const recharts = (rect, offsetWidth, p) => {
  const scale = rect.width / offsetWidth
  return { x: (p.clientX - rect.left) / scale, y: (p.clientY - rect.top) / scale }
}

describe('rotatedChartClientPoint', () => {
  // a 600x200 chart rotated 90deg: on screen it is 200 wide, 600 tall, at left 50 top 10
  const rect = { left: 50, top: 10, right: 250, bottom: 610, width: 200, height: 600 }
  it('the rect top-right corner is the chart origin', () => {
    expect(recharts(rect, 600, rotatedChartClientPoint(rect, 600, 250, 10))).toEqual({ x: 0, y: 0 })
  })
  it('moving down the screen moves along the chart x axis', () => {
    expect(recharts(rect, 600, rotatedChartClientPoint(rect, 600, 250, 310))).toEqual({ x: 300, y: 0 })
  })
  it('moving left on the screen moves down the chart y axis', () => {
    const r = recharts(rect, 600, rotatedChartClientPoint(rect, 600, 150, 610))
    expect(r.x).toBeCloseTo(600)
    expect(r.y).toBeCloseTo(100)
  })
})
