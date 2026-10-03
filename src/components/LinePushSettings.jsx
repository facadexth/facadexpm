// Settings -> การแจ้งเตือนทาง LINE: one switch per message the system sends on
// its own. Each of these is a PUSH, which counts against the LINE bot's monthly
// message quota; replies to something a person typed to the bot do not.
// Keys, defaults and labels: src/lib/linePushToggles.js (mirrors
// supabase/functions/_shared/push-settings.ts, which the functions read).
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { saveAppSetting } from '../hooks/useSupabase.js'
import { LINE_PUSH_TOGGLES, parseToggle } from '../lib/linePushToggles.js'

export default function LinePushSettings({ hasModuleAccess }) {
  const [stored, setStored] = useState(null) // key -> 'true' | 'false'
  const [savingKey, setSavingKey] = useState(null)
  const [loadError, setLoadError] = useState(null)

  useEffect(() => {
    let alive = true
    supabase.from('app_settings').select('key, value').in('key', LINE_PUSH_TOGGLES.map(t => t.key))
      .then(({ data, error }) => {
        if (!alive) return
        if (error) { setLoadError(error.message); return }
        setStored(Object.fromEntries((data || []).map(r => [r.key, r.value])))
      })
    return () => { alive = false }
  }, [])

  const visible = LINE_PUSH_TOGGLES.filter(t => !t.module || hasModuleAccess(t.module))
  const isOn = (t) => parseToggle(stored?.[t.key], t.defaultOn)

  const handleToggle = async (t) => {
    const next = !isOn(t)
    setSavingKey(t.key)
    try {
      await saveAppSetting(t.key, next)
      setStored(s => ({ ...(s || {}), [t.key]: String(next) }))
    } catch (e) {
      alert('บันทึกไม่สำเร็จ: ' + e.message)
    } finally {
      setSavingKey(null)
    }
  }

  return (
    <div className="card" style={{ marginBottom: 24, padding: '16px 20px' }}>
      <h2 style={{ marginBottom: 4, fontSize: 16, fontWeight: 700 }}>🔔 การแจ้งเตือนทาง LINE</h2>
      <p style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 12, lineHeight: 1.6 }}>
        ข้อความด้านล่างเป็นข้อความที่บอทส่งหาผู้ใช้เองตามเหตุการณ์ และ <b>นับเป็นโควตาข้อความของ LINE</b> ส่วนข้อความที่บอทตอบกลับเมื่อมีคนพิมพ์หา ไม่นับโควตา ปิดอันที่ไม่จำเป็นเพื่อประหยัดโควตา
      </p>
      {loadError && <div className="alert alert-warning" style={{ fontSize: 12, marginBottom: 10 }}>โหลดการตั้งค่าไม่สำเร็จ ({loadError}) ค่าที่เห็นอาจไม่ตรงกับที่ตั้งไว้จริง</div>}
      <div style={{ display: 'grid', gap: 12 }}>
        {visible.map(t => (
          <label key={t.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" style={{ marginTop: 3 }} checked={isOn(t)} disabled={stored === null || savingKey === t.key}
              onChange={() => handleToggle(t)} />
            <span>
              <span style={{ fontWeight: 600 }}>{t.icon} {t.label}</span>
              <span style={{ display: 'block', color: 'var(--text3)', fontSize: 12, marginTop: 2 }}>{t.detail}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  )
}
