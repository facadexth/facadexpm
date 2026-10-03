// ============================================================
// LineAdminChat — platform-owner-only inbox for LINE "คุยกับแอดมิน"
// sessions. Messages exist ONLY for users who opened a chat themselves
// (see docs/superpowers/specs/2026-10-02-line-hybrid-privacy-design.md).
// Access is enforced by RLS (platform_admins), not just by hiding the tab.
// ============================================================
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { useAdminChatSessions, useAdminChatMessages, useAdminChatConfig } from '../hooks/useSupabase.js'
import { ConfirmDialog } from '../components/Modal.jsx'

const POLL_MS = 10_000

async function callSend(body) {
  const { data, error } = await supabase.functions.invoke('line-admin-chat-send', { body })
  if (error) throw new Error(error.message)
  if (data?.error) throw new Error(data.error)
}

function PhotoMessage({ path }) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    let alive = true
    supabase.storage.from('line-admin-chat').createSignedUrl(path, 300).then(({ data }) => { if (alive) setUrl(data?.signedUrl ?? null) })
    return () => { alive = false }
  }, [path])
  return url ? <img src={url} alt="" style={{ maxWidth: 240, borderRadius: 8 }} /> : <span>กำลังโหลดรูป…</span>
}

export default function LineAdminChat() {
  const { data: sessions, refetch: refetchSessions } = useAdminChatSessions()
  const { data: config, refetch: refetchConfig } = useAdminChatConfig()
  const [selected, setSelected] = useState(null)
  const { data: messages, refetch: refetchMessages } = useAdminChatMessages(selected)
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [idleHours, setIdleHours] = useState('')
  const [error, setError] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => { if (config?.idle_hours != null) setIdleHours(String(config.idle_hours)) }, [config])

  useEffect(() => {
    const t = setInterval(() => { refetchSessions(); refetchMessages() }, POLL_MS)
    return () => clearInterval(t)
  }, [refetchSessions, refetchMessages])

  const current = (sessions ?? []).find((s) => s.line_user_id === selected)
  const isOpen = current?.mode === 'chat_with_admin'

  const run = async (fn) => {
    setBusy(true)
    setError(null)
    try { await fn() } catch (e) { setError(e.message) } finally { setBusy(false) }
    refetchSessions(); refetchMessages()
  }

  const sendReply = () => run(async () => {
    await callSend({ action: 'reply', lineUserId: selected, text: reply })
    setReply('')
  })
  const endChat = () => run(() => callSend({ action: 'end', lineUserId: selected }))
  const deleteChat = async () => {
    setConfirmDelete(false)
    await run(() => callSend({ action: 'delete', lineUserId: selected }))
  }
  const saveIdle = () => run(async () => {
    const n = parseInt(idleHours, 10)
    if (!(n >= 1 && n <= 720)) throw new Error('ใส่ตัวเลข 1-720 ชั่วโมง')
    const { error } = await supabase.from('line_admin_chat_config').update({ idle_hours: n }).eq('id', true)
    if (error) throw error
    refetchConfig()
  })

  return (
    <div style={{ padding: 16, display: 'grid', gridTemplateColumns: 'minmax(220px, 280px) 1fr', gap: 16 }}>
      <div>
        <h3 style={{ marginTop: 0 }}>💬 แชทแอดมิน</h3>
        <div style={{ marginBottom: 12, fontSize: 13 }}>
          หมดอายุหลังไม่มีกิจกรรม (ชม.){' '}
          <input value={idleHours} onChange={(e) => setIdleHours(e.target.value)} style={{ width: 56 }} />{' '}
          <button disabled={busy} onClick={saveIdle}>บันทึก</button>
        </div>
        {(sessions ?? []).length === 0 && <div style={{ opacity: 0.6 }}>ยังไม่มีบทสนทนา</div>}
        {(sessions ?? []).map((s) => (
          <div key={s.line_user_id} onClick={() => setSelected(s.line_user_id)}
            style={{ padding: 8, cursor: 'pointer', borderRadius: 6, background: s.line_user_id === selected ? 'rgba(127,127,127,0.2)' : 'transparent' }}>
            {s.mode === 'chat_with_admin' ? '🟢' : '⚪'} …{s.line_user_id.slice(-6)}
            <div style={{ fontSize: 12, opacity: 0.7 }}>{new Date(s.last_activity_at).toLocaleString('th-TH')}</div>
          </div>
        ))}
      </div>

      <div>
        {!selected && <div style={{ opacity: 0.6 }}>เลือกบทสนทนาทางซ้าย</div>}
        {selected && (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {isOpen && <button disabled={busy} onClick={endChat}>จบการสนทนา</button>}
              <button disabled={busy} onClick={() => setConfirmDelete(true)}>🗑 ลบบทสนทนา</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '55vh', overflowY: 'auto' }}>
              {(messages ?? []).map((m) => (
                <div key={m.id} style={{ alignSelf: m.direction === 'admin' ? 'flex-end' : 'flex-start', maxWidth: '75%', padding: 8, borderRadius: 8,
                  background: m.direction === 'admin' ? 'rgba(59,130,246,0.25)' : 'rgba(127,127,127,0.2)' }}>
                  {m.body && <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>}
                  {m.storage_path && <PhotoMessage path={m.storage_path} />}
                  <div style={{ fontSize: 11, opacity: 0.6 }}>{new Date(m.created_at).toLocaleString('th-TH')}</div>
                </div>
              ))}
            </div>
            {isOpen ? (
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <input value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && reply.trim() && sendReply()}
                  placeholder="พิมพ์ข้อความตอบกลับ" style={{ flex: 1 }} />
                <button disabled={busy || !reply.trim()} onClick={sendReply}>ส่ง</button>
              </div>
            ) : <div style={{ marginTop: 12, opacity: 0.6 }}>บทสนทนานี้จบแล้ว — ผู้ใช้ต้องกด "คุยกับแอดมิน" ใหม่จึงจะตอบได้</div>}
          </>
        )}
      </div>
      {error && <div role="alert" style={{ gridColumn: '1 / -1', color: 'var(--red, #c0392b)' }}>{error}</div>}
      {confirmDelete && (
        <ConfirmDialog title="ลบบทสนทนา" message="ลบข้อความและรูปทั้งหมดของบทสนทนานี้อย่างถาวร?"
          onConfirm={deleteChat} onCancel={() => setConfirmDelete(false)} danger />
      )}
    </div>
  )
}
