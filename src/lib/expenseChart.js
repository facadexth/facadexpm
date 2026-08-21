// Shared by Expenses.jsx's filtered-table pie chart and SiteOverviewModal's
// per-site breakdown -- both group the same expenses_view row shape
// (category_name, amount) into pie-chart-ready data.

export const CATEGORY_PALETTE = [
  '#6c63ff', '#00d4aa', '#ffd166', '#4ecdc4', '#ff6b6b',
  '#ba68ff', '#78beff', '#ff9f43', '#96dc78', '#ff8cbe',
]

export const OTHER_LABEL = 'อื่นๆ'
export const OTHER_COLOR = '#8a94a6'

const UNCATEGORIZED_LABEL = 'ไม่ระบุหมวด'

/** rows: [{ category_name, amount }] -> [{ name, value }] sorted by value desc */
export function categoryBreakdown(rows) {
  const totals = new Map()
  for (const r of rows || []) {
    const name = r.category_name || UNCATEGORIZED_LABEL
    totals.set(name, (totals.get(name) || 0) + (r.amount || 0))
  }
  return Array.from(totals, ([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
}

/**
 * Pie-chart-only decluttering: merges slices under `threshold` share of the
 * total into one trailing "อื่นๆ" bucket, so charts with many tiny categories
 * don't end up with overlapping labels. Leaves a single small slice alone —
 * bucketing it wouldn't declutter anything, only hide its name.
 */
export function groupSmallSlices(breakdown, threshold = 0.05) {
  const total = (breakdown || []).reduce((s, d) => s + d.value, 0)
  if (!total) return breakdown || []
  const big = breakdown.filter(d => d.value / total >= threshold)
  const small = breakdown.filter(d => d.value / total < threshold)
  if (small.length < 2) return breakdown
  const otherValue = small.reduce((s, d) => s + d.value, 0)
  return [...big, { name: OTHER_LABEL, value: otherValue }]
}
