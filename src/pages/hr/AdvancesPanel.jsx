// src/pages/hr/AdvancesPanel.jsx
// เบิกล่วงหน้า: request -> owner approves -> deducted in installments by payroll.
// Balances count only closed months (what was actually paid).
import { useState } from 'react'
import { useUserRole } from '../../hooks/useUserRole.js'
import { useAdvances } from '../../hooks/usePayroll.js'
import { useAllActiveWorkers } from '../../hooks/useSupabase.js'
import { requestAdvance, approveAdvance, rejectAdvance } from '../../lib/payroll/load.js'
import { MONTHS_TH } from '../../lib/payroll/period.js'
import { fmt } from '../../lib/supabase.js'

const STATUS = {
  pending: ['รออนุมัติ', '#9a5b00'], approved: ['กำลังผ่อน', '#1f5fa8'],
  rejected: ['ไม่อนุมัติ', '#a33a2b'], settled: ['หักครบแล้ว', '#1f6b55'],
}

export default function AdvancesPanel({ canEdit }) {
  const { isAtLeast, user } = useUserRole()
  const isOwner = isAtLeast('OWNER')
  const { data: advances, refetch, loading, error } = useAdvances()
  const { data: workers } = useAllActiveWorkers()
  const now = new Date()
  const myEmail = (user?.email || '').toLowerCase()
  const ownWorker = (workers || []).find(w => w.email && w.email.toLowerCase() === myEmail)
  const [form, setForm] = useState({ worker_id: '', title: 'เบิกล่วงหน้า', amount: '', installments: 1, start: `${now.getFullYear()}-${now.getMonth() + 1}` })
  const [busy, setBusy] = useState(false)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const amount = Number(form.amount) || 0
  const installments = Number(form.installments) || 1
  const per = Math.round(amount / installments * 100) / 100
  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1)
    return { v: `${d.getFullYear()}-${d.getMonth() + 1}`, l: `${MONTHS_TH[d.getMonth()]} ${d.getFullYear() + 543}` }
  })

  const submit = async e => {
    e.preventDefault()
    const worker_id = canEdit ? form.worker_id : ownWorker?.id
    if (!worker_id) { alert('เลือกพนักงาน'); return }
    if (!(amount > 0)) { alert('ใส่จำนวนเงินมากกว่า 0'); return }
    if (!Number.isInteger(installments) || installments < 1 || installments > 60) { alert('จำนวนงวดต้องอยู่ระหว่าง 1-60'); return }
    const [start_year, start_month] = form.start.split('-').map(Number)
    setBusy(true)
    try {
      // status / requested_by / approved_by / tenant_id come from DB defaults + RLS
      await requestAdvance({ worker_id, title: form.title.trim() || 'เบิกล่วงหน้า', amount, installments, start_year, start_month })
      setForm(f => ({ ...f, amount: '' }))
      refetch()
    } catch (err) { alert('ส่งคำขอไม่สำเร็จ: ' + err.message) }
    finally { setBusy(false) }
  }
  const act = async fn => {
    setBusy(true)
    try { await fn(); refetch() } catch (e) { alert('ทำรายการไม่สำเร็จ: ' + e.message) } finally { setBusy(false) }
  }
  const onReject = a => { const r = prompt('เหตุผลที่ไม่อนุมัติ'); if (r !== null) act(() => rejectAdvance(a.id, r)) }

  return (
    <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', alignItems: 'start' }}>
      <form className="card card-body" onSubmit={submit} style={{ display: 'grid', gap: 10 }}>
        <div className="card-title">ขอเบิกเงินล่วงหน้า</div>
        {canEdit && (
          <select className="input" value={form.worker_id} onChange={e => set('worker_id', e.target.value)}>
            <option value="">— เลือกพนักงาน —</option>
            {(workers || []).map(w => <option key={w.id} value={w.id}>{w.name}{w.nickname ? ` (${w.nickname})` : ''}</option>)}
          </select>
        )}
        {!canEdit && !ownWorker && <div style={{ color: 'var(--red)' }}>บัญชีนี้ยังไม่ได้ผูกกับพนักงาน ติดต่อแอดมิน</div>}
        <input className="input" value={form.title} onChange={e => set('title', e.target.value)} placeholder="เบิกเรื่องอะไร" />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <input className="input" type="number" min="1" value={form.amount} onChange={e => set('amount', e.target.value)} placeholder="จำนวนเงิน" />
          <select className="input" value={form.installments} onChange={e => set('installments', Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6, 10, 12].map(n => <option key={n} value={n}>ผ่อน {n} เดือน</option>)}
          </select>
        </div>
        <select className="input" value={form.start} onChange={e => set('start', e.target.value)}>
          {months.map(m => <option key={m.v} value={m.v}>เริ่มหัก {m.l}</option>)}
        </select>
        {amount > 0 && <div style={{ fontSize: 13 }}>หักเดือนละ <b>{fmt(per)}</b> บาท × {installments} เดือน</div>}
        <button className="btn btn-primary" disabled={busy}>ส่งคำขอ</button>
      </form>

      <div className="card card-body">
        <div className="card-title">รายการเบิก</div>
        {loading && <div>⏳</div>}
        {error && <div style={{ color: 'var(--red)' }}>โหลดรายการไม่สำเร็จ: {String(error)}</div>}
        {(advances || []).map(a => {
          const st = STATUS[a.status] || [a.status, 'var(--text3)']
          return (
            <div key={a.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)', display: 'grid', gap: 4 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <span>{a.workers?.nickname || a.workers?.name} · {a.title} · {fmt(a.amount)} ({a.installments} งวด)</span>
                <span style={{ fontWeight: 700, color: st[1] }}>{st[0]}</span>
              </div>
              {['approved', 'settled'].includes(a.status) && (
                <div style={{ fontSize: 13, color: 'var(--text3)' }}>
                  หักแล้ว (เดือนที่ปิดงวด) {a.paidInstallments}/{a.installments} งวด · {fmt(a.deducted)} · คงเหลือ {fmt(Math.max(0, a.remaining))}
                </div>
              )}
              {a.status === 'rejected' && a.reject_reason && <div style={{ fontSize: 13 }}>เหตุผล: {a.reject_reason}</div>}
              {a.status === 'pending' && isOwner && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act(() => approveAdvance(a.id))}>อนุมัติ</button>
                  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onReject(a)}>ไม่อนุมัติ</button>
                </div>
              )}
            </div>
          )
        })}
        {!loading && !error && !(advances || []).length && <div style={{ color: 'var(--text3)' }}>ยังไม่มีรายการเบิก</div>}
      </div>
    </div>
  )
}
