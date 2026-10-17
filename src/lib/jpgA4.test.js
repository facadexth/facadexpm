import { describe, it, expect } from 'vitest'
import { a4JpgPlacement, jpgCaptureOptions, pdfOptions, A4_CONTENT_WIDTH_PX, CAPTURE_WINDOW_WIDTH } from './pdf.js'

describe('JPG export is A4 whatever device pressed it', () => {
  it('lays the captured document out at 190mm, with the desktop window width', () => {
    const o = jpgCaptureOptions()
    expect(o.windowWidth).toBe(CAPTURE_WINDOW_WIDTH)
    expect(CAPTURE_WINDOW_WIDTH).toBeGreaterThan(900) // beyond src/mobile.css
    const el = { style: {} }
    o.onclone(null, el)
    expect(el.style).toMatchObject({ width: `${A4_CONTENT_WIDTH_PX}px`, maxWidth: 'none', boxSizing: 'border-box', transform: 'none' })
  })

  it('a one-page document fills the A4 width inside 10mm margins, top-aligned', () => {
    const at = a4JpgPlacement(718 * 2, 900 * 2)
    expect([at.pageWidth, at.pageHeight]).toEqual([1240, 1754])
    expect(at.x).toBeCloseTo(59)
    expect(at.y).toBe(59)
    expect(at.width).toBeCloseTo(1240 - 2 * 59)
  })

  it('a document taller than a page shrinks to fit, centred', () => {
    const at = a4JpgPlacement(1436, 6000)
    expect(at.height).toBeCloseTo(1754 - 2 * 59)
    expect(at.x + at.width / 2).toBeCloseTo(620)
  })

  it('PDF capture uses the same desktop window width', () => {
    expect(pdfOptions().html2canvas.windowWidth).toBe(CAPTURE_WINDOW_WIDTH)
  })
})
