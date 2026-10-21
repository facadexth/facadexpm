// Shifts (worker_assignments) + worker_ot + company holidays → per-worker facts.
// 1 shift = 0.5 day. Rules carried over from HR.jsx handleCalcFromAssign:
// legacy 'leave' counts as leave_personal; site shifts count only when confirmed
// if confirmation is required; factory always counts; Sunday = holiday rate.
import { weekdayOf, monthRange } from './period.js'

const WORK_TYPES = ['site', 'factory', 'office']

// checkinOt (optional, 2026-10-21 "คิด OT จากเวลาเช็คอิน", default off): 'worker|date' -> OT
// hours computed from check-in work time (src/lib/checkinDay.js). A date in it REPLACES that
// date's assignment/worker_ot OT; every other date keeps the manual OT.
export function summarizeAttendance({ shifts = [], otRows = [], holidayDates = [], requireConfirm = false, checkinOt = null }) {
  const hol = new Set(holidayDates)
  const out = {}
  const fromCheckin = (w, d) => checkinOt != null && Object.prototype.hasOwnProperty.call(checkinOt, `${w}|${d}`)
  const get = id => (out[id] ||= { daysWorked: 0, leavePersonalDays: 0, leaveSickDays: 0, otHours: 0, holidayShifts: 0, officeDays: 0 })
  for (const s of shifts) {
    const a = get(s.worker_id)
    const siteCounts = s.type === 'site' && (!requireConfirm || !!s.confirmed_at)
    if (WORK_TYPES.includes(s.type) && (s.type !== 'site' || siteCounts)) a.daysWorked += 0.5
    if (s.type === 'office') a.officeDays += 0.5
    if (s.type === 'leave_sick') a.leaveSickDays += 0.5
    if (s.type === 'leave_personal' || s.type === 'leave') a.leavePersonalDays += 0.5
    if (s.type === 'site' && !fromCheckin(s.worker_id, s.date)) a.otHours += Number(s.ot_hours) || 0
    if ((s.type === 'factory' || siteCounts) && (hol.has(s.date) || weekdayOf(s.date) === 0)) a.holidayShifts += 1
  }
  for (const o of otRows) if (!fromCheckin(o.worker_id, o.date)) get(o.worker_id).otHours += Number(o.ot_hours) || 0
  for (const [k, h] of Object.entries(checkinOt ?? {})) get(k.split('|')[0]).otHours += Number(h) || 0
  return out
}

// Owner request 2026-10-17: warn whoever runs payroll when Assign is not filled
// in. A gap = Mon–Sat, not a company holiday, on or before `today`, missing the
// morning or evening row (any type counts, incl. leave/holiday). Workers hidden
// from Assign (show_in_assign=false) are skipped.
export function findAssignGaps({ workers, shifts, holidayDates = [], year, month, today }) {
  const { from, to, lastDay } = monthRange(year, month)
  if (today < from) return []
  const end = today < to ? Number(today.slice(8, 10)) : lastDay
  const hol = new Set(holidayDates)
  const have = new Set(shifts.map(s => `${s.worker_id}|${s.date}|${s.shift}`))
  const days = []
  for (let d = 1; d <= end; d++) {
    const date = `${from.slice(0, 8)}${String(d).padStart(2, '0')}`
    if (weekdayOf(date) !== 0 && !hol.has(date)) days.push(date)
  }
  const out = []
  for (const w of workers) {
    if (w.show_in_assign === false) continue
    const dates = []
    for (const date of days) {
      const missing = ['morning', 'evening'].filter(s => !have.has(`${w.id}|${date}|${s}`))
      if (missing.length) dates.push({ date, missing })
    }
    if (dates.length) out.push({ worker_id: w.id, name: w.name, dates })
  }
  return out
}
