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
 * field: 'date' | 'billing_date' (plain column) | 'due' (OR across
 * due_date/check_date — credit rows use due_date, cheque rows use
 * check_date; see docs/superpowers/specs/2026-08-17-expense-filters-credit-terms-design.md)
 */
export function applyDateFilter(query, field, from, to) {
  if (field === 'due') {
    if (from) query = query.or(`due_date.gte.${from},check_date.gte.${from}`)
    if (to)   query = query.or(`due_date.lte.${to},check_date.lte.${to}`)
  } else {
    if (from) query = query.gte(field, from)
    if (to)   query = query.lte(field, to)
  }
  return query
}
