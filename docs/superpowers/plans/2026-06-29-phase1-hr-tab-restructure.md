# Phase 1: HR Tab Restructure + Audit Utilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ย้าย worker management จาก Assign → HR tab ใหม่, เพิ่ม audit_logs table, สร้าง audit.js + pdf.js utilities

**Architecture:** HR.jsx รวม worker CRUD + payroll (จาก Payroll.jsx) + audit viewer ใน inner tabs. Assign.jsx เหลือแค่ assignment matrix. audit.js เป็น thin wrapper เขียน audit_logs ทุก mutation.

**Tech Stack:** React 18, Vite, @supabase/supabase-js v2, html2pdf.js (ใหม่)

---

## Files Map

| Action | File | หน้าที่ |
|--------|------|---------|
| DB (MCP) | audit_logs table | เก็บ change history |
| Install | html2pdf.js | PDF generation ที่รองรับ Thai |
| Create | `src/lib/audit.js` | helper เขียน audit log |
| Create | `src/lib/pdf.js` | helper สร้าง PDF จาก HTML |
| Create | `src/pages/HR.jsx` | worker mgmt + payroll + audit viewer |
| Modify | `src/pages/Assign.jsx` | ลบ worker management ออก |
| Modify | `src/App.jsx` | เปลี่ยน tab เงินเดือน → HR, เพิ่ม tab ผู้รับเหมา |
| Modify | `src/hooks/useSupabase.js` | เพิ่ม useAuditLogs hook |

---

## Task 1: สร้าง audit_logs table (Supabase MCP)

**Files:** execute_sql on project `yyzbgdmgyvvypfcjuhtr`

- [ ] **Step 1: Run SQL**

```sql
CREATE TABLE audit_logs (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  table_name  TEXT NOT NULL,
  record_id   UUID,
  action      TEXT NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
  user_email  TEXT,
  changed_at  TIMESTAMPTZ DEFAULT NOW(),
  old_values  JSONB,
  new_values  JSONB
);
CREATE INDEX idx_audit_table  ON audit_logs(table_name);
CREATE INDEX idx_audit_record ON audit_logs(record_id);
CREATE INDEX idx_audit_time   ON audit_logs(changed_at DESC);
```

- [ ] **Step 2: Verify**

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'audit_logs';
```

Expected: 1 row

- [ ] **Step 3: Commit message**
```
db: add audit_logs table for change history tracking
```

---

## Task 2: Install html2pdf.js

**Files:** `package.json`

- [ ] **Step 1: Install**

```bash
npm install html2pdf.js
```

Expected output includes: `added X packages`

- [ ] **Step 2: Verify import works**

```bash
node -e "require('html2pdf.js'); console.log('ok')"
```

Expected: `ok`

---

## Task 3: สร้าง src/lib/audit.js

**Files:** Create `src/lib/audit.js`

- [ ] **Step 1: Create file**

```js
import { supabase } from './supabase.js'

/**
 * เขียน audit log ทุกครั้งที่มีการแก้ไขข้อมูล
 * เรียกหลัง supabase mutation สำเร็จ
 */
export async function auditLog(tableName, recordId, action, oldValues, newValues) {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    await supabase.from('audit_logs').insert({
      table_name: tableName,
      record_id:  recordId || null,
      action,
      user_email: session?.user?.email || 'system',
      old_values: oldValues || null,
      new_values: newValues || null,
    })
  } catch (e) {
    // audit log failure ไม่ควร block main operation
    console.warn('audit log failed:', e.message)
  }
}
```

---

## Task 4: สร้าง src/lib/pdf.js

**Files:** Create `src/lib/pdf.js`

- [ ] **Step 1: Create file**

```js
/**
 * สร้าง PDF จาก HTML element
 * ใช้ html2pdf.js ซึ่งรองรับ Thai font ผ่าน canvas rendering
 */
export async function downloadPDF(elementId, filename) {
  const html2pdf = (await import('html2pdf.js')).default
  const element = document.getElementById(elementId)
  if (!element) { console.error('element not found:', elementId); return }

  await html2pdf().set({
    margin:      [10, 10, 10, 10],
    filename:    filename || 'document.pdf',
    image:       { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true, letterRendering: true },
    jsPDF:       { unit: 'mm', format: 'a4', orientation: 'portrait' }
  }).from(element).save()
}
```

---

## Task 5: เพิ่ม useAuditLogs hook ใน useSupabase.js

**Files:** Modify `src/hooks/useSupabase.js` — ต่อท้ายไฟล์

- [ ] **Step 1: อ่านไฟล์ แล้วต่อท้าย**

```js
// ── Audit Logs ────────────────────────────────────────────────
export function useAuditLogs(tableName, limit = 50) {
  return useQuery(async () => {
    let q = supabase
      .from('audit_logs')
      .select('*')
      .order('changed_at', { ascending: false })
      .limit(limit)
    if (tableName) q = q.eq('table_name', tableName)
    const { data, error } = await q
    if (error) throw error
    return data
  }, [tableName, limit])
}
```

---

## Task 6: สร้าง HR.jsx

**Files:** Create `src/pages/HR.jsx`

HR.jsx มี 3 inner tabs: ข้อมูลช่าง | เงินเดือน | ประวัติการแก้ไข

Worker management section ย้ายมาจาก Assign.jsx (WorkerForm + worker table + handleSaveWorker + handleDeleteWorker)
Payroll section copy มาจาก Payroll.jsx

- [ ] **Step 1: อ่าน Assign.jsx และ Payroll.jsx ให้เข้าใจ code ที่จะย้าย**

- [ ] **Step 2: Create HR.jsx**

```jsx
// ============================================================
// HR — บริหารทีมช่าง + เงินเดือน + ประวัติการแก้ไข
// ✅ Worker CRUD (ย้ายมาจาก Assign)
// ✅ Payroll (ย้ายมาจาก Payroll.jsx)
// ✅ Audit log viewer
// ============================================================
import { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { useWorkers, useSalary, useAuditLogs } from '../hooks/useSupabase.js'
import { fmt } from '../lib/supabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import { auditLog } from '../lib/audit.js'

const MONTHS = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.']

// ── Worker Form (เหมือนใน Assign.jsx เดิม) ────────────────────
const EMPTY_WORKER = {
  name: '', nickname: '', position: '',
  monthly_salary: '', status: 'active',
  has_social_security: true, annual_leave_days: 6, monthly_contribution: ''
}

function WorkerForm({ initial = EMPTY_WORKER, onSave, onCancel, loading }) {
  const [form, setForm] = useState({ ...EMPTY_WORKER, ...initial })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const dailyRate = form.monthly_salary ? (parseFloat(form.monthly_salary) / 26).toFixed(2) : '—'

  return (
    <form onSubmit={e => { e.preventDefault(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
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
            <label className="label">วันลาต่อปี</label>
            <input type="number" className="input" min="0" value={form.annual_leave_days}
              onChange={e => set('annual_leave_days', parseInt(e.target.value) || 0)} />
          </div>
          <div>
            <label className="label">เงินสมทบ/เดือน</label>
            <input type="number" className="input" min="0" step="0.01" value={form.monthly_contribution}
              onChange={e => set('monthly_contribution', e.target.value)} placeholder="บาท" />
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
  const [form, setForm] = useState({ ...EMPTY_SALARY, ...initial })
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
    <form onSubmit={e => { e.preventDefault(); onSave({ ...form, net_pay: form.net_pay || calcNet(form) }) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div>
          <label className="label">ช่าง / พนักงาน ★</label>
          <select className="select" required value={form.worker_id} onChange={e => {
            const w = (workers||[]).find(x => x.id === e.target.value)
            if (w) prefill(w); else set('worker_id', e.target.value)
          }}>
            <option value="">— เลือก —</option>
            {(workers||[]).map(w => <option key={w.id} value={w.id}>{w.name}{w.nickname ? ` (${w.nickname})` : ''}</option>)}
          </select>
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

// ── HR Main Component ─────────────────────────────────────────
export default function HR() {
  const now = new Date()
  const [innerTab, setInnerTab] = useState('workers')

  // Workers state
  const { data: workers, refetch: refetchWorkers } = useWorkers()
  const [showWorkerForm, setShowWorkerForm] = useState(false)
  const [editWorker, setEditWorker] = useState(null)
  const [deleteWorkerId, setDeleteWorkerId] = useState(null)
  const [savingWorker, setSavingWorker] = useState(false)

  // Payroll state
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [year, setYear]   = useState(now.getFullYear())
  const { data: records, refetch: refetchSalary } = useSalary(month, year)
  const [showSalaryForm, setShowSalaryForm] = useState(false)
  const [editSalary, setEditSalary] = useState(null)
  const [savingSalary, setSavingSalary] = useState(false)
  const [calcLoading, setCalcLoading] = useState(false)
  const [calcPreview, setCalcPreview] = useState(null)

  // Audit state
  const [auditTable, setAuditTable] = useState('')
  const { data: logs } = useAuditLogs(auditTable || null, 100)

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
        monthly_contribution: parseFloat(form.monthly_contribution) || null,
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
      setShowWorkerForm(false); setEditWorker(null); refetchWorkers()
    } catch (e) { alert('Error: ' + e.message) }
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

  const handleCalcFromAssign = async () => {
    setCalcLoading(true)
    try {
      const from = `${year}-${String(month).padStart(2,'0')}-01`
      const to   = new Date(year, month, 0).toISOString().slice(0,10)
      const { data: assigns, error } = await supabase
        .from('worker_assignments')
        .select('worker_id, type, ot_hours, workers(id, name, nickname, monthly_salary, monthly_contribution, has_social_security)')
        .gte('date', from).lte('date', to)
      if (error) throw error
      const wmap = {}
      ;(assigns||[]).forEach(a => {
        const w = a.workers; if (!w) return
        if (!wmap[a.worker_id]) wmap[a.worker_id] = { worker: w, leave: 0, ot_hours: 0 }
        if (a.type === 'leave') wmap[a.worker_id].leave++
        if (a.type === 'site')  wmap[a.worker_id].ot_hours += (a.ot_hours||0)
      })
      const results = Object.entries(wmap).map(([worker_id, d]) => {
        const dr  = (d.worker.monthly_salary||0) / 26
        const lv  = parseFloat((d.leave * dr).toFixed(2))
        const ot  = parseFloat((d.ot_hours * dr / 8 * 1.5).toFixed(2))
        const sso = d.worker.has_social_security ? parseFloat(Math.min(750,(d.worker.monthly_salary||0)*0.05).toFixed(2)) : 0
        return {
          worker_id, name: d.worker.name, nickname: d.worker.nickname,
          base_salary: d.worker.monthly_salary||0,
          contribution: d.worker.monthly_contribution||0,
          social_security_ded: sso, leave_days: d.leave,
          leave_deduction: lv, ot_hours: d.ot_hours, ot_amount: ot,
          net_pay: parseFloat(((d.worker.monthly_salary||0) - sso - lv + ot).toFixed(2)),
        }
      })
      if (!results.length) { alert('ไม่พบ assignment ในเดือนนี้'); return }
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
          ot_amount: r.ot_amount, social_security_ded: r.social_security_ded,
          leave_deduction: r.leave_deduction, net_pay: r.net_pay,
        }
        const { data } = await supabase.from('salary_records')
          .upsert(payload, { onConflict: 'worker_id,month,year' }).select().single()
        await auditLog('salary_records', data?.id, 'UPSERT', null, payload)
      }
      setCalcPreview(null); refetchSalary()
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSavingSalary(false) }
  }

  const totalBase = useMemo(() => (records||[]).reduce((s,r)=>s+(r.base_salary||0),0),[records])
  const totalNet  = useMemo(() => (records||[]).reduce((s,r)=>s+(r.net_pay||0),0),[records])
  const totalOT   = useMemo(() => (records||[]).reduce((s,r)=>s+(r.ot_amount||0),0),[records])
  const totalSSO  = useMemo(() => (records||[]).reduce((s,r)=>s+(r.social_security_ded||0),0),[records])

  const INNER_TABS = [
    { id: 'workers',  label: '👷 ข้อมูลช่าง' },
    { id: 'payroll',  label: '💼 เงินเดือน' },
    { id: 'audit',    label: '📋 ประวัติการแก้ไข' },
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
            <button className="btn btn-primary" onClick={() => { setEditWorker(null); setShowWorkerForm(true) }}>+ เพิ่มช่าง</button>
          </div>
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>ชื่อ</th><th>ชื่อเล่น</th><th>ตำแหน่ง</th>
                    <th>เงินเดือน</th><th>ค่าแรง/วัน</th>
                    <th>SSO</th><th>วันลา/ปี</th><th>สถานะ</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {(workers||[]).map(w => (
                    <tr key={w.id}>
                      <td style={{ fontWeight: 600 }}>{w.name}</td>
                      <td style={{ color: 'var(--text2)' }}>{w.nickname||'—'}</td>
                      <td style={{ fontSize: 12, color: 'var(--text3)' }}>{w.position||'—'}</td>
                      <td className="font-mono">{fmt(w.monthly_salary)}</td>
                      <td className="font-mono" style={{ color: 'var(--yellow)' }}>{fmt(w.daily_rate)}</td>
                      <td>{w.has_social_security ? <span className="badge badge-paid">✓ มี</span> : <span style={{ color: 'var(--text3)', fontSize: 11 }}>—</span>}</td>
                      <td style={{ textAlign: 'center' }}>{w.annual_leave_days}</td>
                      <td><span className={`badge ${w.status==='active'?'badge-paid':'badge-pending'}`}>{w.status}</span></td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn btn-sm btn-ghost" onClick={() => { setEditWorker(w); setShowWorkerForm(true) }}>✏️</button>
                        <button className="btn btn-sm btn-danger" onClick={() => setDeleteWorkerId(w.id)}>🗑️</button>
                      </td>
                    </tr>
                  ))}
                  {!(workers||[]).length && (
                    <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีช่าง</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── Payroll Tab ── */}
      {innerTab === 'payroll' && (
        <div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn btn-primary" onClick={() => { setEditSalary(null); setShowSalaryForm(true) }}>+ เพิ่มรายการ</button>
            <button className="btn btn-ghost" onClick={handleCalcFromAssign} disabled={calcLoading}>
              {calcLoading ? '⏳...' : '🔄 คำนวณจาก Assign'}
            </button>
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
            <div className="kpi-card kpi-sm green"><div className="kpi-label">จ่ายสุทธิรวม</div><div className="kpi-value" style={{ color: 'var(--green)' }}>{fmt(totalNet)}</div></div>
          </div>
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>พนักงาน</th><th>เงินเดือน</th><th>OT</th>
                    <th>ประกันสังคม</th><th>หักลา</th><th>เบิกล่วงหน้า</th>
                    <th>จ่ายสุทธิ</th><th>วันจ่าย</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {(records||[]).map(r => (
                    <tr key={r.id}>
                      <td><div style={{ fontWeight: 600 }}>{r.workers?.name||'—'}</div><div style={{ fontSize: 11, color: 'var(--text3)' }}>{r.workers?.position}</div></td>
                      <td className="font-mono">{fmt(r.base_salary)}</td>
                      <td className="font-mono" style={{ color: r.ot_amount>0?'var(--yellow)':'var(--text3)' }}>{r.ot_amount>0?fmt(r.ot_amount):'—'}</td>
                      <td className="font-mono" style={{ color: 'var(--red)', fontSize: 12 }}>{r.social_security_ded>0?`(${fmt(r.social_security_ded)})`:'—'}</td>
                      <td className="font-mono" style={{ color: 'var(--red)', fontSize: 12 }}>{r.leave_deduction>0?`(${fmt(r.leave_deduction)})`:'—'}</td>
                      <td className="font-mono" style={{ color: 'var(--red)', fontSize: 12 }}>{r.advance_deduction>0?`(${fmt(r.advance_deduction)})`:'—'}</td>
                      <td className="font-mono" style={{ color: 'var(--green)', fontWeight: 700, fontSize: 15 }}>{fmt(r.net_pay)}</td>
                      <td style={{ fontSize: 11 }}>{r.paid_date?new Date(r.paid_date).toLocaleDateString('th-TH'):'—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn btn-sm btn-ghost" onClick={() => { setEditSalary(r); setShowSalaryForm(true) }}>✏️</button>
                        <button className="btn btn-sm btn-danger" onClick={() => handleDeleteSalary(r.id)}>🗑️</button>
                      </td>
                    </tr>
                  ))}
                  {!(records||[]).length && (
                    <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>
                      ยังไม่มีข้อมูลเงินเดือน {MONTHS[month-1]} {year+543}
                    </td></tr>
                  )}
                </tbody>
                {(records||[]).length > 0 && (
                  <tfoot>
                    <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 700 }}>
                      <td style={{ color: 'var(--text3)', fontSize: 12 }}>รวม</td>
                      <td className="font-mono">{fmt(totalBase)}</td>
                      <td className="font-mono" style={{ color: 'var(--yellow)' }}>{fmt(totalOT)}</td>
                      <td className="font-mono" style={{ color: 'var(--red)' }}>{fmt(totalSSO)}</td>
                      <td colSpan={3} />
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
            onCancel={() => { setShowWorkerForm(false); setEditWorker(null) }} loading={savingWorker} />
        </Modal>
      )}

      {deleteWorkerId && (
        <ConfirmDialog title="ลบช่าง" message="ยืนยันการลบช่างคนนี้? ข้อมูล assignment ทั้งหมดจะถูกลบด้วย"
          onConfirm={handleDeleteWorker} onCancel={() => setDeleteWorkerId(null)} danger />
      )}

      {showSalaryForm && (
        <Modal title={editSalary?'แก้ไขเงินเดือน':`เพิ่มเงินเดือน — ${MONTHS[month-1]} ${year+543}`}
          onClose={() => { setShowSalaryForm(false); setEditSalary(null) }} maxWidth={600}>
          <SalaryForm initial={editSalary||EMPTY_SALARY} workers={workers}
            onSave={handleSaveSalary} onCancel={() => { setShowSalaryForm(false); setEditSalary(null) }} loading={savingSalary} />
        </Modal>
      )}

      {calcPreview && (
        <Modal title={`คำนวณจาก Assign — ${MONTHS[month-1]} ${year+543}`}
          onClose={() => setCalcPreview(null)} maxWidth={700}>
          <div className="modal-body">
            <div className="alert alert-info" style={{ marginBottom: 12 }}>ระบบจะ upsert salary_records ตามข้อมูล assignment</div>
            <div className="table-wrap" style={{ maxHeight: 320 }}>
              <table>
                <thead><tr><th>พนักงาน</th><th>เงินเดือน</th><th>วันลา</th><th>หักลา</th><th>OT ชม.</th><th>OT บาท</th><th>SSO</th><th>สุทธิ</th></tr></thead>
                <tbody>
                  {calcPreview.map((r,i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>{r.name}{r.nickname?` (${r.nickname})`:''}</td>
                      <td className="font-mono">{fmt(r.base_salary)}</td>
                      <td style={{ textAlign: 'center', color: r.leave_days>0?'var(--red)':'var(--text3)' }}>{r.leave_days||'—'}</td>
                      <td className="font-mono" style={{ color: 'var(--red)' }}>{r.leave_deduction>0?`(${fmt(r.leave_deduction)})`:'—'}</td>
                      <td style={{ textAlign: 'center', color: r.ot_hours>0?'var(--yellow)':'var(--text3)' }}>{r.ot_hours||'—'}</td>
                      <td className="font-mono" style={{ color: 'var(--yellow)' }}>{r.ot_amount>0?fmt(r.ot_amount):'—'}</td>
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
```

- [ ] **Step 3: Verify file created**
```bash
ls src/pages/HR.jsx
```

---

## Task 7: แก้ Assign.jsx — ลบ worker management ออก

**Files:** Modify `src/pages/Assign.jsx`

- [ ] **Step 1: อ่านไฟล์ Assign.jsx ทั้งหมด**

- [ ] **Step 2: ลบส่วนต่อไปนี้ออก**

ลบ:
1. `EMPTY_WORKER` constant และ `WorkerForm` function (บรรทัดประมาณ 17-88)
2. `showWorkerForm`, `editWorker`, `deleteWorkerId`, `saving` states
3. `handleSaveWorker` function
4. `handleDeleteWorker` function
5. ปุ่ม `+ เพิ่มช่าง` ใน toolbar
6. Worker table section (ส่วน `ข้อมูลช่าง / พนักงาน`)
7. Worker form modal
8. Delete worker confirm dialog
9. import `useWorkers` (ถ้าไม่ใช้แล้ว — ยังใช้แสดงใน matrix ให้เก็บไว้)

**หลังลบ toolbar ควรเหลือแค่:**
```jsx
<div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
  <button className="btn btn-ghost" onClick={() => setShowAssignForm(true)}>+ Assign งาน</button>
  <div style={{ flex: 1 }} />
  <select className="select select-sm" ...>{/* month */}</select>
  <select className="select select-sm" ...>{/* year */}</select>
</div>
```

- [ ] **Step 3: Build ตรวจสอบ**
```bash
npm run build 2>&1 | tail -3
```
Expected: `✓ built in X.XXs`

---

## Task 8: แก้ App.jsx

**Files:** Modify `src/App.jsx`

- [ ] **Step 1: อ่านไฟล์ App.jsx**

- [ ] **Step 2: แก้ imports + TABS + renderPage**

เพิ่ม import:
```js
import HR                from './pages/HR.jsx'
import LaborContractors  from './pages/LaborContractors.jsx'
```

ลบ import:
```js
import Payroll from './pages/Payroll.jsx'  // ลบออก (ย้ายไป HR แล้ว)
```

แก้ TABS:
```js
const TABS = [
  { id: 'dashboard',         label: '📊 ภาพรวม' },
  { id: 'sites',             label: '🏗️ ไซท์งาน' },
  { id: 'assign',            label: '📋 Assign ช่าง' },
  { id: 'expenses',          label: '💸 รายจ่าย' },
  { id: 'income',            label: '💰 รายรับ' },
  { id: 'hr',                label: '👷 HR' },
  { id: 'categories',        label: '🏷️ หมวดหมู่' },
  { id: 'clients',           label: '🏢 ลูกค้า' },
  { id: 'suppliers',         label: '🏭 Supplier' },
  { id: 'labor_contractors', label: '🔧 ผู้รับเหมาค่าแรง' },
]
```

แก้ renderPage switch:
```js
case 'hr':                return <HR               {...props} />
case 'labor_contractors': return <LaborContractors {...props} />
// ลบ case 'payroll' ออก
```

- [ ] **Step 3: Build verify**
```bash
npm run build 2>&1 | tail -3
```
Expected: `✓ built in X.XXs` (จะ error ถ้า LaborContractors.jsx ยังไม่มี — สร้าง placeholder ก่อน)

- [ ] **Step 4: สร้าง placeholder LaborContractors.jsx (ถ้ายังไม่มี)**

```jsx
// src/pages/LaborContractors.jsx — placeholder ก่อน Phase 2
export default function LaborContractors() {
  return <div style={{ padding: 24, color: 'var(--text3)' }}>ผู้รับเหมาค่าแรง — coming in Phase 2</div>
}
```

---

## Task 9: Commit Phase 1

- [ ] **Step 1: Build final**
```bash
npm run build 2>&1 | tail -3
```

- [ ] **Step 2: Commit**
```bash
git add -A
git commit -m "feat: HR tab (worker mgmt + payroll + audit), audit_logs table, utilities"
git push
```

---

## Verification Checklist

- [ ] Tab bar แสดง: Dashboard, ไซท์งาน, Assign ช่าง, รายจ่าย, รายรับ, **HR**, หมวดหมู่, ลูกค้า, Supplier, **ผู้รับเหมาค่าแรง**
- [ ] HR tab → inner tab "ข้อมูลช่าง" แสดงรายชื่อช่างทั้งหมด + เพิ่ม/แก้/ลบได้
- [ ] HR tab → inner tab "เงินเดือน" ทำงานได้ + คำนวณจาก Assign ได้
- [ ] HR tab → inner tab "ประวัติการแก้ไข" แสดง logs
- [ ] Assign tab ไม่มีปุ่ม "+ เพิ่มช่าง" แล้ว
- [ ] audit_logs ถูกเขียนเมื่อ save worker / salary
