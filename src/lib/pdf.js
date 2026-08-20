/**
 * สร้าง PDF จาก HTML element
 * ใช้ html2pdf.js ซึ่งรองรับ Thai font ผ่าน canvas rendering
 */
export async function downloadPDF(elementId, filename) {
  const html2pdf = (await import('html2pdf.js')).default
  const element = document.getElementById(elementId)
  if (!element) { console.error('element not found:', elementId); return }

  await html2pdf().set({
    margin:      [10, 10, 10, 10],
    filename:    filename || 'document.pdf',
    image:       { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true, letterRendering: true },
    jsPDF:       { unit: 'mm', format: 'a4', orientation: 'portrait' }
  }).from(element).save()
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
