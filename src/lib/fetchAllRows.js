/**
 * Supabase/PostgREST caps a single response at 1000 rows by default.
 * This walks `.range()` pages until a short page signals the end, so
 * list hooks return every matching row instead of silently truncating
 * past row 1000. `buildQuery` must return a fresh query each call
 * (query builders can't be re-awaited after their first request) and
 * should have a stable .order() so pages don't overlap or skip rows.
 */
export async function fetchAllRows(buildQuery, pageSize = 1000) {
  let allRows = []
  let from = 0
  while (true) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1)
    if (error) throw error
    allRows = allRows.concat(data || [])
    if (!data || data.length < pageSize) break
    from += pageSize
  }
  return allRows
}
