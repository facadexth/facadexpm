// ============================================================
// Gantt timeline math — pure functions, no React/DOM dependency.
// Worked example used to hand-verify this file (see Task 4 Step 4):
//   site A: phase "ผลิต" 2026-08-01..2026-08-10, phase "ติดตั้ง" 2026-08-11..2026-08-20
//   range = { start: 2026-08-01, end: 2026-08-20 } (19 days total)
//   "ผลิต" bar: left 0%, width ~47.4% (9/19 days)
//   "ติดตั้ง" bar: left ~52.6%, width ~47.4%
//   "ติดตั้ง".depends_on_phase_id = "ผลิต".id -> arrow from x=47.4% to x=52.6%
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

/**
 * One site's phases -> arrow endpoints (in 0-100 x-coordinates) for every
 * phase whose depends_on_phase_id points at another phase that ALSO has
 * both dates set. Soft/informational only: a phase with no dependency, or
 * whose dependency has no dates yet, is silently skipped (no arrow drawn,
 * never an error).
 */
export function computeDependencyArrows(phases, range) {
  const byId = {}
  phases.forEach((p) => { byId[p.id] = p })
  const arrows = []
  phases.forEach((p) => {
    if (!p.depends_on_phase_id) return
    const dep = byId[p.depends_on_phase_id]
    if (!dep) return
    const depBar = barStyle(dep, range)
    const thisBar = barStyle(p, range)
    if (!depBar || !thisBar) return
    const fromX = parseFloat(depBar.left) + parseFloat(depBar.width)
    const toX = parseFloat(thisBar.left)
    arrows.push({ fromX, toX })
  })
  return arrows
}

/**
 * Same as computeDependencyArrows, but for the one-phase-per-row layout
 * (single-site detail view): also carries which row each endpoint sits on
 * (index into the SAME `phases` array the caller renders rows from), so an
 * arrow between two different phases can be drawn as a line spanning
 * multiple stacked rows instead of a single shared track.
 */
export function computeDependencyArrowsByRow(phases, range) {
  const byId = {}
  const rowById = {}
  phases.forEach((p, i) => { byId[p.id] = p; rowById[p.id] = i })
  const arrows = []
  phases.forEach((p, row) => {
    if (!p.depends_on_phase_id) return
    const dep = byId[p.depends_on_phase_id]
    if (!dep) return
    const depBar = barStyle(dep, range)
    const thisBar = barStyle(p, range)
    if (!depBar || !thisBar) return
    const fromX = parseFloat(depBar.left) + parseFloat(depBar.width)
    const toX = parseFloat(thisBar.left)
    arrows.push({ fromX, toX, fromRow: rowById[p.depends_on_phase_id], toRow: row })
  })
  return arrows
}

/**
 * Month-boundary tick labels within [range.start, range.end], positioned
 * as 0-100 x-coordinates, for a header row above a per-phase-row Gantt.
 */
export function computeMonthTicks(range) {
  if (!range) return []
  const ticks = []
  let cursor = new Date(range.start.getFullYear(), range.start.getMonth(), 1)
  const end = range.end
  while (cursor <= end) {
    ticks.push({ date: new Date(cursor), x: positionPercent(cursor.toISOString().slice(0, 10), range) })
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
  }
  return ticks
}
