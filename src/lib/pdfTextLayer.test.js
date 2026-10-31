import { describe, it, expect } from 'vitest'
import { placeLine, groupCharsIntoLines, writeTextLayer } from './pdfTextLayer.js'

// html2pdf's A4 page size with the 10 mm margins downloadPDF uses.
const pageSize = { inner: { width: 190, height: 277 } }
const margin = [10, 10, 10, 10]
const container = { left: 100, top: 50, width: 718 } // 190 mm at 96 dpi

describe('placeLine', () => {
  it('maps container pixels to mm inside the page margins', () => {
    const p = placeLine({ left: 100, top: 50, width: 359, height: 20 }, container, pageSize, margin)
    expect(p.page).toBe(0)
    expect(p.x).toBeCloseTo(10, 5)
    expect(p.y).toBeCloseTo(10, 5)
    expect(p.width).toBeCloseTo(95, 5)
  })
  it('puts a line below the first page cut on page 2 at the page top', () => {
    const pagePx = 718 * 277 / 190 // 1046.7 px per page
    const p = placeLine({ left: 100, top: 50 + pagePx + 10, width: 100, height: 20 }, container, pageSize, margin)
    expect(p.page).toBe(1)
    expect(p.y).toBeCloseTo(10 + 10 * 190 / 718, 5)
  })
  it('uses the floored canvas cut when the canvas geometry is known', () => {
    // html2canvas: canvas.width = floor(718.109 * 2) = 1436; html2pdf: cut = floor(1436 * 277/190) = 2093 canvas px
    const c = { left: 100, top: 50, width: 718.109375 }
    const canvas = { width: 1436, scale: 2 }
    const cutPx = Math.floor(1436 * 277 / 190) / 2 // 1046.5 container px
    const above = placeLine({ left: 100, top: 50 + cutPx - 12, width: 10, height: 10 }, c, pageSize, margin, canvas)
    const below = placeLine({ left: 100, top: 50 + cutPx + 2, width: 10, height: 10 }, c, pageSize, margin, canvas)
    expect(above.page).toBe(0)
    expect(below.page).toBe(1)
    expect(below.y).toBeCloseTo(10 + 2 * (190 * 2 / 1436), 5)
  })
  it('x uses the LEFT margin (html2pdf order top,left,bottom,right)', () => {
    const p = placeLine({ left: 100, top: 50, width: 10, height: 10 }, container, pageSize, [1, 2, 3, 4])
    expect(p.x).toBeCloseTo(2, 5)
    expect(p.y).toBeCloseTo(1, 5)
  })
  it('a line straddling the cut goes with its larger half', () => {
    const pagePx = 718 * 277 / 190
    const mostlyAbove = placeLine({ left: 0, top: 50 + pagePx - 15, width: 10, height: 20 }, container, pageSize, margin)
    const mostlyBelow = placeLine({ left: 0, top: 50 + pagePx - 5, width: 10, height: 20 }, container, pageSize, margin)
    expect(mostlyAbove.page).toBe(0)
    expect(mostlyBelow.page).toBe(1)
  })
})

describe('groupCharsIntoLines', () => {
  const box = (left, top, w = 8, h = 16) => ({ left, top, right: left + w, bottom: top + h, width: w, height: h })
  it('splits a Thai run that wrapped mid-word into two lines', () => {
    const chars = [...'ระบบบริหาร'].map((ch, i) => ({ ch, rect: box(i < 5 ? 10 + i * 8 : 10 + (i - 5) * 8, i < 5 ? 0 : 20) }))
    const lines = groupCharsIntoLines(chars)
    expect(lines.map(l => l.text)).toEqual(['ระบบบ', 'ริหาร'])
    expect(lines[0]).toMatchObject({ left: 10, right: 50, top: 0, bottom: 16 })
  })
  it('keeps combining marks (zero-size boxes) in the current line', () => {
    const chars = [
      { ch: 'ก', rect: box(0, 0) }, { ch: '็', rect: box(8, 0, 0, 0) }, { ch: 'า', rect: box(8, 0) },
    ]
    expect(groupCharsIntoLines(chars).map(l => l.text)).toEqual(['ก็า'])
  })
  it('collapses whitespace and drops empty lines', () => {
    const chars = [{ ch: ' ', rect: box(0, 0) }, { ch: 'A', rect: box(8, 0) }, { ch: ' ', rect: box(16, 0) }, { ch: ' ', rect: box(24, 0) }, { ch: 'B', rect: box(32, 0) }]
    expect(groupCharsIntoLines(chars).map(l => l.text)).toEqual(['A B'])
    expect(groupCharsIntoLines([{ ch: '\n', rect: box(0, 0) }])).toEqual([])
  })
})

describe('writeTextLayer', () => {
  function fakePdf(pages) {
    const calls = []
    return {
      calls,
      getNumberOfPages: () => pages,
      setFont: (n, s) => calls.push(['font', n, s]),
      setPage: (p) => calls.push(['page', p]),
      setFontSize: (s) => calls.push(['size', s]),
      getTextWidth: (t) => t.length * 8,
      text: (t, x, y, o) => calls.push(['text', t, x, y, o]),
    }
  }
  it('writes each line invisibly on its page with a scale that matches the line width', () => {
    const pdf = fakePdf(1)
    const n = writeTextLayer(pdf, [{ text: 'ใบเสนอราคา', left: 100, top: 50, right: 100 + 359, bottom: 70, fontPx: 16 }], container, pageSize, margin, 'Sarabun')
    expect(n).toBe(1)
    const t = pdf.calls.find(c => c[0] === 'text')
    expect(t[1]).toBe('ใบเสนอราคา')
    expect(t[2]).toBeCloseTo(10, 5)
    expect(t[4].renderingMode).toBe('invisible')
    expect(t[4].horizontalScale).toBeCloseTo(95 / 80, 5)
    expect(pdf.calls.find(c => c[0] === 'size')[1]).toBeCloseTo(16 * (190 / 718) * 72 / 25.4, 5)
  })
  it('skips lines that fall on pages the PDF does not have', () => {
    const pdf = fakePdf(1)
    const n = writeTextLayer(pdf, [{ text: 'x', left: 100, top: 50 + 3000, right: 120, bottom: 50 + 3016, fontPx: 12 }], container, pageSize, margin, 'Sarabun')
    expect(n).toBe(0)
    expect(pdf.calls.some(c => c[0] === 'text')).toBe(false)
  })
})
