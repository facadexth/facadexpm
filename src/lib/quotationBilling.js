// Per-quotation billing summary for the site overview: how much each accepted quotation is worth and how much of it
// has been billed ("เบิก"). Billed = invoices that are not void and not deposit invoices (same idea as the site's
// invoiced_pct): the deposit is a payment in advance, the work it covers is billed later by the progress invoices.
// Measured pre-VAT (invoice.subtotal vs quotation subtotal) so a fully billed quotation reads exactly 100% even though
// a later invoice's VAT is lower (the deposit invoice already paid VAT on its slice); baht are shown incl. VAT by
// scaling the quotation's total by that ratio.
import { round2 } from './depositCalc.js'

const num = (v) => Number(v) || 0

/**
 * @param {Array<{id:string, quotation_number:string, date:string, subtotal:number, total:number}>} quotations
 *   accepted quotations of ONE site with their calcQuotationTotals() figures
 * @param {Array<{quotation_id:string, subtotal:any, status:string, is_deposit?:boolean}>} invoices invoices of that site
 */
export function summarizeQuotationBilling(quotations, invoices) {
  const billedByQuotation = new Map()
  for (const inv of invoices || []) {
    if (!inv || inv.status === 'void' || inv.is_deposit) continue
    billedByQuotation.set(inv.quotation_id, (billedByQuotation.get(inv.quotation_id) || 0) + num(inv.subtotal))
  }
  const rows = (quotations || [])
    .map((q) => {
      const billedSubtotal = round2(billedByQuotation.get(q.id) || 0)
      const ratio = num(q.subtotal) > 0 ? billedSubtotal / num(q.subtotal) : 0
      const billedTotal = round2(num(q.total) * ratio)
      return {
        id: q.id,
        quotation_number: q.quotation_number,
        date: q.date,
        total: num(q.total),
        billedTotal,
        remainingTotal: round2(num(q.total) - billedTotal),
        pct: Math.round(ratio * 1000) / 10,
      }
    })
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
  const total = round2(rows.reduce((s, r) => s + r.total, 0))
  const billedTotal = round2(rows.reduce((s, r) => s + r.billedTotal, 0))
  return {
    rows,
    sum: { total, billedTotal, remainingTotal: round2(total - billedTotal), pct: total > 0 ? Math.round(billedTotal / total * 1000) / 10 : 0 },
  }
}
