// ============================================================
// Communication Center (การสื่อสาร) — OWNER only
// Front-end for the LINE crew-bot infrastructure built this session:
// channel connection, worker LINE-linking codes, resolving unrecognized
// senders, and the one real LINE-specific reminder toggle. Everything
// here was previously only reachable by hand-run SQL.
// ============================================================
import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { useTenant } from '../hooks/useTenant.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { useAppSetting, saveAppSetting } from '../hooks/useSupabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'

// Ambiguous-looking characters (0/O, 1/I/L) dropped on purpose -- these
// codes get read aloud or copy-pasted by crew with low literacy.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
function generateLinkCode() {
  let code = ''
  for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  return code
}

export default function CommunicationCenter() {
  const { tenant } = useTenant()
  const { user } = useUserRole()

  // ---- My own LINE link (user_roles.line_link_code/line_user_id --
  // same columns+webhook handling the LINE feature already had for any
  // role, just never had a UI card anywhere until now) ----
  const [myRole, setMyRole] = useState(null)
  const [loadingMyRole, setLoadingMyRole] = useState(true)
  const [generatingMyLink, setGeneratingMyLink] = useState(false)
  const [showMyLinkModal, setShowMyLinkModal] = useState(false)

  const fetchMyRole = async () => {
    if (!user?.email) return
    setLoadingMyRole(true)
    const { data, error } = await supabase.from('user_roles').select('id, line_user_id, line_link_code').eq('user_email', user.email).maybeSingle()
    if (!error) setMyRole(data)
    setLoadingMyRole(false)
  }
  useEffect(() => { fetchMyRole() }, [user?.email])

  const handleGenerateMyCode = async () => {
    if (!myRole?.id) return
    setGeneratingMyLink(true)
    try {
      const code = generateLinkCode()
      const { error } = await supabase.from('user_roles').update({ line_link_code: code }).eq('id', myRole.id)
      if (error) throw error
      setMyRole(r => ({ ...r, line_link_code: code }))
      setShowMyLinkModal(true)
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setGeneratingMyLink(false)
    }
  }

  // ---- Channel connection ----
  const [lineSettings, setLineSettings] = useState(null)
  const [loadingSettings, setLoadingSettings] = useState(true)
  const [connForm, setConnForm] = useState({ channel_id: '', channel_secret: '', channel_access_token: '', crew_group_id: '', basic_id: '' })
  const [savingConnection, setSavingConnection] = useState(false)

  const fetchLineSettings = async () => {
    if (!tenant?.id) return
    setLoadingSettings(true)
    const { data, error } = await supabase.from('line_settings').select('*').eq('tenant_id', tenant.id).maybeSingle()
    if (!error) setLineSettings(data)
    setLoadingSettings(false)
  }
  useEffect(() => { fetchLineSettings() }, [tenant?.id])
  useEffect(() => {
    setConnForm({
      channel_id: lineSettings?.channel_id || '',
      channel_secret: '',
      channel_access_token: '',
      crew_group_id: lineSettings?.crew_group_id || '',
      basic_id: lineSettings?.basic_id || '',
    })
  }, [lineSettings])
  const setConn = (k, v) => setConnForm(f => ({ ...f, [k]: v }))

  const handleSaveConnection = async (e) => {
    e.preventDefault()
    if (!lineSettings && (!connForm.channel_id || !connForm.channel_secret || !connForm.channel_access_token)) {
      alert('กรุณากรอก Channel ID, Channel Secret และ Channel Access Token ให้ครบ (จำเป็นสำหรับการเชื่อมต่อครั้งแรก)')
      return
    }
    setSavingConnection(true)
    try {
      if (!lineSettings) {
        const { error } = await supabase.from('line_settings').insert({
          tenant_id: tenant.id,
          channel_id: connForm.channel_id,
          channel_secret: connForm.channel_secret,
          channel_access_token: connForm.channel_access_token,
          crew_group_id: connForm.crew_group_id || null,
          basic_id: connForm.basic_id || null,
        })
        if (error) throw error
      } else {
        // Secret/token fields start blank every load (never echoing a
        // stored secret back into the page) -- only overwrite what was
        // actually re-typed, so leaving them blank keeps the existing
        // value instead of wiping it.
        const payload = { crew_group_id: connForm.crew_group_id || null, basic_id: connForm.basic_id || null, updated_at: new Date().toISOString() }
        if (connForm.channel_id) payload.channel_id = connForm.channel_id
        if (connForm.channel_secret) payload.channel_secret = connForm.channel_secret
        if (connForm.channel_access_token) payload.channel_access_token = connForm.channel_access_token
        const { error } = await supabase.from('line_settings').update(payload).eq('tenant_id', tenant.id)
        if (error) throw error
      }
      alert('✅ บันทึกการเชื่อมต่อแล้ว')
      fetchLineSettings()
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSavingConnection(false)
    }
  }

  // ---- Workers: LINE linking status ----
  const [workers, setWorkers] = useState([])
  const [loadingWorkers, setLoadingWorkers] = useState(true)
  const [showInactive, setShowInactive] = useState(false)
  const [generatingFor, setGeneratingFor] = useState(null)
  const [linkModalWorker, setLinkModalWorker] = useState(null)

  const fetchWorkers = async () => {
    setLoadingWorkers(true)
    const { data, error } = await supabase
      .from('workers')
      .select('id, name, nickname, position, status, line_user_id, line_link_code')
      .order('name')
    if (!error) setWorkers(data || [])
    setLoadingWorkers(false)
  }
  useEffect(() => { fetchWorkers() }, [])

  const handleGenerateCode = async (worker) => {
    setGeneratingFor(worker.id)
    try {
      const code = generateLinkCode()
      const { error } = await supabase.from('workers').update({ line_link_code: code }).eq('id', worker.id)
      if (error) throw error
      const updated = { ...worker, line_link_code: code }
      setWorkers(ws => ws.map(w => (w.id === worker.id ? updated : w)))
      setLinkModalWorker(updated)
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setGeneratingFor(null)
    }
  }
  const handleShowLink = (worker) => {
    if (worker.line_link_code) setLinkModalWorker(worker)
    else handleGenerateCode(worker)
  }

  const handleCopy = async (text) => {
    try {
      await navigator.clipboard.writeText(text)
      alert('✅ คัดลอกแล้ว')
    } catch {
      alert('คัดลอกไม่สำเร็จ กรุณาคัดลอกด้วยตนเอง: ' + text)
    }
  }

  const basicId = lineSettings?.basic_id
  const linkUrl = (worker) =>
    basicId && worker?.line_link_code ? `https://line.me/R/oaMessage/@${basicId}/?${worker.line_link_code}` : null

  const visibleWorkers = workers.filter(w => showInactive || w.status === 'active')

  // ---- Unresolved senders ----
  const [unlinkedSenders, setUnlinkedSenders] = useState([])
  const [loadingUnlinked, setLoadingUnlinked] = useState(true)
  const [pickedWorker, setPickedWorker] = useState({}) // senderId -> workerId
  const [resolvingId, setResolvingId] = useState(null)
  const [dismissSender, setDismissSender] = useState(null)

  const fetchUnlinkedSenders = async () => {
    setLoadingUnlinked(true)
    const { data, error } = await supabase
      .from('line_unlinked_senders')
      .select('*')
      .is('linked_worker_id', null)
      .order('first_seen_at', { ascending: false })
    if (!error) setUnlinkedSenders(data || [])
    setLoadingUnlinked(false)
  }
  useEffect(() => { fetchUnlinkedSenders() }, [])

  const handleResolveSender = async (sender) => {
    const workerId = pickedWorker[sender.id]
    if (!workerId) return alert('กรุณาเลือกทีมงานก่อน')
    setResolvingId(sender.id)
    try {
      const { error: e1 } = await supabase.from('workers').update({ line_user_id: sender.line_user_id }).eq('id', workerId)
      if (e1) throw e1
      const { error: e2 } = await supabase.from('line_unlinked_senders').update({ linked_worker_id: workerId }).eq('id', sender.id)
      if (e2) throw e2
      setUnlinkedSenders(list => list.filter(s => s.id !== sender.id))
      fetchWorkers()
      alert('✅ เชื่อมต่อแล้ว')
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setResolvingId(null)
    }
  }

  const handleDismissSender = async () => {
    if (!dismissSender) return
    setResolvingId(dismissSender.id)
    try {
      const { error } = await supabase.from('line_unlinked_senders').delete().eq('id', dismissSender.id)
      if (error) throw error
      setUnlinkedSenders(list => list.filter(s => s.id !== dismissSender.id))
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setResolvingId(null)
      setDismissSender(null)
    }
  }

  // ---- Unrecognized groups -- every message from a group that isn't
  // the configured crew_group_id gets captured here by line-webhook
  // (see 2026-09-27-04-line-unrecognized-groups.sql) so switching to a
  // new/different group chat has somewhere to actually find its ID,
  // instead of the "Crew Group ID" field's placeholder claim being
  // false. "ใช้กลุ่มนี้" writes straight into line_settings.crew_group_id.
  const [unrecognizedGroups, setUnrecognizedGroups] = useState([])
  const [loadingGroups, setLoadingGroups] = useState(true)
  const [groupActionId, setGroupActionId] = useState(null)
  const [dismissGroup, setDismissGroup] = useState(null)
  const [useGroupTarget, setUseGroupTarget] = useState(null)

  const fetchUnrecognizedGroups = async () => {
    setLoadingGroups(true)
    const { data, error } = await supabase
      .from('line_unrecognized_groups')
      .select('*')
      .order('last_seen_at', { ascending: false })
    if (!error) setUnrecognizedGroups(data || [])
    setLoadingGroups(false)
  }
  useEffect(() => { fetchUnrecognizedGroups() }, [])

  const handleUseGroup = async () => {
    if (!useGroupTarget) return
    setGroupActionId(useGroupTarget.id)
    try {
      const { error: e1 } = await supabase.from('line_settings').update({ crew_group_id: useGroupTarget.group_id, updated_at: new Date().toISOString() }).eq('tenant_id', tenant.id)
      if (e1) throw e1
      const { error: e2 } = await supabase.from('line_unrecognized_groups').delete().eq('id', useGroupTarget.id)
      if (e2) throw e2
      setUnrecognizedGroups(list => list.filter(g => g.id !== useGroupTarget.id))
      fetchLineSettings()
      alert('✅ ตั้งเป็นกลุ่มทีมงานแล้ว')
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setGroupActionId(null)
      setUseGroupTarget(null)
    }
  }

  const handleDismissGroup = async () => {
    if (!dismissGroup) return
    setGroupActionId(dismissGroup.id)
    try {
      const { error } = await supabase.from('line_unrecognized_groups').delete().eq('id', dismissGroup.id)
      if (error) throw error
      setUnrecognizedGroups(list => list.filter(g => g.id !== dismissGroup.id))
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setGroupActionId(null)
      setDismissGroup(null)
    }
  }

  // ---- Reminders: the one LINE-specific toggle that actually gates a
  // scheduled push (line-push-cheque-reminders reads this exact key --
  // see that function's own top comment). Everything else scheduled
  // (daily assignments, invoice-due) has no on/off setting to expose,
  // and quotation follow-up is configured per-quotation, not here.
  const { data: chequeLineEnabledVal, refetch: refetchChequeLineEnabled } = useAppSetting('cheque_reminder_line_enabled', 'false')
  const chequeLineEnabled = chequeLineEnabledVal === 'true'
  const [savingChequeToggle, setSavingChequeToggle] = useState(false)
  const handleToggleChequeLine = async () => {
    setSavingChequeToggle(true)
    try {
      await saveAppSetting('cheque_reminder_line_enabled', chequeLineEnabled ? 'false' : 'true')
      refetchChequeLineEnabled()
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSavingChequeToggle(false)
    }
  }

  const statusBadge = (ok, onText, offText) => (
    <span className="badge" style={{ background: ok ? 'rgba(0,212,170,0.2)' : 'rgba(255,107,107,0.2)', color: ok ? 'var(--green)' : 'var(--red)' }}>
      {ok ? onText : offText}
    </span>
  )

  return (
    <div>
      <h2 style={{ marginBottom: 16, fontSize: 18, fontWeight: 700 }}>💬 การสื่อสาร — บอทไลน์ทีมงาน</h2>

      {/* ---- Command guide ---- */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ padding: 16, borderBottom: '1px solid var(--border)', fontWeight: 700 }}>📖 คำสั่งที่พิมพ์ได้ในไลน์</div>
        <div style={{ padding: '10px 16px', fontSize: 12, color: 'var(--text3)', borderBottom: '1px solid var(--border)' }}>
          คำสั่งเหล่านี้ถูกกำหนดไว้ในระบบตายตัว (ไม่ใช่ตั้งค่าได้จากหน้านี้) — รายการนี้ไว้ดูอ้างอิงว่าพิมพ์อะไรได้บ้าง และใช้ได้ที่ไหน
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>พิมพ์</th>
                <th>ใช้ได้ที่ไหน</th>
                <th>ทำอะไร</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['งานวันนี้', 'แชทส่วนตัว + กลุ่ม', 'แชทส่วนตัว: งานของตัวเอง + ปุ่มลัดตามสถานะ (เช็คอิน/เช็คเอาท์/งานเสร็จ) · กลุ่ม: งานของทั้งทีมวันนี้ แบ่งตามไซต์'],
                ['งานวันพรุ่งนี้', 'แชทส่วนตัว + กลุ่ม', 'เหมือนงานวันนี้ แต่เป็นของพรุ่งนี้'],
                ['งานอาทิตย์นี้', 'แชทส่วนตัว + กลุ่ม', 'สรุป 7 วัน (จ-อา) ของอาทิตย์นี้ ทีละบรรทัด'],
                ['งานอาทิตย์หน้า', 'แชทส่วนตัว + กลุ่ม', 'สรุป 7 วัน (จ-อา) ของอาทิตย์หน้า ทีละบรรทัด'],
                ['เช็คอิน / เช็คเอาท์', 'แชทส่วนตัวเท่านั้น', 'ขอแชร์ตำแหน่ง แล้วบันทึกเช็คอิน/เอาท์ (ต้องอยู่ในรัศมีไซต์งาน)'],
                ['รูปภาพหน้างาน', 'แชทส่วนตัวเท่านั้น', 'ส่งรูปหน้างาน (ส่งได้หลายรูป จบด้วย "เสร็จแล้ว")'],
                ['งานเสร็จ / เสร็จงาน', 'แชทส่วนตัวเท่านั้น', 'ปิดการ์ด Kanban งานที่ทำอยู่ + แนบรูปงานเสร็จ'],
                ['แจ้งปัญหา (มีคำว่า "ปัญหา")', 'กลุ่มทีมงาน', 'บันทึกแจ้งปัญหาหน้างาน'],
                ['ขอเบิก / อยากเบิก / เบิกของ', 'กลุ่มทีมงาน', 'ส่งลิงก์ฟอร์มเบิกของ (ใช้ได้ 30 นาที)'],
                ['ขอลา / อยากลา / ลากิจ / ลาป่วย', 'กลุ่มทีมงาน', 'ส่งลิงก์ฟอร์มขอลา (ใช้ได้ 30 นาที)'],
                ['รหัสเชื่อมต่อ 6 หลัก', 'แชทส่วนตัวเท่านั้น', 'เชื่อมบัญชีไลน์เข้ากับผู้ใช้/พนักงานในระบบ'],
              ].map(([cmd, where, what]) => (
                <tr key={cmd}>
                  <td style={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap' }}>{cmd}</td>
                  <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{where}</td>
                  <td style={{ fontSize: 12.5 }}>{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ padding: '10px 16px', fontSize: 11.5, color: 'var(--text3)', borderTop: '1px solid var(--border)' }}>
          "แชทส่วนตัว" ต้องเชื่อมบัญชีก่อนด้วยรหัส 6 หลัก · "กลุ่มทีมงาน" ต้องเป็นกลุ่มที่ตั้งไว้ด้านล่าง (การ์ด "การเชื่อมต่อ LINE Official Account") ยกเว้นคำสั่งดูตารางงาน 4 อันแรกที่ใครในกลุ่มก็ถามได้เลยเพราะเป็นแค่การดูข้อมูล
        </div>
      </div>

      {/* ---- Connection ---- */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ padding: 16, borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ fontWeight: 700 }}>📡 การเชื่อมต่อ LINE Official Account</div>
          {!loadingSettings && statusBadge(!!lineSettings?.bot_user_id, '✅ เชื่อมต่อแล้ว', '❌ ยังไม่เชื่อมต่อ')}
        </div>
        {loadingSettings ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>กำลังโหลด...</div>
        ) : (
          <form onSubmit={handleSaveConnection} style={{ padding: 16, display: 'grid', gap: 12, maxWidth: 480 }}>
            <div>
              <label className="label">Channel ID {!lineSettings && '★'}</label>
              <input className="input" value={connForm.channel_id} onChange={e => setConn('channel_id', e.target.value)} placeholder="เช่น 2011669659" />
            </div>
            <div>
              <label className="label">Channel Secret {!lineSettings && '★'}</label>
              <input className="input" type="password" value={connForm.channel_secret} onChange={e => setConn('channel_secret', e.target.value)}
                placeholder={lineSettings ? '•••• (ตั้งไว้แล้ว — เว้นว่างไว้ถ้าไม่เปลี่ยน)' : 'วาง Channel Secret'} />
            </div>
            <div>
              <label className="label">Channel Access Token {!lineSettings && '★'}</label>
              <input className="input" type="password" value={connForm.channel_access_token} onChange={e => setConn('channel_access_token', e.target.value)}
                placeholder={lineSettings ? '•••• (ตั้งไว้แล้ว — เว้นว่างไว้ถ้าไม่เปลี่ยน)' : 'วาง Channel Access Token'} />
            </div>
            <div>
              <label className="label">Basic ID (@handle)</label>
              <input className="input" value={connForm.basic_id} onChange={e => setConn('basic_id', e.target.value)} placeholder="เช่น 302yljzw (ไม่ต้องใส่ @)" />
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>ใช้สร้างลิงก์เชื่อมต่อให้ทีมงานด้านล่าง — ดูได้จาก LINE Official Account Manager</div>
            </div>
            <div>
              <label className="label">Crew Group ID</label>
              <input className="input" value={connForm.crew_group_id} onChange={e => setConn('crew_group_id', e.target.value)} placeholder="Cxxxxxxxx... (จับได้จากข้อความจริงในกลุ่ม)" />
            </div>
            {!lineSettings?.bot_user_id && lineSettings && (
              <div className="alert alert-warning" style={{ fontSize: 12 }}>
                ⚠️ ยังไม่มี Bot User ID — บอทจะไม่ตอบข้อความจนกว่าผู้ดูแลระบบจะตั้งค่านี้ให้ (ดึงจาก LINE Get Bot Info API)
              </div>
            )}
            <div>
              <button type="submit" className="btn btn-primary" disabled={savingConnection}>
                {savingConnection ? '⏳...' : '✅ บันทึก'}
              </button>
            </div>
          </form>
        )}
      </div>

      {/* ---- My own LINE link ---- */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ padding: 16, borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ fontWeight: 700 }}>🙋 เชื่อมต่อ LINE ส่วนตัว</div>
          {!loadingMyRole && statusBadge(!!myRole?.line_user_id, '✅ เชื่อมต่อแล้ว', '❌ ยังไม่เชื่อมต่อ')}
        </div>
        <div style={{ padding: 16 }}>
          <div style={{ fontSize: 12.5, color: 'var(--text3)', marginBottom: 10 }}>
            เชื่อมบัญชี LINE ของคุณเองเข้ากับบอทนี้ เพื่อรับการแจ้งเตือน (เช่น พนักงานพ้นสภาพยังส่งข้อความอยู่)
          </div>
          {!myRole?.line_user_id && (
            <button className="btn btn-sm btn-ghost" disabled={generatingMyLink} onClick={() => (myRole?.line_link_code ? setShowMyLinkModal(true) : handleGenerateMyCode())}>
              {generatingMyLink ? '⏳...' : myRole?.line_link_code ? '🔗 ดูลิงก์' : '🔗 สร้างลิงก์เชื่อมต่อ'}
            </button>
          )}
        </div>
      </div>

      {/* ---- Worker linking ---- */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ padding: 16, borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ fontWeight: 700 }}>👷 การเชื่อมต่อ LINE ของทีมงาน</div>
          <label style={{ fontSize: 12, color: 'var(--text3)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
            แสดงที่ลาออกแล้ว
          </label>
        </div>
        {loadingWorkers ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>กำลังโหลด...</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ชื่อ</th>
                  <th>ตำแหน่ง</th>
                  <th>สถานะการเชื่อมต่อ</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visibleWorkers.map(w => (
                  <tr key={w.id}>
                    <td style={{ fontWeight: 600 }}>{w.nickname || w.name}{w.status !== 'active' && <span style={{ color: 'var(--text3)', fontWeight: 400 }}> (ลาออกแล้ว)</span>}</td>
                    <td style={{ color: 'var(--text3)' }}>{w.position || '-'}</td>
                    <td>
                      {w.line_user_id
                        ? statusBadge(true, '✅ เชื่อมต่อแล้ว')
                        : w.line_link_code
                        ? <span className="badge" style={{ background: 'rgba(255,193,7,0.2)', color: '#c98a00' }}>⏳ รอกดลิงก์</span>
                        : statusBadge(false, '', '❌ ยังไม่เชื่อม')}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {!w.line_user_id && (
                        <button className="btn btn-sm btn-ghost" disabled={generatingFor === w.id} onClick={() => handleShowLink(w)}>
                          {generatingFor === w.id ? '⏳...' : w.line_link_code ? '🔗 ดูลิงก์' : '🔗 สร้างลิงก์เชื่อมต่อ'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {!visibleWorkers.length && (
                  <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ไม่พบทีมงาน</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---- Unresolved senders ---- */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ padding: 16, borderBottom: '1px solid var(--border)', fontWeight: 700 }}>
          ❓ ผู้ส่งข้อความที่ยังไม่รู้จัก {unlinkedSenders.length > 0 && `(${unlinkedSenders.length})`}
        </div>
        {loadingUnlinked ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>กำลังโหลด...</div>
        ) : !unlinkedSenders.length ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>ไม่มีรายการ — ทุกคนที่ทักในกลุ่มทีมงานถูกจดจำแล้ว</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>LINE User ID</th>
                  <th>พบครั้งแรก</th>
                  <th>เชื่อมกับทีมงาน</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {unlinkedSenders.map(s => (
                  <tr key={s.id}>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{s.line_user_id}</td>
                    <td style={{ fontSize: 12, color: 'var(--text3)' }}>{new Date(s.first_seen_at).toLocaleString('th-TH')}</td>
                    <td>
                      <select className="select select-sm" value={pickedWorker[s.id] || ''} onChange={e => setPickedWorker(p => ({ ...p, [s.id]: e.target.value }))}>
                        <option value="">-- เลือกทีมงาน --</option>
                        {workers.filter(w => !w.line_user_id).map(w => (
                          <option key={w.id} value={w.id}>{w.nickname || w.name}</option>
                        ))}
                      </select>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm btn-primary" disabled={resolvingId === s.id} onClick={() => handleResolveSender(s)}>เชื่อมต่อ</button>
                      <button className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} disabled={resolvingId === s.id} onClick={() => setDismissSender(s)}>ลบ</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---- Unrecognized groups ---- */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ padding: 16, borderBottom: '1px solid var(--border)', fontWeight: 700 }}>
          👥 กลุ่มไลน์ที่ยังไม่ตั้งเป็นกลุ่มทีมงาน {unrecognizedGroups.length > 0 && `(${unrecognizedGroups.length})`}
        </div>
        <div style={{ padding: '10px 16px', fontSize: 12, color: 'var(--text3)', borderBottom: '1px solid var(--border)' }}>
          เพิ่มบอทเข้ากลุ่มใหม่แล้วพิมพ์ข้อความอะไรก็ได้ในกลุ่มนั้น — ID กลุ่มจะโผล่ที่นี่ให้กดตั้งเป็นกลุ่มทีมงานได้เลย
        </div>
        {loadingGroups ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>กำลังโหลด...</div>
        ) : !unrecognizedGroups.length ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>ไม่มีรายการ — ยังไม่มีข้อความจากกลุ่มอื่นที่ไม่รู้จัก</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Group ID</th>
                  <th>ข้อความล่าสุด</th>
                  <th>พบล่าสุด</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {unrecognizedGroups.map(g => (
                  <tr key={g.id}>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{g.group_id}</td>
                    <td style={{ fontSize: 12, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.sample_text || '-'}</td>
                    <td style={{ fontSize: 12, color: 'var(--text3)' }}>{new Date(g.last_seen_at).toLocaleString('th-TH')}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm btn-primary" disabled={groupActionId === g.id} onClick={() => setUseGroupTarget(g)}>ใช้กลุ่มนี้</button>
                      <button className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} disabled={groupActionId === g.id} onClick={() => setDismissGroup(g)}>ลบ</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---- Reminders ---- */}
      <div className="card">
        <div style={{ padding: 16, borderBottom: '1px solid var(--border)', fontWeight: 700 }}>🔔 การแจ้งเตือนอัตโนมัติผ่าน LINE</div>
        <div style={{ padding: 16, display: 'grid', gap: 14 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={chequeLineEnabled} disabled={savingChequeToggle} onChange={handleToggleChequeLine} />
            <div>
              <div style={{ fontWeight: 600 }}>แจ้งเตือนเช็คใกล้ครบกำหนดผ่าน LINE</div>
              <div style={{ fontSize: 12, color: 'var(--text3)' }}>ใช้จำนวนวันเดียวกับที่ตั้งไว้ใน ⚙️ ตั้งค่า → แจ้งเตือนเช็ค</div>
            </div>
          </label>
          <div style={{ fontSize: 12, color: 'var(--text3)', borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            รายการอื่นที่ส่งอัตโนมัติอยู่แล้ว ไม่มีสวิตช์เปิด/ปิด:
            <ul style={{ margin: '6px 0 0 0', paddingLeft: 18 }}>
              <li>สรุปงานประจำวันเข้ากลุ่มทีมงาน (ทุกวัน)</li>
              <li>ติดตามใบเสนอราคา — ตั้งจำนวนวันได้ในหน้าใบเสนอราคาแต่ละใบ</li>
              <li>แจ้งเตือนใบแจ้งหนี้ค้างชำระ (ทุกต้นเดือน)</li>
            </ul>
          </div>
        </div>
      </div>

      {linkModalWorker && (
        <Modal title={`ลิงก์เชื่อมต่อ — ${linkModalWorker.nickname || linkModalWorker.name}`} onClose={() => setLinkModalWorker(null)} maxWidth={420}>
          <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
            {!basicId ? (
              <div className="alert alert-warning" style={{ fontSize: 12 }}>
                ⚠️ ยังไม่ได้ตั้ง Basic ID ด้านบน — ให้ทีมงานพิมพ์รหัสนี้เองในแชทบอทแทน
              </div>
            ) : null}
            <div>
              <label className="label">รหัสเชื่อมต่อ</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="input" readOnly value={linkModalWorker.line_link_code} style={{ fontFamily: 'monospace', fontWeight: 700, letterSpacing: 2 }} />
                <button type="button" className="btn btn-ghost" onClick={() => handleCopy(linkModalWorker.line_link_code)}>คัดลอก</button>
              </div>
            </div>
            {basicId && (
              <div>
                <label className="label">ลิงก์ (กดแล้วพิมพ์รหัสให้อัตโนมัติ)</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="input" readOnly value={linkUrl(linkModalWorker)} style={{ fontSize: 12 }} />
                  <button type="button" className="btn btn-ghost" onClick={() => handleCopy(linkUrl(linkModalWorker))}>คัดลอก</button>
                </div>
              </div>
            )}
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>
              ส่งรหัส (หรือลิงก์) นี้ให้ {linkModalWorker.nickname || linkModalWorker.name} เป็นการส่วนตัว — ให้เปิดแชทกับบอทแล้วกดส่งเพื่อเชื่อมต่อบัญชี
            </div>
            <button type="button" className="btn btn-sm btn-ghost" style={{ justifySelf: 'start' }} onClick={() => handleGenerateCode(linkModalWorker)}>
              🔄 สร้างรหัสใหม่
            </button>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-primary" onClick={() => setLinkModalWorker(null)}>ปิด</button>
          </div>
        </Modal>
      )}

      {showMyLinkModal && myRole?.line_link_code && (
        <Modal title="ลิงก์เชื่อมต่อ LINE ส่วนตัว" onClose={() => setShowMyLinkModal(false)} maxWidth={420}>
          <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
            {!basicId ? (
              <div className="alert alert-warning" style={{ fontSize: 12 }}>⚠️ ยังไม่ได้ตั้ง Basic ID ด้านบน — ให้พิมพ์รหัสนี้เองในแชทบอทแทน</div>
            ) : null}
            <div>
              <label className="label">รหัสเชื่อมต่อ</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="input" readOnly value={myRole.line_link_code} style={{ fontFamily: 'monospace', fontWeight: 700, letterSpacing: 2 }} />
                <button type="button" className="btn btn-ghost" onClick={() => handleCopy(myRole.line_link_code)}>คัดลอก</button>
              </div>
            </div>
            {basicId && (
              <div>
                <label className="label">ลิงก์ (กดแล้วพิมพ์รหัสให้อัตโนมัติ)</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="input" readOnly value={`https://line.me/R/oaMessage/@${basicId}/?${myRole.line_link_code}`} style={{ fontSize: 12 }} />
                  <button type="button" className="btn btn-ghost" onClick={() => handleCopy(`https://line.me/R/oaMessage/@${basicId}/?${myRole.line_link_code}`)}>คัดลอก</button>
                </div>
              </div>
            )}
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>เปิดลิงก์นี้บนมือถือของคุณเอง แล้วกดส่งข้อความเพื่อเชื่อมต่อบัญชี</div>
            <button type="button" className="btn btn-sm btn-ghost" style={{ justifySelf: 'start' }} onClick={handleGenerateMyCode}>🔄 สร้างรหัสใหม่</button>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-primary" onClick={() => setShowMyLinkModal(false)}>ปิด</button>
          </div>
        </Modal>
      )}

      {dismissSender && (
        <ConfirmDialog
          title="ลบรายการ"
          message="ลบผู้ส่งข้อความนี้ออกจากรายการ? ใช้เมื่อไม่ใช่ทีมงานจริง (เช่น สแปมหรือลูกค้าที่ทักผิดกลุ่ม)"
          onConfirm={handleDismissSender}
          onCancel={() => setDismissSender(null)}
        />
      )}

      {dismissGroup && (
        <ConfirmDialog
          title="ลบรายการ"
          message="ลบกลุ่มนี้ออกจากรายการ? ใช้เมื่อไม่ใช่กลุ่มที่ต้องการ (เช่น กลุ่มทดสอบหรือกลุ่มอื่นที่ไม่เกี่ยวข้อง)"
          onConfirm={handleDismissGroup}
          onCancel={() => setDismissGroup(null)}
        />
      )}

      {useGroupTarget && (
        <ConfirmDialog
          title="ตั้งกลุ่มนี้เป็นกลุ่มทีมงาน"
          message={
            <>
              <div style={{ fontFamily: 'monospace', fontSize: 12.5 }}>{useGroupTarget.group_id}</div>
              <div style={{ margin: '8px 0' }}>ข้อความล่าสุด: "{useGroupTarget.sample_text || '-'}"</div>
              <div>ระบบจะแจ้งงานประจำวันและข้อความอัตโนมัติอื่นๆ เข้ากลุ่มนี้แทนกลุ่มเดิม</div>
            </>
          }
          onConfirm={handleUseGroup}
          onCancel={() => setUseGroupTarget(null)}
        />
      )}
    </div>
  )
}
