// ============================================================
// expenseFilters — pure query-building logic for useExpenses'
// date-type filter, extracted from src/hooks/useSupabase.js so
// it's unit-testable against a fake query builder (no Supabase
// client needed).
// ============================================================

/**
 * Applies a from/to date-range filter to a PostgREST-style query builder
 * (any object with .or()/.gte()/.lte() that return the builder, e.g. the
 * real supabase-js query or a test double).
 *
 * field: 'date' | 'billing_date' (plain column) | 'due' (COALESCE(check_date,
 * due_date, date) — cheque rows use check_date, credit rows use due_date,
 * everything else (transfer/cash, or a credit/cheque row that hasn't been
 * given a specific due_date/check_date yet) falls back to the plain
 * transaction date. MUST match payment_forecast's own COALESCE ordering
 * (supabase/schema.sql) exactly, or the Dashboard's "ยอดที่ต้องชำระ" total
 * and clicking through to Expenses filtered by the same month show
 * different numbers — see 2026-09-01 dashboard/expenses total mismatch bug.
 *
 * check_date MUST be checked first, not due_date: a cheque-linked expense
 * can carry a stale due_date left over from before it was linked (e.g.
 * auto-filled from the supplier's credit term when payment_method was
 * still 'transfer', never cleared after switching to 'check' and linking
 * a cheque) — if due_date won the coalesce, the expense would forecast
 * under its old credit-term month instead of the cheque's real due date,
 * even though check_date (kept in sync with the cheque itself) has the
 * correct answer. Reproduced live on real data: 11 real expenses had
 * both columns set to different months, all cheque-linked, all showing
 * the wrong (earlier) month before this fix — see
 * 2026-09-02-05-fix-payment-forecast-check-date-priority.sql.
 *
 * NOTE this used to be two separate .or() range calls (due_date.gte OR
 * check_date.gte, AND SEPARATELY due_date.lte OR check_date.lte) --
 * that's not equivalent to a coalesce: it let one row's due_date lower
 * bound pair with an unrelated check_date upper bound and match rows
 * where NEITHER column was actually in range. Encoded here as three
 * mutually exclusive and() branches instead, so exactly one column's
 * value (in coalesce priority order) is ever tested against the range.
 */
export function applyDateFilter(query, field, from, to) {
  if (field === 'due') {
    if (!from && !to) return query
    const bounds = (col) => {
      const parts = []
      if (from) parts.push(`${col}.gte.${from}`)
      if (to)   parts.push(`${col}.lte.${to}`)
      return parts.join(',')
    }
    query = query.or([
      `and(check_date.not.is.null,${bounds('check_date')})`,
      `and(check_date.is.null,due_date.not.is.null,${bounds('due_date')})`,
      `and(check_date.is.null,due_date.is.null,${bounds('date')})`,
    ].join(','))
  } else {
    if (from) query = query.gte(field, from)
    if (to)   query = query.lte(field, to)
  }
  return query
}
