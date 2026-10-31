// _shared/factory-location.ts -- where a worker really checks in for FACTORY work.
//
// A 'factory' assignment names the customer's site (the job), but the check-in RPCs
// geofence it against the factory location. The bot and the /f/ page must say so.
// Resolution order is the same as perform_worker_checkin_by_id (migration 2026-10-20-03):
//   1. worker_assignments.checkin_location_id of that assignment
//   2. the checkin_locations row with role = 'factory'
//   3. app_settings 'factory_site_id'
// Every lookup is filtered by tenant. Returns null when no factory location is found
// (callers then fall back to the plain site display).
export type FactoryLocation = { id: string; name: string; lat: number | null; lng: number | null }

// deno-lint-ignore no-explicit-any
export async function resolveFactoryLocation(admin: any, tenantId: string, workerId: string, siteId: string, date: string): Promise<FactoryLocation | null> {
  const cols = 'id, name, lat, lng'
  const { data: a } = await admin.from('worker_assignments').select('checkin_location_id')
    .eq('worker_id', workerId).eq('site_id', siteId).eq('date', date).eq('type', 'factory').eq('tenant_id', tenantId)
    .not('checkin_location_id', 'is', null).limit(1).maybeSingle()
  if (a?.checkin_location_id) {
    const { data } = await admin.from('checkin_locations').select(cols).eq('id', a.checkin_location_id).eq('tenant_id', tenantId).maybeSingle()
    if (data) return data
  }
  const { data: byRole } = await admin.from('checkin_locations').select(cols).eq('tenant_id', tenantId).eq('role', 'factory').limit(1).maybeSingle()
  if (byRole) return byRole
  const { data: setting } = await admin.from('app_settings').select('value').eq('tenant_id', tenantId).eq('key', 'factory_site_id').maybeSingle()
  const id = String(setting?.value ?? '').trim()
  if (!id) return null
  const { data } = await admin.from('checkin_locations').select(cols).eq('id', id).eq('tenant_id', tenantId).maybeSingle()
  return data ?? null
}
