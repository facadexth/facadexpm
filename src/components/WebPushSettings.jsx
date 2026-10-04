// Settings -> แจ้งเตือนบนเครื่องนี้ (Web Push). Free, not part of the LINE quota.
// Per device: turning it on here only affects the phone/computer being used.
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { saveAppSetting } from '../hooks/useSupabase.js'
import { parseToggle } from '../lib/linePushToggles.js'
import { WEB_PUSH_TOGGLES } from '../lib/webPushToggles.js'
import { pushSupport, currentSubscription, subscribeThisDevice, subscriptionParts } from '../lib/webPush.js'

// OWNER only: which events send a device notification at all (company-wide, not per device).
function EventSwitches() {
  const [stored, setStored] = useState(null)
  const [savingKey, setSavingKey] = useState(null)
  useEffect(() => {
    supabase.from('app_settings').select('key, value').in('key', WEB_PUSH_TOGGLES.map(t => t.key))
      .then(({ data }) => setStored(Object.fromEntries((data || []).map(r => [r.key, r.value]))))
  }, [])
  const isOn = (t) => parseToggle(stored?.[t.key], t.defaultOn)
  const toggle = async (t) => {
    const next = !isOn(t)
    setSavingKey(t.key)
    try {
      await saveAppSetting(t.key, next)
      setStored(s => ({ ...(s || {}), [t.key]: String(next) }))
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) } finally { setSavingKey(null) }
  }
  return (
    <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>เหตุการณ์ที่ส่งแจ้งเตือนบนเครื่อง (ทุกเครื่องของบริษัท)</div>
      <p style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10, lineHeight: 1.6 }}>
        แต่ละเหตุการณ์เลือกช่องทางได้ ทาง LINE (นับโควตาข้อความ ตั้งที่ "การแจ้งเตือนทาง LINE") ทางเครื่อง (ฟรี) ทั้งสองอย่าง หรือปิดทั้งคู่
      </p>
      <div style={{ display: 'grid', gap: 10 }}>
        {WEB_PUSH_TOGGLES.map(t => (
          <label key={t.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" style={{ marginTop: 3 }} checked={isOn(t)} disabled={stored === null || savingKey === t.key} onChange={() => toggle(t)} />
            <span><span style={{ fontWeight: 600 }}>{t.icon} {t.label}</span><span style={{ display: 'block', color: 'var(--text3)', fontSize: 12 }}>{t.detail}</span></span>
          </label>
        ))}
      </div>
    </div>
  )
}

export default function WebPushSettings() {
  const { isAtLeast } = useUserRole()
  const support = pushSupport()
  const [on, setOn] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  useEffect(() => {
    if (support !== 'ok') return
    currentSubscription().then(s => setOn(!!s)).catch(() => setOn(false))
  }, [support])

  const enable = async () => {
    setBusy(true); setMsg(null)
    try {
      const sub = await subscribeThisDevice()
      const { endpoint, p256dh, auth } = subscriptionParts(sub)
      const { error } = await supabase.rpc('register_push_subscription', {
        p_endpoint: endpoint, p_p256dh: p256dh, p_auth: auth, p_user_agent: navigator.userAgent,
      })
      if (error) throw error
      setOn(true)
    } catch (e) {
      setMsg(e.message === 'denied'
        ? 'เบราว์เซอร์ไม่ได้รับอนุญาตให้แจ้งเตือน เปิดสิทธิ์แจ้งเตือนของเว็บนี้ในการตั้งค่าเบราว์เซอร์แล้วลองใหม่'
        : 'เปิดไม่สำเร็จ: ' + e.message)
    } finally { setBusy(false) }
  }

  const disable = async () => {
    setBusy(true); setMsg(null)
    try {
      const sub = await currentSubscription()
      if (sub) {
        await supabase.rpc('unregister_push_subscription', { p_endpoint: sub.endpoint })
        await sub.unsubscribe()
      }
      setOn(false)
    } catch (e) { setMsg('ปิดไม่สำเร็จ: ' + e.message) } finally { setBusy(false) }
  }

  const sendTest = async () => {
    setBusy(true); setMsg(null)
    try {
      const { data, error } = await supabase.functions.invoke('web-push-test')
      if (error) throw error
      setMsg(data?.sent > 0 ? 'ส่งแล้ว ถ้ามีแจ้งเตือนเด้งขึ้นมาแสดงว่าใช้งานได้' : 'ไม่มีเครื่องที่รับได้ ลองปิดแล้วเปิดใหม่')
    } catch (e) { setMsg('ส่งไม่สำเร็จ: ' + e.message) } finally { setBusy(false) }
  }

  return (
    <div className="card" style={{ marginBottom: 24, padding: '16px 20px' }}>
      <h2 style={{ marginBottom: 4, fontSize: 16, fontWeight: 700 }}>📲 แจ้งเตือนบนเครื่องนี้</h2>
      <p style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 12, lineHeight: 1.6 }}>
        ให้เครื่องนี้เด้งแจ้งเตือนเมื่อมีคำขอลา คำขอเบิกของ หรือแจ้งปัญหาหน้างานเข้ามา ฟรี ไม่นับโควตา LINE และตั้งค่าแยกตามเครื่อง
      </p>
      {support === 'needs-install' && (
        <div className="alert alert-warning" style={{ fontSize: 13 }}>
          บน iPhone/iPad ต้องเพิ่มแอปไว้หน้าจอหลักก่อน (Safari → แชร์ → เพิ่มลงในหน้าจอโฮม) แล้วเปิดจากไอคอนนั้น จึงจะเปิดแจ้งเตือนได้
        </div>
      )}
      {support === 'unsupported' && (
        <div className="alert alert-warning" style={{ fontSize: 13 }}>เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน</div>
      )}
      {support === 'ok' && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {on === false && <button className="btn btn-primary" onClick={enable} disabled={busy}>เปิดแจ้งเตือนบนเครื่องนี้</button>}
          {on === true && <>
            <span style={{ fontSize: 13 }}>✅ เปิดอยู่บนเครื่องนี้</span>
            <button className="btn" onClick={sendTest} disabled={busy}>ส่งแจ้งเตือนทดสอบ</button>
            <button className="btn" onClick={disable} disabled={busy}>ปิด</button>
          </>}
        </div>
      )}
      {msg && <div style={{ fontSize: 12, marginTop: 10, color: 'var(--text3)' }}>{msg}</div>}
      {isAtLeast('OWNER') && <EventSwitches />}
    </div>
  )
}
