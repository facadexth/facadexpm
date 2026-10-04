// Driving distance/time from the company's base to a site (Edge Function route-distance).
import { supabase } from './supabase.js'

export const ORIGIN_KEYS = { url: 'travel_origin_url', lat: 'travel_origin_lat', lng: 'travel_origin_lng' }

const MESSAGES = {
  not_configured: 'ยังไม่ได้ตั้งค่าบริการคำนวณเส้นทาง (ORS_API_KEY)',
  daily_limit: 'วันนี้คำนวณครบจำนวนที่กำหนดแล้ว ลองใหม่พรุ่งนี้',
  no_route: 'หาเส้นทางรถยนต์ระหว่างสองจุดนี้ไม่พบ ตรวจสอบพิกัดอีกครั้ง',
  invalid_points: 'พิกัดไม่ถูกต้อง',
}
export const routeErrorMessage = (code) => MESSAGES[code] || 'คำนวณเส้นทางไม่สำเร็จ ลองใหม่อีกครั้ง'

// Returns { ok: true, km, minutes } or { ok: false, error }.
export async function fetchRoute(from, to) {
  const { data, error } = await supabase.functions.invoke('route-distance', { body: { from, to } })
  if (error) return { ok: false, error: 'request_failed' }
  return data
}

export function readOrigin(settingsByKey) {
  const lat = parseFloat(settingsByKey[ORIGIN_KEYS.lat])
  const lng = parseFloat(settingsByKey[ORIGIN_KEYS.lng])
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null
}

export async function loadOrigin() {
  const { data } = await supabase.from('app_settings').select('key, value').in('key', Object.values(ORIGIN_KEYS))
  return readOrigin(Object.fromEntries((data || []).map(r => [r.key, r.value])))
}
