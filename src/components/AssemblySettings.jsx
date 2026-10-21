// Settings › 📍 (OWNER): the tenant default for "where does the crew's day start".
// ไปไซท์เลย = today's behaviour (only site arrive/leave). รวมพลที่บริษัท/โรงงานก่อน = the crew
// taps leave/return at a checkin_locations row too (spec 2026-10-21-assembly-checkin-design.md).
// A site can override this in its own form; the worker's FIRST site of the day decides.
import { useEffect, useState } from 'react'
import { useAppSetting, saveAppSetting } from '../hooks/useSupabase.js'

export default function AssemblySettings({ locations = [] }) {
  const { data: modeVal, refetch: refetchMode } = useAppSetting('assembly_mode', 'none')
  const { data: locVal, refetch: refetchLoc } = useAppSetting('assembly_location_id', '')
  const [mode, setMode] = useState('none')
  const [locationId, setLocationId] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (modeVal != null) setMode(modeVal === 'assembly' ? 'assembly' : 'none') }, [modeVal])
  useEffect(() => { if (locVal != null) setLocationId(locVal) }, [locVal])

  const usable = locations.filter(l => l.lat != null && l.lng != null)

  const save = async () => {
    if (mode === 'assembly' && !locationId) { alert('เลือกจุดรวมพลก่อนบันทึก'); return }
    setSaving(true)
    try {
      await saveAppSetting('assembly_mode', mode)
      if (mode === 'assembly') await saveAppSetting('assembly_location_id', locationId)
      refetchMode(); refetchLoc()
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSaving(false) }
  }

  return (
    <div className="card" style={{ marginBottom: 24, padding: '16px 20px' }}>
      <h2 style={{ marginBottom: 4, fontSize: 16, fontWeight: 700 }}>🏭 จุดเริ่มงานของช่าง</h2>
      <p style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 12 }}>
        ค่าเริ่มต้นของบริษัท แต่ละไซท์เปลี่ยนเองได้ในฟอร์มไซท์ — วันไหนใช้แบบไหนดูจากไซท์แรกของวันนั้น
        เวลางาน = ออกจากจุดรวมพล → กลับถึงจุดรวมพล (ไปไซท์เลย: ถึงไซท์แรก → ออกจากไซท์สุดท้าย)
      </p>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 6, cursor: 'pointer' }}>
        <input type="radio" name="assembly_mode" checked={mode === 'none'} onChange={() => setMode('none')} />
        ไปไซท์เลย (กดถึงไซท์ / ออกจากไซท์ เหมือนเดิม)
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 10, cursor: 'pointer' }}>
        <input type="radio" name="assembly_mode" checked={mode === 'assembly'} onChange={() => setMode('assembly')} />
        รวมพลที่บริษัท/โรงงานก่อน (กดออกจากจุดรวมพล → ไซท์ → กลับถึงจุดรวมพล)
      </label>
      {mode === 'assembly' && (
        <div style={{ marginBottom: 10 }}>
          <label className="label">จุดรวมพล</label>
          <select className="select" style={{ minWidth: 220 }} value={locationId} onChange={e => setLocationId(e.target.value)}>
            <option value="">— เลือกตำแหน่งเช็คอิน —</option>
            {usable.map(l => (
              <option key={l.id} value={l.id}>{l.name}{l.role === 'factory' ? ' (โรงงาน)' : l.role === 'office' ? ' (ออฟฟิศ)' : ''}</option>
            ))}
          </select>
        </div>
      )}
      <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}</button>
    </div>
  )
}
