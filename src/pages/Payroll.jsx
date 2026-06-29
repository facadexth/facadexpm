// ============================================================
// Payroll — เงินเดือน
// ✅ field ตรงกับ salary_records DB schema
// ✅ ปุ่ม "คำนวณจาก Assign" — auto-fill leave_deduction + ot_amount
// ✅ KPIs: เงินเดือนรวม, OT, ประกันสังคม, จ่ายสุทธิ
// ============================================================
import { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { useSalary, useWorkers } from '../hooks/useSupabase.js'
import { fmt } from '../lib/supabase.js'
import { Modal } from '../components/Modal.jsx'

const MONTHS = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.']

const EMPTY_FORM = {
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

function SalaryForm({ initial = EMPTY_FORM, workers, onSave, onCancel, loading }) {
  const [form, setForm] = useState({ ...EMPTY_FORM, ...initial })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const prefill = (w) => {
    set('worker_id', w.id)
    if (!initial.base_salary) {
      set('base_salary', w.monthly_salary || '')
      set('contribution', w.monthly_contribution || '')
      if (w.has_social_security) set('social_security_ded', Math.min(750, (w.monthly_salary||0) * 0.05).toFixed(2))
    }
  }

  const netCalc = calcNet(form)

  return (
    <form onSubmit={e => { e.preventDefault(); onSave({ ...form, net_pay: form.net_pay || netCalc }) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 14 }}>
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

        {/* รายรับ */}
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 1 }}>รายรับ</div>
        <div className="form-grid-3">
          <div>
            <label className="label">เงินเดือน</label>
            <input type="number" className="input" min="0" step="0.01" value={form.base_salary} onChange={e => set('base_salary', e.target.value)} />
          </div>
          <div>
            <label className="label">สมทบนายจ้าง</label>
            <input type="number" className="input" min="0" step="0.01" value={form.contribution} onChange={e => set('contribution', e.target.value)} />
          </div>
          <div>
            <label className="label">ค่าโทรศัพท์</label>
            <input type="number" className="input" min="0" step="0.01" value={form.phone_allowance} onChange={e => set('phone_allowance', e.target.value)} />
          </div>
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label">OT</label>
            <input type="number" className="input" min="0" step="0.01" value={form.ot_amount} onChange={e => set('ot_amount', e.target.value)} />
          </div>
          <div>
            <label className="label">เงินพิเศษ / ค่าจอดรถ</label>
            <input type="number" className="input" min="0" step="0.01" value={form.special_allowance} onChange={e => set('special_allowance', e.target.value)} />
          </div>
        </div>

        {/* รายหัก */}
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 1 }}>รายหัก</div>
        <div className="form-grid-2">
          <div>
            <label className="label">ประกันสังคม</label>
            <input type="number" className="input" min="0" step="0.01" value={form.social_security_ded} onChange={e => set('social_security_ded', e.target.value)} />
          </div>
          <div>
            <label className="label">หักวันลา</label>
            <input type="number" className="input" min="0" step="0.01" value={form.leave_deduction} onChange={e => set('leave_deduction', e.target.value)} />
          </div>
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label">เบิกล่วงหน้า</label>
            <input type="number" className="input" min="0" step="0.01" value={form.advance_deduction} onChange={e => set('advance_deduction', e.target.value)} />
          </div>
          <div>
            <label className="label">กยศ / เงินกู้</label>
            <input type="number" className="input" min="0" step="0.01" value={form.loan_deduction} onChange={e => set('loan_deduction', e.target.value)} />
          </div>
        </div>

        {/* Net */}
        <div style={{ background: 'rgba(0,212,170,0.08)', borderRadius: 8, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--text2)', fontSize: 13 }}>รับสุทธิ (คำนวณ):</span>
          <strong style={{ color: 'var(--green)', fontSize: 20 }}>{fmt(netCalc)} บาท</strong>
          <div style={{ flex: 1 }} />
          <div>
            <label className="label" style={{ marginBottom: 2 }}>หรือระบุเอง</label>
            <input type="number" className="input input-sm" min="0" step="0.01" value={form.net_pay}
              onChange={e => set('net_pay', e.target.value)} style={{ width: 130 }} placeholder="(auto)" />
          </div>
        </div>

        <div className="form-grid-2">
          <div>
            <label className="label">วันที่จ่าย</label>
            <input type="date" className="input" value={form.paid_date} onChange={e => set('paid_date', e.target.value)} />
          </div>
          <div>
            <label className="label">หมายเหตุ</label>
            <input className="input" value={form.notes} onChange={e => set('notes', e.target.value)} />
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

export default function Payroll() {
  const now = new Date()
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [year,  setYear]  = useState(now.getFullYear())
  const [showForm,  setShowForm]  = useState(false)
  const [editRow,   setEditRow]   = useState(null)
  const [saving,    setSaving]    = useState(false)
  const [calcLoading, setCalcLoading] = useState(false)
  const [calcPreview, setCalcPreview] = useState(null) // modal preview

  const { data: records, refetch } = useSalary(month, year)
  const { data: workers } = useWorkers()

  const totalBase = useMemo(() => (records||[]).reduce((s,r) => s+(r.base_salary||0), 0), [records])
  const totalNet  = useMemo(() => (records||[]).reduce((s,r) => s+(r.net_pay||0), 0), [records])
  const totalOT   = useMemo(() => (records||[]).reduce((s,r) => s+(r.ot_amount||0), 0), [records])
  const totalSSO  = useMemo(() => (records||[]).reduce((s,r) => s+(r.social_security_ded||0), 0), [records])

  const handleSave = async (form) => {
    setSaving(true)
    try {
      const payload = {
        worker_id:          form.worker_id,
        month, year,
        base_salary:        parseFloat(form.base_salary) || 0,
        contribution:       parseFloat(form.contribution) || 0,
        phone_allowance:    parseFloat(form.phone_allowance) || 0,
        ot_amount:          parseFloat(form.ot_amount) || 0,
        special_allowance:  parseFloat(form.special_allowance) || 0,
        social_security_ded:parseFloat(form.social_security_ded) || 0,
        advance_deduction:  parseFloat(form.advance_deduction) || 0,
        loan_deduction:     parseFloat(form.loan_deduction) || 0,
        leave_deduction:    parseFloat(form.leave_deduction) || 0,
        net_pay:            parseFloat(form.net_pay) || calcNet(form),
        paid_date:          form.paid_date || null,
        notes:              form.notes || null,
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

  // ── คำนวณจาก Assign ──────────────────────────────────────────
  const handleCalcFromAssign = async () => {
    setCalcLoading(true)
    try {
      const from = `${year}-${String(month).padStart(2,'0')}-01`
      const to   = new Date(year, month, 0).toISOString().slice(0,10)

      const { data: assigns, error } = await supabase
        .from('worker_assignments')
        .select('worker_id, type, ot_hours, workers(id, name, nickname, monthly_salary, monthly_contribution, has_social_security)')
        .gte('date', from)
        .lte('date', to)
      if (error) throw error

      // Group by worker
      const wmap = {}
      ;(assigns || []).forEach(a => {
        const w = a.workers
        if (!w) return
        if (!wmap[a.worker_id]) wmap[a.worker_id] = { worker: w, leave: 0, ot_hours: 0 }
        if (a.type === 'leave')  wmap[a.worker_id].leave++
        if (a.type === 'site')   wmap[a.worker_id].ot_hours += (a.ot_hours || 0)
      })

      const results = Object.entries(wmap).map(([worker_id, d]) => {
        const daily_rate     = (d.worker.monthly_salary || 0) / 26
        const leave_ded      = parseFloat((d.leave * daily_rate).toFixed(2))
        const ot_amt         = parseFloat((d.ot_hours * daily_rate / 8 * 1.5).toFixed(2))
        const sso            = d.worker.has_social_security
          ? parseFloat(Math.min(750, (d.worker.monthly_salary||0) * 0.05).toFixed(2)) : 0
        const net = parseFloat((
          (d.worker.monthly_salary||0)
          - sso - leave_ded + ot_amt
        ).toFixed(2))
        return {
          worker_id,
          name:            d.worker.name,
          nickname:        d.worker.nickname,
          base_salary:     d.worker.monthly_salary || 0,
          contribution:    d.worker.monthly_contribution || 0,
          social_security_ded: sso,
          leave_days:      d.leave,
          leave_deduction: leave_ded,
          ot_hours:        d.ot_hours,
          ot_amount:       ot_amt,
          net_pay:         net,
        }
      })

      if (!results.length) {
        alert('ไม่พบข้อมูล assignment ในเดือนนี้ กรุณา Assign ช่างก่อน')
        return
      }
      setCalcPreview(results)
    } catch (e) { alert('Error: ' + e.message) }
    finally { setCalcLoading(false) }
  }

  const handleConfirmCalc = async () => {
    if (!calcPreview?.length) return
    setSaving(true)
    try {
      for (const r of calcPreview) {
        const payload = {
          worker_id:           r.worker_id,
          month, year,
          base_salary:         r.base_salary,
          contribution:        r.contribution,
          ot_amount:           r.ot_amount,
          social_security_ded: r.social_security_ded,
          leave_deduction:     r.leave_deduction,
          net_pay:             r.net_pay,
        }
        await supabase.from('salary_records')
          .upsert(payload, { onConflict: 'worker_id,month,year' })
      }
      setCalcPreview(null)
      refetch()
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSaving(false) }
  }

  return (
    <div>
      {/* ── Toolbar ── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn btn-primary" onClick={() => { setEditRow(null); setShowForm(true) }}>+ เพิ่มรายการ</button>
        <button className="btn btn-ghost" onClick={handleCalcFromAssign} disabled={calcLoading}>
          {calcLoading ? '⏳...' : '🔄 คำนวณจาก Assign'}
        </button>
        <div style={{ flex: 1 }} />
        <select className="select select-sm" value={month} onChange={e => setMonth(parseInt(e.target.value))}>
          {MONTHS.map((m, i) => <option key={i+1} value={i+1}>{m}</option>)}
        </select>
        <select className="select select-sm" value={year} onChange={e => setYear(parseInt(e.target.value))}>
          {[2024,2025,2026,2027].map(y => <option key={y}>{y}</option>)}
        </select>
        <span style={{ color: 'var(--text3)', fontSize: 12 }}>{(records||[]).length} คน</span>
      </div>

      {/* ── KPIs ── */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div className="kpi-card kpi-sm"><div className="kpi-label">เงินเดือนรวม</div><div className="kpi-value">{fmt(totalBase)}</div></div>
        <div className="kpi-card kpi-sm" style={{ '--accent': 'var(--yellow)' }}><div className="kpi-label">OT รวม</div><div className="kpi-value" style={{ color: 'var(--yellow)' }}>{fmt(totalOT)}</div></div>
        <div className="kpi-card kpi-sm"><div className="kpi-label">ประกันสังคม</div><div className="kpi-value">{fmt(totalSSO)}</div></div>
        <div className="kpi-card kpi-sm green"><div className="kpi-label">จ่ายสุทธิรวม</div><div className="kpi-value" style={{ color: 'var(--green)' }}>{fmt(totalNet)}</div></div>
      </div>

      {/* ── Table ── */}
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>พนักงาน</th>
                <th>เงินเดือน</th><th>สมทบ</th><th>โทรศัพท์</th>
                <th>OT</th><th>เงินพิเศษ</th>
                <th>ประกันสังคม</th><th>หักลา</th><th>เบิกล่วงหน้า</th><th>กยศ</th>
                <th>จ่ายสุทธิ</th><th>วันจ่าย</th><th></th>
              </tr>
            </thead>
            <tbody>
              {(records||[]).map(r => (
                <tr key={r.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{r.workers?.name || '—'}</div>
                    <div style={{ fontSize: 11, color: 'var(--text3)' }}>{r.workers?.position}</div>
                  </td>
                  <td className="font-mono">{fmt(r.base_salary)}</td>
                  <td className="font-mono" style={{ color: 'var(--text3)', fontSize: 12 }}>{r.contribution > 0 ? fmt(r.contribution) : '—'}</td>
                  <td className="font-mono" style={{ fontSize: 12 }}>{r.phone_allowance > 0 ? fmt(r.phone_allowance) : '—'}</td>
                  <td className="font-mono" style={{ color: r.ot_amount > 0 ? 'var(--yellow)' : 'var(--text3)' }}>{r.ot_amount > 0 ? fmt(r.ot_amount) : '—'}</td>
                  <td className="font-mono" style={{ fontSize: 12 }}>{r.special_allowance > 0 ? fmt(r.special_allowance) : '—'}</td>
                  <td className="font-mono" style={{ color: 'var(--red)', fontSize: 12 }}>{r.social_security_ded > 0 ? `(${fmt(r.social_security_ded)})` : '—'}</td>
                  <td className="font-mono" style={{ color: 'var(--red)', fontSize: 12 }}>{r.leave_deduction > 0 ? `(${fmt(r.leave_deduction)})` : '—'}</td>
                  <td className="font-mono" style={{ color: 'var(--red)', fontSize: 12 }}>{r.advance_deduction > 0 ? `(${fmt(r.advance_deduction)})` : '—'}</td>
                  <td className="font-mono" style={{ color: 'var(--red)', fontSize: 12 }}>{r.loan_deduction > 0 ? `(${fmt(r.loan_deduction)})` : '—'}</td>
                  <td className="font-mono" style={{ color: 'var(--green)', fontWeight: 700, fontSize: 15 }}>{fmt(r.net_pay)}</td>
                  <td style={{ fontSize: 11, color: 'var(--text3)' }}>{r.paid_date ? new Date(r.paid_date).toLocaleDateString('th-TH') : '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm btn-ghost" onClick={() => { setEditRow(r); setShowForm(true) }}>✏️</button>
                    <button className="btn btn-sm btn-danger" onClick={() => handleDelete(r.id)}>🗑️</button>
                  </td>
                </tr>
              ))}
              {!(records||[]).length && (
                <tr><td colSpan={13} style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>
                  ยังไม่มีข้อมูลเงินเดือน {MONTHS[month-1]} {year+543} — กด "คำนวณจาก Assign" เพื่อสร้างอัตโนมัติ
                </td></tr>
              )}
            </tbody>
            {(records||[]).length > 0 && (
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 700 }}>
                  <td style={{ color: 'var(--text3)', fontSize: 12 }}>รวม</td>
                  <td className="font-mono">{fmt(totalBase)}</td>
                  <td /><td />
                  <td className="font-mono" style={{ color: 'var(--yellow)' }}>{fmt(totalOT)}</td>
                  <td /><td className="font-mono" style={{ color: 'var(--red)' }}>{fmt(totalSSO)}</td>
                  <td /><td /><td />
                  <td className="font-mono" style={{ color: 'var(--green)' }}>{fmt(totalNet)}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* ── Calc Preview Modal ── */}
      {calcPreview && (
        <Modal title={`คำนวณจาก Assign — ${MONTHS[month-1]} ${year+543} (${calcPreview.length} คน)`}
          onClose={() => setCalcPreview(null)} maxWidth={760}>
          <div className="modal-body">
            <div className="alert alert-info" style={{ marginBottom: 12 }}>
              ระบบจะ upsert salary_records — ถ้ามีข้อมูลอยู่แล้วจะอัพเดตเฉพาะ OT และหักวันลา
            </div>
            <div className="table-wrap" style={{ maxHeight: 360 }}>
              <table>
                <thead>
                  <tr>
                    <th>พนักงาน</th><th>เงินเดือน</th>
                    <th>วันลา</th><th>หักลา</th>
                    <th>OT (ชม.)</th><th>OT (บาท)</th>
                    <th>ประกันสังคม</th><th>รับสุทธิ</th>
                  </tr>
                </thead>
                <tbody>
                  {calcPreview.map((r, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>{r.name}{r.nickname ? ` (${r.nickname})` : ''}</td>
                      <td className="font-mono">{fmt(r.base_salary)}</td>
                      <td style={{ textAlign: 'center', color: r.leave_days > 0 ? 'var(--red)' : 'var(--text3)' }}>{r.leave_days || '—'}</td>
                      <td className="font-mono" style={{ color: 'var(--red)' }}>{r.leave_deduction > 0 ? `(${fmt(r.leave_deduction)})` : '—'}</td>
                      <td style={{ textAlign: 'center', color: r.ot_hours > 0 ? 'var(--yellow)' : 'var(--text3)' }}>{r.ot_hours || '—'}</td>
                      <td className="font-mono" style={{ color: 'var(--yellow)' }}>{r.ot_amount > 0 ? fmt(r.ot_amount) : '—'}</td>
                      <td className="font-mono" style={{ color: 'var(--red)', fontSize: 12 }}>{r.social_security_ded > 0 ? `(${fmt(r.social_security_ded)})` : '—'}</td>
                      <td className="font-mono" style={{ color: 'var(--green)', fontWeight: 700 }}>{fmt(r.net_pay)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-ghost" onClick={() => setCalcPreview(null)}>ยกเลิก</button>
            <button className="btn btn-success" onClick={handleConfirmCalc} disabled={saving}>
              {saving ? '⏳ กำลังบันทึก...' : `✅ ยืนยัน upsert ${calcPreview.length} รายการ`}
            </button>
          </div>
        </Modal>
      )}

      {/* ── Form Modal ── */}
      {showForm && (
        <Modal title={editRow ? 'แก้ไขเงินเดือน' : `เพิ่มเงินเดือน — ${MONTHS[month-1]} ${year+543}`}
          onClose={() => { setShowForm(false); setEditRow(null) }} maxWidth={600}>
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
