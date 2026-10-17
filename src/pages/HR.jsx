// ============================================================
// HR — บริหารทีมช่าง + เงินเดือน + ประวัติการแก้ไข
// ✅ Worker CRUD (ย้ายมาจาก Assign)
// ✅ Payroll (PayrollMonth.jsx)
// ✅ Audit log viewer
// ============================================================
import { useState, useMemo, useEffect } from 'react'
import { useUserRole } from '../hooks/useUserRole.js'
import { useTenant } from '../hooks/useTenant.js'
import { canEditPage } from '../lib/permissions.js'
import { useDraftForm } from '../hooks/useDraftForm.js'
import { supabase } from '../lib/supabase.js'
import { useAllActiveWorkers, useAuditLogs, useCompanyHolidays, saveCompanyHoliday, deleteCompanyHoliday, useAppSetting, saveAppSetting, useLeaveQuotaUsage, useSickLeaveQuotaUsage, useSeatStatus } from '../hooks/useSupabase.js'
import { fmt } from '../lib/supabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import PendingMark from '../components/PendingMark.jsx'
import { usePendingFocus } from '../hooks/usePendingFocus.js'
import PendingFocusChip from '../components/PendingFocusChip.jsx'
import { isLeavePending } from '../lib/pendingRules.js'
import SearchableSelect from '../components/SearchableSelect.jsx'
import { auditLog } from '../lib/audit.js'
import { TrashIcon, PencilIcon } from '../components/icons.jsx'
import AttendanceGrid from './hr/AttendanceGrid.jsx'
import WorkerPayFields from './hr/WorkerPayFields.jsx'
import PayrollMonth from './hr/PayrollMonth.jsx'
import AdvancesPanel from './hr/AdvancesPanel.jsx'
import { usePayItems, useWorkerPayAmounts } from '../hooks/usePayroll.js'
import { validateAccount } from '../lib/bankExport/banks.js'

// ── Worker Form (เหมือนใน Assign.jsx เดิม) ────────────────────
const EMPTY_WORKER = {
  name: '', nickname: '', position: '',
  monthly_salary: '', status: 'active',
  has_social_security: true, annual_leave_days: 6, annual_sick_leave_days: 30, monthly_contribution: '', email: '',
  show_in_assign: true, id_card_number: '', address: '',
  employee_code: '', pay_type: 'monthly', daily_wage: '', bank_code: '', bank_account_no: '', bank_account_name: '', bank_branch_code: '',
}

function WorkerForm({ initial = EMPTY_WORKER, onSave, onCancel, loading, workerUsers = [], seat }) {
  const isAdd = !initial?.id
  const [form, setForm, clearFormDraft] = useDraftForm('worker-form', { ...EMPTY_WORKER, ...initial, bank_branch_touched: !!initial?.bank_branch_code }, isAdd)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const dailyRate = form.pay_type === 'daily'
    ? (form.daily_wage || '—')
    : (form.monthly_salary ? (parseFloat(form.monthly_salary) / 30).toFixed(2) : '—')
  const { data: payItems } = usePayItems()
  const { data: savedAmounts } = useWorkerPayAmounts(initial?.id)
  const [amounts, setAmounts] = useState({})
  useEffect(() => { if (savedAmounts) setAmounts(a => ({ ...savedAmounts, ...a })) }, [savedAmounts])
  const workersFull = isAdd && seat?.workers?.max != null && seat.workers.used >= seat.workers.max

  // Raw File, deliberately NOT part of `form` (see handleSaveWorker's own
  // comment for why -- draft-persisted state can't survive a File object).
  const [idCardFile, setIdCardFile] = useState(null)
  const idCardPreviewUrl = useMemo(() => idCardFile ? URL.createObjectURL(idCardFile) : null, [idCardFile])
  useEffect(() => () => { if (idCardPreviewUrl) URL.revokeObjectURL(idCardPreviewUrl) }, [idCardPreviewUrl])

  // Existing photo (editing an already-saved worker) -- signed URL, since
  // worker-id-cards is a private bucket.
  const [existingIdCardUrl, setExistingIdCardUrl] = useState(null)
  useEffect(() => {
    if (!initial?.id_card_photo_path) { setExistingIdCardUrl(null); return }
    let cancelled = false
    supabase.storage.from('worker-id-cards').createSignedUrl(initial.id_card_photo_path, 300)
      .then(({ data }) => { if (!cancelled) setExistingIdCardUrl(data?.signedUrl) })
    return () => { cancelled = true }
  }, [initial?.id_card_photo_path])

  return (
    <form onSubmit={e => {
      e.preventDefault()
      const acctErr = form.bank_code && form.bank_account_no ? validateAccount(form.bank_code, form.bank_account_no) : null
      if (acctErr) { alert(acctErr); return }
      if (form.bank_branch_code && !/^\d{4}$/.test(form.bank_branch_code)) { alert('รหัสสาขาต้องมี 4 หลัก'); return }
      clearFormDraft(); onSave(form, idCardFile, amounts)
    }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        {workersFull && (
          <div className="alert alert-warning" style={{ fontSize: 12 }}>
            ⚠️ Package ปัจจุบันอนุญาตพนักงานสูงสุด {seat.workers.max} คน (ใช้ไปแล้ว {seat.workers.used})
            หากบันทึกอาจไม่สำเร็จ — ติดต่อผู้ดูแลระบบเพื่ออัปเกรด package
          </div>
        )}
        <div className="form-grid-2">
          <div>
            <label className="label">ชื่อ ★</label>
            <input className="input" required value={form.name} onChange={e => set('name', e.target.value)} />
          </div>
          <div>
            <label className="label">ชื่อเล่น</label>
            <input className="input" value={form.nickname} onChange={e => set('nickname', e.target.value)} />
          </div>
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label">ตำแหน่ง</label>
            <input className="input" value={form.position} onChange={e => set('position', e.target.value)} placeholder="ช่างกระจก, ช่างอลูมิเนียม..." />
          </div>
          <div>
            <label className="label">สถานะ</label>
            <select className="select" value={form.status} onChange={e => set('status', e.target.value)}>
              <option value="active">Active</option>
              <option value="inactive">Inactive (ออกแล้ว)</option>
            </select>
          </div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={form.show_in_assign} onChange={e => set('show_in_assign', e.target.checked)} style={{ width: 16, height: 16 }} />
          แสดงในตาราง Assign (ปิดสำหรับพนักงานที่ไม่ต้อง assign วันทำงาน เช่น ออฟฟิศ)
        </label>
        <div>
          <label className="label">เงินเดือน (บาท) ★</label>
          <input type="number" className="input" required min="0" step="0.01" value={form.monthly_salary}
            onChange={e => set('monthly_salary', e.target.value)} />
          <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text3)' }}>
            → ค่าแรงรายวัน: <strong style={{ color: 'var(--yellow)' }}>{dailyRate} บาท/วัน</strong>
          </div>
        </div>
        <div className="form-grid-3">
          <div>
            <label className="label">ประกันสังคม</label>
            <select className="select" value={form.has_social_security ? 'yes' : 'no'} onChange={e => set('has_social_security', e.target.value === 'yes')}>
              <option value="yes">มี</option>
              <option value="no">ไม่มี</option>
            </select>
          </div>
          <div>
            <label className="label">ลากิจต่อปี</label>
            <input type="number" className="input" min="0" value={form.annual_leave_days}
              onChange={e => set('annual_leave_days', parseInt(e.target.value) || 0)} />
          </div>
          <div>
            <label className="label">ลาป่วยต่อปี</label>
            <input type="number" className="input" min="0" value={form.annual_sick_leave_days}
              onChange={e => set('annual_sick_leave_days', parseInt(e.target.value) || 0)} />
          </div>
        </div>
        <div>
          <label className="label">เงินสมทบ/เดือน</label>
          <input type="number" className="input" min="0" step="0.01" value={form.monthly_contribution}
            onChange={e => set('monthly_contribution', e.target.value)} placeholder="บาท" />
        </div>
        <div>
          <label className="label">ผูกกับ User Account (Login)</label>
          <select className="select" value={form.email || ''} onChange={e => set('email', e.target.value)}>
            <option value="">— ไม่ผูก —</option>
            {form.email && !workerUsers.some(u => u.user_email === form.email) && (
              <option value={form.email}>{form.email}</option>
            )}
            {workerUsers.map(u => (
              <option key={u.user_email} value={u.user_email}>{u.user_email} ({u.role})</option>
            ))}
          </select>
          <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text3)' }}>
            เมื่อผูกแล้ว user นี้จะเห็นเฉพาะข้อมูลเงินเดือนของตัวเองในหน้า HR ·
            ถ้าล็อกอินด้วยบัญชีนี้ ชื่อจะแสดงใต้เส้นลายเซ็นในเอกสารที่พิมพ์ด้วย
          </div>
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label">เลขประจำตัวประชาชน</label>
            <input className="input" inputMode="numeric" maxLength={13} value={form.id_card_number}
              onChange={e => set('id_card_number', e.target.value.replace(/\D/g, '').slice(0, 13))} placeholder="13 หลัก" />
          </div>
          <div>
            <label className="label">รูปบัตรประชาชน</label>
            <input type="file" accept="image/*" className="input" onChange={e => setIdCardFile(e.target.files?.[0] || null)} />
          </div>
        </div>
        {(idCardPreviewUrl || existingIdCardUrl) && (
          <img src={idCardPreviewUrl || existingIdCardUrl} alt="บัตรประชาชน" style={{ maxWidth: 240, maxHeight: 160, borderRadius: 6, border: '1px solid var(--border)' }} />
        )}
        <div>
          <label className="label">ที่อยู่</label>
          <textarea className="textarea" rows={2} value={form.address} onChange={e => set('address', e.target.value)} />
        </div>
        <WorkerPayFields form={form} set={set} payItems={payItems || []} amounts={amounts} setAmount={(id, v) => setAmounts(a => ({ ...a, [id]: v }))} />
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? '⏳...' : '✅ บันทึก'}</button>
      </div>
    </form>
  )
}

// ── Holiday Form ───────────────────────────────────────────────
function HolidayForm({ onSave, onCancel, loading }) {
  const [date, setDate] = useState('')
  const [name, setName] = useState('')
  return (
    <form onSubmit={e => { e.preventDefault(); onSave({ date, name }) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div>
          <label className="label">วันที่ ★</label>
          <input type="date" className="input" required value={date} onChange={e => setDate(e.target.value)} />
        </div>
        <div>
          <label className="label">ชื่อวันหยุด ★</label>
          <input className="input" required value={name} onChange={e => setName(e.target.value)} placeholder="เช่น วันแรงงาน" />
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? '⏳...' : '✅ บันทึก'}</button>
      </div>
    </form>
  )
}

// ── HR Main Component ─────────────────────────────────────────
export default function HR({ navState }) {
  const now = new Date()
  const { role, user, isAtLeast } = useUserRole()
  const { tenant, hasModuleAccess } = useTenant()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'hr')
  const [innerTab, setInnerTab] = useState(navState?.pending === 'leave_pending' ? 'requests' : 'workers')
  // Bell/push "leave requests waiting": open the requests tab showing only pending ones.
  const leaveFocus = usePendingFocus(navState, 'leave_pending')
  useEffect(() => { if (navState?.pending === 'leave_pending') setInnerTab('requests') }, [navState])

  // Workers state
  const { data: workers, refetch: refetchWorkers } = useAllActiveWorkers()
  const { data: seat, refetch: refetchSeat } = useSeatStatus()
  const { data: leaveUsed } = useLeaveQuotaUsage(now.getFullYear())
  const { data: sickLeaveUsed } = useSickLeaveQuotaUsage(now.getFullYear())
  const [showWorkerForm, setShowWorkerForm] = useState(false)
  const [editWorker, setEditWorker] = useState(null)
  const [deleteWorkerId, setDeleteWorkerId] = useState(null)
  const [savingWorker, setSavingWorker] = useState(false)
  const [workerSearch, setWorkerSearch] = useState('')
  const [workerSortCol, setWorkerSortCol] = useState('name')
  const [workerSortDir, setWorkerSortDir] = useState('asc')
  const [holidaySortCol, setHolidaySortCol] = useState('date')
  const [holidaySortDir, setHolidaySortDir] = useState('asc')

  // User accounts (for pairing worker ↔ login)
  const [workerUsers, setWorkerUsers] = useState([])
  useEffect(() => {
    if (!canEdit) return
    supabase.from('user_roles').select('user_email, role').order('user_email')
      .then(({ data }) => setWorkerUsers(data || []))
  }, [canEdit])

  // Leave requests (ขอลา from LINE crew bot, via FieldFormPage) --
  // pending queue an ADMIN/OWNER must approve/reject. Approving is what
  // actually creates the real worker_assignments day(s) -- a worker's
  // LINE message alone was never enough authority for that. (เบิกของ used
  // to land in a sibling table here too, but now creates a real
  // purchase_orders 'draft' row directly -- see PurchaseOrders.jsx.)
  const [leaveRequests, setLeaveRequests] = useState([])
  const [loadingRequests, setLoadingRequests] = useState(true)
  const [reviewingId, setReviewingId] = useState(null)

  const fetchRequests = async () => {
    if (!canEdit || !hasModuleAccess('line_bot')) return
    setLoadingRequests(true)
    const { data } = await supabase.from('leave_requests').select('*, workers(name, nickname)').order('requested_at', { ascending: false })
    setLeaveRequests(data || [])
    setLoadingRequests(false)
  }
  // Depends on hasModuleAccess('line_bot') too, not just canEdit -- useTenant()
  // (module list) and useUserRole() (canEdit) are two independent async
  // fetches with no guaranteed order. If canEdit resolves true before the
  // module list finishes loading, fetchRequests's own guard bounces once
  // and, without this second dependency, never re-fires once module access
  // later resolves true -- leaving loadingRequests stuck true forever (the
  // tab shows "กำลังโหลด..." with no error, indefinitely).
  useEffect(() => { fetchRequests() }, [canEdit, hasModuleAccess('line_bot')])

  const pendingRequestCount = leaveRequests.filter(r => r.status === 'pending').length
  const visibleLeaveRequests = leaveRequests.filter(r => !leaveFocus.active || isLeavePending(r))

  // Check-in/check-out log -- worker_checkins, written by the GPS-based
  // /f/<token> flow (line-webhook + field-form, see FieldFormPage.jsx's
  // CheckInFlow) and by the web app's own TodayCheckinCard. Read-only
  // report, defaults to the last 30 days since the table only grows.
  const todayISO = new Date().toISOString().slice(0, 10)
  const [checkins, setCheckins] = useState([])
  const [loadingCheckins, setLoadingCheckins] = useState(true)
  const [checkinFrom, setCheckinFrom] = useState(new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10))
  const [checkinTo, setCheckinTo] = useState(todayISO)

  const [checkinWorkerFilter, setCheckinWorkerFilter] = useState(null)

  const fetchCheckins = async () => {
    if (!canEdit) return
    setLoadingCheckins(true)
    let q = supabase.from('worker_checkins')
      .select('*, workers(name, nickname), sites(name), checkin_locations(name)')
      .gte('date', checkinFrom).lte('date', checkinTo)
      .order('date', { ascending: false }).order('checkin_at', { ascending: false })
    if (checkinWorkerFilter) q = q.eq('worker_id', checkinWorkerFilter)
    const { data } = await q
    setCheckins(data || [])
    setLoadingCheckins(false)
  }
  useEffect(() => { fetchCheckins() }, [canEdit, checkinFrom, checkinTo, checkinWorkerFilter])

  const reviewLeaveRequest = async (req, status) => {
    setReviewingId(req.id)
    try {
      if (status === 'approved') {
        // One worker_assignments row per day in [date_from, date_to] --
        // same shape CellEditPopup.jsx builds for a manual leave save.
        const days = []
        for (let d = new Date(req.date_from); d <= new Date(req.date_to); d.setDate(d.getDate() + 1)) {
          days.push(new Date(d).toISOString().slice(0, 10))
        }
        // upsert, not insert -- a worker can already have a real assignment
        // (site/factory/office, or even a different leave type) on a day
        // their leave request gets approved for (e.g. assigned to a site
        // days before requesting leave for that same day). Approved leave
        // must take priority and overwrite whatever was there, matching
        // the same onConflict Assign.jsx's own cell/wizard saves already
        // use for this exact table -- a plain insert() throws
        // worker_assignments_worker_id_date_shift_key the moment any prior
        // row already occupies that slot, permanently blocking approval.
        // full_day blocks BOTH shift rows -- previously this hardcoded
        // 'morning' only, so a full-day approved leave never blocked the
        // afternoon slot and the worker could still get double-booked for
        // an afternoon site assignment.
        const shiftsToBlock = req.shift === 'full_day' ? ['morning', 'evening'] : [req.shift]
        const rows = days.flatMap(date => shiftsToBlock.map(shift => (
          { worker_id: req.worker_id, date, shift, type: req.leave_type, site_id: null, notes: req.reason || null }
        )))
        const { error: insertErr } = await supabase.from('worker_assignments').upsert(rows, { onConflict: 'worker_id,date,shift' })
        if (insertErr) throw insertErr
      }
      const { error } = await supabase.from('leave_requests').update({ status, reviewed_by: user?.email, reviewed_at: new Date().toISOString() }).eq('id', req.id)
      if (error) throw error
      // Best-effort worker confirmation -- never blocks the approval/rejection
      // itself on a push failure.
      supabase.functions.invoke('leave-notify', { body: { leaveRequestId: req.id, decision: status } }).catch(() => {})
      await fetchRequests()
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setReviewingId(null)
    }
  }

  // Audit state
  const [auditTable, setAuditTable] = useState('')
  const { data: logs } = useAuditLogs(auditTable || null, 100)
  const [auditSortCol, setAuditSortCol] = useState('changed_at')
  const [auditSortDir, setAuditSortDir] = useState('desc')

  // Holiday calendar state
  const { data: holidays, refetch: refetchHolidays } = useCompanyHolidays()
  const [showHolidayForm, setShowHolidayForm] = useState(false)
  const [savingHoliday, setSavingHoliday] = useState(false)
  const [deleteHolidayId, setDeleteHolidayId] = useState(null)
  const { data: multiplierVal, refetch: refetchMultiplier } = useAppSetting('holiday_pay_multiplier', '1.5')
  const [multiplierInput, setMultiplierInput] = useState('')
  const [savingMultiplier, setSavingMultiplier] = useState(false)
  useEffect(() => { if (multiplierVal != null) setMultiplierInput(String(multiplierVal)) }, [multiplierVal])
  // Whether a site shift counts as wages/travel only after a real check-in (or admin override).
  // Off by default; the database views labor_cost_by_site / site_travel_cost read the same setting.
  const { data: requireConfirmVal, refetch: refetchRequireConfirm } = useAppSetting('require_checkin_confirmation', 'false')
  const [savingRequireConfirm, setSavingRequireConfirm] = useState(false)
  const handleToggleRequireConfirm = async () => {
    setSavingRequireConfirm(true)
    try {
      await saveAppSetting('require_checkin_confirmation', requireConfirmVal === 'true' ? 'false' : 'true')
      refetchRequireConfirm()
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSavingRequireConfirm(false) }
  }

  // ── Worker handlers ──
  // idCardFile is a raw File, kept OUTSIDE the draft-persisted form state
  // (WorkerForm's own local state, not routed through useDraftForm) --
  // JSON.stringify(File) serializes to '{}' with no way back to a real
  // File, so stuffing it into the auto-saved-to-localStorage draft would
  // silently corrupt it on restore. A worker record needs an id before a
  // photo can be uploaded under it (path is {tenant}/{worker_id}/...), so
  // for a brand-new worker this uploads AFTER the insert, in a follow-up
  // update -- editing an existing worker already has that id up front.
  const handleSaveWorker = async (form, idCardFile, amounts = {}) => {
    setSavingWorker(true)
    try {
      const payload = {
        name: form.name, nickname: form.nickname || null,
        position: form.position || null,
        monthly_salary: parseFloat(form.monthly_salary) || 0,
        status: form.status,
        has_social_security: form.has_social_security,
        annual_leave_days: parseInt(form.annual_leave_days) || 0,
        annual_sick_leave_days: parseInt(form.annual_sick_leave_days) || 0,
        monthly_contribution: parseFloat(form.monthly_contribution) || null,
        email: form.email || null,
        show_in_assign: form.show_in_assign,
        id_card_number: form.id_card_number || null,
        address: form.address || null,
        employee_code: form.employee_code || null,
        pay_type: form.pay_type || 'monthly',
        daily_wage: form.pay_type === 'daily' ? (parseFloat(form.daily_wage) || 0) : null,
        bank_code: form.bank_code || null,
        bank_account_no: form.bank_account_no || null,
        bank_account_name: form.bank_account_name || null,
        bank_branch_code: form.bank_branch_code || null,
      }

      const uploadIdCardPhoto = async (workerId) => {
        const ext = idCardFile.name.split('.').pop()
        const path = `${tenant.id}/${workerId}/id-card.${ext}`
        const { error: upErr } = await supabase.storage.from('worker-id-cards').upload(path, idCardFile, { upsert: true })
        if (upErr) throw upErr
        return path
      }

      let savedId
      if (editWorker) {
        savedId = editWorker.id
        const { data: old } = await supabase.from('workers').select('*').eq('id', editWorker.id).single()
        if (idCardFile) payload.id_card_photo_path = await uploadIdCardPhoto(editWorker.id)
        const { error } = await supabase.from('workers').update(payload).eq('id', editWorker.id)
        if (error) throw error
        await auditLog('workers', editWorker.id, 'UPDATE', old, payload)
      } else {
        const { data, error } = await supabase.from('workers').insert(payload).select().single()
        if (error) throw error
        savedId = data.id
        setEditWorker(data) // a retry after a partial failure must update, not insert again
        if (idCardFile) {
          const path = await uploadIdCardPhoto(data.id)
          const { error: photoErr } = await supabase.from('workers').update({ id_card_photo_path: path }).eq('id', data.id)
          if (photoErr) throw photoErr
        }
        await auditLog('workers', data.id, 'INSERT', null, payload)
      }
      const amountRows = Object.entries(amounts).map(([pay_item_id, v]) => ({ worker_id: savedId, pay_item_id, amount: parseFloat(v) || 0 }))
      if (amountRows.length) {
        const { error: amtErr } = await supabase.from('worker_pay_item_amounts').upsert(amountRows, { onConflict: 'worker_id,pay_item_id' })
        if (amtErr) throw amtErr
      }
      setShowWorkerForm(false); setEditWorker(null); refetchWorkers(); refetchSeat()
    } catch (e) {
      if (e.message?.includes('workers_employee_code')) { alert('รหัสพนักงานนี้มีคนใช้แล้ว'); return }
      alert(e.message?.includes('row-level security policy')
        ? 'บันทึกไม่สำเร็จ: อาจเกินจำนวนพนักงานที่ package ปัจจุบันอนุญาต กรุณาติดต่อผู้ดูแลระบบเพื่ออัปเกรด package'
        : 'Error: ' + e.message)
    }
    finally { setSavingWorker(false) }
  }

  const handleDeleteWorker = async () => {
    if (!deleteWorkerId) return
    const { data: old } = await supabase.from('workers').select('*').eq('id', deleteWorkerId).single()
    const { error } = await supabase.from('workers').delete().eq('id', deleteWorkerId)
    if (!error) {
      await auditLog('workers', deleteWorkerId, 'DELETE', old, null)
      setDeleteWorkerId(null); refetchWorkers()
    } else alert('Error: ' + error.message)
  }

  // ── Holiday handlers ──
  const handleSaveHoliday = async (form) => {
    setSavingHoliday(true)
    try {
      await saveCompanyHoliday(form)
      setShowHolidayForm(false); refetchHolidays()
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSavingHoliday(false) }
  }

  const handleDeleteHoliday = async () => {
    if (!deleteHolidayId) return
    try {
      await deleteCompanyHoliday(deleteHolidayId)
      setDeleteHolidayId(null); refetchHolidays()
    } catch (e) { alert('Error: ' + e.message) }
  }

  const handleSaveMultiplier = async () => {
    setSavingMultiplier(true)
    try {
      await saveAppSetting('holiday_pay_multiplier', parseFloat(multiplierInput) || 1.5)
      refetchMultiplier()
      alert('✅ บันทึกตัวคูณโบนัสวันหยุดแล้ว')
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSavingMultiplier(false) }
  }

  // WORKER: filter roster to only show their own worker record
  const visibleWorkers = useMemo(() => {
    if (canEdit) return workers || []
    const email = user?.email
    if (!email) return []
    return (workers || []).filter(w => w.email === email)
  }, [workers, canEdit, user])

  // ── Sorting (per-table, client-side only) ──
  const toggleWorkerSort = (col) => {
    if (workerSortCol === col) setWorkerSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setWorkerSortCol(col); setWorkerSortDir('asc') }
  }
  const wsi = (col) => workerSortCol === col ? (workerSortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕'
  const sortedWorkers = useMemo(() => {
    const rows = visibleWorkers.filter(w => !workerSearch || w.name?.toLowerCase().includes(workerSearch.toLowerCase()))
    return [...rows].sort((a, b) => {
      const va = a[workerSortCol] ?? '', vb = b[workerSortCol] ?? ''
      if (typeof va === 'number') return workerSortDir === 'asc' ? va - vb : vb - va
      return workerSortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va))
    })
  }, [visibleWorkers, workerSearch, workerSortCol, workerSortDir])

  const toggleHolidaySort = (col) => {
    if (holidaySortCol === col) setHolidaySortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setHolidaySortCol(col); setHolidaySortDir('asc') }
  }
  const hsi = (col) => holidaySortCol === col ? (holidaySortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕'
  const sortedHolidays = useMemo(() => {
    const rows = holidays || []
    return [...rows].sort((a, b) => {
      const va = a[holidaySortCol] ?? '', vb = b[holidaySortCol] ?? ''
      if (typeof va === 'number') return holidaySortDir === 'asc' ? va - vb : vb - va
      return holidaySortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va))
    })
  }, [holidays, holidaySortCol, holidaySortDir])

  const toggleAuditSort = (col) => {
    if (auditSortCol === col) setAuditSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setAuditSortCol(col); setAuditSortDir('asc') }
  }
  const asi = (col) => auditSortCol === col ? (auditSortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕'
  const sortedLogs = useMemo(() => {
    const rows = logs || []
    return [...rows].sort((a, b) => {
      const va = a[auditSortCol] ?? '', vb = b[auditSortCol] ?? ''
      if (typeof va === 'number') return auditSortDir === 'asc' ? va - vb : vb - va
      return auditSortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va))
    })
  }, [logs, auditSortCol, auditSortDir])


  const INNER_TABS = [
    { id: 'workers',  label: '👷 ข้อมูลช่าง' },
    { id: 'payroll',  label: '💼 เงินเดือน' },
    { id: 'advances', label: '💸 เบิกล่วงหน้า' },
    // Approval queue (เบิกของ/ขอลา จาก LINE) — only for tenants with the LINE bot module enabled, so other tenants don't see a tab for a feature they haven't set up
    ...(canEdit && hasModuleAccess('line_bot') ? [{ id: 'requests', label: `🏖️ คำขอลา${pendingRequestCount ? ` (${pendingRequestCount})` : ''}` }] : []),
    ...(canEdit ? [{ id: 'checkins', label: '🕐 เช็คอิน-เช็คเอาท์' }] : []),
    ...(canEdit ? [{ id: 'audit', label: '📋 ประวัติการแก้ไข' }] : []),
  ]

  return (
    <div>
      {/* Inner tab bar */}
      <div className="inner-tabs" style={{ marginBottom: 20 }}>
        {INNER_TABS.map(t => (
          <button key={t.id} className={`inner-tab ${innerTab === t.id ? 'active' : ''}`}
            onClick={() => setInnerTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {/* ── Workers Tab ── */}
      {innerTab === 'workers' && (
        <div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
            {canEdit && (
              <button className="btn btn-primary" onClick={() => { setEditWorker(null); setShowWorkerForm(true) }}>+ เพิ่มพนักงาน</button>
            )}
            <input className="input input-sm" style={{ width: 200 }} placeholder="ค้นหาชื่อช่าง..." value={workerSearch} onChange={e => setWorkerSearch(e.target.value)} />
          </div>
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="sortable" onClick={() => toggleWorkerSort('name')}>ชื่อ{wsi('name')}</th>
                    <th className="sortable" onClick={() => toggleWorkerSort('nickname')}>ชื่อเล่น{wsi('nickname')}</th>
                    <th className="sortable" onClick={() => toggleWorkerSort('position')}>ตำแหน่ง{wsi('position')}</th>
                    <th className="sortable" onClick={() => toggleWorkerSort('monthly_salary')}>เงินเดือน{wsi('monthly_salary')}</th>
                    <th className="sortable" onClick={() => toggleWorkerSort('daily_rate')}>ค่าแรง/วัน{wsi('daily_rate')}</th>
                    <th>SSO</th>
                    <th className="sortable" onClick={() => toggleWorkerSort('annual_leave_days')}>ลากิจ/ปี{wsi('annual_leave_days')}</th>
                    <th>ใช้แล้ว</th><th>คงเหลือ</th>
                    <th className="sortable" onClick={() => toggleWorkerSort('annual_sick_leave_days')}>ลาป่วย/ปี{wsi('annual_sick_leave_days')}</th>
                    <th>ใช้แล้ว</th><th>คงเหลือ</th>
                    <th className="sortable" onClick={() => toggleWorkerSort('status')}>สถานะ{wsi('status')}</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedWorkers.map(w => {
                    const used = leaveUsed?.[w.id] || 0
                    const remaining = (w.annual_leave_days || 0) - used
                    const sickUsed = sickLeaveUsed?.[w.id] || 0
                    const sickRemaining = (w.annual_sick_leave_days || 0) - sickUsed
                    return (
                    <tr key={w.id}>
                      <td style={{ fontWeight: 600 }}>{w.name}</td>
                      <td style={{ color: 'var(--text2)' }}>{w.nickname||'—'}</td>
                      <td style={{ fontSize: 12, color: 'var(--text3)' }}>{w.position||'—'}</td>
                      <td className="font-mono">{fmt(w.monthly_salary)}</td>
                      <td className="font-mono" style={{ color: 'var(--yellow)' }}>{fmt(w.daily_rate)}</td>
                      <td>{w.has_social_security ? <span className="badge badge-paid">✓ มี</span> : <span style={{ color: 'var(--text3)', fontSize: 11 }}>—</span>}</td>
                      <td style={{ textAlign: 'center' }}>{w.annual_leave_days}</td>
                      <td style={{ textAlign: 'center', color: used > 0 ? 'var(--red)' : 'var(--text3)' }}>{used || '—'}</td>
                      <td style={{ textAlign: 'center', fontWeight: 600, color: remaining < 0 ? 'var(--red)' : 'var(--text2)' }}>{remaining}</td>
                      <td style={{ textAlign: 'center' }}>{w.annual_sick_leave_days}</td>
                      <td style={{ textAlign: 'center', color: sickUsed > 0 ? 'var(--red)' : 'var(--text3)' }}>{sickUsed || '—'}</td>
                      <td style={{ textAlign: 'center', fontWeight: 600, color: sickRemaining < 0 ? 'var(--red)' : 'var(--text2)' }}>{sickRemaining}</td>
                      <td><span className={`badge ${w.status==='active'?'badge-paid':'badge-pending'}`}>{w.status}</span></td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {canEdit && (
                          <div className="actions-cell">
                            <button className="btn btn-sm btn-edit" onClick={() => { setEditWorker(w); setShowWorkerForm(true) }}><PencilIcon /></button>
                            <button className="btn btn-sm btn-danger" onClick={() => setDeleteWorkerId(w.id)}><TrashIcon /></button>
                          </div>
                        )}
                      </td>
                    </tr>
                    )
                  })}
                  {!sortedWorkers.length && (
                    <tr><td colSpan={11} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีช่าง</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>


          {canEdit && (
            <div className="card" style={{ marginTop: 24, padding: '14px 18px' }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>⚙️ ตั้งค่าการนับค่าแรง</div>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" style={{ marginTop: 3 }} checked={requireConfirmVal === 'true'} disabled={requireConfirmVal == null || savingRequireConfirm} onChange={handleToggleRequireConfirm} />
                <span>
                  <span style={{ fontWeight: 600 }}>นับค่าแรง/ค่าเดินทางเฉพาะกะที่ยืนยันแล้ว</span>
                  <span style={{ display: 'block', color: 'var(--text3)', fontSize: 12, marginTop: 2, lineHeight: 1.6 }}>
                    {requireConfirmVal === 'true'
                      ? 'เปิดอยู่: กะที่จัดลงไซต์จะนับเป็นค่าแรงและค่าเดินทางต่อเมื่อช่างเช็คอินจริงผ่าน LINE หรือแอดมินกด "ยืนยันเอง" (โบนัสวันหยุดก็นับเฉพาะกะที่ยืนยัน)'
                      : 'ปิดอยู่: ทุกกะที่จัดลงไซต์นับเป็นค่าแรงและค่าเดินทางทันที ไม่ต้องรอเช็คอิน เปิดเมื่อพร้อมใช้ระบบเช็คอินจริง'}
                  </span>
                </span>
              </label>
            </div>
          )}

          <div style={{ marginTop: 24 }}>
            <div style={{ display: 'flex', gap: 10, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 1 }}>
                🎌 วันหยุดประจำปี
              </div>
              {canEdit && <button className="btn btn-sm btn-primary" onClick={() => setShowHolidayForm(true)}>+ เพิ่มวันหยุด</button>}
            </div>
            {canEdit && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
                <label className="label" style={{ marginBottom: 0 }}>ตัวคูณโบนัสวันหยุด (ค่าเริ่มต้น 1.5)</label>
                <input type="number" className="input input-sm" style={{ width: 90 }} min="1" step="0.1"
                  value={multiplierInput} onChange={e => setMultiplierInput(e.target.value)} />
                <button className="btn btn-sm btn-ghost" onClick={handleSaveMultiplier} disabled={savingMultiplier}>
                  {savingMultiplier ? '⏳...' : '💾 บันทึก'}
                </button>
              </div>
            )}
            <div className="card">
              <div className="table-wrap">
                <table>
                  <thead><tr>
                    <th className="sortable" onClick={() => toggleHolidaySort('date')}>วันที่{hsi('date')}</th>
                    <th className="sortable" onClick={() => toggleHolidaySort('name')}>ชื่อวันหยุด{hsi('name')}</th>
                    <th></th>
                  </tr></thead>
                  <tbody>
                    {sortedHolidays.map(h => (
                      <tr key={h.id}>
                        <td style={{ fontSize: 12 }}>{new Date(h.date).toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' })}</td>
                        <td style={{ fontWeight: 600 }}>{h.name}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {canEdit && <button className="btn btn-sm btn-danger" onClick={() => setDeleteHolidayId(h.id)}><TrashIcon /></button>}
                        </td>
                      </tr>
                    ))}
                    {!sortedHolidays.length && (
                      <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีวันหยุดที่กำหนด</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {innerTab === 'payroll' && <PayrollMonth canEdit={canEdit} />}
      {innerTab === 'advances' && <AdvancesPanel canEdit={canEdit} />}

      {/* ── Requests Tab (ขอลา from LINE crew bot) ── */}
      {innerTab === 'requests' && (
        <div>
          {loadingRequests ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>กำลังโหลด...</div>
          ) : (
            <>
              <div className="card">
                <div style={{ padding: 16, borderBottom: '1px solid var(--border)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span>🏖️ คำขอลา</span>
                  <PendingFocusChip focus={leaveFocus} pendingKey="leave_pending" />
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>ช่าง</th>
                        <th>ประเภท</th>
                        <th>วันที่</th>
                        <th>ช่วงเวลา</th>
                        <th>เหตุผล</th>
                        <th>สถานะ</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleLeaveRequests.map(r => (
                        <tr key={r.id}>
                          <td style={{ fontWeight: 600 }}>{isLeavePending(r) && <PendingMark />}{r.workers?.nickname || r.workers?.name}</td>
                          <td>{r.leave_type === 'leave_sick' ? '🤒 ลาป่วย' : '🏖️ ลากิจ'}</td>
                          <td>{r.date_from === r.date_to ? r.date_from : `${r.date_from} — ${r.date_to}`}</td>
                          <td>{r.shift === 'morning' ? 'ช่วงเช้า' : r.shift === 'evening' ? 'ช่วงบ่าย' : 'เต็มวัน'}</td>
                          <td style={{ color: 'var(--text3)' }}>{r.reason || '-'}</td>
                          <td>
                            {r.status === 'pending' && <span className="badge" style={{ background: 'rgba(255,193,7,0.2)', color: '#c98a00' }}>⏳ รออนุมัติ</span>}
                            {r.status === 'approved' && <span className="badge" style={{ background: 'rgba(40,167,69,0.2)', color: 'var(--green)' }}>✅ อนุมัติแล้ว</span>}
                            {r.status === 'rejected' && <span className="badge" style={{ background: 'rgba(220,53,69,0.2)', color: 'var(--red)' }}>❌ ปฏิเสธ</span>}
                          </td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            {r.status === 'pending' && (
                              <>
                                <button className="btn btn-sm btn-primary" disabled={reviewingId === r.id} onClick={() => reviewLeaveRequest(r, 'approved')}>อนุมัติ</button>
                                <button className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} disabled={reviewingId === r.id} onClick={() => reviewLeaveRequest(r, 'rejected')}>ปฏิเสธ</button>
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                      {!visibleLeaveRequests.length && (
                        <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ไม่มีคำขอลา</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Check-in/Check-out Tab ── */}
      {innerTab === 'checkins' && (
        <div>
          <AttendanceGrid
            workers={workers}
            onCellClick={(workerId, date) => { setCheckinFrom(date); setCheckinTo(date); setCheckinWorkerFilter(workerId) }}
          />
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <label className="label" style={{ marginBottom: 0 }}>จาก</label>
            <input type="date" className="input input-sm" style={{ width: 150 }} value={checkinFrom} max={checkinTo} onChange={e => setCheckinFrom(e.target.value)} />
            <label className="label" style={{ marginBottom: 0 }}>ถึง</label>
            <input type="date" className="input input-sm" style={{ width: 150 }} value={checkinTo} min={checkinFrom} onChange={e => setCheckinTo(e.target.value)} />
            <span style={{ color: 'var(--text3)', fontSize: 12 }}>{checkins.length} รายการ</span>
            {checkinWorkerFilter && (
              <button className="btn btn-sm btn-ghost" onClick={() => setCheckinWorkerFilter(null)}>✕ ล้างตัวกรองช่าง</button>
            )}
          </div>
          {loadingCheckins ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>กำลังโหลด...</div>
          ) : (
            <div className="card">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>ช่าง</th>
                      <th>ไซต์/ตำแหน่ง</th>
                      <th>วันที่</th>
                      <th>เช็คอิน</th>
                      <th>ระยะห่าง</th>
                      <th>เช็คเอาท์</th>
                      <th>ระยะห่าง</th>
                    </tr>
                  </thead>
                  <tbody>
                    {checkins.map(c => (
                      <tr key={c.id}>
                        <td style={{ fontWeight: 600 }}>{c.workers?.nickname || c.workers?.name || '—'}</td>
                        <td>{c.sites?.name || c.checkin_locations?.name || '—'}</td>
                        <td style={{ fontSize: 12 }}>{new Date(`${c.date}T00:00:00Z`).toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })}</td>
                        <td style={{ fontSize: 12 }}>{c.checkin_at ? new Date(c.checkin_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                        <td className="font-mono" style={{ fontSize: 12, color: 'var(--text3)' }}>{c.checkin_distance_m != null ? `${Math.round(c.checkin_distance_m)} ม.` : '—'}</td>
                        <td style={{ fontSize: 12 }}>{c.checkout_at ? new Date(c.checkout_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : <span style={{ color: 'var(--yellow)' }}>ยังไม่เช็คเอาท์</span>}</td>
                        <td className="font-mono" style={{ fontSize: 12, color: 'var(--text3)' }}>{c.checkout_distance_m != null ? `${Math.round(c.checkout_distance_m)} ม.` : '—'}</td>
                      </tr>
                    ))}
                    {!checkins.length && (
                      <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ไม่มีข้อมูลเช็คอินในช่วงนี้</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Audit Tab ── */}
      {innerTab === 'audit' && (
        <div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
            <select className="select select-sm" style={{ width: 200 }} value={auditTable} onChange={e => setAuditTable(e.target.value)}>
              <option value="">ทุกตาราง</option>
              {['sites','expenses','incomes','workers','salary_records','labor_contracts','labor_payments'].map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <span style={{ color: 'var(--text3)', fontSize: 12 }}>{(logs||[]).length} รายการล่าสุด</span>
          </div>
          <div className="card">
            <div className="table-wrap table-wrap-fill">
              <table>
                <thead>
                  <tr>
                    <th className="sortable" onClick={() => toggleAuditSort('changed_at')}>เวลา{asi('changed_at')}</th>
                    <th className="sortable" onClick={() => toggleAuditSort('user_email')}>ผู้ใช้{asi('user_email')}</th>
                    <th className="sortable" onClick={() => toggleAuditSort('table_name')}>ตาราง{asi('table_name')}</th>
                    <th className="sortable" onClick={() => toggleAuditSort('action')}>Action{asi('action')}</th>
                    <th>รายละเอียด</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedLogs.map(l => (
                    <tr key={l.id}>
                      <td style={{ fontSize: 11, whiteSpace: 'nowrap', color: 'var(--text3)' }}>
                        {new Date(l.changed_at).toLocaleString('th-TH')}
                      </td>
                      <td style={{ fontSize: 12 }}>{l.user_email||'—'}</td>
                      <td><span className="badge">{l.table_name}</span></td>
                      <td>
                        <span style={{
                          color: l.action==='INSERT'?'var(--green)':l.action==='DELETE'?'var(--red)':'var(--yellow)',
                          fontWeight: 700, fontSize: 12
                        }}>{l.action}</span>
                      </td>
                      <td style={{ fontSize: 11, color: 'var(--text3)', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {l.new_values ? JSON.stringify(l.new_values).slice(0,120) : l.old_values ? JSON.stringify(l.old_values).slice(0,120) : '—'}
                      </td>
                    </tr>
                  ))}
                  {!sortedLogs.length && (
                    <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีประวัติการแก้ไข</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── Modals ── */}
      {showWorkerForm && (
        <Modal title={editWorker?`แก้ไข: ${editWorker.name}`:'เพิ่มพนักงาน'}
          onClose={() => { setShowWorkerForm(false); setEditWorker(null) }} maxWidth={560}>
          <WorkerForm initial={editWorker||EMPTY_WORKER} onSave={handleSaveWorker}
            onCancel={() => { setShowWorkerForm(false); setEditWorker(null) }} loading={savingWorker}
            workerUsers={workerUsers} seat={seat} />
        </Modal>
      )}

      {deleteWorkerId && (
        <ConfirmDialog title="ลบช่าง" message="ยืนยันการลบช่างคนนี้? ข้อมูล assignment ทั้งหมดจะถูกลบด้วย"
          onConfirm={handleDeleteWorker} onCancel={() => setDeleteWorkerId(null)} danger />
      )}

      {showHolidayForm && (
        <Modal title="เพิ่มวันหยุดประจำปี" onClose={() => setShowHolidayForm(false)} maxWidth={420}>
          <HolidayForm onSave={handleSaveHoliday} onCancel={() => setShowHolidayForm(false)} loading={savingHoliday} />
        </Modal>
      )}

      {deleteHolidayId && (
        <ConfirmDialog title="ลบวันหยุด" message="ยืนยันการลบวันหยุดนี้?"
          onConfirm={handleDeleteHoliday} onCancel={() => setDeleteHolidayId(null)} danger />
      )}
    </div>
  )
}
