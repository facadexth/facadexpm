// ============================================================
// Payroll — เงินเดือน
// ✅ เลือกเดือน/ปี → แสดงสรุปเงินเดือนพนักงาน
// ✅ Add/Edit salary record (เงินเดือน, OT, หัก, รับสุทธิ, หมายเหตุ)
// ✅ Summary KPIs: เงินเดือนรวม, OT รวม, ประกันสังคมรวม
// ============================================================
import { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { useSalary, useWorkers } from '../hooks/useSupabase.js'
import { fmt } from '../lib/supabase.js'
import { Modal } from '../components/Modal.jsx'

const EMPTY_FORM = {
  worker_id: '', base_salary: '', ot_amount: '', bonus: '',
  deduction_sso: '', deduction_other: '', net_salary: '', notes: ''
}

function calcNet(form) {
  const base = parseFloat(form.base_salary) || 0
  const ot   = parseFloat(form.ot_amount) || 0
  const bon  = parseFloat(form.bonus) || 0
  const sso  = parseFloat(form.deduction_sso) || 0
  const ded  = parseFloat(form.deduction_other) || 0
  return base + ot + bon - sso - ded
}

function SalaryForm({ initial, workers, onSave, onCancel, loading }) {
  const [form, setForm] = useState({ ...EMPTY_FORM, ...initial })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  // ถ้าเลือกช่างแล้ว ดึงเงินเดือนตั้งต้นมา
  const selectedWorker = (workers || []).find(w => w.id === form.worker_id)
  const netCalc = form.net_salary || calcNet(form)

  const prefill = (w) => {
    set('worker_id', w.id)
    if (!form.base_salary) set('base_salary', w.monthly_salary)
    if (!form.deduction_sso && w.sso_registered) set('deduction_sso', Math.min(750, w.monthly_salary * 0.05))
  }

  return (
    <form onSubmit={e => { e.preventDefault(); onSave({ ...form, net_salary: form.net_salary || calcNet(form) }) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div>
          <label className="label">ช่าง / พนักงาน ★</label>
          <select className="select" required value={form.worker_id} onChange={e => {
            const w = (workers||[]).find(x => x.id === e.target.value)
            if (w) prefill(w); else set('worker_id', e.target.value)
          }}>
            <option value="">— เลือก —</option>
            {(workers || []).map(w => <option key={w.id} value={w.id}>{w.name} ({w.nickname || w.position})</option>)}
          </select>
        </div>
        <div className="form-grid-3">
          <div>
            <label className="label">เงินเดือนฐาน</label>
            <input type="number" className="input" min="0" step="0.01" value={form.base_salary} onChange={e => set('base_salary', e.target.value)} />
          </div>
          <div>
            <label className="label">OT</label>
            <input type="number" className="input" min="0" step="0.01" value={form.ot_amount} onChange={e => set('ot_amount', e.target.value)} />
          </div>
          <div>
            <label className="label">โบนัส / เบี้ยเลี้ยง</label>
            <input type="number" className="input" min="0" step="0.01" value={form.bonus} onChange={e => set('bonus', e.target.value)} />
          </div>
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label">หัก ประกันสังคม</label>
            <input type="number" className="input" min="0" step="0.01" value={form.deduction_sso} onChange={e => set('deduction_sso', e.target.value)} />
          </div>
          <div>
            <label className="label">หัก อื่นๆ</label>
            <input type="number" className="input" min="0" step="0.01" value={form.deduction_other} onChange={e => set('deduction_other', e.target.value)} />
          </div>
        </div>
        <div style={{ background: 'rgba(0,212,170,0.08)', borderRadius: 8, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: 'var(--text2)', fontSize: 13 }}>รับสุทธิ (คำนวณ):</span>
          <strong style={{ color: 'var(--green)', fontSize: 18 }}>{fmt(calcNet(form))} บาท</strong>
          <div style={{ flex: 1 }} />
          <div>
            <label className="label" style={{ marginBottom: 2 }}>หรือระบุเอง</label>
            <input type="number" className="input input-sm" min="0" step="0.01" value={form.net_salary}
              onChange={e => set('net_salary', e.target.value)} style={{ width: 130 }} placeholder="(ปล่อยว่าง = auto)" />
          </div>
        </div>
        <div>
          <label className="label">หมายเหตุ</label>
          <input className="input" value={form.notes} onChange={e => set('notes', e.target.value)} />
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? '⏳...' : '✅ บันทึก'}</button>
      </div>
    </form>
  )
}

export default function Payroll() {
  const now = new Date()
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [year,  setYear]  = useState(now.getFullYear())
  const [showForm, setShowForm] = useState(false)
  const [editRow,  setEditRow]  = useState(null)
  const [saving,   setSaving]   = useState(false)

  const { data: records, refetch } = useSalary(month, year)
  const { data: workers } = useWorkers()

  const totalBase = useMemo(() => (records||[]).reduce((s, r) => s + (r.base_salary||0), 0), [records])
  const totalNet  = useMemo(() => (records||[]).reduce((s, r) => s + (r.net_salary||0), 0), [records])
  const totalOT   = useMemo(() => (records||[]).reduce((s, r) => s + (r.ot_amount||0), 0), [records])
  const totalSSO  = useMemo(() => (records||[]).reduce((s, r) => s + (r.deduction_sso||0), 0), [records])

  const handleSave = async (form) => {
    setSaving(true)
    try {
      const payload = {
        worker_id:       form.worker_id,
        month, year,
        base_salary:     parseFloat(form.base_salary) || 0,
        ot_amount:       parseFloat(form.ot_amount) || 0,
        bonus:           parseFloat(form.bonus) || 0,
        deduction_sso:   parseFloat(form.deduction_sso) || 0,
        deduction_other: parseFloat(form.deduction_other) || 0,
        net_salary:      parseFloat(form.net_salary) || calcNet(form),
        notes:           form.notes || null,
      }
      if (editRow) {
        const { error } = await supabase.from('salary_records').update(payload).eq('id', editRow.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('salary_records').insert(payload)
        if (error) throw error
      }
      setShowForm(false); setEditRow(null); refetch()
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSaving(false) }
  }

  const handleDelete = async (id) => {
    if (!window.confirm('ลบรายการเงินเดือนนี้?')) return
    await supabase.from('salary_records').delete().eq('id', id)
    refetch()
  }

  function calcNet(form) {
    return (parseFloat(form.base_salary)||0) + (parseFloat(form.ot_amount)||0) + (parseFloat(form.bonus)||0)
         - (parseFloat(form.deduction_sso)||0) - (parseFloat(form.deduction_other)||0)
  }

  const MONTHS = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.']

  return (
    <div>
      {/* ── Month selector ── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn btn-primary" onClick={() => { setEditRow(null); setShowForm(true) }}>+ เพิ่มรายการเงินเดือน</button>
        <div style={{ flex: 1 }} />
        <select className="select select-sm" value={month} onChange={e => setMonth(parseInt(e.target.value))}>
          {MONTHS.map((m, i) => <option key={i+1} value={i+1}>{m}</option>)}
        </select>
        <select className="select select-sm" value={year} onChange={e => setYear(parseInt(e.target.value))}>
          {[2024,2025,2026,2027].map(y => <option key={y}>{y}</option>)}
        </select>
        <span style={{ color: 'var(--text3)', fontSize: 12 }}>รายการ: {(records||[]).length} คน</span>
      </div>

      {/* ── KPI ── */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div className="kpi-card kpi-sm"><div className="kpi-label">เงินเดือนฐาน</div><div className="kpi-value">{fmt(totalBase)}</div></div>
        <div className="kpi-card kpi-sm yellow"><div className="kpi-label">OT รวม</div><div className="kpi-value" style={{color:'var(--yellow)'}}>{fmt(totalOT)}</div></div>
        <div className="kpi-card kpi-sm"><div className="kpi-label">ประกันสังคม</div><div className="kpi-value">{fmt(totalSSO)}</div></div>
        <div className="kpi-card kpi-sm green"><div className="kpi-label">จ่ายสุทธิรวม</div><div className="kpi-value" style={{color:'var(--green)'}}>{fmt(totalNet)}</div></div>
      </div>

      {/* ── Table ── */}
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>พนักงาน</th><th>ตำแหน่ง</th>
                <th>เงินเดือนฐาน</th><th>OT</th><th>โบนัส</th>
                <th>หัก SSO</th><th>หัก อื่น</th>
                <th>รับสุทธิ</th><th>หมายเหตุ</th><th></th>
              </tr>
            </thead>
            <tbody>
              {(records || []).map(r => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 600 }}>{r.workers?.name || '—'}</td>
                  <td style={{ color: 'var(--text3)', fontSize: 12 }}>{r.workers?.position || '—'}</td>
                  <td className="font-mono">{fmt(r.base_salary)}</td>
                  <td className="font-mono" style={{ color: r.ot_amount > 0 ? 'var(--yellow)' : 'var(--text3)' }}>{r.ot_amount > 0 ? fmt(r.ot_amount) : '—'}</td>
                  <td className="font-mono" style={{ color: r.bonus > 0 ? 'var(--blue)' : 'var(--text3)' }}>{r.bonus > 0 ? fmt(r.bonus) : '—'}</td>
                  <td className="font-mono" style={{ color: 'var(--red)', fontSize: 12 }}>{r.deduction_sso > 0 ? `(${fmt(r.deduction_sso)})` : '—'}</td>
                  <td className="font-mono" style={{ color: 'var(--red)', fontSize: 12 }}>{r.deduction_other > 0 ? `(${fmt(r.deduction_other)})` : '—'}</td>
                  <td className="font-mono" style={{ color: 'var(--green)', fontWeight: 700, fontSize: 15 }}>{fmt(r.net_salary)}</td>
                  <td style={{ color: 'var(--text3)', fontSize: 11 }}>{r.notes || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm btn-ghost" onClick={() => { setEditRow(r); setShowForm(true) }}>✏️</button>
                    <button className="btn btn-sm btn-danger" onClick={() => handleDelete(r.id)}>🗑️</button>
                  </td>
                </tr>
              ))}
              {!(records||[]).length && (
                <tr><td colSpan={10} style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>ยังไม่มีข้อมูลเงินเดือน {MONTHS[month-1]} {year + 543}</td></tr>
              )}
            </tbody>
            {(records||[]).length > 0 && (
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 700 }}>
                  <td colSpan={2} style={{ color: 'var(--text3)', fontSize: 12 }}>รวม</td>
                  <td className="font-mono">{fmt(totalBase)}</td>
                  <td className="font-mono" style={{ color: 'var(--yellow)' }}>{fmt(totalOT)}</td>
                  <td />
                  <td className="font-mono" style={{ color: 'var(--red)' }}>{fmt(totalSSO)}</td>
                  <td />
                  <td className="font-mono" style={{ color: 'var(--green)' }}>{fmt(totalNet)}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* ── Form Modal ── */}
      {showForm && (
        <Modal title={editRow ? 'แก้ไขเงินเดือน' : `เพิ่มเงินเดือน — ${MONTHS[month-1]} ${year+543}`} onClose={() => { setShowForm(false); setEditRow(null) }} maxWidth={580}>
          <SalaryForm
            initial={editRow || EMPTY_FORM}
            workers={workers}
            onSave={handleSave}
            onCancel={() => { setShowForm(false); setEditRow(null) }}
            loading={saving}
          />
        </Modal>
      )}
    </div>
  )
}
