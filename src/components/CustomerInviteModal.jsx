// Invite a site's client to the company's customer LINE OA: one-time code + QR + link.
// A new invite is created every time this modal opens (the RPC revokes older open codes).
import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { supabase } from '../lib/supabase.js'
import { Modal } from './Modal.jsx'
import { buildOaInviteLink, inviteErrorText, formatBkkDate } from '../lib/customerLine.js'

const muted = { fontSize: 12, color: 'var(--text3)' }

export default function CustomerInviteModal({ siteId, siteName, canUnlink, onClose }) {
  const [state, setState] = useState({ loading: true, error: null, invite: null, qr: null })
  const [account, setAccount] = useState(null)
  const [siteCount, setSiteCount] = useState(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data, error } = await supabase.rpc('create_customer_invite', { p_site_id: siteId })
      if (!alive) return
      if (error) { setState({ loading: false, error: inviteErrorText(error.message), invite: null, qr: null }); return }
      const invite = Array.isArray(data) ? data[0] : data
      if (!invite) { setState({ loading: false, error: 'สร้างรหัสเชิญไม่สำเร็จ', invite: null, qr: null }); return }
      let qr = null
      if (invite.basic_id) {
        try { qr = await QRCode.toDataURL(buildOaInviteLink(invite.basic_id, invite.code), { width: 480, margin: 1 }) } catch { qr = null }
      }
      if (!alive) return
      setState({ loading: false, error: null, invite, qr })
      if (invite.client_id) {
        const [acc, cnt] = await Promise.all([
          supabase.from('customer_line_accounts').select('id, line_display_name, linked_at, last_seen_at').eq('client_id', invite.client_id).maybeSingle(),
          supabase.from('sites').select('id', { count: 'exact', head: true }).eq('client_id', invite.client_id).neq('status', 'Cancelled'),
        ])
        if (!alive) return
        setAccount(acc.data || null)
        setSiteCount(cnt.count ?? null)
      }
    })()
    return () => { alive = false }
  }, [siteId])

  const { invite, qr } = state
  const link = invite?.basic_id ? buildOaInviteLink(invite.basic_id, invite.code) : null

  async function copyLink() {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1800) } catch { /* ignore */ }
  }
  function share() {
    const text = `สแกนหรือกดลิงก์นี้เพื่อติดตามงาน ${siteName}: ${link}`
    window.open('https://line.me/R/share?text=' + encodeURIComponent(text), '_blank', 'noopener')
  }
  async function unlink() {
    if (!account || !confirm('ยกเลิกการเชื่อมไลน์ของ client นี้?')) return
    setBusy(true)
    const { error } = await supabase.from('customer_line_accounts').delete().eq('id', account.id)
    setBusy(false)
    if (error) { alert('ยกเลิกการเชื่อมไม่สำเร็จ: ' + error.message); return }
    setAccount(null)
  }

  return (
    <Modal title={`เชิญลูกค้าติดตามงาน · ${siteName || ''}`} onClose={onClose} maxWidth={800}>
      <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ fontSize: 13, color: 'var(--text2)' }}>
          ส่ง QR หรือลิงก์นี้ให้ลูกค้า (1 บัญชีต่อ client เห็นทุกไซท์ของ client นี้) ไม่เห็นราคาหรือข้อมูลช่าง
        </div>

        {state.loading && <div style={{ color: 'var(--text3)' }}>กำลังสร้างรหัสเชิญ...</div>}
        {state.error && <div style={{ color: 'var(--red)', fontSize: 13 }}>{state.error}</div>}
        {invite && !invite.basic_id && (
          <div style={{ color: 'var(--red)', fontSize: 13 }}>ยังไม่ได้เชื่อม LINE OA — ไปที่ ตั้งค่า › การสื่อสารและแจ้งเตือน</div>
        )}

        {invite && invite.basic_id && (
          <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
              {qr
                ? <img src={qr} alt="QR code เชิญลูกค้า" style={{ width: 232, height: 232, border: '1px solid var(--border)', borderRadius: 12, background: '#fff' }} />
                : <div style={{ width: 232, height: 232, ...muted }}>สร้าง QR ไม่สำเร็จ</div>}
              {qr && <a className="btn btn-sm btn-ghost" href={qr} download={`invite-${invite.code}.png`}>บันทึกรูป QR</a>}
            </div>
            <div style={{ flex: 1, minWidth: 260, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>รหัสเชิญ</div>
                <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: 8, fontFamily: 'ui-monospace, Menlo, monospace' }}>{invite.code}</div>
                <div style={muted}>ใช้ได้ครั้งเดียว · หมดอายุ {formatBkkDate(invite.expires_at)} (7 วัน)</div>
                <div style={muted}>เปิดหน้านี้ใหม่ = รหัสเดิมใช้ไม่ได้</div>
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>ลิงก์ (เปิดไลน์ เพิ่มเพื่อน @{String(invite.basic_id).replace(/^@/, '')} พร้อมพิมพ์รหัสให้)</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="input" readOnly value={link} style={{ flex: 1, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13 }} onFocus={e => e.target.select()} />
                  <button className="btn btn-sm btn-ghost" onClick={copyLink}>{copied ? 'คัดลอกแล้ว' : 'คัดลอก'}</button>
                </div>
              </div>
              <div style={{ background: 'var(--bg2, #FBF8F3)', borderRadius: 10, padding: '12px 14px', fontSize: 13, color: 'var(--text2)', lineHeight: 1.8 }}>
                <b style={{ color: 'var(--text)' }}>ลูกค้าทำแค่ 2 ขั้น</b><br />
                1. สแกน QR (หรือกดลิงก์) จะเปิดแชท @{String(invite.basic_id).replace(/^@/, '')}<br />
                2. กดส่งรหัสที่พิมพ์ไว้ให้แล้ว เสร็จ บอทตอบว่า “เชื่อมกับงาน {siteName} แล้ว”
              </div>
              <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={share}>แชร์ไปไลน์ลูกค้า</button>
            </div>
          </div>
        )}

        {invite && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              บัญชีไลน์ของ client: {invite.client_name}{siteCount != null ? ` (เห็น ${siteCount} ไซท์)` : ''}
            </div>
            {account ? (
              <>
                <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{account.line_display_name || '(ไม่มีชื่อ)'} · ลูกค้า: {invite.client_name}</div>
                    <div style={muted}>เชื่อมเมื่อ {formatBkkDate(account.linked_at)} · ล่าสุดถามสถานะงาน {formatBkkDate(account.last_seen_at)}</div>
                  </div>
                  {canUnlink && <button className="btn btn-sm btn-danger" disabled={busy} onClick={unlink}>ยกเลิกการเชื่อม</button>}
                </div>
                <div style={muted}>ถ้ามีคนใหม่ใช้รหัสนี้ จะแทนที่บัญชีเดิม (1 บัญชีต่อ client)</div>
              </>
            ) : (
              <div style={muted}>ยังไม่มีบัญชีไลน์เชื่อมกับ client นี้</div>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
