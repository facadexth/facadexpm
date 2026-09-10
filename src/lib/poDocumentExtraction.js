// ============================================================
// PO document-scan extraction -- pure validation/sizing logic used by
// both the Suppliers-page calibration flow and the PO create form's
// "upload from photo" control (see
// docs/superpowers/specs/2026-09-10-po-document-scan-extraction-design.md).
// The actual AI call lives server-side (supabase/functions/extract-po-
// document) -- this file only shapes what goes in (image sizing) and
// validates what comes back, so a malformed AI response can never crash
// the form it's about to pre-fill.
// ============================================================

/** Target size for an image before it's sent to the extraction API or
 *  stored as a calibration example -- never upscales, only shrinks the
 *  longest side down to maxDim. */
export function computeDownscaledSize(width, height, maxDim = 1600) {
  if (width <= maxDim && height <= maxDim) return { width, height }
  const scale = width >= height ? maxDim / width : maxDim / height
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

function toFiniteNumber(v) {
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : null
}

/** Normalizes and defensively validates the extraction edge function's
 *  JSON response. Never throws -- returns { ok:false, error } for
 *  anything unusable instead, so a bad AI response degrades to "nothing
 *  pre-filled" rather than a crash or garbage data in the form. */
export function validateExtraction(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'ผลลัพธ์จาก AI ไม่ใช่ข้อมูลที่ถูกต้อง' }
  }
  if (!Array.isArray(raw.line_items)) {
    return { ok: false, error: 'ผลลัพธ์จาก AI ไม่มี line_items' }
  }

  const line_items = raw.line_items
    .map(it => {
      if (!it || typeof it !== 'object') return null
      const description = typeof it.description === 'string' ? it.description.trim() : ''
      if (!description) return null
      const quantity = toFiniteNumber(it.quantity)
      const unit_price = toFiniteNumber(it.unit_price)
      return {
        description,
        quantity: quantity ?? 0,
        unit: typeof it.unit === 'string' ? it.unit : '',
        unit_price: unit_price ?? 0,
      }
    })
    .filter(Boolean)

  return {
    ok: true,
    data: {
      supplier_name_guess: typeof raw.supplier_name_guess === 'string' ? raw.supplier_name_guess : null,
      document_date_guess: typeof raw.document_date_guess === 'string' ? raw.document_date_guess : null,
      reference_no_guess: typeof raw.reference_no_guess === 'string' ? raw.reference_no_guess : null,
      line_items,
    },
  }
}

/** Reads a browser File, downscales it via canvas, and returns a JPEG
 *  base64 payload (no data: URL prefix) ready to send to the edge
 *  function or store as a calibration example. Browser-only (Image +
 *  canvas) -- not unit tested, verified manually per Task 8. */
export async function fileToDownscaledBase64(file, maxDim = 1600) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
  const img = await new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('อ่านไฟล์รูปภาพไม่สำเร็จ'))
    image.src = dataUrl
  })
  const { width, height } = computeDownscaledSize(img.naturalWidth, img.naturalHeight, maxDim)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d').drawImage(img, 0, 0, width, height)
  const outUrl = canvas.toDataURL('image/jpeg', 0.85)
  return { base64: outUrl.split(',')[1], mimeType: 'image/jpeg' }
}

/** Converts a Blob (e.g. downloaded from Supabase Storage) to a bare
 *  base64 string, no data: URL prefix. Used to re-encode an already-
 *  downscaled saved calibration example for a future extraction call. */
export async function blobToBase64(blob) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
  return dataUrl.split(',')[1]
}
