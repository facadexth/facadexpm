import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { computeTimelineRange, positionPercent, barStyle, phaseOverlapsRange, computeDependencyArrows, computeMonthTicks, expandRangeForTransactions } from './ganttTimeline.js'

describe('computeTimelineRange', () => {
  it('spans every dated phase across every site', () => {
    const sites = [{ id: 's1' }, { id: 's2' }]
    const phasesBySite = {
      s1: [{ start_date: '2026-08-01', end_date: '2026-08-10' }],
      s2: [{ start_date: '2026-08-05', end_date: '2026-08-20' }],
    }
    const range = computeTimelineRange(sites, phasesBySite)
    expect(range.start.toISOString().slice(0, 10)).toBe('2026-08-01')
    expect(range.end.toISOString().slice(0, 10)).toBe('2026-08-20')
  })

  it('falls back to the site\'s own start/end when it has no dated phases', () => {
    const sites = [{ id: 's1', start_date: '2026-01-01', end_date: '2026-02-01' }]
    const range = computeTimelineRange(sites, { s1: [] })
    expect(range.start.toISOString().slice(0, 10)).toBe('2026-01-01')
    expect(range.end.toISOString().slice(0, 10)).toBe('2026-02-01')
  })

  it('returns null when there are no dates anywhere', () => {
    expect(computeTimelineRange([{ id: 's1' }], { s1: [] })).toBeNull()
  })
})

describe('positionPercent', () => {
  const range = { start: new Date('2026-08-01'), end: new Date('2026-08-20') }
  it('places the range start at 0 and end at 100', () => {
    expect(positionPercent('2026-08-01', range)).toBe(0)
    expect(positionPercent('2026-08-20', range)).toBe(100)
  })
  it('clamps dates outside the range instead of going negative or past 100', () => {
    expect(positionPercent('2026-07-01', range)).toBe(0)
    expect(positionPercent('2026-09-01', range)).toBe(100)
  })
})

describe('barStyle / phaseOverlapsRange / computeDependencyArrows', () => {
  const range = { start: new Date('2026-08-01'), end: new Date('2026-08-20') }

  it('matches the worked example in this file\'s header comment', () => {
    const production = { id: 'p1', start_date: '2026-08-01', end_date: '2026-08-10' }
    const install = { id: 'p2', start_date: '2026-08-11', end_date: '2026-08-20', depends_on_phase_id: 'p1' }
    const prodStyle = barStyle(production, range)
    expect(prodStyle.left).toBe('0%')
    expect(parseFloat(prodStyle.width)).toBeCloseTo(47.4, 1)

    const installStyle = barStyle(install, range)
    expect(parseFloat(installStyle.left)).toBeCloseTo(52.6, 1)

    const arrows = computeDependencyArrows([production, install], range)
    expect(arrows).toHaveLength(1)
    expect(arrows[0].fromX).toBeCloseTo(47.4, 1)
    expect(arrows[0].toX).toBeCloseTo(52.6, 1)
  })

  it('returns null for a phase missing either date', () => {
    expect(barStyle({ start_date: '2026-08-01', end_date: null }, range)).toBeNull()
  })

  it('phaseOverlapsRange is true for any interval overlap, false when entirely outside', () => {
    expect(phaseOverlapsRange({ start_date: '2026-07-25', end_date: '2026-08-02' }, range)).toBe(true)
    expect(phaseOverlapsRange({ start_date: '2026-09-01', end_date: '2026-09-10' }, range)).toBe(false)
  })
})

describe('computeMonthTicks', () => {
  // Regression coverage for the "timeline scale always broken" bug: the
  // function used to build its cursor with the LOCAL-time `new Date(y,m,1)`
  // constructor, then convert back to a date string via `.toISOString()`
  // (UTC) to feed into positionPercent. For any positive UTC offset --
  // including Asia/Bangkok (UTC+7), this app's own deployment timezone --
  // that round-trip silently lands one calendar day early, so every tick's
  // computed x-position was a day off from the month it was labeled with.
  // Setting TZ here reproduces exactly that environment.
  const originalTZ = process.env.TZ
  beforeAll(() => { process.env.TZ = 'Asia/Bangkok' })
  afterAll(() => { process.env.TZ = originalTZ })

  it('positions each month tick at the exact UTC-day offset its label names, not one day early', () => {
    const range = { start: new Date('2026-08-15'), end: new Date('2026-10-15') }
    const ticks = computeMonthTicks(range)
    const isoDates = ticks.map((t) => t.date.toISOString().slice(0, 10))
    expect(isoDates).toEqual(['2026-08-01', '2026-09-01', '2026-10-01'])

    const totalMs = range.end - range.start
    ticks.forEach((t) => {
      const expectedX = Math.min(100, Math.max(0, (new Date(t.date.toISOString().slice(0, 10)) - range.start) / totalMs * 100))
      expect(t.x).toBeCloseTo(expectedX, 6)
    })

    // The September tick is fully inside the range (Aug 15 < Sep 1 < Oct 15)
    // -- under the old bug this landed one day early (Aug 31 worth of
    // offset), a real, visible misalignment against the phase bars.
    const sepTick = ticks[1]
    const expectedSepX = (new Date('2026-09-01') - range.start) / totalMs * 100
    expect(sepTick.x).toBeCloseTo(expectedSepX, 6)
  })

  it('returns an empty array for a null range', () => {
    expect(computeMonthTicks(null)).toEqual([])
  })

  it('produces one tick per calendar month touched by the range, in order', () => {
    const range = { start: new Date('2026-01-01'), end: new Date('2026-03-31') }
    const ticks = computeMonthTicks(range)
    expect(ticks.map((t) => t.date.toISOString().slice(0, 10))).toEqual(['2026-01-01', '2026-02-01', '2026-03-01'])
  })
})

describe('expandRangeForTransactions', () => {
  it('widens the range to cover transaction dates outside the phase-based range', () => {
    const range = { start: new Date('2026-08-01'), end: new Date('2026-08-20') }
    const widened = expandRangeForTransactions(range, ['2026-07-15', '2026-08-25'])
    expect(widened.start.toISOString().slice(0, 10)).toBe('2026-07-15')
    expect(widened.end.toISOString().slice(0, 10)).toBe('2026-08-25')
  })

  it('leaves the range untouched when every transaction date is already inside it', () => {
    const range = { start: new Date('2026-08-01'), end: new Date('2026-08-20') }
    const widened = expandRangeForTransactions(range, ['2026-08-05'])
    expect(widened).toEqual(range)
  })

  it('returns the original range unchanged when there are no transaction dates', () => {
    const range = { start: new Date('2026-08-01'), end: new Date('2026-08-20') }
    expect(expandRangeForTransactions(range, [])).toBe(range)
  })
})
