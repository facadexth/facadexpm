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
export type DayStep = { kind: StepKind; siteId: string | null; placeName: string; done: boolean; atFactory: boolean }
// The worker's assembly row today: checkin_at = left the assembly point, checkout_at = back.
export type AssemblyTaps = { leave_at: string | null; return_at: string | null } | null

export function planAssemblyDay(sites: TodaysSite[], assembly: AssemblyTaps, assemblyName: string): { steps: DayStep[]; next: DayStep | null } {
  const leaveDone = !!assembly?.leave_at
  const returnDone = !!assembly?.return_at
  const steps: DayStep[] = [{ kind: 'assembly_leave', siteId: null, placeName: assemblyName, done: leaveDone, atFactory: false }]
  for (const s of sites) {
    steps.push({ kind: 'site_arrive', siteId: s.siteId, placeName: s.siteName, done: s.nextAction !== 'check_in', atFactory: s.atFactory })
    steps.push({ kind: 'site_leave', siteId: s.siteId, placeName: s.siteName, done: s.nextAction === 'done', atFactory: s.atFactory })
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

// The one forward skip allowed by GPS: expected leave, but the worker is already at the
// first site (forgot to tap at the factory) -> record the site arrival instead.
export function skipStep(plan: { steps: DayStep[]; next: DayStep | null }): DayStep | null {
  if (plan.next?.kind !== 'assembly_leave') return null
  return plan.steps.find((s) => s.kind === 'site_arrive') ?? null
}

export function stepLabel(step: { kind: StepKind; placeName: string }): { emoji: string; title: string; place: string } {
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
export function assemblyLinkReplyText(step: { kind: StepKind; placeName: string }, link: string): string {
  const l = stepLabel(step)
  const what = step.kind === 'site_arrive' || step.kind === 'site_leave' ? `${l.title} ${l.place}` : l.title
  return `${l.emoji} กดลิงก์นี้เพื่อบันทึก "${what}" ครับ (ใช้ได้ 30 นาที ต้องอนุญาตให้เว็บใช้ตำแหน่งของคุณ)\n${link}`
}
