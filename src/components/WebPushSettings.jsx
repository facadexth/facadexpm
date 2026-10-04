// Settings -> แจ้งเตือนบนเครื่องนี้ (Web Push). Free, not part of the LINE quota.
// Per device: turning it on here only affects the phone/computer being used.
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { pushSupport, currentSubscription, subscribeThisDevice, subscriptionParts } from '../lib/webPush.js'

export default function WebPushSettings() {
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
    </div>
  )
}
