// ============================================================
// LocationCheckinCard -- like TodayCheckinCard, but for an ADMIN/OWNER
// account's owner-assigned fixed location instead of a daily site
// assignment. Calls perform_location_checkin/checkout (no p_site_id --
// the location is implicit, resolved server-side from
// user_roles.assigned_checkin_location_id) instead of
// perform_worker_checkin/checkout. Rendered only when the logged-in user
// has no site assignment today AND has an assigned location (see
// MySchedule.jsx).
// ============================================================
import { useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { useTodayLocationCheckin } from '../../hooks/useSupabase.js'

const getGeolocation = () => new Promise((resolve, reject) => {
  if (!navigator.geolocation) { reject(new Error('เบราว์เซอร์นี้ไม่รองรับตำแหน่งที่ตั้ง')); return }
  navigator.geolocation.getCurrentPosition(
    pos => resolve(pos.coords),
    err => reject(new Error('ต้องเปิดสิทธิ์ตำแหน่งที่ตั้งเพื่อเช็คอิน: ' + err.message))
  )
})

export default function LocationCheckinCard({ workerId, locationId, locationName, date }) {
  const { data: checkin, refetch } = useTodayLocationCheckin(workerId, locationId, date)
  const [state, setState] = useState(null) // { loading, message, success }

  const handleCheckIn = async () => {
    setState({ loading: true, message: null })
    try {
      const coords = await getGeolocation()
      const { data, error } = await supabase.rpc('perform_location_checkin', {
        p_lat: coords.latitude, p_lng: coords.longitude,
      })
      if (error) throw error
      const result = data?.[0]
      setState({ loading: false, message: result?.message, success: result?.success })
      if (result?.success) refetch()
    } catch (e) {
      setState({ loading: false, message: e.message, success: false })
    }
  }

  const handleCheckOut = async () => {
    setState({ loading: true, message: null })
    try {
      const coords = await getGeolocation()
      const { data, error } = await supabase.rpc('perform_location_checkout', {
        p_lat: coords.latitude, p_lng: coords.longitude,
      })
      if (error) throw error
      const result = data?.[0]
      setState({ loading: false, message: result?.message, success: result?.success })
      if (result?.success) refetch()
    } catch (e) {
      setState({ loading: false, message: e.message, success: false })
    }
  }

  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 8 }}>
      <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 4 }}>{locationName}</div>
      {!checkin?.checkin_at ? (
        <button className="btn btn-primary btn-sm" onClick={handleCheckIn} disabled={state?.loading}>
          {state?.loading ? '⏳...' : '📍 เช็คอิน'}
        </button>
      ) : !checkin?.checkout_at ? (
        <button className="btn btn-primary btn-sm" onClick={handleCheckOut} disabled={state?.loading}>
          {state?.loading ? '⏳...' : '📍 เช็คเอาท์'}
        </button>
      ) : (
        <span style={{ color: 'var(--green)', fontSize: 12.5 }}>✅ เช็คอิน/เช็คเอาท์ครบแล้ววันนี้</span>
      )}
      {state?.message && (
        <div style={{ marginTop: 6, fontSize: 12, color: state.success ? 'var(--green)' : 'var(--red)' }}>
          {state.message}
        </div>
      )}
    </div>
  )
}
