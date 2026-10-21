// Read-time day view of worker_checkins for HR › 🕐 เช็คอิน-เช็คเอาท์ and the optional
// "คิด OT จากเวลาเช็คอิน" payroll input (spec: docs/superpowers/specs/
// 2026-10-21-assembly-checkin-design.md).
//
// Every tap is a real worker_checkins row, so a time read from the worker's own row is
// "self". A missed assembly tap is FILLED here, never written: first from the team leader's
// assembly row that day (same site, worker_assignments.is_team_leader) -> "leader", else from
// the worker's own site time -> "site" + flag (red for the admin).

const WORK_TYPES = ['site', 'factory', 'subcontract']
const SHIFT_RANK = { morning: 0, evening: 1 }
const minutesBetween = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / 60000) : null)
const byTime = (a, b) => String(a).localeCompare(String(b))

// The worker's site rows for the day in day order (morning first, then site name).
function orderedSiteAssignments(assignments, sites) {
  return assignments
    .filter(a => a.site_id && WORK_TYPES.includes(a.type ?? 'site'))
    .sort((x, y) => (SHIFT_RANK[x.shift] ?? 0) - (SHIFT_RANK[y.shift] ?? 0)
      || String(sites[x.site_id]?.name ?? '').localeCompare(String(sites[y.site_id]?.name ?? ''), 'th'))
}

// Same rule as the SQL worker_assembly_location(): the first site's own setting, else the
// tenant default; assembly only when a location is set.
export function dayAssemblyMode(assignments, sites, settings) {
  const first = orderedSiteAssignments(assignments, sites)[0]
  if (!first || !settings?.assemblyLocationId) return 'none'
  const mode = sites[first.site_id]?.assembly_mode || settings.assemblyMode || 'none'
  return mode === 'assembly' ? 'assembly' : 'none'
}

export function buildCheckinDays({ checkins = [], assignments = [], sites = {}, settings = {} }) {
  const key = (w, d) => `${w}|${d}`
  const asgBy = new Map()
  for (const a of assignments) {
    const k = key(a.worker_id, a.date)
    if (!asgBy.has(k)) asgBy.set(k, [])
    asgBy.get(k).push(a)
  }
  const siteRowsBy = new Map()
  const asmBy = new Map()
  for (const c of checkins) {
    const k = key(c.worker_id, c.date)
    if (c.is_assembly) { asmBy.set(k, c); continue }
    if (!c.site_id) continue // office location check-in: not a crew day
    if (!siteRowsBy.has(k)) siteRowsBy.set(k, [])
    siteRowsBy.get(k).push(c)
  }
  // Team leaders: date|site -> leader worker ids.
  const leaders = new Map()
  for (const a of assignments) {
    if (!a.is_team_leader || !a.site_id) continue
    const k = `${a.date}|${a.site_id}`
    if (!leaders.has(k)) leaders.set(k, new Set())
    leaders.get(k).add(a.worker_id)
  }
  const leaderTime = (workerId, date, siteId, field) => {
    for (const lid of leaders.get(`${date}|${siteId}`) ?? []) {
      if (lid === workerId) continue
      const row = asmBy.get(key(lid, date))
      if (row?.[field]) return row[field]
    }
    return null
  }

  const keys = new Set([...asgBy.keys()].filter(k => orderedSiteAssignments(asgBy.get(k), sites).length > 0))
  for (const k of siteRowsBy.keys()) keys.add(k)
  for (const k of asmBy.keys()) keys.add(k)

  const days = []
  for (const k of keys) {
    const [workerId, date] = k.split('|')
    const dayAsg = orderedSiteAssignments(asgBy.get(k) ?? [], sites)
    const rows = (siteRowsBy.get(k) ?? []).slice().sort((x, y) => byTime(x.checkin_at, y.checkin_at))
    const asm = asmBy.get(k) ?? null
    const mode = asm ? 'assembly' : dayAssemblyMode(dayAsg, sites, settings)
    const siteIds = [...new Set([...dayAsg.map(a => a.site_id), ...rows.map(r => r.site_id)])]
    const shiftCount = new Set(dayAsg.map(a => a.shift).filter(Boolean)).size || 2

    const first = rows[0]
    const lastOut = rows.filter(r => r.checkout_at).sort((x, y) => byTime(x.checkout_at, y.checkout_at)).pop()
    const allOut = rows.length > 0 && rows.every(r => r.checkout_at)
    const arrive = first ? { at: first.checkin_at, source: 'self', siteId: first.site_id } : null
    const depart = allOut && lastOut ? { at: lastOut.checkout_at, source: 'self', siteId: lastOut.site_id } : null

    let leave = null
    let ret = null
    let flag = false
    if (mode === 'assembly') {
      const firstSite = first?.site_id ?? dayAsg[0]?.site_id
      const lastSite = lastOut?.site_id ?? dayAsg[dayAsg.length - 1]?.site_id
      if (asm?.checkin_at) leave = { at: asm.checkin_at, source: 'self' }
      else if (firstSite && leaderTime(workerId, date, firstSite, 'checkin_at')) leave = { at: leaderTime(workerId, date, firstSite, 'checkin_at'), source: 'leader' }
      else if (arrive) { leave = { at: arrive.at, source: 'site' }; flag = true }
      if (asm?.checkout_at) ret = { at: asm.checkout_at, source: 'self' }
      else if (lastSite && leaderTime(workerId, date, lastSite, 'checkout_at')) ret = { at: leaderTime(workerId, date, lastSite, 'checkout_at'), source: 'leader' }
      else if (depart) { ret = { at: depart.at, source: 'site' }; flag = true }
    }

    const start = mode === 'assembly' ? leave?.at : arrive?.at
    const end = mode === 'assembly' ? ret?.at : depart?.at
    const workMin = minutesBetween(start, end)
    const tapsExpected = (mode === 'assembly' ? 2 : 0) + 2 * Math.max(siteIds.length, 1)
    const tapsMade = Math.min(tapsExpected,
      rows.reduce((n, r) => n + (r.checkin_at ? 1 : 0) + (r.checkout_at ? 1 : 0), 0)
      + (asm?.checkin_at ? 1 : 0) + (asm?.checkout_at ? 1 : 0))

    days.push({
      workerId, date, mode, siteIds, shiftCount,
      leave, arrive, depart, return: ret,
      travelOutMin: leave && leave.source !== 'site' && arrive ? minutesBetween(leave.at, arrive.at) : null,
      travelBackMin: ret && ret.source !== 'site' && depart ? minutesBetween(depart.at, ret.at) : null,
      workMin: workMin != null && workMin >= 0 ? workMin : null,
      complete: workMin != null && workMin >= 0,
      flag, tapsMade, tapsExpected,
    })
  }
  return days.sort((a, b) => b.date.localeCompare(a.date) || a.workerId.localeCompare(b.workerId))
}

// OT hours for one day: work time beyond the standard day (half of it for a one-shift day),
// 2 decimals. null when the work time is unknown.
export function otHoursForDay(day, standardHours = 8) {
  if (day.workMin == null) return null
  const std = (Number(standardHours) || 8) * 60 * (day.shiftCount === 1 ? 0.5 : 1)
  return Math.round(Math.max(0, day.workMin - std) / 60 * 100) / 100
}

// 'worker|date' -> OT hours, only for days whose work time is known.
export function otByWorkerDate(days, standardHours = 8) {
  const out = {}
  for (const d of days) {
    const h = otHoursForDay(d, standardHours)
    if (h != null) out[`${d.workerId}|${d.date}`] = h
  }
  return out
}

export function summarizeTaps(days) {
  const out = {}
  for (const d of days) {
    const s = (out[d.workerId] ||= { daysWorked: 0, tapsMade: 0, tapsExpected: 0, pct: null })
    s.daysWorked += 1
    s.tapsMade += d.tapsMade
    s.tapsExpected += d.tapsExpected
  }
  for (const s of Object.values(out)) s.pct = s.tapsExpected ? Math.round(s.tapsMade / s.tapsExpected * 100) : null
  return out
}

export function fmtMinutes(min) {
  if (min == null) return '—'
  const h = Math.floor(min / 60)
  const m = min % 60
  return h ? `${h} ชม. ${m} น.` : `${m} น.`
}
