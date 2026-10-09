// ============================================================
// Deposit deduction chosen while CREATING an invoice (not at payment time).
//
// The user picks one of three modes for this one invoice:
//   'none'  -> deduct nothing
//   'pct'   -> deduct a % of this invoice's pre-VAT subtotal
//   'value' -> deduct a fixed pre-VAT amount in baht
// The result can never exceed the site's remaining deposit balance. VAT and
// withholding-tax bases are NOT touched here (they follow the deposit
// invoices' tax offset, see invoiceCalc.calcInvoiceTotals).
// ============================================================
import { round2 } from './depositCalc.js'

/** Parse what the user typed; blank / non-numeric / negative -> 0. */
export function parseAmount(text) {
  const v = parseFloat(text)
  return Number.isFinite(v) && v > 0 ? v : 0
}

/** Keep digits and a single decimal point (the field is a plain text input, no spinner). */
export function cleanDecimalText(text) {
  const s = String(text ?? '').replace(/[^0-9.]/g, '')
  const dot = s.indexOf('.')
  return dot < 0 ? s : s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '')
}

function floor2(n) { return Math.floor(n * 100 + 1e-9) / 100 }

/**
 * @param {{subtotal:number, mode:'none'|'pct'|'value', text:string, balance:number}} p
 * @returns {{amount:number, pct:number, over:boolean, cappedText:string}}
 *   amount     the deduction to store (0 <= amount <= min(balance, subtotal), 2dp)
 *   pct        amount as % of subtotal (2dp), for display
 *   over       true when what was typed exceeds the limit (remaining deposit balance or this invoice's subtotal)
 *   cappedText what the field should show once capped (floored so it never re-exceeds)
 */
export function resolveDepositChoice({ subtotal, mode, text, balance }) {
  const sub = Math.max(0, Number(subtotal) || 0)
  const bal = Math.max(0, round2(Number(balance) || 0))
  let wanted = 0
  if (mode === 'pct') wanted = round2(sub * parseAmount(text) / 100)
  else if (mode === 'value') wanted = round2(parseAmount(text))
  // can't deduct more than the deposit that is left, nor more than this invoice is worth
  const limit = Math.min(bal, round2(sub))
  const over = wanted > limit + 1e-9
  const amount = over ? limit : wanted
  const pct = sub > 0 ? round2(amount / sub * 100) : 0
  let cappedText = text
  if (over) cappedText = mode === 'pct' ? String(sub > 0 ? floor2(limit / sub * 100) : 0) : String(limit)
  return { amount, pct, over, cappedText, limit }
}

/** The amount for "deduct everything that is left" (never more than this invoice's own subtotal). */
export function fullDepositAmount(subtotal, balance) {
  return round2(Math.min(Math.max(0, Number(balance) || 0), Math.max(0, Number(subtotal) || 0)))
}
