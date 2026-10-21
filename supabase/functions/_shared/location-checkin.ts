// _shared/location-checkin.ts -- LINE เช็คอิน/เช็คเอาท์ for an office/admin account with
// NO site assignment today but an owner-assigned fixed check-in location
// (user_roles.assigned_checkin_location_id, or the tenant's one role='office' location for
// an ADMIN/OWNER/PM -- the same resolution MySchedule.jsx's useMyAssignedCheckinLocation and
// the perform_location_checkin RPC use, so web and LINE agree).
//
// Found live 2026-10-21: โปรย (ADMIN, office location assigned) got the "no work today"
// reply from the bot because the time-clock flow only knew about site assignments.
//
// Pure (no Deno imports) so vitest can import it: src/lib/locationCheckin.test.js.

export type CheckinLocation = { id: string; name: string }
export type LocationNextAction = 'check_in' | 'check_out' | 'done'
export type TimeClockTarget = { kind: 'site' } | { kind: 'location'; location: CheckinLocation } | { kind: 'none' }

const LOCATION_ROLES = ['ADMIN', 'OWNER', 'PM']

// A site assignment today always wins (the existing flow, untouched). Only a worker with
// no site at all falls through to their fixed location; with neither, the caller keeps
// its existing "no work today" reply.
export function pickTimeClockTarget(sites: ReadonlyArray<unknown>, location: CheckinLocation | null | undefined): TimeClockTarget {
  if (sites.length > 0) return { kind: 'site' }
  if (location) return { kind: 'location', location }
  return { kind: 'none' }
}

// The worker's user_roles row (joined to its assigned location) -> the location they may
// clock at. Mirrors useMyAssignedCheckinLocation: an explicit assignment first, otherwise
// the tenant's office location for ADMIN/OWNER/PM only; a WORKER role gets nothing here.
export function pickCheckinLocationFromRole(
  roleRow: { role: string | null; checkin_locations?: CheckinLocation | null } | null | undefined,
  officeLocation: CheckinLocation | null | undefined,
): CheckinLocation | null {
  if (!roleRow?.role || !LOCATION_ROLES.includes(roleRow.role)) return null
  if (roleRow.checkin_locations) return roleRow.checkin_locations
  return officeLocation ?? null
}

// From today's worker_checkins row for this location (keyed by checkin_location_id).
export function locationNextAction(row: { checkin_at: string | null; checkout_at: string | null } | null | undefined): LocationNextAction {
  if (!row?.checkin_at) return 'check_in'
  if (!row.checkout_at) return 'check_out'
  return 'done'
}

// Same wording as the single-site link reply in line-webhook (sendSingleSiteLink).
export function locationLinkReplyText(actionType: 'check_in' | 'check_out', location: CheckinLocation, link: string): string {
  const verb = actionType === 'check_in' ? 'เช็คอิน' : 'เช็คเอาท์'
  return `📍 กดลิงก์นี้เพื่อ${verb}ที่ ${location.name} ครับ (ใช้ได้ 30 นาที ต้องอนุญาตให้เว็บใช้ตำแหน่งของคุณ)\n${link}`
}

// The line_deep_link_tokens row for a location link: checkin_location_id instead of site_id.
export function locationTokenPayload(p: { tenantId: string; workerId: string; actionType: 'check_in' | 'check_out'; locationId: string }) {
  return { tenant_id: p.tenantId, worker_id: p.workerId, action_type: p.actionType, checkin_location_id: p.locationId }
}
