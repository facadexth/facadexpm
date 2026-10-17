import { collectTextLines, writeTextLayer, loadTextLayerFont, registerTextLayerFont, TEXT_LAYER_FONT } from './pdfTextLayer.js'
// count = จำนวนครั้งที่เคยพิมพ์เอกสารนี้มาก่อน (ไม่รวมครั้งนี้) -- ครั้งแรก
// (count===0) คือ "ต้นฉบับ" ตัวจริง ครั้งต่อๆ ไปคือสำเนา เลขลำดับนับรวมครั้งนี้
// ด้วย (count+1) ดู useDocumentPrintCount/logDocumentPrint ใน useSupabase.js
export function printTagFor(count) {
  return count > 0 ? `สำเนาที่ ${count + 1}` : 'ต้นฉบับ'
}

/**
 * สร้าง PDF จาก HTML element
 * ใช้ html2pdf.js ซึ่งรองรับ Thai font ผ่าน canvas rendering
 */
export function pdfOptions({ margin = 10, scale = 2, filename, format = 'a4', orientation = 'portrait' } = {}) {
  return {
    margin:      [margin, margin, margin, margin],
    filename:    filename || 'document.pdf',
    image:       { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale, useCORS: true, letterRendering: true, backgroundColor: '#ffffff' },
    jsPDF:       { unit: 'mm', format, orientation },
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

export async function downloadPDF(elementId, filename, { margin = 10, scale = 2, format = 'a4', orientation = 'portrait' } = {}) {
  const html2pdf = (await import('html2pdf.js')).default
  const element = document.getElementById(elementId)
  if (!element) { console.error('element not found:', elementId); return }

  const { worker } = await buildPDF(html2pdf, element, pdfOptions({ margin, scale, filename, format, orientation }))
  await worker.save()
}

/**
 * สร้าง JPG จาก HTML element ขนาดหน้า A4 (150dpi: 1240×1754px)
 * เนื้อหาถูก scale ให้พอดีความกว้างของหน้า A4 แล้วชิดขอบบน (เว้น margin
 * กลางๆ) จัดกึ่งกลางแนวนอนเท่านั้น
 */
export async function downloadJPG(elementId, filename) {
  const html2canvas = (await import('html2canvas')).default
  const element = document.getElementById(elementId)
  if (!element) { console.error('element not found:', elementId); return }

  const captured = await html2canvas(element, { scale: 2, useCORS: true, letterRendering: true, backgroundColor: '#ffffff' })

  const A4_WIDTH = 1240
  const A4_HEIGHT = 1754
  // ~10mm at this canvas's ~150dpi (1754px / 297mm ≈ 5.9px/mm) -- chosen to
  // roughly match downloadPDF's own 10mm top page margin, though the two
  // pipelines aren't pixel-for-pixel comparable (downloadPDF applies its
  // margin symmetrically on all four sides via html2pdf.js/jsPDF; this
  // canvas only pins the top, with left/right purely center-derived and
  // bottom whatever falls out of the aspect ratio).
  const TOP_MARGIN = 60
  const page = document.createElement('canvas')
  page.width = A4_WIDTH
  page.height = A4_HEIGHT
  const ctx = page.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, A4_WIDTH, A4_HEIGHT)

  const scale = Math.min(A4_WIDTH / captured.width, (A4_HEIGHT - TOP_MARGIN) / captured.height)
  const drawWidth = captured.width * scale
  const drawHeight = captured.height * scale
  const offsetX = (A4_WIDTH - drawWidth) / 2
  const offsetY = TOP_MARGIN
  ctx.drawImage(captured, offsetX, offsetY, drawWidth, drawHeight)

  const link = document.createElement('a')
  link.href = page.toDataURL('image/jpeg', 0.95)
  link.download = filename || 'document.jpg'
  link.click()
}
