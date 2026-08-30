// ============================================================
// HR — บริหารทีมช่าง + เงินเดือน + ประวัติการแก้ไข
// ✅ Worker CRUD (ย้ายมาจาก Assign)
// ✅ Payroll (ย้ายมาจาก Payroll.jsx)
// ✅ Audit log viewer
// ============================================================
import { useState, useMemo, useEffect } from 'react'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import { useDraftForm } from '../hooks/useDraftForm.js'
import { supabase } from '../lib/supabase.js'
import { useAllActiveWorkers, useSalary, usePreviousMonthSalaries, useAuditLogs, fetchWorkerOTForRange, useCompanyHolidays, saveCompanyHoliday, deleteCompanyHoliday, useAppSetting, saveAppSetting, fetchCompanyHolidaysForRange, useLeaveQuotaUsage, useSickLeaveQuotaUsage, useSeatStatus } from '../hooks/useSupabase.js'
import { fmt } from '../lib/supabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import SearchableSelect from '../components/SearchableSelect.jsx'
import { auditLog } from '../lib/audit.js'
import { mergeWorkerOT } from '../lib/otMerge.js'
import { SITE_TYPES } from './assign/constants.js'
import { downloadPDF } from '../lib/pdf.js'
import { TrashIcon, PencilIcon } from '../components/icons.jsx'

const MONTHS = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.']

// ── Worker Form (เหมือนใน Assign.jsx เดิม) ────────────────────
const EMPTY_WORKER = {
  name: '', nickname: '', position: '',
  monthly_salary: '', status: 'active',
  has_social_security: true, annual_leave_days: 6, annual_sick_leave_days: 30, monthly_contribution: '', email: '',
  show_in_assign: true,
}

function WorkerForm({ initial = EMPTY_WORKER, onSave, onCancel, loading, workerUsers = [], seat }) {
  const isAdd = !initial?.id
  const [form, setForm, clearFormDraft] = useDraftForm('worker-form', { ...EMPTY_WORKER, ...initial }, isAdd)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const dailyRate = form.monthly_salary ? (parseFloat(form.monthly_salary) / 26).toFixed(2) : '—'
  const workersFull = isAdd && seat?.workers?.max != null && seat.workers.used >= seat.workers.max

  return (
    <form onSubmit={e => { e.preventDefault(); clearFormDraft(); onSave(form) }}>
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
            เมื่อผูกแล้ว user นี้จะเห็นเฉพาะข้อมูลเงินเดือนของตัวเองในหน้า HR
          </div>
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? '⏳...' : '✅ บันทึก'}</button>
      </div>
    </form>
  )
}

// ── Salary Form (เหมือนใน Payroll.jsx) ───────────────────────
const EMPTY_SALARY = {
  worker_id: '', base_salary: '', contribution: '', phone_allowance: '',
  ot_amount: '', special_allowance: '',
  social_security_ded: '', advance_deduction: '', loan_deduction: '', leave_deduction: '',
  net_pay: '', paid_date: '', notes: ''
}

function calcNet(form) {
  return (parseFloat(form.base_salary)||0)
       + (parseFloat(form.phone_allowance)||0)
       + (parseFloat(form.ot_amount)||0)
       + (parseFloat(form.special_allowance)||0)
       - (parseFloat(form.social_security_ded)||0)
       - (parseFloat(form.advance_deduction)||0)
       - (parseFloat(form.loan_deduction)||0)
       - (parseFloat(form.leave_deduction)||0)
}

function SalaryForm({ initial = EMPTY_SALARY, workers, onSave, onCancel, loading }) {
  const isAdd = !initial?.id
  const [form, setForm, clearFormDraft] = useDraftForm('salary-form', { ...EMPTY_SALARY, ...initial }, isAdd)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const prefill = (w) => {
    set('worker_id', w.id)
    if (!initial.base_salary) {
      set('base_salary', w.monthly_salary || '')
      set('contribution', w.monthly_contribution || '')
      if (w.has_social_security) set('social_security_ded', Math.min(750, (w.monthly_salary||0) * 0.05).toFixed(2))
    }
  }

  return (
    <form onSubmit={e => { e.preventDefault(); clearFormDraft(); onSave({ ...form, net_pay: form.net_pay || calcNet(form) }) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div>
          <label className="label">ช่าง / พนักงาน ★</label>
          <SearchableSelect
            required
            value={form.worker_id}
            onChange={id => {
              const w = (workers||[]).find(x => x.id === id)
              if (w) prefill(w); else set('worker_id', id)
            }}
            placeholder="— เลือก —"
            options={(workers||[]).map(w => ({ value: w.id, label: `${w.name}${w.nickname ? ` (${w.nickname})` : ''}`, keywords: `${w.name} ${w.nickname || ''}` }))}
          />
        </div>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 1 }}>รายรับ</div>
        <div className="form-grid-3">
          <div><label className="label">เงินเดือน</label>
            <input type="number" className="input" min="0" step="0.01" value={form.base_salary} onChange={e => set('base_salary', e.target.value)} /></div>
          <div><label className="label">สมทบนายจ้าง</label>
            <input type="number" className="input" min="0" step="0.01" value={form.contribution} onChange={e => set('contribution', e.target.value)} /></div>
          <div><label className="label">ค่าโทรศัพท์</label>
            <input type="number" className="input" min="0" step="0.01" value={form.phone_allowance} onChange={e => set('phone_allowance', e.target.value)} /></div>
        </div>
        <div className="form-grid-2">
          <div><label className="label">OT</label>
            <input type="number" className="input" min="0" step="0.01" value={form.ot_amount} onChange={e => set('ot_amount', e.target.value)} /></div>
          <div><label className="label">เงินพิเศษ / ค่าจอดรถ</label>
            <input type="number" className="input" min="0" step="0.01" value={form.special_allowance} onChange={e => set('special_allowance', e.target.value)} /></div>
        </div>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 1 }}>รายหัก</div>
        <div className="form-grid-2">
          <div><label className="label">ประกันสังคม</label>
            <input type="number" className="input" min="0" step="0.01" value={form.social_security_ded} onChange={e => set('social_security_ded', e.target.value)} /></div>
          <div><label className="label">หักวันลา</label>
            <input type="number" className="input" min="0" step="0.01" value={form.leave_deduction} onChange={e => set('leave_deduction', e.target.value)} /></div>
        </div>
        <div className="form-grid-2">
          <div><label className="label">เบิกล่วงหน้า</label>
            <input type="number" className="input" min="0" step="0.01" value={form.advance_deduction} onChange={e => set('advance_deduction', e.target.value)} /></div>
          <div><label className="label">กยศ / เงินกู้</label>
            <input type="number" className="input" min="0" step="0.01" value={form.loan_deduction} onChange={e => set('loan_deduction', e.target.value)} /></div>
        </div>
        <div style={{ background: 'rgba(0,212,170,0.08)', borderRadius: 8, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--text2)', fontSize: 13 }}>รับสุทธิ (คำนวณ):</span>
          <strong style={{ color: 'var(--green)', fontSize: 20 }}>{fmt(calcNet(form))} บาท</strong>
          <div style={{ flex: 1 }} />
          <div>
            <label className="label" style={{ marginBottom: 2 }}>หรือระบุเอง</label>
            <input type="number" className="input input-sm" min="0" step="0.01" value={form.net_pay}
              onChange={e => set('net_pay', e.target.value)} style={{ width: 130 }} placeholder="(auto)" />
          </div>
        </div>
        <div className="form-grid-2">
          <div><label className="label">วันที่จ่าย</label>
            <input type="date" className="input" value={form.paid_date} onChange={e => set('paid_date', e.target.value)} /></div>
          <div><label className="label">หมายเหตุ</label>
            <input className="input" value={form.notes} onChange={e => set('notes', e.target.value)} /></div>
        </div>
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

// ── Salary Slip (payslip PDF) ─────────────────────────────────
function SalarySlipModal({ record, month, year, onClose }) {
  const handleDownload = () => {
    const label = (record.workers?.nickname || record.workers?.name || 'slip').replace(/\s+/g, '_')
    downloadPDF('salary-slip-preview', `สลิปเงินเดือน_${label}_${MONTHS[month-1]}${year+543}.pdf`)
  }

  const row = (label, value, negative = false) => value > 0 && (
    <tr>
      <td style={{ padding: '6px 0', borderBottom: '1px solid #ddd' }}>{label}</td>
      <td style={{ textAlign: 'right', padding: '6px 0', borderBottom: '1px solid #ddd', color: negative ? '#c00' : undefined }}>
        {negative ? `(${fmt(value)})` : fmt(value)}
      </td>
    </tr>
  )

  return (
    <Modal title={`สลิปเงินเดือน — ${record.workers?.name || ''}`} onClose={onClose} maxWidth={520}>
      <div className="modal-body">
        <div id="salary-slip-preview" style={{ fontFamily: 'Sarabun,sans-serif', padding: '20px 24px', background: '#fff', color: '#111' }}>
          <div style={{ textAlign: 'center', marginBottom: 16 }}>
            <div style={{ fontSize: 18, fontWeight: 800 }}>FACADE X</div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>สลิปเงินเดือน — {MONTHS[month-1]} {year+543}</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12, fontSize: 13 }}>
            <div><strong>ชื่อ-สกุล:</strong> {record.workers?.name || '—'}</div>
            <div><strong>ชื่อเล่น:</strong> {record.workers?.nickname || '—'}</div>
            <div><strong>ตำแหน่ง:</strong> {record.workers?.position || '—'}</div>
            <div><strong>วันที่จ่าย:</strong> {record.paid_date ? new Date(record.paid_date).toLocaleDateString('th-TH') : '—'}</div>
          </div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: 1, marginTop: 8, marginBottom: 4 }}>รายรับ</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <tbody>
              {row('เงินเดือน', record.base_salary)}
              {row('เงินสมทบนายจ้าง', record.contribution)}
              {row('ค่าโทรศัพท์', record.phone_allowance)}
              {row('OT', record.ot_amount)}
              {row('เงินพิเศษ/ค่าจอดรถ', record.special_allowance)}
            </tbody>
          </table>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: 1, marginTop: 14, marginBottom: 4 }}>รายหัก</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <tbody>
              {row('ประกันสังคม', record.social_security_ded, true)}
              {row('หักวันลา', record.leave_deduction, true)}
              {row('เบิกล่วงหน้า', record.advance_deduction, true)}
              {row('กยศ/เงินกู้', record.loan_deduction, true)}
              <tr style={{ fontWeight: 700, fontSize: 16 }}>
                <td style={{ padding: '10px 0 0' }}>รับสุทธิ</td>
                <td style={{ textAlign: 'right', padding: '10px 0 0', borderTop: '2px solid #111' }}>{fmt(record.net_pay)} บาท</td>
              </tr>
            </tbody>
          </table>
          {record.notes && <div style={{ marginTop: 12, fontSize: 12, color: '#555' }}><strong>หมายเหตุ:</strong> {record.notes}</div>}
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
        <button className="btn btn-primary" onClick={handleDownload}>📄 Download PDF</button>
      </div>
    </Modal>
  )
}

// ── HR Main Component ─────────────────────────────────────────
export default function HR() {
  const now = new Date()
  const { role, user, isAtLeast } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'hr')
  const [innerTab, setInnerTab] = useState('workers')

  // Workers state
  const { data: workers, refetch: refetchWorkers } = useAllActiveWorkers()
  const { data: seat, refetch: refetchSeat } = useSeatStatus()
  const { data: leaveUsed } = useLeaveQuotaUsage(now.getFullYear())
  const { data: sickLeaveUsed } = useSickLeaveQuotaUsage(now.getFullYear())
  const [showWorkerForm, setShowWorkerForm] = useState(false)
  const [editWorker, setEditWorker] = useState(null)
  const [deleteWorkerId, setDeleteWorkerId] = useState(null)
  const [savingWorker, setSavingWorker] = useState(false)

  // User accounts (for pairing worker ↔ login)
  const [workerUsers, setWorkerUsers] = useState([])
  useEffect(() => {
    if (!canEdit) return
    supabase.from('user_roles').select('user_email, role').order('user_email')
      .then(({ data }) => setWorkerUsers(data || []))
  }, [canEdit])

  // Payroll state
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [year, setYear]   = useState(now.getFullYear())
  const { data: records, refetch: refetchSalary } = useSalary(month, year)
  const { data: prevMonthRecords } = usePreviousMonthSalaries(month, year)
  const [showSalaryForm, setShowSalaryForm] = useState(false)
  const [editSalary, setEditSalary] = useState(null)
  const [savingSalary, setSavingSalary] = useState(false)
  const [calcLoading, setCalcLoading] = useState(false)
  const [calcPreview, setCalcPreview] = useState(null)
  const [calcPreviewMode, setCalcPreviewMode] = useState('assign') // 'assign' | 'copy'
  const [slipRecord, setSlipRecord] = useState(null)

  // Audit state
  const [auditTable, setAuditTable] = useState('')
  const { data: logs } = useAuditLogs(auditTable || null, 100)

  // Holiday calendar state
  const { data: holidays, refetch: refetchHolidays } = useCompanyHolidays()
  const [showHolidayForm, setShowHolidayForm] = useState(false)
  const [savingHoliday, setSavingHoliday] = useState(false)
  const [deleteHolidayId, setDeleteHolidayId] = useState(null)
  const { data: multiplierVal, refetch: refetchMultiplier } = useAppSetting('holiday_pay_multiplier', '1.5')
  const [multiplierInput, setMultiplierInput] = useState('')
  const [savingMultiplier, setSavingMultiplier] = useState(false)
  useEffect(() => { if (multiplierVal != null) setMultiplierInput(String(multiplierVal)) }, [multiplierVal])

  // ── Worker handlers ──
  const handleSaveWorker = async (form) => {
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
      }
      if (editWorker) {
        const { data: old } = await supabase.from('workers').select('*').eq('id', editWorker.id).single()
        const { error } = await supabase.from('workers').update(payload).eq('id', editWorker.id)
        if (error) throw error
        await auditLog('workers', editWorker.id, 'UPDATE', old, payload)
      } else {
        const { data, error } = await supabase.from('workers').insert(payload).select().single()
        if (error) throw error
        await auditLog('workers', data.id, 'INSERT', null, payload)
      }
      setShowWorkerForm(false); setEditWorker(null); refetchWorkers(); refetchSeat()
    } catch (e) {
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

  // ── Salary handlers ──
  const handleSaveSalary = async (form) => {
    setSavingSalary(true)
    try {
      const payload = {
        worker_id: form.worker_id, month, year,
        base_salary: parseFloat(form.base_salary)||0,
        contribution: parseFloat(form.contribution)||0,
        phone_allowance: parseFloat(form.phone_allowance)||0,
        ot_amount: parseFloat(form.ot_amount)||0,
        special_allowance: parseFloat(form.special_allowance)||0,
        social_security_ded: parseFloat(form.social_security_ded)||0,
        advance_deduction: parseFloat(form.advance_deduction)||0,
        loan_deduction: parseFloat(form.loan_deduction)||0,
        leave_deduction: parseFloat(form.leave_deduction)||0,
        net_pay: parseFloat(form.net_pay)||calcNet(form),
        paid_date: form.paid_date||null, notes: form.notes||null,
      }
      if (editSalary) {
        const { error } = await supabase.from('salary_records').update(payload).eq('id', editSalary.id)
        if (error) throw error
        await auditLog('salary_records', editSalary.id, 'UPDATE', null, payload)
      } else {
        const { data, error } = await supabase.from('salary_records').insert(payload).select().single()
        if (error) throw error
        await auditLog('salary_records', data.id, 'INSERT', null, payload)
      }
      setShowSalaryForm(false); setEditSalary(null); refetchSalary()
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSavingSalary(false) }
  }

  const handleDeleteSalary = async (id) => {
    if (!window.confirm('ลบรายการเงินเดือนนี้?')) return
    await supabase.from('salary_records').delete().eq('id', id)
    await auditLog('salary_records', id, 'DELETE', null, null)
    refetchSalary()
  }

  const handleCopyPrevMonth = () => {
    if (!prevMonthRecords?.length) {
      alert('ไม่พบข้อมูลเงินเดือนเดือนที่แล้ว')
      return
    }
    const preview = prevMonthRecords.map(r => ({
      worker_id: r.worker_id,
      name: r.workers?.name || '—',
      nickname: r.workers?.nickname || '',
      base_salary: r.base_salary,
      contribution: r.contribution,
      phone_allowance: r.phone_allowance,
      social_security_ded: r.social_security_ded,
      special_allowance: r.special_allowance,
      // reset variable fields
      ot_amount: 0,
      advance_deduction: 0,
      loan_deduction: 0,
      leave_deduction: 0,
      leave_sick_days: 0,
      leave_personal_days: 0,
      office_days: 0,
      office_cost: 0,
      ot_hours: 0,
      net_pay: parseFloat(
        ((r.base_salary||0) + (r.phone_allowance||0) + (r.special_allowance||0) - (r.social_security_ded||0))
        .toFixed(2)
      ),
    }))
    setCalcPreviewMode('copy')
    setCalcPreview(preview)
  }

  const handleClearPayroll = async () => {
    if (!window.confirm(`ล้างข้อมูลเงินเดือนทั้งหมดของ ${MONTHS[month-1]} ${year+543}?`)) return
    const ids = (records || []).map(r => r.id)
    if (!ids.length) return
    for (const id of ids) {
      await supabase.from('salary_records').delete().eq('id', id)
      await auditLog('salary_records', id, 'DELETE', null, null)
    }
    refetchSalary()
  }

  const handleCalcFromAssign = async () => {
    setCalcLoading(true)
    try {
      const from = `${year}-${String(month).padStart(2,'0')}-01`
      const to   = new Date(year, month, 0).toISOString().slice(0,10)
      const { data: assigns, error } = await supabase
        .from('worker_assignments')
        .select('worker_id, type, ot_hours, date, workers(id, name, nickname, monthly_salary, monthly_contribution, has_social_security)')
        .gte('date', from).lte('date', to)
      if (error) throw error
      // Legacy 'leave' rows (created before the sick/personal split) are
      // treated as leave_personal so recalculating a historical month
      // doesn't silently change an already-paid deduction.
      const wmap = {}
      ;(assigns||[]).forEach(a => {
        const w = a.workers; if (!w) return
        if (!wmap[a.worker_id]) wmap[a.worker_id] = { worker: w, leave_sick: 0, leave_personal: 0, office: 0, ot_hours: 0 }
        if (a.type === 'leave_sick')                          wmap[a.worker_id].leave_sick += 0.5
        if (a.type === 'leave_personal' || a.type === 'leave') wmap[a.worker_id].leave_personal += 0.5  // 1 กะ = 0.5 วัน (เช้า+บ่าย = 1 วัน)
        if (a.type === 'office')                               wmap[a.worker_id].office += 0.5  // 1 กะ = 0.5 วัน, เหมือน leave
        if (a.type === 'site')                                 wmap[a.worker_id].ot_hours += (a.ot_hours||0)  // legacy OT stored on the shift row
      })

      const otRows = await fetchWorkerOTForRange(from, to)
      mergeWorkerOT(wmap, otRows)  // adds worker_ot's decoupled OT entries on top

      // Count each worker's site/factory shifts that fall on a company
      // holiday OR a Sunday — both pay at the same holiday-rate premium.
      const holidayRows = await fetchCompanyHolidaysForRange(from, to)
      const holidaySet = new Set(holidayRows.map(h => h.date))
      const holidayMultiplier = parseFloat(multiplierVal) || 1.5
      ;(assigns||[]).forEach(a => {
        if (!wmap[a.worker_id]) return
        const isHolidayRateDay = holidaySet.has(a.date) || new Date(a.date).getDay() === 0
        if (SITE_TYPES.includes(a.type) && isHolidayRateDay) {
          wmap[a.worker_id].holiday_shifts = (wmap[a.worker_id].holiday_shifts || 0) + 1
        }
      })

      const results = Object.entries(wmap).map(([worker_id, d]) => {
        const dr  = (d.worker.monthly_salary||0) / 26
        const lv  = parseFloat((d.leave_personal * dr).toFixed(2))
        const ot  = parseFloat((d.ot_hours * dr / 8 * 1.5).toFixed(2))
        const hb  = parseFloat(((d.holiday_shifts||0) * dr * 0.5 * holidayMultiplier).toFixed(2))
        const oc  = parseFloat((d.office * dr).toFixed(2))
        const sso = d.worker.has_social_security ? parseFloat(Math.min(750,(d.worker.monthly_salary||0)*0.05).toFixed(2)) : 0
        return {
          worker_id, name: d.worker.name, nickname: d.worker.nickname,
          base_salary: d.worker.monthly_salary||0,
          contribution: d.worker.monthly_contribution||0,
          social_security_ded: sso,
          leave_sick_days: d.leave_sick, leave_personal_days: d.leave_personal,
          leave_deduction: lv, ot_hours: d.ot_hours, ot_amount: ot,
          holiday_shifts: d.holiday_shifts||0, holiday_bonus: hb,
          office_days: d.office, office_cost: oc,
          net_pay: parseFloat(((d.worker.monthly_salary||0) - sso - lv + ot + hb).toFixed(2)),
        }
      })
      if (!results.length) { alert('ไม่พบ assignment ในเดือนนี้'); return }
      setCalcPreviewMode('assign')
      setCalcPreview(results)
    } catch (e) { alert('Error: ' + e.message) }
    finally { setCalcLoading(false) }
  }

  const handleConfirmCalc = async () => {
    if (!calcPreview?.length) return
    setSavingSalary(true)
    try {
      for (const r of calcPreview) {
        const payload = {
          worker_id: r.worker_id, month, year,
          base_salary: r.base_salary, contribution: r.contribution,
          ot_amount: r.ot_amount + (r.holiday_bonus || 0), social_security_ded: r.social_security_ded,
          leave_deduction: r.leave_deduction, net_pay: r.net_pay,
          office_days: r.office_days || 0, office_cost: r.office_cost || 0,
        }
        const { data } = await supabase.from('salary_records')
          .upsert(payload, { onConflict: 'worker_id,month,year' }).select().single()
        await auditLog('salary_records', data?.id, 'UPSERT', null, payload)
      }
      setCalcPreview(null); refetchSalary()
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSavingSalary(false) }
  }

  // WORKER: filter payroll to only show records matching their own email
  const visibleRecords = useMemo(() => {
    if (canEdit) return records || []
    const email = user?.email
    if (!email) return []
    return (records || []).filter(r => r.workers?.email === email)
  }, [records, canEdit, user])

  // WORKER: filter roster to only show their own worker record
  const visibleWorkers = useMemo(() => {
    if (canEdit) return workers || []
    const email = user?.email
    if (!email) return []
    return (workers || []).filter(w => w.email === email)
  }, [workers, canEdit, user])

  const totalBase = useMemo(() => visibleRecords.reduce((s,r)=>s+(r.base_salary||0),0),[visibleRecords])
  const totalNet  = useMemo(() => visibleRecords.reduce((s,r)=>s+(r.net_pay||0),0),[visibleRecords])
  const totalOT   = useMemo(() => visibleRecords.reduce((s,r)=>s+(r.ot_amount||0),0),[visibleRecords])
  const totalSSO  = useMemo(() => visibleRecords.reduce((s,r)=>s+(r.social_security_ded||0),0),[visibleRecords])
  const totalOfficeCost = useMemo(() => visibleRecords.reduce((s,r)=>s+(r.office_cost||0),0),[visibleRecords])

  const INNER_TABS = [
    { id: 'workers',  label: '👷 ข้อมูลช่าง' },
    { id: 'payroll',  label: '💼 เงินเดือน' },
    // Audit log only visible to ADMIN and OWNER
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
              <button className="btn btn-primary" onClick={() => { setEditWorker(null); setShowWorkerForm(true) }}>+ เพิ่มช่าง</button>
            )}
          </div>
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>ชื่อ</th><th>ชื่อเล่น</th><th>ตำแหน่ง</th>
                    <th>เงินเดือน</th><th>ค่าแรง/วัน</th>
                    <th>SSO</th>
                    <th>ลากิจ/ปี</th><th>ใช้แล้ว</th><th>คงเหลือ</th>
                    <th>ลาป่วย/ปี</th><th>ใช้แล้ว</th><th>คงเหลือ</th>
                    <th>สถานะ</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleWorkers.map(w => {
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
                  {!visibleWorkers.length && (
                    <tr><td colSpan={11} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีช่าง</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

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
                  <thead><tr><th>วันที่</th><th>ชื่อวันหยุด</th><th></th></tr></thead>
                  <tbody>
                    {(holidays || []).map(h => (
                      <tr key={h.id}>
                        <td style={{ fontSize: 12 }}>{new Date(h.date).toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' })}</td>
                        <td style={{ fontWeight: 600 }}>{h.name}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {canEdit && <button className="btn btn-sm btn-danger" onClick={() => setDeleteHolidayId(h.id)}><TrashIcon /></button>}
                        </td>
                      </tr>
                    ))}
                    {!(holidays || []).length && (
                      <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีวันหยุดที่กำหนด</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Payroll Tab ── */}
      {innerTab === 'payroll' && (
        <div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            {canEdit && (
              <>
                <button className="btn btn-primary" onClick={() => { setEditSalary(null); setShowSalaryForm(true) }}>+ เพิ่มรายการ</button>
                <button className="btn btn-ghost" onClick={handleCalcFromAssign} disabled={calcLoading}>
                  {calcLoading ? '⏳...' : '🔄 คำนวณจาก Assign'}
                </button>
                <button className="btn btn-ghost" onClick={handleCopyPrevMonth} title="คัดลอกพนักงาน+ค่าแรงจากเดือนก่อน (OT และวันลาจะถูกรีเซ็ต)">
                  📋 ใช้ข้อมูลเดือนที่แล้ว
                </button>
                {(records||[]).length > 0 && (
                  <button className="btn btn-ghost" style={{ color: 'var(--red)' }} onClick={handleClearPayroll}>
                    🗑️ Clear
                  </button>
                )}
              </>
            )}
            <div style={{ flex: 1 }} />
            <select className="select select-sm" value={month} onChange={e => setMonth(parseInt(e.target.value))}>
              {MONTHS.map((m,i) => <option key={i+1} value={i+1}>{m}</option>)}
            </select>
            <select className="select select-sm" value={year} onChange={e => setYear(parseInt(e.target.value))}>
              {[2024,2025,2026,2027].map(y => <option key={y}>{y}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
            <div className="kpi-card kpi-sm"><div className="kpi-label">เงินเดือนรวม</div><div className="kpi-value">{fmt(totalBase)}</div></div>
            <div className="kpi-card kpi-sm"><div className="kpi-label">OT</div><div className="kpi-value" style={{ color: 'var(--yellow)' }}>{fmt(totalOT)}</div></div>
            <div className="kpi-card kpi-sm"><div className="kpi-label">ประกันสังคม</div><div className="kpi-value">{fmt(totalSSO)}</div></div>
            <div className="kpi-card kpi-sm blue"><div className="kpi-label">ค่าใช้จ่ายส่วนกลางรวม</div><div className="kpi-value" style={{ color: 'var(--blue)' }}>{fmt(totalOfficeCost)}</div></div>
            <div className="kpi-card kpi-sm green"><div className="kpi-label">จ่ายสุทธิรวม</div><div className="kpi-value" style={{ color: 'var(--green)' }}>{fmt(totalNet)}</div></div>
          </div>
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>พนักงาน</th><th>เงินเดือน</th><th>วันออฟฟิศ</th><th>ค่าใช้จ่ายส่วนกลาง</th><th>OT</th>
                    <th>ประกันสังคม</th><th>หักลา</th><th>เบิกล่วงหน้า</th>
                    <th>จ่ายสุทธิ</th><th>วันจ่าย</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRecords.map(r => (
                    <tr key={r.id}>
                      <td><div style={{ fontWeight: 600 }}>{r.workers?.name||'—'}</div><div style={{ fontSize: 11, color: 'var(--text3)' }}>{r.workers?.position}</div></td>
                      <td className="font-mono">{fmt(r.base_salary)}</td>
                      <td style={{ textAlign: 'center', color: r.office_days>0?'var(--blue)':'var(--text3)' }}>{r.office_days||'—'}</td>
                      <td className="font-mono" style={{ color: r.office_cost>0?'var(--blue)':'var(--text3)' }}>{r.office_cost>0?fmt(r.office_cost):'—'}</td>
                      <td className="font-mono" style={{ color: r.ot_amount>0?'var(--yellow)':'var(--text3)' }}>{r.ot_amount>0?fmt(r.ot_amount):'—'}</td>
                      <td className="font-mono" style={{ color: 'var(--red)', fontSize: 12 }}>{r.social_security_ded>0?`(${fmt(r.social_security_ded)})`:'—'}</td>
                      <td className="font-mono" style={{ color: 'var(--red)', fontSize: 12 }}>{r.leave_deduction>0?`(${fmt(r.leave_deduction)})`:'—'}</td>
                      <td className="font-mono" style={{ color: 'var(--red)', fontSize: 12 }}>{r.advance_deduction>0?`(${fmt(r.advance_deduction)})`:'—'}</td>
                      <td className="font-mono" style={{ color: 'var(--green)', fontWeight: 700, fontSize: 15 }}>{fmt(r.net_pay)}</td>
                      <td style={{ fontSize: 11 }}>{r.paid_date?new Date(r.paid_date).toLocaleDateString('th-TH'):'—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <div className="actions-cell">
                          <button className="btn btn-sm btn-ghost" onClick={() => setSlipRecord(r)} title="Download สลิปเงินเดือน">📄</button>
                          {canEdit && (
                            <>
                              <button className="btn btn-sm btn-edit" onClick={() => { setEditSalary(r); setShowSalaryForm(true) }}><PencilIcon /></button>
                              <button className="btn btn-sm btn-danger" onClick={() => handleDeleteSalary(r.id)}><TrashIcon /></button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!visibleRecords.length && (
                    <tr><td colSpan={11} style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>
                      ยังไม่มีข้อมูลเงินเดือน {MONTHS[month-1]} {year+543}
                    </td></tr>
                  )}
                </tbody>
                {visibleRecords.length > 0 && (
                  <tfoot>
                    <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 700 }}>
                      <td style={{ color: 'var(--text3)', fontSize: 12 }}>รวม</td>
                      <td className="font-mono">{fmt(totalBase)}</td>
                      <td />
                      <td className="font-mono" style={{ color: 'var(--blue)' }}>{fmt(totalOfficeCost)}</td>
                      <td className="font-mono" style={{ color: 'var(--yellow)' }}>{fmt(totalOT)}</td>
                      <td className="font-mono" style={{ color: 'var(--red)' }}>{fmt(totalSSO)}</td>
                      <td colSpan={2} />
                      <td className="font-mono" style={{ color: 'var(--green)' }}>{fmt(totalNet)}</td>
                      <td colSpan={2} />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
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
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>เวลา</th><th>ผู้ใช้</th><th>ตาราง</th><th>Action</th><th>รายละเอียด</th></tr>
                </thead>
                <tbody>
                  {(logs||[]).map(l => (
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
                  {!(logs||[]).length && (
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
        <Modal title={editWorker?`แก้ไข: ${editWorker.name}`:'เพิ่มช่าง / พนักงาน'}
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

      {showSalaryForm && (
        <Modal title={editSalary?'แก้ไขเงินเดือน':`เพิ่มเงินเดือน — ${MONTHS[month-1]} ${year+543}`}
          onClose={() => { setShowSalaryForm(false); setEditSalary(null) }} maxWidth={600}>
          <SalaryForm initial={editSalary||EMPTY_SALARY} workers={workers}
            onSave={handleSaveSalary} onCancel={() => { setShowSalaryForm(false); setEditSalary(null) }} loading={savingSalary} />
        </Modal>
      )}

      {slipRecord && (
        <SalarySlipModal record={slipRecord} month={month} year={year} onClose={() => setSlipRecord(null)} />
      )}

      {calcPreview && (
        <Modal title={calcPreviewMode === 'copy'
            ? `คัดลอกจากเดือนที่แล้ว → ${MONTHS[month-1]} ${year+543}`
            : `คำนวณจาก Assign — ${MONTHS[month-1]} ${year+543}`}
          onClose={() => setCalcPreview(null)} maxWidth={700}>
          <div className="modal-body">
            <div className="alert alert-info" style={{ marginBottom: 12 }}>
              {calcPreviewMode === 'copy'
                ? 'คัดลอกพนักงานและเงินเดือนจากเดือนที่แล้ว (OT, วันลา, เบิกล่วงหน้า จะถูก reset เป็น 0)'
                : 'ระบบจะ upsert salary_records ตามข้อมูล assignment'}
            </div>
            <div className="table-wrap" style={{ maxHeight: 320 }}>
              <table>
                <thead><tr><th>พนักงาน</th><th>เงินเดือน</th><th>ลาป่วย</th><th>ลากิจ</th><th>หักลา</th><th>OT ชม.</th><th>OT บาท</th><th>กะวันหยุด</th><th>โบนัสวันหยุด</th><th>วันออฟฟิศ</th><th>ค่าใช้จ่ายส่วนกลาง</th><th>SSO</th><th>สุทธิ</th></tr></thead>
                <tbody>
                  {calcPreview.map((r,i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>{r.name}{r.nickname?` (${r.nickname})`:''}</td>
                      <td className="font-mono">{fmt(r.base_salary)}</td>
                      <td style={{ textAlign: 'center', color: r.leave_sick_days>0?'var(--yellow)':'var(--text3)' }}>{r.leave_sick_days||'—'}</td>
                      <td style={{ textAlign: 'center', color: r.leave_personal_days>0?'var(--red)':'var(--text3)' }}>{r.leave_personal_days||'—'}</td>
                      <td className="font-mono" style={{ color: 'var(--red)' }}>{r.leave_deduction>0?`(${fmt(r.leave_deduction)})`:'—'}</td>
                      <td style={{ textAlign: 'center', color: r.ot_hours>0?'var(--yellow)':'var(--text3)' }}>{r.ot_hours||'—'}</td>
                      <td className="font-mono" style={{ color: 'var(--yellow)' }}>{r.ot_amount>0?fmt(r.ot_amount):'—'}</td>
                      <td style={{ textAlign: 'center', color: r.holiday_shifts>0?'var(--accent)':'var(--text3)' }}>{r.holiday_shifts||'—'}</td>
                      <td className="font-mono" style={{ color: 'var(--accent)' }}>{r.holiday_bonus>0?fmt(r.holiday_bonus):'—'}</td>
                      <td style={{ textAlign: 'center', color: r.office_days>0?'var(--blue)':'var(--text3)' }}>{r.office_days||'—'}</td>
                      <td className="font-mono" style={{ color: 'var(--blue)' }}>{r.office_cost>0?fmt(r.office_cost):'—'}</td>
                      <td className="font-mono" style={{ color: 'var(--red)', fontSize: 12 }}>{r.social_security_ded>0?`(${fmt(r.social_security_ded)})`:'—'}</td>
                      <td className="font-mono" style={{ color: 'var(--green)', fontWeight: 700 }}>{fmt(r.net_pay)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-ghost" onClick={() => setCalcPreview(null)}>ยกเลิก</button>
            <button className="btn btn-success" onClick={handleConfirmCalc} disabled={savingSalary}>
              {savingSalary?'⏳...': `✅ ยืนยัน ${calcPreview.length} รายการ`}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
