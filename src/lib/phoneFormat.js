// Pure formatting helpers for the phone cards (mobile-view round 1b). Tested in phoneFormat.test.js.

/** 14017214 → '14.02M', 668500 → '668.5K', 950 → '950', -1426007 → '-1.43M'; sign: true adds '+' to positives. */
export function fmtCompact(n, { sign = false } = {}) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  const abs = Math.abs(v)
  const pre = v < 0 ? '-' : (sign && v > 0 ? '+' : '')
  const trim = s => s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
  if (abs >= 1e6) return pre + trim((abs / 1e6).toFixed(2)) + 'M'
  if (abs >= 1e3) return pre + trim((abs / 1e3).toFixed(1)) + 'K'
  return pre + String(Math.round(abs))
}

/** Expense as a share of income for the site card bar: { pct, over, label } or null when there is nothing to compare. */
export function spendRatio(income, expense) {
  const i = Number(income) || 0, e = Number(expense) || 0
  if (i <= 0 && e <= 0) return null
  if (i <= 0) return { pct: 100, over: true, label: 'ยังไม่มีรายรับ' }
  const pct = (e / i) * 100
  return { pct, over: pct > 100, label: `${Math.round(pct)}%` }
}

/** Days between two ISO dates (b - a), whole days, Bangkok calendar dates expected. */
export function daysBetween(aIso, bIso) {
  const a = Date.parse(String(aIso).slice(0, 10) + 'T00:00:00Z'), b = Date.parse(String(bIso).slice(0, 10) + 'T00:00:00Z')
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.round((b - a) / 86400000)
}

/** Short status line for a quotation card: { text, tone } where tone is '' | 'warn' | 'bad'. */
export function quotationNote(qt, total, todayIso) {
  if (qt?.status === 'sent' && qt.on_hold) return { text: 'พักไว้ (เลยวันยืนราคา)', tone: 'warn' }
  if (qt?.status === 'sent' && qt.valid_until) {
    const d = daysBetween(todayIso, qt.valid_until)
    if (d == null) return { text: '', tone: '' }
    if (d < 0) return { text: `เลยวันยืนราคา ${-d} วัน`, tone: 'bad' }
    return { text: d === 0 ? 'หมดอายุวันนี้' : `หมดอายุใน ${d} วัน`, tone: d <= 7 ? 'warn' : '' }
  }
  if (qt?.status === 'draft' && !(Number(total) > 0)) return { text: 'ยังไม่ใส่ราคา', tone: 'warn' }
  return { text: '', tone: '' }
}
