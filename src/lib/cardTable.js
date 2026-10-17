// Pure helpers for CardTable (phone card view of a desktop <table>). Tested in cardTable.test.js.
// A card has: title (left, bold) · amount (right, bold) · sub lines (muted) · label:value rows · status pill · actions.
// Roles are inferred from the header texts and one sample row so most tables need no map at all;
// `map` overrides any role by header text (cleaned) or column index.

const SORT_GLYPHS = /[\s ]*[↑↓↕⇅▲▼]+[\s ]*$/
export function cleanLabel(text) { return String(text || '').replace(SORT_GLYPHS, '').trim() }

const MONEY = /ยอด|มูลค่า|ราคา|รวม|จำนวนเงิน|บาท|คงเหลือ|ค้าง|amount|total|value|net|vat/i
const INDEX = /^(#|ลำดับ|no\.?)$/i

/** sampleRow = [{ text, numeric, hasBadge, hasButton }] or null (empty table). Returns one role per column:
 *  'title' | 'amount' | 'status' | 'actions' | 'sub' | 'row' | 'hide'. */
export function inferRoles(headers, sampleRow, map = {}) {
  const n = headers.length
  const roles = new Array(n).fill('row')
  const labels = headers.map(cleanLabel)
  const used = new Set()
  const idx = ref => (typeof ref === 'number' ? ref : labels.indexOf(ref))
  const setRole = (ref, role) => { const i = idx(ref); if (i >= 0 && i < n) { roles[i] = role; used.add(i) } }
  const free = i => !used.has(i)
  const row = sampleRow || []
  const cell = i => row[i] || {}

  const hide = map.hide ?? labels.map((l, i) => (INDEX.test(l) ? i : -1)).filter(i => i >= 0)
  hide.forEach(h => setRole(h, 'hide'))
  if (map.title !== undefined) setRole(map.title, 'title')
  if (map.amount !== undefined) setRole(map.amount, 'amount')
  if (map.status !== undefined) setRole(map.status, 'status')
  if (map.actions !== undefined) setRole(map.actions === 'last' ? n - 1 : map.actions, 'actions')
  ;(map.sub || []).forEach(s => setRole(s, 'sub'))

  if (map.actions === undefined && n > 0 && free(n - 1) && (cell(n - 1).hasButton || (labels[n - 1] === '' && !cell(n - 1).text))) setRole(n - 1, 'actions')
  if (map.status === undefined) { const i = row.findIndex((c, k) => free(k) && c.hasBadge); if (i >= 0) setRole(i, 'status') }
  if (map.amount === undefined) {
    for (let i = n - 1; i >= 0; i--) {
      if (free(i) && MONEY.test(labels[i]) && (cell(i).numeric || !sampleRow || !cell(i).text)) { setRole(i, 'amount'); break }
    }
  }
  if (map.title === undefined) {
    const i = labels.findIndex((l, k) => free(k) && !cell(k).numeric && !cell(k).hasBadge && !cell(k).hasButton)
    if (i >= 0) setRole(i, 'title')
  }
  if (!map.sub) {
    let left = 2
    for (let i = 0; i < n && left > 0; i++) {
      if (free(i) && !cell(i).numeric && !cell(i).hasBadge && !cell(i).hasButton) { setRole(i, 'sub'); left-- }
    }
  }
  return roles
}

const NUMERIC = /^[-+−]?\s*[\d,]+(\.\d+)?\s*(บาท|%|฿)?$/
/** Shape of one cell for inferRoles, from a <td>. */
export function describeCell(td) {
  const text = (td.textContent || '').trim()
  return {
    text,
    numeric: text !== '' && NUMERIC.test(text),
    hasBadge: !!td.querySelector('[class*="badge"], [class*="status"], [class*="pill"]'),
    hasButton: !!td.querySelector('button, a, [role="button"], input[type="checkbox"]'),
  }
}
