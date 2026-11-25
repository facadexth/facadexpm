// Web side of the repair work order (ใบงานซ่อม): loads it with the logged-in client and builds the
// view model. The queries live in supabase/functions/_shared/repair-workorder-load.ts (shared with the
// repair-workorder edge function); here only the storage signing and Bangkok "today" are supplied.
import { loadWorkOrderInput } from '../../supabase/functions/_shared/repair-workorder-load.ts'
import { buildWorkOrder } from '../../supabase/functions/_shared/repair-workorder.ts'
import { bangkokTodayIso } from './photoUpload.js'

const SIGNED_URL_SECONDS = 3600

// signUrls for loadWorkOrderInput: one createSignedUrls call per bucket, aligned with `paths`.
// A storage failure leaves the photos as grey placeholders instead of blocking the whole sheet.
export function storageSigner(supabase, seconds = SIGNED_URL_SECONDS) {
  return async (bucket, paths) => {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrls(paths, seconds)
    if (error) { console.warn('work order: signing failed', bucket, error.message); return paths.map(() => null) }
    const byPath = new Map()
    for (const s of data || []) if (s?.path && s.signedUrl) byPath.set(s.path, s.signedUrl)
    return paths.map((p) => byPath.get(p) ?? null)
  }
}

// tenant = the tenant row from useTenant() (company_name, address, phone, logo_url).
export async function loadWorkOrder(supabase, ticketId, tenant) {
  const header = {
    company_name: tenant?.company_name, address: tenant?.address, phone: tenant?.phone, logo_url: tenant?.logo_url ?? null,
  }
  const input = await loadWorkOrderInput(supabase, ticketId, {
    today: bangkokTodayIso(), signUrls: storageSigner(supabase), tenant: header,
  })
  return buildWorkOrder(input)
}

const QR_SELECTOR = 'img[alt="แผนที่"]'

// Resolves once the sheet is safe to capture: every <img> inside `el` has finished (loaded or failed)
// and, when the sheet has a map link, the QR image (drawn asynchronously) is in place. Gives up after
// timeoutMs (resolves false) so a stuck image never locks the download button for good.
export function waitForSheetImages(el, { needQr = false, timeoutMs = 15000, intervalMs = 100 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    const check = () => {
      if (!el || !el.isConnected) { resolve(false); return }
      const imgs = Array.from(el.querySelectorAll('img'))
      const qrReady = !needQr || !!el.querySelector(QR_SELECTOR)
      if (qrReady && imgs.every((img) => img.complete)) { resolve(true); return }
      if (Date.now() - started >= timeoutMs) { resolve(false); return }
      setTimeout(check, intervalMs)
    }
    check()
  })
}
