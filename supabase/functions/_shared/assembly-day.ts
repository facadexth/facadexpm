// _shared/assembly-day.ts -- the step resolver for an "assembly" day (2026-10-21, spec
// docs/superpowers/specs/2026-10-21-assembly-checkin-design.md).
//
// On a day whose first site says "รวมพลที่บริษัท/โรงงานก่อน" the crew taps the one LINE
// เช็คอิน button four (or more) times: leave the assembly point -> arrive site A -> leave
// site A -> (arrive/leave B ...) -> back at the assembly point. This module only decides
// WHICH step comes next and which one the GPS says the worker is at. The geofenced write is
// done by the RPCs (perform_assembly_tap_by_id / perform_worker_checkin(_out)_by_id).
//
// Pure (no Deno imports) so vitest can import it: src/lib/assemblyDay.test.js.
import type { TodaysSite } from './todays-sites.ts'

export type StepKind = 'assembly_leave' | 'site_arrive' | 'site_leave' | 'assembly_return'
// single: a factory-only day (see planAssemblyDay) -- plain เช็คอิน/เช็คเอาท์ที่ <factory>.
export type DayStep = { kind: StepKind; siteId: string | null; placeName: string; done: boolean; atFactory: boolean; single?: boolean }
// The worker's assembly row today: checkin_at = left the assembly point, checkout_at = back.
export type AssemblyTaps = { leave_at: string | null; return_at: string | null } | null

export function planAssemblyDay(sites: TodaysSite[], assembly: AssemblyTaps, assemblyName: string): { steps: DayStep[]; next: DayStep | null } {
  const leaveDone = !!assembly?.leave_at
  const returnDone = !!assembly?.return_at
  // Factory-only day (2026-10-21 owner rule): when EVERY site today is factory work (atFactory:
  // type 'factory', geofenced at the factory = the assembly point), the crew never leaves, so it
  // is one plain check-in and one check-out per entry -- no assembly leave/return taps, no hints;
  // the work time is check-in -> check-out. Any non-factory site today (mixed day, in either
  // order) keeps the full leave -> sites -> return flow.
  const factoryOnly = sites.length > 0 && sites.every((s) => s.atFactory)
  const single = factoryOnly ? { single: true } : {}
  const steps: DayStep[] = factoryOnly ? [] : [{ kind: 'assembly_leave', siteId: null, placeName: assemblyName, done: leaveDone, atFactory: false }]
  for (const s of sites) {
    steps.push({ kind: 'site_arrive', siteId: s.siteId, placeName: s.siteName, done: s.nextAction !== 'check_in', atFactory: s.atFactory, ...single })
    steps.push({ kind: 'site_leave', siteId: s.siteId, placeName: s.siteName, done: s.nextAction === 'done', atFactory: s.atFactory, ...single })
  }
  if (factoryOnly) {
    const open = sites.find((s) => s.nextAction === 'check_out')
    const next = open
      ? steps.find((st) => st.kind === 'site_leave' && st.siteId === open.siteId) ?? null
      : steps.find((st) => st.kind === 'site_arrive' && !st.done) ?? null
    return { steps, next }
  }
  steps.push({ kind: 'assembly_return', siteId: null, placeName: assemblyName, done: returnDone, atFactory: false })

  let next: DayStep | null = null
  const open = sites.find((s) => s.nextAction === 'check_out')
  const anySiteTapped = sites.some((s) => s.nextAction !== 'check_in')
  if (open) {
    // One open check-in at a time.
    next = steps.find((st) => st.kind === 'site_leave' && st.siteId === open.siteId) ?? null
  } else if (!leaveDone && !anySiteTapped && !returnDone) {
    next = steps[0]
  } else {
    next = steps.find((st) => st.kind === 'site_arrive' && !st.done)
      ?? (returnDone ? null : steps[steps.length - 1])
  }
  return { steps, next }
}

// The forward skips allowed by GPS:
// - expected leave, but the worker is already at the first site (forgot to tap at the factory)
//   -> record the site arrival instead;
// - expected a site arrival, but the worker is back at the assembly point (that site was
//   skipped today) -> record the return.
export function skipStep(plan: { steps: DayStep[]; next: DayStep | null }): DayStep | null {
  if (plan.next?.kind === 'assembly_leave') return plan.steps.find((s) => s.kind === 'site_arrive') ?? null
  if (plan.next?.kind === 'site_arrive') {
    const ret = plan.steps[plan.steps.length - 1]
    return ret.kind === 'assembly_return' && !ret.done ? ret : null
  }
  return null
}

export function stepLabel(step: { kind: StepKind; placeName: string; atFactory?: boolean; single?: boolean }): { emoji: string; title: string; place: string } {
  if (step.single && step.kind === 'site_arrive') return { emoji: '🏭', title: `เช็คอินที่${step.placeName}`, place: step.placeName }
  if (step.single && step.kind === 'site_leave') return { emoji: '🏭', title: `เช็คเอาท์ที่${step.placeName}`, place: step.placeName }
  // Factory work is geofenced at the factory: never say "ไซท์", name the work place.
  if (step.atFactory && step.kind === 'site_arrive') return { emoji: '🏭', title: `ถึง${step.placeName}`, place: step.placeName }
  if (step.atFactory && step.kind === 'site_leave') return { emoji: '🏭', title: `ออกจาก${step.placeName}`, place: step.placeName }
  switch (step.kind) {
    case 'assembly_leave': return { emoji: '🏭', title: `ออกจาก${step.placeName}`, place: step.placeName }
    case 'assembly_return': return { emoji: '🏭', title: `กลับถึง${step.placeName}`, place: step.placeName }
    case 'site_arrive': return { emoji: '🏗️', title: 'ถึงไซท์', place: step.placeName }
    case 'site_leave': return { emoji: '🏗️', title: 'ออกจากไซท์', place: step.placeName }
  }
}

// Which company on/off command setting governs a step.
export function stepAction(kind: StepKind): 'check_in' | 'check_out' {
  return kind === 'assembly_leave' || kind === 'site_arrive' ? 'check_in' : 'check_out'
}

// GPS choice. A null distance means the place has no coordinates here: the RPC decides.
export function chooseStepByGps<T>(a: { next: T; nextDistance: number | null; skip: T | null; skipDistance: number | null; radius: number }):
  { step: T } | { refused: true; distanceM: number } {
  if (a.nextDistance == null || a.nextDistance <= a.radius) return { step: a.next }
  if (a.skip && a.skipDistance != null && a.skipDistance <= a.radius) return { step: a.skip }
  return { refused: true, distanceM: a.nextDistance }
}

// Same formula as the database's haversine_distance_m (earth radius 6371000 m).
export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2
  return 6371000 * 2 * Math.asin(Math.sqrt(a))
}

// The LINE reply carrying the one link on an assembly day.
export function assemblyLinkReplyText(step: { kind: StepKind; placeName: string; atFactory?: boolean; single?: boolean }, link: string): string {
  const l = stepLabel(step)
  const what = (step.kind === 'site_arrive' || step.kind === 'site_leave') && !step.atFactory ? `${l.title} ${l.place}` : l.title
  return `${l.emoji} กดลิงก์นี้เพื่อบันทึก "${what}" ครับ (ใช้ได้ 30 นาที ต้องอนุญาตให้เว็บใช้ตำแหน่งของคุณ)\n${link}`
}

// The "where next" line on the success screen after a leave tap (2026-10-21 owner request).
// steps = the plan BEFORE the tap; tapped = the step just recorded. '' = no hint.
export function nextStepHint(steps: DayStep[], tapped: DayStep): string {
  if (tapped.single) return ''
  const ret = steps.find((s) => s.kind === 'assembly_return')
  const pending = steps.filter((s) => s.kind === 'site_arrive' && !s.done && s.siteId !== tapped.siteId)
  if (tapped.kind === 'assembly_leave') {
    if (pending.length === 0) return ''
    const first = `ต่อไป: ไปเช็คอินถึงไซท์ ${pending[0].placeName}`
    return pending.length > 1 ? `${first}\nไซท์วันนี้: ${pending.map((s) => s.placeName).join(' → ')}` : first
  }
  if (tapped.kind === 'site_leave') {
    if (pending.length > 0) return `ต่อไป: ไปเช็คอินถึงไซท์ ${pending[0].placeName}`
    return ret && !ret.done ? `อย่าลืมกดเช็คอิน กลับถึง${ret.placeName} เมื่อถึงแล้ว` : ''
  }
  return ''
}
