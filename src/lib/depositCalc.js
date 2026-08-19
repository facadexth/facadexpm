// ============================================================
// Client deposit (มัดจำ) deduction math -- see
// docs/superpowers/specs/2026-08-19-client-deposit-tracking-design.md.
//
// A 'มัดจำ' income row never deducts from itself. Every 'ปกติ' row for the
// same site auto-deducts a % of its own pre-VAT amount from the site's
// deposit balance, clamped so the running total deducted can never exceed
// the total deposit actually collected.
// ============================================================

export function round2(n) {
  return Math.round(n * 100) / 100
}

/**
 * @param {number} noVat - the row's pre-VAT amount
 * @param {number} depositPct - the % to deduct (site.default_deposit_pct,
 *   or a per-row override)
 * @param {number} remainingBalance - the deposit balance available to this
 *   row (site_deposit_summary.remaining_balance, with this row's own prior
 *   deduction added back in via remainingBalanceForEdit if this is an edit)
 * @returns {number} the deposit_deduction to apply, clamped to
 *   [0, remainingBalance], rounded to 2 decimal places
 */
export function calcDepositDeduction(noVat, depositPct, remainingBalance) {
  const proposed = round2((noVat || 0) * (depositPct || 0) / 100)
  const balance  = Math.max(0, remainingBalance || 0)
  return Math.min(proposed, balance)
}

/**
 * Adds a row's own previously-saved deposit_deduction back onto the site's
 * current remaining_balance. Without this, re-editing a row would be
 * charged against a balance that still includes that same row's earlier
 * deduction -- double counting. Pass 0/undefined for a brand-new row.
 */
export function remainingBalanceForEdit(siteRemainingBalance, rowPriorDeduction) {
  return (siteRemainingBalance || 0) + (rowPriorDeduction || 0)
}

export function depositStatusFor(row) {
  if (row.remaining_balance > 0) return { label: 'คงเหลือ', cls: 'badge-paid' }
  return { label: 'หักครบแล้ว', cls: 'badge-finished' }
}
