// Settings -> เชื่อม LINE OA ของบริษัท (สำหรับลูกค้า). The owner pastes their own
// OA's Channel ID / secret / token. secret + token are write-only: they go to the
// save_customer_line_credentials RPC and are never read back or kept in state
// beyond the two controlled inputs (cleared after save).
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { useTenant } from '../hooks/useTenant.js'
import { buildWebhookUrl } from '../lib/customerLine.js'

const COLS = 'channel_id, webhook_key, basic_id, display_name, contact_phone, contact_hours, verified_at'

const SAVE_ERRORS = {
  module_missing: 'แพ็กเกจนี้ยังไม่มีโมดูล LINE',
  missing_credentials: 'กรอก Channel ID, secret และ token ให้ครบ',
  read_only: 'บัญชีอยู่ในโหมดอ่านอย่างเดียว',
  not_owner: 'เฉพาะเจ้าของบัญชีเท่านั้น',
}
const TEST_ERRORS = {
  not_configured: 'ยังไม่ได้บันทึกข้อมูล OA',
  bad_token: 'token ไม่ถูกต้อง',
  forbidden: 'เฉพาะเจ้าของบัญชีเท่านั้น',
}
const errText = (e, map) => {
  const m = String(e?.message || e || '')
  const k = Object.keys(map).find(k => m.includes(k))
  return k ? map[k] : m
}

const STEPS = [
  'เข้า LINE Developers › เลือก channel ของ OA › แท็บ Messaging API',
  'วาง Webhook URL ด้านบน แล้วเปิด “Use webhook”',
  'ใน LINE OA Manager ตั้ง “แชท” เป็นเปิด เพื่อให้แอดมินยังคุยกับลูกค้าได้ตามปกติ',
  'กลับมากด “ทดสอบการเชื่อมต่อ”',
]

export default function CustomerLineSettings() {
  const { tenant } = useTenant()
  const [row, setRow] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const [channelId, setChannelId] = useState('')
  const [secret, setSecret] = useState('')
  const [token, setToken] = useState('')
  const [phone, setPhone] = useState('')
  const [hours, setHours] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testMsg, setTestMsg] = useState(null) // { ok, text }
  const [savingContact, setSavingContact] = useState(false)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('customer_line_channels').select(COLS).maybeSingle()
    if (error) { setLoadError(error.message); setLoaded(true); return }
    setLoadError(null)
    setRow(data || null)
    if (data) {
      setChannelId(data.channel_id || '')
      setPhone(data.contact_phone || '')
      setHours(data.contact_hours || '')
    }
    setLoaded(true)
  }, [])

  useEffect(() => { load() }, [load])

  const badge = row?.verified_at
    ? { text: `เชื่อมแล้ว · @${String(row.basic_id || '').replace(/^@/, '')}`, color: 'var(--accent)' }
    : row ? { text: 'ยังไม่ได้ทดสอบ', color: 'var(--text3)' }
      : { text: 'ยังไม่เชื่อม', color: 'var(--text3)' }

  const handleSave = async () => {
    setSaving(true)
    try {
      const { error } = await supabase.rpc('save_customer_line_credentials', {
        p_channel_id: channelId.trim(),
        p_channel_secret: secret.trim(),
        p_access_token: token.trim(),
      })
      if (error) throw error
      setSecret(''); setToken('')
      setTestMsg(null)
      await load()
    } catch (e) {
      alert('บันทึกไม่สำเร็จ: ' + errText(e, SAVE_ERRORS))
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true); setTestMsg(null)
    try {
      const { data, error } = await supabase.functions.invoke('customer-line-test')
      if (error) throw error
      if (data?.error) {
        setTestMsg({ ok: false, text: TEST_ERRORS[data.error] || String(data.error) })
      } else if (data?.webhook && !data.webhook.success) {
        setTestMsg({ ok: false, text: `LINE เรียก webhook ไม่ผ่าน (status ${data.webhook.statusCode ?? '?'}) — ตรวจว่าวาง URL และเปิด Use webhook แล้ว` })
      } else if (data?.ok) {
        setTestMsg({ ok: true, text: 'ทดสอบผ่าน' })
      } else {
        setTestMsg({ ok: false, text: 'ทดสอบไม่สำเร็จ' })
      }
      await load()
    } catch (e) {
      setTestMsg({ ok: false, text: 'ทดสอบไม่สำเร็จ: ' + (e?.message || e) })
    } finally {
      setTesting(false)
    }
  }

  const handleSaveContact = async () => {
    setSavingContact(true)
    try {
      let q = supabase.from('customer_line_channels')
        .update({ contact_phone: phone.trim() || null, contact_hours: hours.trim() || null })
      q = tenant?.id ? q.eq('tenant_id', tenant.id) : q
      const { error } = await q
      if (error) throw error
      await load()
    } catch (e) {
      alert('บันทึกไม่สำเร็จ: ' + errText(e, SAVE_ERRORS))
    } finally {
      setSavingContact(false)
    }
  }

  const webhookUrl = row?.webhook_key ? buildWebhookUrl(import.meta.env.VITE_SUPABASE_URL, row.webhook_key) : null
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl)
      setCopied(true); setTimeout(() => setCopied(false), 1800)
    } catch { alert('คัดลอกไม่สำเร็จ — เลือกข้อความแล้วคัดลอกเอง') }
  }

  const label = { fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }
  const hint = { fontSize: 12, color: 'var(--text3)', lineHeight: 1.6 }

  return (
    <>
      <div className="card" style={{ marginBottom: 24, padding: '16px 20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ marginBottom: 4, fontSize: 16, fontWeight: 700 }}>💬 เชื่อม LINE OA ของบริษัท (สำหรับลูกค้า)</h2>
          {loaded && <span style={{ fontSize: 12, fontWeight: 600, color: badge.color }}>{badge.text}</span>}
        </div>
        <p style={{ ...hint, fontSize: 13, marginBottom: 12 }}>
          ลูกค้าเพิ่มเพื่อน OA ของบริษัทคุณ แล้วเช็คสถานะงานได้เอง ช่างยังใช้บอท @changpm เหมือนเดิม ไม่ต้องผูกใหม่
        </p>
        {loadError && <div className="alert alert-warning" style={{ fontSize: 12, marginBottom: 10 }}>โหลดข้อมูลไม่สำเร็จ ({loadError})</div>}
        <div style={{ display: 'grid', gap: 12, maxWidth: 520 }}>
          <div>
            <label style={label}>Channel ID</label>
            <input className="input" value={channelId} onChange={e => setChannelId(e.target.value)} />
          </div>
          {row?.display_name && (
            <div>
              <label style={label}>ชื่อ OA (อ่านจาก LINE อัตโนมัติ)</label>
              <input className="input" value={row.display_name} readOnly disabled />
            </div>
          )}
          <div>
            <label style={label}>Channel secret</label>
            <input className="input" type="password" autoComplete="new-password" value={secret}
              onChange={e => setSecret(e.target.value)} placeholder={row ? 'บันทึกแล้ว — ใส่ใหม่เพื่อเปลี่ยน' : ''} />
          </div>
          <div>
            <label style={label}>Channel access token (long-lived)</label>
            <input className="input" type="password" autoComplete="new-password" value={token}
              onChange={e => setToken(e.target.value)} placeholder={row ? 'บันทึกแล้ว — ใส่ใหม่เพื่อเปลี่ยน' : ''} />
          </div>
          <div style={hint}>secret และ token เก็บไว้ฝั่งเซิร์ฟเวอร์เท่านั้น บันทึกแล้วจะไม่แสดงอีก แม้แต่เจ้าของบัญชีก็ดูไม่ได้</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? 'กำลังบันทึก…' : 'บันทึก'}</button>
            <button className="btn" onClick={handleTest} disabled={testing || !row}>{testing ? 'กำลังทดสอบ…' : 'ทดสอบการเชื่อมต่อ'}</button>
          </div>
          {testMsg && (
            <div className={`alert ${testMsg.ok ? 'alert-success' : 'alert-warning'}`} style={{ fontSize: 12 }}>{testMsg.text}</div>
          )}
        </div>

        {webhookUrl && (
          <div style={{ marginTop: 20 }}>
            <label style={label}>Webhook URL — คัดลอกไปวางใน LINE Developers</label>
            <div style={{ display: 'flex', gap: 8, maxWidth: 720 }}>
              <input className="input" readOnly value={webhookUrl} onFocus={e => e.target.select()} style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }} />
              <button className="btn" onClick={copy}>{copied ? 'คัดลอกแล้ว' : 'คัดลอก'}</button>
            </div>
            <ol style={{ ...hint, fontSize: 13, margin: '12px 0 0', paddingLeft: 20 }}>
              {STEPS.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 24, padding: '16px 20px' }}>
        <h2 style={{ marginBottom: 4, fontSize: 16, fontWeight: 700 }}>ข้อมูลสำหรับปุ่ม “ติดต่อเรา”</h2>
        <p style={{ ...hint, fontSize: 13, marginBottom: 12 }}>บอทตอบข้อความนี้เมื่อลูกค้ากดปุ่มติดต่อเราใน rich menu</p>
        <div style={{ display: 'grid', gap: 12, maxWidth: 520 }}>
          <div>
            <label style={label}>เบอร์โทร</label>
            <input className="input" value={phone} onChange={e => setPhone(e.target.value)} disabled={!row} />
          </div>
          <div>
            <label style={label}>เวลาทำการ</label>
            <input className="input" value={hours} onChange={e => setHours(e.target.value)} disabled={!row} />
          </div>
          <div>
            <button className="btn btn-primary" onClick={handleSaveContact} disabled={!row || savingContact}>{savingContact ? 'กำลังบันทึก…' : 'บันทึก'}</button>
          </div>
        </div>
      </div>
    </>
  )
}
