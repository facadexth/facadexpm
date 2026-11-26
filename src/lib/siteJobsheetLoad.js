// Web side of the crew daily job sheet (ใบงานประจำวัน): loads it with the logged-in client and builds
// the view model. The queries live in supabase/functions/_shared/site-jobsheet-load.ts (shared with the
// site-jobsheet edge function); here only the storage signing and Bangkok "today" are supplied.
import { loadJobSheetInput } from '../../supabase/functions/_shared/site-jobsheet-load.ts'
import { buildJobSheet } from '../../supabase/functions/_shared/site-jobsheet.ts'
import { bangkokTodayIso } from './photoUpload.js'
import { storageSigner } from './repairWorkorderLoad.js'

const SIGNED_URL_SECONDS = 1800

// tenant = the tenant row from useTenant() (company_name, address, phone, logo_url).
// date defaults to the Bangkok today. Staff view: no viewer, so the run is the leader's.
export async function loadJobSheet(supabase, siteId, tenant, date = bangkokTodayIso()) {
  const header = {
    company_name: tenant?.company_name, address: tenant?.address, phone: tenant?.phone, logo_url: tenant?.logo_url ?? null,
  }
  const input = await loadJobSheetInput(supabase, siteId, {
    date, tenant: header, viewerWorkerId: null, signUrls: storageSigner(supabase, SIGNED_URL_SECONDS),
  })
  return buildJobSheet(input)
}
