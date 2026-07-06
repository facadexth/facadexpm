// ============================================================
// Gantt timeline math — pure functions, no React/DOM dependency.
// Worked example used to hand-verify this file (see Task 4 Step 4):
//   site A: phase "ผลิต" 2026-08-01..2026-08-10, phase "ติดตั้ง" 2026-08-11..2026-08-20
//   range = { start: 2026-08-01, end: 2026-08-20 } (19 days total)
//   "ผลิต" bar: left 0%, width ~47.4% (9/19 days)
//   "ติดตั้ง" bar: left ~52.6%, width ~47.4%
// ============================================================

export const STATUS_COLOR = {
  not_started: 'var(--text3)',
  in_progress: 'var(--yellow)',
  done: 'var(--green)',
}

/**
 * Spans every site's phase dates (falling back to the site's own
 * start_date/end_date when it has no dated phases yet).
 */
export function computeTimelineRange(sites, phasesBySite) {
  const dates = []
  sites.forEach((site) => {
    const phases = phasesBySite[site.id] || []
    let sitePhaseDatesFound = false
    phases.forEach((p) => {
      if (p.start_date) { dates.push(new Date(p.start_date)); sitePhaseDatesFound = true }
      if (p.end_date)   { dates.push(new Date(p.end_date));   sitePhaseDatesFound = true }
    })
    if (!sitePhaseDatesFound) {
      if (site.start_date) dates.push(new Date(site.start_date))
      if (site.end_date)   dates.push(new Date(site.end_date))
    }
  })
  if (dates.length === 0) return null
  return {
    start: new Date(Math.min(...dates)),
    end: new Date(Math.max(...dates)),
  }
}

/** Where a date falls within [range.start, range.end], as 0-100. */
export function positionPercent(dateStr, range) {
  if (!dateStr || !range) return null
  const d = new Date(dateStr)
  const totalMs = range.end - range.start
  if (totalMs <= 0) return 0
  const offsetMs = d - range.start
  return Math.min(100, Math.max(0, (offsetMs / totalMs) * 100))
}

/** CSS left/width for one phase's bar, or null if it has no dates yet. */
export function barStyle(phase, range) {
  if (!phase.start_date || !phase.end_date || !range) return null
  const left = positionPercent(phase.start_date, range)
  const right = positionPercent(phase.end_date, range)
  return { left: `${left}%`, width: `${Math.max(right - left, 1)}%` }
}
