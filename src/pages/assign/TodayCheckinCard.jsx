// ============================================================
// TodayCheckinCard — one instance per distinct site a worker is
// assigned to today. Owns its own geolocation + RPC calls so multiple
// same-day site assignments (spec: "worker assigned to two different
// sites same day") each get an independent check-in/out flow.
// ============================================================
import { useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { useTodayCheckin } from '../../hooks/useSupabase.js'
import { computeOTHours } from './otMath.js'

const getGeolocation = () => new Promise((resolve, reject) => {
  if (!navigator.geolocation) { reject(new Error('เบราว์เซอร์นี้ไม่รองรับตำแหน่งที่ตั้ง')); return }
  navigator.geolocation.getCurrentPosition(
    pos => resolve(pos.coords),
    err => reject(new Error('ต้องเปิดสิทธิ์ตำแหน่งที่ตั้งเพื่อเช็คอิน: ' + err.message))
  )
})

export default function TodayCheckinCard({ workerId, siteId, siteName, date }) {
  const { data: checkin, refetch } = useTodayCheckin(workerId, siteId, date)
  const [state, setState] = useState(null) // { loading, message, success }

  const handleCheckIn = async () => {
    setState({ loading: true, message: null })
    try {
      const coords = await getGeolocation()
      const { data, error } = await supabase.rpc('perform_worker_checkin', {
        p_site_id: siteId, p_lat: coords.latitude, p_lng: coords.longitude,
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
      const shiftEndStr = await supabase.rpc('get_regular_shift_end_time').then(r => r.data)
      const nowStr = new Date().toTimeString().slice(0, 5)
      let otParams = {}
      if (shiftEndStr && nowStr > shiftEndStr) {
        const otHours = computeOTHours(shiftEndStr, nowStr, false)
        if (otHours != null && otHours > 0) {
          otParams = { p_ot_start: shiftEndStr, p_ot_end: nowStr, p_ot_hours: otHours, p_ot_is_overnight: false, p_ot_notes: 'auto จากเช็คเอาท์' }
        }
      }
      const { data, error } = await supabase.rpc('perform_worker_checkout', {
        p_site_id: siteId, p_lat: coords.latitude, p_lng: coords.longitude, ...otParams,
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
      <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 4 }}>{siteName}</div>
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
