// Settings -> ตำแหน่งและค่าเดินทาง: the company's default safety text printed on every crew daily
// job sheet (ใบงานประจำวัน) whose site has no text of its own. Stored in app_settings
// 'site_safety_note_default'; '' (empty) means "use the built-in default" (DEFAULT_SAFETY_NOTE).
import { useEffect, useState } from 'react'
import { useAppSetting, saveAppSetting } from '../hooks/useSupabase.js'
import { DEFAULT_SAFETY_NOTE } from '../../supabase/functions/_shared/site-jobsheet.ts'
import { SAFETY_SETTING_KEY } from '../../supabase/functions/_shared/site-jobsheet-load.ts'

export const SAFETY_NOTE_MAX = 500

export default function SiteSafetyDefaultSettings() {
  const { data: savedVal, refetch } = useAppSetting(SAFETY_SETTING_KEY, '')
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (savedVal != null) setText(String(savedVal)) }, [savedVal])

  const save = async () => {
    setSaving(true)
    try {
      await saveAppSetting(SAFETY_SETTING_KEY, text.trim().slice(0, SAFETY_NOTE_MAX))
      refetch()
      alert('✅ บันทึกข้อควรระวังหน้างานแล้ว')
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card" style={{ marginBottom: 24, padding: '16px 20px' }}>
      <label className="label" htmlFor="site-safety-default">ข้อควรระวังหน้างาน (ค่าเริ่มต้น)</label>
      <p style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 8 }}>ใช้กับทุกไซท์ที่ไม่ได้ตั้งเอง</p>
      <textarea id="site-safety-default" className="textarea" rows={3} maxLength={SAFETY_NOTE_MAX}
        value={text} onChange={e => setText(e.target.value)} placeholder={DEFAULT_SAFETY_NOTE} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, gap: 10 }}>
        <span style={{ fontSize: 11, color: 'var(--text3)' }}>{text.length}/{SAFETY_NOTE_MAX}</span>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}
        </button>
      </div>
    </div>
  )
}
