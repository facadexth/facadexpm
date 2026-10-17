import { collectTextLines, writeTextLayer, loadTextLayerFont, registerTextLayerFont, TEXT_LAYER_FONT } from './pdfTextLayer.js'
// count = จำนวนครั้งที่เคยพิมพ์เอกสารนี้มาก่อน (ไม่รวมครั้งนี้) -- ครั้งแรก
// (count===0) คือ "ต้นฉบับ" ตัวจริง ครั้งต่อๆ ไปคือสำเนา เลขลำดับนับรวมครั้งนี้
// ด้วย (count+1) ดู useDocumentPrintCount/logDocumentPrint ใน useSupabase.js
export function printTagFor(count) {
  return count > 0 ? `สำเนาที่ ${count + 1}` : 'ต้นฉบับ'
}

// Exports must look the same whichever device pressed the button. html2canvas
// re-lays the page out in a hidden iframe as wide as this, so phone-only CSS
// (src/mobile.css, max-width 900px) never reaches a captured document.
export const CAPTURE_WINDOW_WIDTH = 1280
// The document's own width on paper: A4 210mm minus 10mm left+right margins =
// 190mm = 718px at 96dpi -- the width html2pdf lays a PDF out at, and
// PAGE_WIDTH_PX in src/hooks/usePaginatedDocument.jsx.
export const A4_CONTENT_WIDTH_PX = 718

/**
 * สร้าง PDF จาก HTML element
 * ใช้ html2pdf.js ซึ่งรองรับ Thai font ผ่าน canvas rendering
 */
export function pdfOptions({ margin = 10, scale = 2, filename } = {}) {
  return {
    margin:      [margin, margin, margin, margin],
    filename:    filename || 'document.pdf',
    image:       { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale, useCORS: true, letterRendering: true, backgroundColor: '#ffffff', windowWidth: CAPTURE_WINDOW_WIDTH },
    jsPDF:       { unit: 'mm', format: 'a4', orientation: 'portrait' },
  }
}

/**
 * Build the PDF for an element: the picture html2pdf paints, plus an invisible text
 * layer (src/lib/pdfTextLayer.js) so the PDF can be searched, selected and indexed
 * (Drive, Gmail, accounting tools). Best-effort: if the font cannot be fetched or the
 * layer throws, the picture-only PDF is still produced. Resolves to `{ worker }`, the
 * html2pdf worker holding the finished jsPDF (`.save()` / `.outputPdf()`). Wrapped in
 * an object on purpose: the worker is a thenable, so returning it bare from an async
 * function would hand the caller the chain's resolved value (undefined), not the worker.
 */
export async function buildPDF(html2pdf, element, options) {
  const fontB64 = await loadTextLayerFont()
  let lines = null, containerRect = null, pageSize = null, margin = null
  const worker = html2pdf().set(options).from(element)
    .toContainer()
    .then(function () {
      if (!fontB64) return
      try {
        // this.prop.container is html2pdf's own clone (page-break spacers applied),
        // laid out at the page's inner width; measure there, not on the live element.
        const container = this.prop.container
        containerRect = container.getBoundingClientRect()
        pageSize = this.prop.pageSize
        margin = this.opt.margin
        lines = collectTextLines(container)
      } catch (err) { console.warn('pdf text layer: measuring failed', err?.message); lines = null }
    })
    .toPdf()
    .get('pdf')
    .then(function (pdf) {
      if (!lines || !fontB64) return
      try {
        // The real page cut is in canvas pixels (html2pdf floors it), so hand the
        // canvas width and html2canvas scale over for exact page/offset maths.
        const canvas = this.prop.canvas ? { width: this.prop.canvas.width, scale: this.opt.html2canvas?.scale || 1 } : null
        registerTextLayerFont(pdf, fontB64)
        writeTextLayer(pdf, lines, containerRect, pageSize, margin, TEXT_LAYER_FONT, canvas)
      } catch (err) { console.warn('pdf text layer: writing failed', err?.message) }
    })
  return { worker }
}

export async function downloadPDF(elementId, filename, { margin = 10, scale = 2 } = {}) {
  const html2pdf = (await import('html2pdf.js')).default
  const element = document.getElementById(elementId)
  if (!element) { console.error('element not found:', elementId); return }

  const { worker } = await buildPDF(html2pdf, element, pdfOptions({ margin, scale, filename }))
  await worker.save()
}

/**
 * สร้าง JPG ขนาดหน้า A4 (150dpi: 1240×1754px) ให้หน้าตาเหมือนหน้าแรกของ PDF
 * ไม่ว่ากดจากมือถือ แท็บเล็ต หรือคอม: เอกสารถูกจัดหน้าใหม่ที่ความกว้าง 190mm
 * (A4_CONTENT_WIDTH_PX) แล้ววางในหน้า A4 เว้นขอบ 10mm ทุกด้านเท่า PDF ถ้ายาว
 * เกินหนึ่งหน้าจะย่อลงให้พอดีหน้า จัดกึ่งกลางแนวนอน
 */
export function jpgCaptureOptions() {
  return {
    scale: 2, useCORS: true, letterRendering: true, backgroundColor: '#ffffff',
    windowWidth: CAPTURE_WINDOW_WIDTH,
    // Before this, the capture took the element at its on-screen width, so a
    // phone's ~360px-wide modal came out as a narrow column on the A4 page.
    onclone: (_doc, el) => {
      el.style.width = A4_CONTENT_WIDTH_PX + 'px'
      el.style.maxWidth = 'none'
      el.style.boxSizing = 'border-box'
      el.style.transform = 'none'
    },
  }
}

export function a4JpgPlacement(capturedWidth, capturedHeight) {
  const A4_WIDTH = 1240
  const A4_HEIGHT = 1754
  const MARGIN = Math.round(A4_WIDTH * 10 / 210)  // 10mm, as downloadPDF
  const scale = Math.min((A4_WIDTH - 2 * MARGIN) / capturedWidth, (A4_HEIGHT - 2 * MARGIN) / capturedHeight)
  const width = capturedWidth * scale
  const height = capturedHeight * scale
  return { pageWidth: A4_WIDTH, pageHeight: A4_HEIGHT, x: (A4_WIDTH - width) / 2, y: MARGIN, width, height }
}

export async function downloadJPG(elementId, filename) {
  const html2canvas = (await import('html2canvas')).default
  const element = document.getElementById(elementId)
  if (!element) { console.error('element not found:', elementId); return }

  const captured = await html2canvas(element, jpgCaptureOptions())
  const at = a4JpgPlacement(captured.width, captured.height)
  const page = document.createElement('canvas')
  page.width = at.pageWidth
  page.height = at.pageHeight
  const ctx = page.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, at.pageWidth, at.pageHeight)
  ctx.drawImage(captured, at.x, at.y, at.width, at.height)

  const link = document.createElement('a')
  link.href = page.toDataURL('image/jpeg', 0.95)
  link.download = filename || 'document.jpg'
  link.click()
}
