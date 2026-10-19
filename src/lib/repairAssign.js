// Pure crew planning for a repair appointment (งานซ่อม). Assign works in half-day shifts:
// worker_assignments.shift is 'morning' (เช้า) or 'evening' (บ่าย), unique per (worker_id, date, shift).
// A repair window starting before 12:00 takes the morning; it also takes the evening when it runs
// past 12:00 (start + duration > 12:00). A window starting at 12:00 or later takes the evening only.

function minutesOf(start) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(start ?? ''))
  if (!m) throw new Error(`เวลาเริ่มไม่ถูกต้อง: ${start}`)
  return Number(m[1]) * 60 + Number(m[2])
}

// 'HH:MM' + hours -> ['morning'] | ['evening'] | ['morning', 'evening'].
export function repairShifts(start, durationHours) {
  const s = minutesOf(start)
  const end = s + Math.round((Number(durationHours) || 0) * 60)
  if (s >= 12 * 60) return ['evening']
  return end > 12 * 60 ? ['morning', 'evening'] : ['morning']
}

// { rows: [{worker_id, date, shift}], conflicts: [{worker_id, date, shift, existing}] }.
// `existing` = the workers' current worker_assignments that day (excluding this ticket's own rows,
// which the caller replaces). Any (worker, date, shift) already taken is a conflict, never a row.
export function planRepairAssignments({ workerIds, date, start, durationHours, existing }) {
  const shifts = repairShifts(start, durationHours)
  const taken = new Map()
  for (const e of existing || []) taken.set(`${e.worker_id}|${e.date}|${e.shift}`, e)
  const rows = []
  const conflicts = []
  for (const worker_id of [...new Set(workerIds || [])]) {
    for (const shift of shifts) {
      const hit = taken.get(`${worker_id}|${date}|${shift}`)
      if (hit) conflicts.push({ worker_id, date, shift, existing: hit })
      else rows.push({ worker_id, date, shift })
    }
  }
  return { rows, conflicts }
}
