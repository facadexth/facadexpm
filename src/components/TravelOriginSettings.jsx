// Settings -> ค่าเดินทาง: where trips start (ส่วนกลาง/โรงงาน), and a one-click fill of the
// distance + drive time for every site that has none yet. Never overwrites a distance that is
// already typed in: it feeds travel pay.
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { saveAppSetting } from '../hooks/useSupabase.js'
import { ORIGIN_KEYS, loadOrigin, fetchRoute, routeErrorMessage } from '../lib/siteRoute.js'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

export default function TravelOriginSettings() {
  const [url, setUrl] = useState('')
  const [origin, setOrigin] = useState(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null)
  const [msg, setMsg] = useState(null)

  useEffect(() => {
    loadOrigin().then(setOrigin)
    supabase.from('app_settings').select('value').eq('key', ORIGIN_KEYS.url).maybeSingle().then(({ data }) => setUrl(data?.value || ''))
  }, [])

  const extract = async (mapUrl) => {
    const { data, error } = await supabase.functions.invoke('extract-map-coordinates', { body: { url: mapUrl } })
    if (error || !data?.ok) return null
    return { lat: data.lat, lng: data.lng }
  }

  const saveOrigin = async () => {
    if (!url.trim()) { setMsg('วางลิงก์ Google Maps ของส่วนกลางก่อน'); return }
    setBusy(true); setMsg(null)
    try {
      const c = await extract(url.trim())
      if (!c) { setMsg('หาพิกัดจากลิงก์นี้ไม่พบ'); return }
      await saveAppSetting(ORIGIN_KEYS.url, url.trim())
      await saveAppSetting(ORIGIN_KEYS.lat, c.lat)
      await saveAppSetting(ORIGIN_KEYS.lng, c.lng)
      setOrigin(c)
      setMsg('บันทึกที่ตั้งส่วนกลางแล้ว')
    } catch (e) { setMsg('บันทึกไม่สำเร็จ: ' + e.message) } finally { setBusy(false) }
  }

  const fillAll = async () => {
    if (!origin) return
    setBusy(true); setMsg(null); setProgress(null)
    try {
      const { data: sites, error } = await supabase.from('sites').select('id, name, lat, lng, map_url, distance_km').is('distance_km', null)
      if (error) throw error
      const todo = (sites || []).filter(s => (s.lat != null && s.lng != null) || s.map_url)
      let done = 0, skipped = 0, stopped = null
      for (let i = 0; i < todo.length; i++) {
        setProgress(`กำลังคำนวณ ${i + 1}/${todo.length}`)
        const s = todo[i]
        let point = s.lat != null && s.lng != null ? { lat: Number(s.lat), lng: Number(s.lng) } : await extract(s.map_url)
        if (!point) { skipped++; continue }
        const r = await fetchRoute(origin, point)
        if (!r?.ok) {
          if (['daily_limit', 'not_configured'].includes(r?.error)) { stopped = r.error; break }
          skipped++; continue
        }
        const patch = { distance_km: r.km, travel_minutes: r.minutes }
        if (s.lat == null) { patch.lat = point.lat; patch.lng = point.lng }
        const { error: upErr } = await supabase.from('sites').update(patch).eq('id', s.id).is('distance_km', null)
        if (upErr) { skipped++; continue }
        done++
        await sleep(1600) // the routing service allows ~40 requests a minute
      }
      setMsg(`เติมระยะทางให้ ${done} ไซต์` + (skipped ? ` ข้าม ${skipped} ไซต์ (ไม่มีพิกัดหรือหาเส้นทางไม่พบ)` : '') + (stopped ? ` — หยุดกลางทาง: ${routeErrorMessage(stopped)}` : ''))
    } catch (e) { setMsg('ไม่สำเร็จ: ' + e.message) } finally { setBusy(false); setProgress(null) }
  }

  return (
    <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
      <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>📍 ที่ตั้งส่วนกลาง / โรงงาน (จุดเริ่มต้นเดินทาง)</h3>
      <p style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10, lineHeight: 1.6 }}>
        ใช้คำนวณระยะทางและเวลาขับรถไปแต่ละไซต์โดยอัตโนมัติ วางลิงก์ Google Maps ของส่วนกลางครั้งเดียว
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input className="input" style={{ flex: 1, minWidth: 220 }} type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="วางลิงก์แผนที่..." />
        <button className="btn btn-primary" onClick={saveOrigin} disabled={busy}>บันทึกที่ตั้ง</button>
      </div>
      {origin && <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 6 }}>✅ ตั้งไว้แล้ว ({origin.lat.toFixed(5)}, {origin.lng.toFixed(5)})</div>}
      <div style={{ marginTop: 12 }}>
        <button className="btn" onClick={fillAll} disabled={busy || !origin}>🚗 เติมระยะทางให้ไซต์ที่ยังว่าง</button>
        <span style={{ fontSize: 12, color: 'var(--text3)', marginLeft: 10 }}>เติมเฉพาะไซต์ที่ยังไม่มีระยะทาง ไม่แก้ค่าที่กรอกไว้แล้ว</span>
      </div>
      {progress && <div style={{ fontSize: 12, marginTop: 8 }}>⏳ {progress}</div>}
      {msg && <div style={{ fontSize: 12, marginTop: 8 }}>{msg}</div>}
    </div>
  )
}
