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
import {
  SCHEDULE_COMMAND_KEYS, SCHEDULE_COMMAND_DEFAULTS, FIXED_COMMAND_KEYS, FIXED_COMMAND_LABELS, FIXED_COMMAND_PHRASES,
  resolveEnabled, resolveEffectivePhrases, validateCustomPhrase,
} from '../lib/lineCommandSettings.js'

const SCHEDULE_COMMAND_DESCRIPTIONS = {
  today_job: 'แชทส่วนตัว: งานของตัวเอง + ปุ่มลัดตามสถานะ (เช็คอิน/เช็คเอาท์/งานเสร็จ) · กลุ่ม: งานของทั้งทีมวันนี้ แบ่งตามไซต์',
  tomorrow_job: 'เหมือนงานวันนี้ แต่เป็นของพรุ่งนี้',
  this_week_job: 'สรุป 7 วัน (จ-อา) ของอาทิตย์นี้ ทีละบรรทัด',
  next_week_job: 'สรุป 7 วัน (จ-อา) ของอาทิตย์หน้า ทีละบรรทัด',
}

const FIXED_COMMAND_DESCRIPTIONS = {
  issue_report: 'บันทึกแจ้งปัญหาหน้างาน',
  material_request: 'ส่งลิงก์ฟอร์มเบิกของ (ใช้ได้ 30 นาที)',
  leave: 'ส่งลิงก์ฟอร์มขอลา (ใช้ได้ 30 นาที)',
  check_in: 'ขอแชร์ตำแหน่ง แล้วบันทึกเช็คอิน (ต้องอยู่ในรัศมีไซต์งาน)',
  check_out: 'ขอแชร์ตำแหน่ง แล้วบันทึกเช็คเอาท์ (ต้องอยู่ในรัศมีไซต์งาน)',
  site_photo: 'ส่งรูปหน้างาน (ส่งได้หลายรูป จบด้วย "เสร็จแล้ว")',
  job_done_start: 'ปิดการ์ด Kanban งานที่ทำอยู่ + แนบรูปงานเสร็จ',
}

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

  // Tests whatever Group ID is currently TYPED (not just the saved
  // value) against LINE's own "get group chat summary" API -- read-only,
  // no message sent, no push quota spent. Confirms both that the ID is
  // valid AND that the bot is still actually a member of that group.
  const [testingGroup, setTestingGroup] = useState(false)
  const [groupTestResult, setGroupTestResult] = useState(null)
  const handleTestGroupId = async () => {
    setTestingGroup(true)
    setGroupTestResult(null)
    try {
      const { data, error } = await supabase.functions.invoke('line-test-group', { body: { group_id: connForm.crew_group_id } })
      if (error) throw error
      setGroupTestResult(data)
    } catch (e) {
      setGroupTestResult({ ok: false, error: e.message })
    } finally {
      setTestingGroup(false)
    }
  }

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

  // ---- Custom command settings -- lets OWNER enable/disable ALL 11
  // crew bot commands (widened 2026-09-28 from just the 4 schedule
  // ones, per explicit ask), and additionally rename the 4 read-only
  // schedule-query commands (2026-09-27-06-line-command-settings.sql +
  // 2026-09-28-02-line-command-settings-all-11.sql). Rename supports
  // multiple comma-separated phrases; the other 7's phrases stay fixed
  // in code (matchGroupAction/matchDMAction), toggle-only. A missing
  // row for a command_key means "enabled, default phrase"
  // (resolveEnabled/resolveEffectivePhrases handle that fallback), so
  // this fetch can come back empty and the page still renders every
  // command correctly.
  const [commandSettings, setCommandSettings] = useState([])
  const commandSettingsByKey = Object.fromEntries(commandSettings.map(r => [r.command_key, r]))
  const [editingCommandKey, setEditingCommandKey] = useState(null)
  const [editPhraseValue, setEditPhraseValue] = useState('')
  const [savingCommandKey, setSavingCommandKey] = useState(null)

  const fetchCommandSettings = async () => {
    const { data, error } = await supabase.from('line_command_settings').select('*').eq('tenant_id', tenant.id)
    if (!error) setCommandSettings(data || [])
  }
  useEffect(() => { if (tenant?.id) fetchCommandSettings() }, [tenant?.id])

  const startEditCommandPhrase = (commandKey) => {
    setEditingCommandKey(commandKey)
    setEditPhraseValue(commandSettingsByKey[commandKey]?.custom_phrase || '')
  }

  const handleSaveCommandPhrase = async () => {
    if (!editingCommandKey) return
    const validation = validateCustomPhrase(editPhraseValue, editingCommandKey, commandSettingsByKey)
    if (!validation.valid) { alert('⚠️ ' + validation.reason); return }
    setSavingCommandKey(editingCommandKey)
    try {
      const existing = commandSettingsByKey[editingCommandKey]
      const { error } = await supabase.from('line_command_settings').upsert(
        { tenant_id: tenant.id, command_key: editingCommandKey, enabled_dm: existing ? existing.enabled_dm : true, enabled_group: existing ? existing.enabled_group : true, custom_phrase: editPhraseValue.trim() || null, updated_at: new Date().toISOString() },
        { onConflict: 'tenant_id,command_key' }
      )
      if (error) throw error
      setEditingCommandKey(null)
      await fetchCommandSettings()
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSavingCommandKey(null)
    }
  }

  // context: 'dm' | 'group' -- toggles only that one context, leaving the
  // other's current state (or default true) untouched.
  const handleToggleCommandEnabled = async (commandKey, context) => {
    setSavingCommandKey(commandKey)
    try {
      const existing = commandSettingsByKey[commandKey]
      const field = context === 'group' ? 'enabled_group' : 'enabled_dm'
      const otherField = context === 'group' ? 'enabled_dm' : 'enabled_group'
      const currentlyEnabled = resolveEnabled(commandKey, commandSettingsByKey, context)
      const { error } = await supabase.from('line_command_settings').upsert(
        {
          tenant_id: tenant.id, command_key: commandKey,
          [field]: !currentlyEnabled,
          [otherField]: existing ? existing[otherField] : true,
          custom_phrase: existing?.custom_phrase ?? null, updated_at: new Date().toISOString(),
        },
        { onConflict: 'tenant_id,command_key' }
      )
      if (error) throw error
      await fetchCommandSettings()
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSavingCommandKey(null)
    }
  }

  // ---- Issue reports (แจ้งปัญหา) -- line_issue_reports has been
  // written to by the webhook since this feature's first build, but
  // never had a viewer anywhere in the app until now: the user noticed
  // the gap directly ("i didn't see place to store information like
  // ปัญหา or photos?"). status is DB-constrained to 'open'/'resolved'
  // (see line_issue_reports_status_check) -- an admin_updates RLS
  // policy for it already existed too, just unused.
  const [issueReports, setIssueReports] = useState([])
  const [loadingIssues, setLoadingIssues] = useState(true)
  const [resolvingIssueId, setResolvingIssueId] = useState(null)

  const fetchIssueReports = async () => {
    setLoadingIssues(true)
    const { data, error } = await supabase
      .from('line_issue_reports')
      .select('id, message, status, created_at, workers(name, nickname), sites(name)')
      .order('created_at', { ascending: false })
      .limit(100)
    if (!error) setIssueReports(data || [])
    setLoadingIssues(false)
  }
  useEffect(() => { fetchIssueReports() }, [])

  const handleResolveIssue = async (id) => {
    setResolvingIssueId(id)
    try {
      const { error } = await supabase.from('line_issue_reports').update({ status: 'resolved' }).eq('id', id)
      if (error) throw error
      setIssueReports(list => list.map(r => (r.id === id ? { ...r, status: 'resolved' } : r)))
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setResolvingIssueId(null)
    }
  }

  // ---- Site photos (รูปภาพหน้างาน) -- same "written but never shown"
  // gap as issue reports above. line-site-photos is a PRIVATE storage
  // bucket; a signed-URL read policy for admin/owner already existed
  // (line_site_photos_tenant_access), just never called from anywhere.
  const [sitePhotos, setSitePhotos] = useState([])
  const [loadingPhotos, setLoadingPhotos] = useState(true)

  const fetchSitePhotos = async () => {
    setLoadingPhotos(true)
    const { data, error } = await supabase
      .from('line_site_photos')
      .select('id, photo_path, date, created_at, workers(name, nickname), sites(name)')
      .order('created_at', { ascending: false })
      .limit(60)
    if (error || !data?.length) {
      setSitePhotos([])
      setLoadingPhotos(false)
      return
    }
    const { data: signed } = await supabase.storage.from('line-site-photos').createSignedUrls(data.map(p => p.photo_path), 3600)
    const urlByPath = Object.fromEntries((signed || []).filter(s => !s.error).map(s => [s.path, s.signedUrl]))
    setSitePhotos(data.map(p => ({ ...p, url: urlByPath[p.photo_path] })))
    setLoadingPhotos(false)
  }
  useEffect(() => { fetchSitePhotos() }, [])

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
          เปิด/ปิดได้ทุกคำสั่ง แยกอิสระระหว่างแชทส่วนตัว (DM) กับกลุ่มไลน์ — คำสั่งดูตารางงาน 4 อันแรกเปลี่ยนคำที่ใช้พิมพ์ได้ด้วย (ใส่ได้หลายคำ คั่นด้วยจุลภาค ",") ที่เหลือกำหนดคำไว้ในระบบตายตัว แต่ปิดเปิดได้เหมือนกัน
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>พิมพ์</th>
                <th>ส่วนตัว (DM)</th>
                <th>กลุ่ม</th>
                <th>ทำอะไร</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {SCHEDULE_COMMAND_KEYS.map(key => {
                const enabledDm = resolveEnabled(key, commandSettingsByKey, 'dm')
                const enabledGroup = resolveEnabled(key, commandSettingsByKey, 'group')
                const phrases = resolveEffectivePhrases(key, commandSettingsByKey)
                const isEditing = editingCommandKey === key
                const isSaving = savingCommandKey === key
                return (
                  <tr key={key} style={{ opacity: (enabledDm || enabledGroup) ? 1 : 0.5 }}>
                    <td style={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap' }}>
                      {isEditing ? (
                        <input className="input" style={{ fontSize: 12, padding: '3px 6px', width: 220 }} value={editPhraseValue}
                          onChange={e => setEditPhraseValue(e.target.value)} placeholder={`${SCHEDULE_COMMAND_DEFAULTS[key]}, ...`} autoFocus />
                      ) : phrases.join(' / ')}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm btn-ghost" disabled={isSaving} onClick={() => handleToggleCommandEnabled(key, 'dm')}>{enabledDm ? '✅ เปิด' : '⛔ ปิด'}</button>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm btn-ghost" disabled={isSaving} onClick={() => handleToggleCommandEnabled(key, 'group')}>{enabledGroup ? '✅ เปิด' : '⛔ ปิด'}</button>
                    </td>
                    <td style={{ fontSize: 12.5 }}>{SCHEDULE_COMMAND_DESCRIPTIONS[key]}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {isEditing ? (
                        <>
                          <button className="btn btn-sm btn-primary" disabled={isSaving} onClick={handleSaveCommandPhrase}>บันทึก</button>
                          <button className="btn btn-sm btn-ghost" disabled={isSaving} onClick={() => setEditingCommandKey(null)}>ยกเลิก</button>
                        </>
                      ) : (
                        <button className="btn btn-sm btn-ghost" disabled={isSaving} onClick={() => startEditCommandPhrase(key)}>แก้ไข</button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {FIXED_COMMAND_KEYS.map(key => {
                const enabledDm = resolveEnabled(key, commandSettingsByKey, 'dm')
                const enabledGroup = resolveEnabled(key, commandSettingsByKey, 'group')
                const isSaving = savingCommandKey === key
                return (
                  <tr key={key} style={{ opacity: (enabledDm || enabledGroup) ? 1 : 0.5 }}>
                    <td style={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap' }}>{FIXED_COMMAND_PHRASES[key].join(' / ')}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm btn-ghost" disabled={isSaving} onClick={() => handleToggleCommandEnabled(key, 'dm')}>{enabledDm ? '✅ เปิด' : '⛔ ปิด'}</button>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm btn-ghost" disabled={isSaving} onClick={() => handleToggleCommandEnabled(key, 'group')}>{enabledGroup ? '✅ เปิด' : '⛔ ปิด'}</button>
                    </td>
                    <td style={{ fontSize: 12.5 }}>{FIXED_COMMAND_DESCRIPTIONS[key]}</td>
                    <td></td>
                  </tr>
                )
              })}
              <tr>
                <td style={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap' }}>รหัสเชื่อมต่อ 6 หลัก</td>
                <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>แชทส่วนตัวเท่านั้น</td>
                <td style={{ fontSize: 12.5 }}>เชื่อมบัญชีไลน์เข้ากับผู้ใช้/พนักงานในระบบ</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div style={{ padding: '10px 16px', fontSize: 11.5, color: 'var(--text3)', borderTop: '1px solid var(--border)' }}>
          "แชทส่วนตัว" ต้องเชื่อมบัญชีก่อนด้วยรหัส 6 หลัก · "กลุ่มทีมงาน" ต้องเป็นกลุ่มที่ตั้งไว้ด้านล่าง (การ์ด "การเชื่อมต่อ LINE Official Account") ยกเว้นคำสั่งดูตารางงาน 4 อันแรกที่ใครในกลุ่มก็ถามได้เลยเพราะเป็นแค่การดูข้อมูล — คำสั่งไหน "ปิด" อยู่แล้วมีคนพิมพ์ บอทจะตอบกลับว่าฟีเจอร์นี้ปิดอยู่ ให้ติดต่อแอดมินโดยตรง (ไม่เงียบเฉยแบบเดิม)
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
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="input" value={connForm.crew_group_id} onChange={e => { setConn('crew_group_id', e.target.value); setGroupTestResult(null) }} placeholder="Cxxxxxxxx... (จับได้จากข้อความจริงในกลุ่ม)" />
                <button type="button" className="btn btn-ghost" disabled={testingGroup || !connForm.crew_group_id} onClick={handleTestGroupId}>
                  {testingGroup ? '⏳...' : 'ทดสอบ'}
                </button>
              </div>
              <div style={{ fontSize: 11, marginTop: 4 }}>
                {groupTestResult?.ok && <span style={{ color: 'var(--green)' }}>✅ กลุ่ม: {groupTestResult.groupName}</span>}
                {groupTestResult && !groupTestResult.ok && <span style={{ color: 'var(--red)' }}>❌ {groupTestResult.error}</span>}
                {!groupTestResult && <span style={{ color: 'var(--text3)' }}>กด "ทดสอบ" เพื่อเช็คว่าบอทยังอยู่ในกลุ่มนี้จริง (ไม่ส่งข้อความ ไม่เสียโควต้า)</span>}
              </div>
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

      {/* ---- Issue reports ---- */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ padding: 16, borderBottom: '1px solid var(--border)', fontWeight: 700 }}>
          🚧 แจ้งปัญหาหน้างาน {issueReports.filter(r => r.status === 'open').length > 0 && `(${issueReports.filter(r => r.status === 'open').length} ยังไม่แก้ไข)`}
        </div>
        {loadingIssues ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>กำลังโหลด...</div>
        ) : !issueReports.length ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>ไม่มีรายการ — ยังไม่มีการแจ้งปัญหาเข้ามา</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>พนักงาน</th>
                  <th>ไซต์งาน</th>
                  <th>รายละเอียด</th>
                  <th>วันที่แจ้ง</th>
                  <th>สถานะ</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {issueReports.map(r => (
                  <tr key={r.id} style={{ opacity: r.status === 'resolved' ? 0.55 : 1 }}>
                    <td style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>{r.workers?.nickname || r.workers?.name || '-'}</td>
                    <td style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>{r.sites?.name || '-'}</td>
                    <td style={{ fontSize: 12.5, maxWidth: 320 }}>{r.message}</td>
                    <td style={{ fontSize: 12, color: 'var(--text3)', whiteSpace: 'nowrap' }}>{new Date(r.created_at).toLocaleString('th-TH')}</td>
                    <td>{statusBadge(r.status === 'resolved', '✅ แก้ไขแล้ว', '🚧 ยังไม่แก้ไข')}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {r.status === 'open' && (
                        <button className="btn btn-sm btn-primary" disabled={resolvingIssueId === r.id} onClick={() => handleResolveIssue(r.id)}>แก้ไขแล้ว</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---- Site photos ---- */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ padding: 16, borderBottom: '1px solid var(--border)', fontWeight: 700 }}>📷 รูปภาพหน้างาน (ล่าสุด {sitePhotos.length} รูป)</div>
        {loadingPhotos ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>กำลังโหลด...</div>
        ) : !sitePhotos.length ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>ไม่มีรายการ — ยังไม่มีรูปภาพส่งเข้ามา</div>
        ) : (
          <div style={{ padding: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12 }}>
            {sitePhotos.map(p => (
              <a key={p.id} href={p.url} target="_blank" rel="noreferrer" style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
                {p.url ? (
                  <img src={p.url} alt="" style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)' }} />
                ) : (
                  <div style={{ width: '100%', aspectRatio: '1', borderRadius: 8, border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: 'var(--text3)' }}>โหลดรูปไม่สำเร็จ</div>
                )}
                <div style={{ fontSize: 11, marginTop: 4, color: 'var(--text3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {p.workers?.nickname || p.workers?.name || '-'} · {p.sites?.name || '-'}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--text3)' }}>{new Date(p.created_at).toLocaleDateString('th-TH')}</div>
              </a>
            ))}
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
