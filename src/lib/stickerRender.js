// src/lib/stickerRender.js
// Browser-only drawing for stickers.js: QR codes and end-cut glyphs as PNG data URLs (html2canvas does not render
// inline SVG reliably), and the sticker PDF sized to the label paper.
import QRCode from 'qrcode'

export function qrDataUrl(text) {
  return QRCode.toDataURL(text, { margin: 0, width: 160, errorCorrectionLevel: 'M' })
}

const GLYPH_W = 140, GLYPH_H = 28
const L = 8, R = GLYPH_W - 8, T = 6, B = GLYPH_H - 6
const SLANT = B - T // 45°
const NW = 12, ND = 7 // notch cut-out, px
const glyphCache = new Map()

// Outline of the bar, clockwise from the bottom-left: left end up, top edge, right end down, bottom edge.
export function glyphPoints(a, b) {
  const pts = []
  if (a === 'miter45') pts.push([L + SLANT, B], [L, T])
  else if (a === 'notch') pts.push([L, B], [L, T + ND], [L + NW, T + ND], [L + NW, T])
  else pts.push([L, B], [L, T])
  if (b === 'miter45') pts.push([R, T], [R - SLANT, B])
  else if (b === 'notch') pts.push([R - NW, T], [R - NW, T + ND], [R, T + ND], [R, B])
  else pts.push([R, T], [R, B])
  return pts
}

export function endGlyphDataUrl(a, b) {
  const key = `${a}|${b}`
  if (glyphCache.has(key)) return glyphCache.get(key)
  const c = document.createElement('canvas')
  c.width = GLYPH_W
  c.height = GLYPH_H
  const ctx = c.getContext('2d')
  ctx.beginPath()
  glyphPoints(a, b).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
  ctx.closePath()
  ctx.fillStyle = '#c9ced6'
  ctx.fill()
  ctx.lineWidth = 2
  ctx.strokeStyle = '#111111'
  ctx.stroke()
  const url = c.toDataURL('image/png')
  glyphCache.set(key, url)
  return url
}

// html2pdf's worker is a thenable: the whole chain (.set().from().save()) is built before it is awaited, exactly as
// downloadPDF in pdf.js does. One `.stk-page` element per PDF page; no break after the last one (no blank last page).
// A4 is always portrait (3 × 70 mm across, 8 × 37 mm down); a roll label's orientation follows its own w × h.
export async function downloadStickersPdf(elementId, paper, filename) {
  const html2pdf = (await import('html2pdf.js')).default
  const element = document.getElementById(elementId)
  if (!element) { console.error('element not found:', elementId); return }
  await html2pdf().set({
    margin: 0,
    filename: filename || 'stickers.pdf',
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 3, useCORS: true, letterRendering: true, backgroundColor: '#ffffff' },
    jsPDF: { unit: 'mm', format: paper.sheet ? 'a4' : [paper.w, paper.h], orientation: !paper.sheet && paper.w > paper.h ? 'landscape' : 'portrait' },
    pagebreak: { mode: ['css'], after: '.stk-page:not(:last-child)' },
  }).from(element).save()
}
