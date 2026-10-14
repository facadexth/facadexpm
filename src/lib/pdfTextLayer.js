// Invisible, searchable text layer for the PDFs downloadPDF() makes.
//
// html2pdf.js paints the document as a picture (html2canvas -> JPEG per page), so the
// PDF had no text: nothing to search, select or copy, and Drive/Gmail/accounting tools
// could not index it. This module reads every line of text and where it sits inside
// html2pdf's own render container, then writes the same text at the same place into
// the finished jsPDF in "invisible" rendering mode -- what a scanner's OCR layer does,
// but exact. The picture stays the visible layer, so documents look identical.
//
// Geometry (html2pdf.js 0.14): the container is laid out `inner.width` mm wide
// (A4 210 - margins), the canvas is split into pages of
// `containerWidthPx * inner.height / inner.width` px, and each page image is placed at
// (margin-left, margin-top) scaled to inner width/height. So 1 container px =
// inner.width / containerWidthPx mm, on every page.

const PT_PER_MM = 72 / 25.4

/** Where one line box lands in the PDF: page index (0-based) and mm coordinates. */
export function placeLine(rect, containerRect, pageSize, margin) {
  const ratio = pageSize.inner.width / containerRect.width
  const pagePx = containerRect.width * (pageSize.inner.height / pageSize.inner.width)
  const xPx = rect.left - containerRect.left
  const yPx = rect.top - containerRect.top
  // Use the line's vertical middle to pick the page, so a line box that straddles the
  // page cut lands on the page that shows most of it.
  const page = Math.max(0, Math.floor((yPx + rect.height / 2) / pagePx))
  return {
    page,
    x: margin[3] + xPx * ratio,
    y: margin[0] + (yPx - page * pagePx) * ratio,
    width: rect.width * ratio,
    height: rect.height * ratio,
  }
}

/**
 * Group per-character boxes of one text node into visual lines. Thai wraps anywhere
 * (no spaces between words), so lines are found from the boxes, not from the text.
 * chars: [{ ch, rect }] in document order; zero-width boxes (combining marks) join the
 * current line. Returns [{ text, left, top, right, bottom }].
 */
export function groupCharsIntoLines(chars) {
  const lines = []
  let cur = null
  for (const { ch, rect } of chars) {
    if (!rect || (rect.width === 0 && rect.height === 0)) { if (cur) cur.text += ch; continue }
    const sameLine = cur && Math.abs(rect.top - cur.top) < Math.max(cur.bottom - cur.top, rect.height) * 0.5
    if (sameLine) {
      cur.text += ch
      cur.left = Math.min(cur.left, rect.left)
      cur.right = Math.max(cur.right, rect.right)
      cur.top = Math.min(cur.top, rect.top)
      cur.bottom = Math.max(cur.bottom, rect.bottom)
    } else {
      cur = { text: ch, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
      lines.push(cur)
    }
  }
  return lines.map(l => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() })).filter(l => l.text && l.right > l.left)
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'OPTION'])

/** Every visible text line inside `root` with its box (viewport coordinates) and font size. */
export function collectTextLines(root, doc = root.ownerDocument) {
  const win = doc.defaultView
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */)
  const out = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue
    if (!text || !text.trim()) continue
    const parent = node.parentElement
    if (!parent || SKIP_TAGS.has(parent.tagName)) continue
    const style = win.getComputedStyle(parent)
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue
    const range = doc.createRange()
    const chars = []
    for (let i = 0; i < text.length; i++) {
      range.setStart(node, i)
      range.setEnd(node, i + 1)
      const r = range.getClientRects()[0]
      chars.push({ ch: text[i], rect: r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : null })
    }
    const fontPx = parseFloat(style.fontSize) || 12
    for (const line of groupCharsIntoLines(chars)) out.push({ ...line, fontPx })
  }
  return out
}

/** Write the collected lines into `pdf` as invisible text. Pages beyond the PDF are skipped. */
export function writeTextLayer(pdf, lines, containerRect, pageSize, margin, fontName) {
  const pages = pdf.getNumberOfPages()
  const ratio = pageSize.inner.width / containerRect.width
  pdf.setFont(fontName, 'normal')
  let written = 0
  for (const line of lines) {
    const rect = { left: line.left, top: line.top, width: line.right - line.left, height: line.bottom - line.top }
    const pos = placeLine(rect, containerRect, pageSize, margin)
    if (pos.page >= pages) continue
    const sizePt = Math.max(1, line.fontPx * ratio * PT_PER_MM)
    pdf.setPage(pos.page + 1)
    pdf.setFontSize(sizePt)
    const natural = pdf.getTextWidth(line.text)
    const horizontalScale = natural > 0 ? Math.min(3, Math.max(0.2, pos.width / natural)) : 1
    // Baseline roughly 80% down the line box for Thai/Latin text at this size.
    pdf.text(line.text, pos.x, pos.y + Math.min(pos.height, sizePt / PT_PER_MM) * 0.8, { renderingMode: 'invisible', horizontalScale })
    written++
  }
  return written
}

let fontPromise = null
/** Sarabun Regular (OFL) as base64, fetched once per session; null if unavailable. */
export function loadTextLayerFont(url = '/fonts/Sarabun-Regular.ttf') {
  if (!fontPromise) {
    fontPromise = fetch(url).then(async r => {
      if (!r.ok) throw new Error(`font ${r.status}`)
      const bytes = new Uint8Array(await r.arrayBuffer())
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
      return btoa(bin)
    }).catch(err => { console.warn('pdf text layer: font not loaded', err?.message); fontPromise = null; return null })
  }
  return fontPromise
}

export const TEXT_LAYER_FONT = 'Sarabun'

/** Register the font on a jsPDF instance (idempotent per instance). */
export function registerTextLayerFont(pdf, base64) {
  const file = 'Sarabun-Regular.ttf'
  pdf.addFileToVFS(file, base64)
  pdf.addFont(file, TEXT_LAYER_FONT, 'normal')
}
