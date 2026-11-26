// Web side of the crew daily job sheet (ใบงานประจำวัน): loads it with the logged-in client and builds
// the view model. The queries live in supabase/functions/_shared/site-jobsheet-load.ts (shared with the
// site-jobsheet edge function); here only the storage signing and Bangkok "today" are supplied.
import { loadJobSheetInput } from '../../supabase/functions/_shared/site-jobsheet-load.ts'
import { buildJobSheet } from '../../supabase/functions/_shared/site-jobsheet.ts'
import { bangkokDay } from '../../supabase/functions/_shared/customer-form-logic.ts'
import { storageSigner } from './repairWorkorderLoad.js'

const SIGNED_URL_SECONDS = 1800

// A PM cannot read sites or workers directly (RLS: OWNER/ADMIN only); the same fields come from the
// SECURITY DEFINER pm_sites()/pm_workers(), already limited to the caller's tenant. pm_sites() has no
// tenant_id column, so it is taken from the logged-in tenant. Any error -> null (the loader then says
// ไม่พบไซต์นี้ / leaves the name blank), exactly what the direct read would have given.
export function pmSiteFallback(supabase, tenantId) {
  return async (siteId) => {
    if (!tenantId) return null
    const { data, error } = await supabase.rpc('pm_sites').eq('id', siteId).maybeSingle()
    if (error || !data) return null
    return { ...data, tenant_id: tenantId }
  }
}

export function pmWorkerNames(supabase) {
  return async (workerIds) => {
    const { data, error } = await supabase.rpc('pm_workers').in('id', workerIds)
    if (error || !data) return {}
    return Object.fromEntries(data.map((w) => [w.id, { name: w.name, nickname: w.nickname }]))
  }
}

// tenant = the tenant row from useTenant() (id, company_name, address, phone, logo_url).
// date defaults to the Bangkok today. Staff view: no viewer, so the run is the leader's.
export async function loadJobSheet(supabase, siteId, tenant, date = bangkokDay(Date.now())) {
  const header = {
    company_name: tenant?.company_name, address: tenant?.address, phone: tenant?.phone, logo_url: tenant?.logo_url ?? null,
  }
  const input = await loadJobSheetInput(supabase, siteId, {
    date, tenant: header, viewerWorkerId: null, signUrls: storageSigner(supabase, SIGNED_URL_SECONDS),
    siteFallback: pmSiteFallback(supabase, tenant?.id),
    workerNames: pmWorkerNames(supabase),
  })
  return buildJobSheet(input)
}
