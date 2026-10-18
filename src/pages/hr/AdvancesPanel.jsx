// src/pages/hr/AdvancesPanel.jsx
// เบิกล่วงหน้า: request -> owner approves -> deducted in installments by payroll.
// Balances count only closed months (what was actually paid).
import { useState, useEffect, useMemo } from 'react'
import { useUserRole } from '../../hooks/useUserRole.js'
import { useAdvances, usePayrollPeriodStatuses } from '../../hooks/usePayroll.js'
import { useAllActiveWorkers } from '../../hooks/useSupabase.js'
import { requestAdvance, approveAdvanceEdit, rejectAdvance, loadMonthRecalcState } from '../../lib/payroll/load.js'
import { MONTHS_TH } from '../../lib/payroll/period.js'
import { fmt } from '../../lib/supabase.js'
import { Modal } from '../../components/Modal.jsx'
import { summarizeAdvances, advanceLimit, workerMonthlyPay, defaultStartMonth, parseAdvanceAmount } from '../../lib/payroll/advanceRules.js'

const STATUS = {
  pending: ['รออนุมัติ', '#9a5b00'], approved: ['กำลังผ่อน', '#1f5fa8'],
  rejected: ['ไม่อนุมัติ', '#a33a2b'], settled: ['หักครบแล้ว', '#1f6b55'],
}

const bangkokToday = () => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: 'numeric' }).formatToParts(new Date())
  return { year: Number(p.find(x => x.type === 'year').value), month: Number(p.find(x => x.type === 'month').value) }
}

// Approve editor: prefilled with what the worker asked, owner can change it. Always goes through the edit RPC.
function ApproveModal({ adv, startDefault, onClose, onDone }) {
  const [amount, setAmount] = useState(String(adv.amount))
  const [inst, setInst] = useState(String(adv.installments))
  const [ym, setYm] = useState(`${startDefault.year}-${startDefault.month}`)
  const [touched, setTouched] = useState(false)
  // Period statuses may load after the modal opens: follow the default until the owner picks a month.
  useEffect(() => { if (!touched) setYm(`${startDefault.year}-${startDefault.month}`) }, [startDefault.year, startDefault.month, touched])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [recalc, setRecalc] = useState(false)
  const [startYear, startMonth] = ym.split('-').map(Number)
  const months = useMemo(() => Array.from({ length: 12 }, (_, i) => {
    const d = new Date(startDefault.year, startDefault.month - 1 + i, 1)
    return { v: `${d.getFullYear()}-${d.getMonth() + 1}`, l: `${MONTHS_TH[d.getMonth()]} ${d.getFullYear() + 543}` }
  }), [startDefault.year, startDefault.month])
  // One cheap read per chosen month: a draft period with saved records needs a recalculation before confirming.
  useEffect(() => {
    let live = true
    setRecalc(false)
    loadMonthRecalcState(startYear, startMonth)
      .then(r => { if (live) setRecalc(r.status === 'draft' && r.saved > 0) })
      .catch(() => {})
    return () => { live = false }
  }, [startYear, startMonth])
  const amt = Number(amount)
  const n = Number(inst)
  const edited = amt !== Number(adv.requested_amount ?? adv.amount) || n !== Number(adv.requested_installments ?? adv.installments)
  const over = amt > 0 ? Math.max(0, amt - adv.left) : 0
  const hasReq = adv.requested_amount != null && adv.requested_installments != null
  const confirm = async () => {
    const pa = parseAdvanceAmount(amount)
    if (!pa.ok) { setErr(pa.error); return }
    if (!Number.isInteger(n) || n < 1 || n > 60) { setErr('จำนวนงวดต้องอยู่ระหว่าง 1-60'); return }
    setBusy(true); setErr('')
    try {
      await approveAdvanceEdit(adv.id, { amount: pa.amount, installments: n, startYear, startMonth })
      onDone()
    } catch (e) { setErr(e.message || String(e)) } finally { setBusy(false) }
  }
  return (
    <Modal title={`อนุมัติเบิกเงิน · ${adv.workers?.nickname || adv.workers?.name || ''}`} onClose={onClose} maxWidth={440}>
      <div className="modal-body" style={{ display: 'grid', gap: 10 }}>
        {hasReq && edited && <div style={{ fontSize: 13, color: 'var(--text3)' }}>ขอมา {fmt(adv.requested_amount)} × {adv.requested_installments}</div>}
        <label className="label">จำนวนเงิน (บาท)</label>
        <input className="input" type="number" min="1" value={amount} onChange={e => setAmount(e.target.value)} />
        <label className="label">จำนวนงวด (1-60)</label>
        <input className="input" type="number" min="1" max="60" value={inst} onChange={e => setInst(e.target.value)} />
        <label className="label">เริ่มหักเดือน</label>
        <select className="input" value={ym} onChange={e => { setTouched(true); setYm(e.target.value) }}>
          {months.map(m => <option key={m.v} value={m.v}>{m.l}</option>)}
        </select>
        {amt > 0 && n >= 1 && <div style={{ fontSize: 13 }}>หักเดือนละ <b>{fmt(Math.round(amt / n * 100) / 100)}</b> บาท × {n} เดือน</div>}
        {over > 0 && <div style={{ color: 'var(--red)', fontSize: 13 }}>เกินวงเงินที่เบิกได้ {fmt(over)} บาท (อนุมัติได้ถ้าเจ้าของตกลง)</div>}
        {recalc && <div style={{ color: '#9a5b00', fontSize: 13 }}>เดือนเริ่มหักคำนวณไว้แล้ว กดคำนวณใหม่ก่อนยืนยัน</div>}
        {err && <div style={{ color: 'var(--red)' }}>{err}</div>}
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" disabled={busy} onClick={onClose}>ยกเลิก</button>
        <button className="btn btn-primary" disabled={busy} onClick={confirm}>อนุมัติ</button>
      </div>
    </Modal>
  )
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
  const { data: periodStatuses } = usePayrollPeriodStatuses()
  const [approving, setApproving] = useState(null)
  const [rejecting, setRejecting] = useState(null) // { id, reason }
  const [actError, setActError] = useState('')
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
  const doReject = async () => {
    setBusy(true); setActError('')
    try { await rejectAdvance(rejecting.id, rejecting.reason.trim()); setRejecting(null); refetch() } catch (e) { setActError('ทำรายการไม่สำเร็จ: ' + e.message) } finally { setBusy(false) }
  }

  // Pending cards: the four numbers per worker (balance from closed deductions, other pending, pay, left to withdraw).
  const pendingCards = (advances || []).filter(a => a.status === 'pending').map(a => {
    const mine = (advances || []).filter(x => x.worker_id === a.worker_id)
    const lines = mine.filter(x => x.status === 'approved').map(x => ({ advance_id: x.id, amount: x.deducted || 0 }))
    const sum = summarizeAdvances(mine, lines, a.id)
    const pay = workerMonthlyPay(a.workers)
    const left = advanceLimit({ monthlyPay: pay, outstanding: sum.outstanding, pendingOther: sum.pendingOther })
    const overBy = Math.max(0, Number(a.amount) - left)
    return { ...a, outstanding: sum.outstanding, pendingOther: sum.pendingOther, pay, left, overBy }
  })
  const startDefault = defaultStartMonth(periodStatuses || {}, bangkokToday())

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

      {pendingCards.length > 0 && (
        <div className="card card-body" style={{ gridColumn: '1 / -1', display: 'grid', gap: 10 }}>
          <div className="card-title">คำขอรออนุมัติ ({pendingCards.length})</div>
          {actError && <div style={{ color: 'var(--red)' }}>{actError}</div>}
          {pendingCards.map(a => (
            <div key={a.id} style={{ border: `1px solid ${a.overBy > 0 ? 'var(--red)' : 'var(--border)'}`, borderRadius: 8, padding: 10, display: 'grid', gap: 6 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <b>{a.workers?.nickname || a.workers?.name}</b>
                {String(a.requested_by || '').startsWith('line:') && <span style={{ fontSize: 12, background: '#e3f1e8', color: '#1f6b55', borderRadius: 10, padding: '1px 8px' }}>ขอผ่าน LINE</span>}
              </div>
              <div>ขอ {fmt(a.amount)} บาท · ผ่อน {a.installments} เดือน</div>
              {a.title && <div style={{ fontSize: 13, color: 'var(--text3)' }}>{a.title}</div>}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 6, fontSize: 13 }}>
                <div>ยอดคืนคงเหลือ (ของเก่า)<br /><b>{fmt(a.outstanding)}</b></div>
                <div>รออนุมัติอื่นอยู่<br /><b>{fmt(a.pendingOther)}</b></div>
                <div>เงินเดือน<br /><b>{a.pay > 0 ? fmt(a.pay) : '—'}</b></div>
                <div>ยังเบิกได้อีก<br /><b>{fmt(a.left)}</b></div>
              </div>
              {a.overBy > 0 && <div style={{ color: 'var(--red)', fontSize: 13 }}>เกินวงเงินที่เบิกได้ {fmt(a.overBy)} บาท</div>}
              {isOwner && rejecting?.id !== a.id && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => { setActError(''); setApproving(a) }}>อนุมัติ</button>
                  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setActError(''); setRejecting({ id: a.id, reason: '' }) }}>ไม่อนุมัติ</button>
                </div>
              )}
              {isOwner && rejecting?.id === a.id && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <input className="input" style={{ flex: 1, minWidth: 160 }} placeholder="เหตุผลที่ไม่อนุมัติ" value={rejecting.reason} onChange={e => setRejecting(r => ({ ...r, reason: e.target.value }))} />
                  <button className="btn btn-primary btn-sm" disabled={busy} onClick={doReject}>ยืนยันไม่อนุมัติ</button>
                  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setRejecting(null)}>ยกเลิก</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {approving && (
        <ApproveModal adv={pendingCards.find(c => c.id === approving.id) || approving} startDefault={startDefault}
          onClose={() => setApproving(null)} onDone={() => { setApproving(null); refetch() }} />
      )}

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
            </div>
          )
        })}
        {!loading && !error && !(advances || []).length && <div style={{ color: 'var(--text3)' }}>ยังไม่มีรายการเบิก</div>}
      </div>
    </div>
  )
}
