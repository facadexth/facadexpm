// Layout data + helpers for the official หนังสือรับรองการหักภาษี ณ ที่จ่าย (มาตรา 50 ทวิ) form.
// All coordinates are PDF points on the A4 page (595 x 842, origin bottom-left) taken from the
// Revenue Department's own PDF (DOC/approve_wh3_081156.pdf): form-field rectangles and the
// printed cell lines. The page background is src/assets/forms/wht-50tawi-bg.png.

export const PAGE = { w: 595, h: 842 }

// 13-digit ID row: 5 groups of cells (1-4-5-2-1). [left edge, right edge] of each group.
export const ID_GROUPS = {
  payer: [[374.2, 386.1], [392.2, 440.2], [446.7, 507.2], [512.7, 537.2], [544.1, 556.4]],
  payee: [[374.8, 386.8], [392.8, 440.8], [447.3, 507.8], [513.3, 537.8], [544.9, 556.7]],
}
export const ID_GROUP_SIZES = [1, 4, 5, 2, 1]
export const ID_ROW_Y = { payer: [744.0, 758.7], payee: [675.6, 690.3] }

// The centre x of each of the 13 digit cells.
export function idCellCenters(groups) {
  const out = []
  groups.forEach(([x0, x1], gi) => {
    const n = ID_GROUP_SIZES[gi]
    const w = (x1 - x0) / n
    for (let i = 0; i < n; i++) out.push(x0 + w * (i + 0.5))
  })
  return out
}

// Keeps digits only, at most 13.
export const digits13 = (v) => String(v ?? '').replace(/\D/g, '').slice(0, 13)

// "12,345.60" -> { baht: '12,345', satang: '60' }
export function splitMoney(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return { baht: '', satang: '' }
  const [b, s] = v.toFixed(2).split('.')
  return { baht: Number(b).toLocaleString('en-US'), satang: s }
}

const MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม']

// 'YYYY-MM-DD' (or ISO timestamp) -> { day: '5', month: 'ตุลาคม', year: '2569', short: '05/10/2569' }; null when unreadable.
export function thaiDateParts(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''))
  if (!m) return null
  const y = Number(m[1]) + 543, mo = Number(m[2]), d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return { day: String(d), month: MONTHS[mo - 1], year: String(y), short: `${m[3]}/${m[2]}/${y}` }
}

// Font size (pt) so `text` fits `widthPt`, never above `maxPt` or below `minPt`.
// Thai/Latin average advance is roughly 0.5em.
export function fitFontPt(text, widthPt, maxPt = 10, minPt = 6) {
  const len = String(text ?? '').length
  if (!len) return maxPt
  return Math.max(minPt, Math.min(maxPt, widthPt / (len * 0.52)))
}
