// ============================================================
// One pipeline for "what does this invoice come to" in the create form, used by BOTH the summary card and the
// "กรอกยอดที่ต้องการเรียกเก็บ" back-solver, so the two can never disagree:
//   drawn value -> (deposit choice) -> tax offset -> VAT -> withholding -> retention -> cash actually received.
// Mirrors CreateInvoiceModal / handleMarkPaid (see invoiceCalc.chosenTaxOffset, invoiceDeposit.resolveDepositChoice).
// ============================================================
import { calcInvoiceTotals, chosenTaxOffset } from './invoiceCalc.js'
import { resolveDepositChoice } from './invoiceDeposit.js'
import { round2 } from './depositCalc.js'

/**
 * Deposit still free to deduct: the site's remaining balance minus what other UNPAID invoices have already reserved
 * (an unpaid invoice deducts its chosen amount only when it is marked paid, until then the balance looks untouched).
 * @param {Array<{deposit_deduction_amount:any, status:string, is_deposit?:boolean}>} openInvoices invoices of the site
 */
export function reservedDepositTotal(invoices) {
  return round2((invoices || []).reduce((s, inv) => {
    if (!inv || inv.status !== 'unpaid' || inv.is_deposit) return s
    return s + Math.max(0, Number(inv.deposit_deduction_amount) || 0)
  }, 0))
}

export function availableDeposit(remainingBalance, reserved) {
  return Math.max(0, round2((Number(remainingBalance) || 0) - (Number(reserved) || 0)))
}

/**
 * @param {object} p
 * @param {number} p.raw                value drawn this period (sum of the invoice lines)
 * @param {boolean} p.hasVat
 * @param {boolean} p.priceIncludesVat
 * @param {number} p.whtPct             withholding % (0 = none)
 * @param {number} p.retentionPct       site retention %
 * @param {number} p.availableOffset    deposit tax still unused on the quotation (legacy offset when no deposit choice)
 * @param {{enabled:boolean, mode:string, text:string, balance:number}} p.deposit  the deposit choice (enabled=false: box hidden)
 */
export function computeInvoiceNet({ raw, hasVat, priceIncludesVat, whtPct, retentionPct, availableOffset, deposit }) {
  const lines = [{ line_total: Number(raw) || 0 }]
  const opts = { hasVat, priceIncludesVat }
  const base = calcInvoiceTotals(lines, { ...opts, depositTaxOffset: 0 })
  const dep = deposit?.enabled
    ? resolveDepositChoice({ subtotal: base.subtotal, mode: deposit.mode, text: deposit.text, balance: deposit.balance })
    : null
  const taxOffset = dep ? chosenTaxOffset(dep.amount, availableOffset) : Math.max(0, Number(availableOffset) || 0)
  const totals = calcInvoiceTotals(lines, { ...opts, depositTaxOffset: taxOffset })
  const whtBase = Math.max(0, totals.subtotal - taxOffset)
  const wht = round2(whtBase * (Number(whtPct) || 0) / 100)
  const retention = round2(totals.subtotal * (Number(retentionPct) || 0) / 100)
  const depositAmount = dep ? dep.amount : 0
  const net = round2(totals.subtotal + totals.vat - wht - retention - depositAmount)
  return { baseSubtotal: base.subtotal, subtotal: totals.subtotal, vat: totals.vat, total: totals.total, taxOffset, whtBase, wht, retention, dep, depositAmount, net }
}

/**
 * The drawn value whose cash received equals `targetNet` (bisection: received cash only ever grows with the drawn
 * value). Capped at `maxRaw` (everything still open); returns maxRaw when even that falls short.
 */
export function solveRawForNet(targetNet, params, maxRaw) {
  const target = Number(targetNet) || 0
  const max = Math.max(0, Number(maxRaw) || 0)
  if (target <= 0 || max <= 0) return 0
  const netAt = (raw) => computeInvoiceNet({ ...params, raw }).net
  if (netAt(max) <= target) return max
  let lo = 0
  let hi = max
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (netAt(mid) < target) lo = mid
    else hi = mid
  }
  return round2(hi)
}
