// src/pages/hr/PayrollMonth.jsx
// One month of payroll as a grid like the owner's sheet: one row per worker,
// one column per pay item. Draft → ยืนยัน → ปิดงวด. All money comes from the
// engine (lib/payroll); this file only displays and calls RPCs.
import { useEffect, useMemo, useState } from 'react'
import { useUserRole } from '../../hooks/useUserRole.js'
import { usePayrollMonth } from '../../hooks/usePayroll.js'
import { calculateMonth, saveDraft, setManualLine, confirmMonth, unconfirmMonth, closeMonth, reopenMonth } from '../../lib/payroll/load.js'
import { periodLabel, MONTHS_TH, monthRange } from '../../lib/payroll/period.js'
import { fmt, supabase } from '../../lib/supabase.js'
import { dailyRate } from '../../lib/payroll/calc.js'
import { Modal } from '../../components/Modal.jsx'
import PayslipModal from './Payslip.jsx'
import BankExportModal from './BankExportModal.jsx'

const STATUS = {
  draft: { label: 'ร่าง', color: '#9a5b00' },
  confirmed: { label: 'ยืนยันแล้ว', color: '#1f5fa8' },
  closed: { label: 'ปิดงวดแล้ว', color: '#1f6b55' },
}
const WARN = { negative_net: 'ยอดสุทธิติดลบ', missing_daily_wage: 'ยังไม่ได้ตั้งค่าแรงรายวัน' }

export default function PayrollMonth({ canEdit }) {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const { data, loading, error, refetch } = usePayrollMonth(year, month)
  const { isAtLeast } = useUserRole()
  const isOwner = isAtLeast('OWNER')
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
  const [closeOpen, setCloseOpen] = useState(false)
  const [slip, setSlip] = useState(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [paidDate, setPaidDate] = useState(monthRange(now.getFullYear(), now.getMonth() + 1).to)

  // Workers (read-only) land on their latest confirmed/closed slip, not an empty current month.
  useEffect(() => {
    if (canEdit) return
    let off = false
    supabase.from('salary_records')
      .select('year, month, payroll_periods!inner(status)')
      .in('payroll_periods.status', ['confirmed', 'closed'])
      .order('year', { ascending: false }).order('month', { ascending: false }).limit(1)
      .then(({ data: rows }) => {
        const r = rows?.[0]
        if (off || !r) return
        setYear(r.year); setMonth(r.month); setPaidDate(monthRange(r.year, r.month).to)
      })
      .catch(() => {})
    return () => { off = true }
  }, [canEdit])
  const [advEdit, setAdvEdit] = useState(null) // { lineId, value }

  const status = data?.period?.status || 'draft'
  const items = useMemo(() => (data?.items || []).filter(i => i.active), [data])
  const records = data?.records || []
  const cell = (rec, item) => rec.salary_record_lines.filter(l => l.pay_item_id === item.id).reduce((s, l) => s + Number(l.amount), 0)
  const total = item => records.reduce((s, r) => s + cell(r, item), 0)
  const itemIds = useMemo(() => new Set(items.map(i => i.id)), [items])
  const otherAmt = rec => rec.salary_record_lines.filter(l => !l.pay_item_id || !itemIds.has(l.pay_item_id)).reduce((s, l) => s + (l.side === 'deduction' ? -1 : 1) * Number(l.amount), 0)
  const workerById = useMemo(() => Object.fromEntries((data?.workers || []).map(w => [w.id, w])), [data])
  const officeDays = rec => Number(rec.facts?.officeDays) || 0
  const officeCost = rec => {
    const w = workerById[rec.worker_id]
    return w ? Math.round(officeDays(rec) * dailyRate(w) * 100) / 100 : 0
  }
  const totalOffice = records.reduce((s, r) => s + officeCost(r), 0)
  const totalOther = records.reduce((s, r) => s + otherAmt(r), 0)
  const advanceRemaining = (rec, line) => {
    const a = (data?.advances || []).find(x => x.id === line.advance_id)
    if (!a) return null
    const others = (data?.advanceLines || []).filter(l => l.advance_id === a.id && l.salary_record_id !== rec.id).reduce((s, l) => s + Number(l.amount), 0)
    return Math.round((Number(a.amount) - others) * 100) / 100
  }
  const onAdvance = (rec, item, line, raw) => {
    const v = raw.trim()
    setAdvEdit(null)
    if (v === '') { if (line.is_manual) run(() => setManualLine(rec.id, item.id, line.advance_id, null)); return }
    const n = Number(v)
    const remaining = advanceRemaining(rec, line)
    if (!Number.isFinite(n) || n < 0) { alert('กรุณาใส่ตัวเลขที่ไม่ติดลบ'); return }
    if (remaining != null && n > remaining) { alert(`ยอดหักเกินยอดเบิกคงเหลือ (เหลือ ${fmt(remaining)})`); return }
    if (n === Number(line.amount)) return
    run(() => setManualLine(rec.id, item.id, line.advance_id, n))
  }
  const totalNet = records.reduce((s, r) => s + Number(r.net_pay || 0), 0)

  const run = async (fn, doRefetch = true) => {
    setBusy(true)
    try { await fn(); if (doRefetch) await refetch() }
    catch (e) { alert(e.message) }
    finally { setBusy(false) }
  }
  const onCalculate = () => run(async () => {
    const result = await calculateMonth(year, month)
    // save_payroll_draft refuses an empty run, so never offer to save one.
    if (!result.run.length) { alert('ไม่มีพนักงานที่ต้องคิดเงินเดือนเดือนนี้'); return }
    setPreview(result)
  }, false)
  const onSavePreview = () => {
    if (!preview?.run.length) return
    return run(async () => { await saveDraft(year, month, preview.run); setPreview(null) })
  }
  const onManual = (rec, item, value) => {
    const v = value.trim()
    if (v !== '' && !Number.isFinite(Number(v))) { alert('กรุณาใส่ตัวเลข'); return }
    return run(() => setManualLine(rec.id, item.id, null, v === '' ? null : Number(v)))
  }
  const onReopen = () => { const r = prompt('เหตุผลที่เปิดงวดใหม่'); if (r?.trim()) run(() => reopenMonth(year, month, r.trim())) }
  const gaps = data?.assignGaps || []
  const onConfirm = () => {
    // Warnings only, none of these block confirming.
    const noWage = (data?.workers || []).filter(w => w.pay_type === 'daily' && !(Number(w.daily_wage) > 0)).map(w => w.name)
    const negative = records.filter(r => Number(r.net_pay) < 0).map(r => r.workers?.name || '?')
    const noBank = records.filter(r => !r.workers?.bank_code || !r.workers?.bank_account_no).map(r => r.workers?.name || '?')
    const lines = []
    if (noWage.length) lines.push(`ยังไม่ตั้งค่าแรงรายวัน ${noWage.length} คน (${noWage.join(', ')})`)
    if (negative.length) lines.push(`ยอดสุทธิติดลบ ${negative.length} คน (${negative.join(', ')})`)
    if (noBank.length) lines.push(`ยังไม่มีบัญชีธนาคาร ${noBank.length} คน (${noBank.join(', ')})`)
    if (gaps.length) lines.push(`Assign ยังไม่ครบ ${gaps.length} คน (${gaps.map(g => g.name).join(', ')})`)
    if (lines.length && !confirm(`คำเตือน:\n- ${lines.join('\n- ')}\n\nยืนยันต่อไหม`)) return
    run(() => confirmMonth(year, month))
  }
  const advanceCell = (rec, item) => {
    const lines = rec.salary_record_lines.filter(l => l.pay_item_id === item.id)
    if (!lines.length) return '–'
    const editable = canEdit && status === 'draft'
    return (
      <div style={{ display: 'grid', gap: 2, justifyItems: 'end' }}>
        {lines.map(l => {
          const title = (l.note || l.name || '').trim()
          if (editable && l.advance_id && advEdit?.lineId === l.id) {
            const remaining = advanceRemaining(rec, l)
            return (
              <div key={l.id} style={{ display: 'grid', gap: 2, justifyItems: 'end' }}>
                <input autoFocus className="input input-sm" style={{ width: 90, textAlign: 'right' }} defaultValue={l.amount}
                  placeholder="ว่าง = อัตโนมัติ"
                  onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setAdvEdit(null) }}
                  onBlur={e => onAdvance(rec, item, l, e.target.value)} />
                {remaining != null && <small style={{ color: 'var(--text3)' }}>เหลือ {fmt(remaining)}</small>}
              </div>
            )
          }
          return (
            <div key={l.id} title={title} style={{ fontSize: 12 }}>
              {editable && l.advance_id
                ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdvEdit({ lineId: l.id })} title={`${title} — กดเพื่อแก้ยอดหัก`}>{fmt(l.amount)}{l.is_manual ? ' ✎' : ''}</button>
                : fmt(l.amount)}
              {title && <small style={{ color: 'var(--text3)', display: 'block' }}>{title}</small>}
            </div>
          )
        })}
      </div>
    )
  }
  const warnings = (preview?.run || []).filter(r => r.warnings.length)

  if (loading && !data) return <div>⏳ กำลังโหลด...</div>
  if (error) return <div className="card" style={{ color: 'var(--red)' }}>โหลดเงินเดือนไม่สำเร็จ: {error}</div>

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select className="select select-sm" value={month} onChange={e => { setMonth(+e.target.value); setPaidDate(monthRange(year, +e.target.value).to) }}>
          {MONTHS_TH.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
        <select className="select select-sm" value={year} onChange={e => { setYear(+e.target.value); setPaidDate(monthRange(+e.target.value, month).to) }}>
          {Array.from({ length: 5 }, (_, i) => now.getFullYear() - 2 + i).map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <span>{periodLabel(year, month)}</span>
        <span style={{ fontWeight: 700, color: STATUS[status].color }}>● {STATUS[status].label}</span>
        {status === 'draft' && data?.period?.reopen_reason && <span style={{ fontSize: 12, color: 'var(--text3)' }}>เปิดงวดใหม่: {data.period.reopen_reason}</span>}
        {canEdit && status === 'draft' && gaps.length > 0 && <span style={{ fontSize: 12, color: 'var(--red)' }}>⚠️ Assign ยังไม่ครบ {gaps.length} คน</span>}
        <span style={{ flex: 1 }} />
        {canEdit && status === 'draft' && <button className="btn btn-primary" disabled={busy} onClick={onCalculate}>🧮 คำนวณ</button>}
        {canEdit && status === 'draft' && records.length > 0 && <button className="btn" disabled={busy} onClick={onConfirm}>✅ ยืนยันเงินเดือน</button>}
        {canEdit && status === 'confirmed' && <button className="btn btn-ghost" disabled={busy} onClick={() => run(() => unconfirmMonth(year, month))}>↩️ กลับไปแก้ไข</button>}
        {canEdit && status === 'confirmed' && <button className="btn btn-primary" disabled={busy} onClick={() => setCloseOpen(true)}>🔒 ปิดงวด</button>}
        {isOwner && status === 'closed' && <button className="btn btn-ghost" disabled={busy} onClick={onReopen}>🔓 เปิดงวดใหม่</button>}
        {canEdit && ['confirmed', 'closed'].includes(status) && <button className="btn" onClick={() => setExportOpen(true)}>🏦 ไฟล์ธนาคาร</button>}
      </div>

      {records.length > 0 && (
        <div style={{ fontSize: 13 }}>
          ค่าใช้จ่ายส่วนกลาง (วันออฟฟิศ): <b style={{ color: 'var(--blue)' }}>{fmt(totalOffice)}</b> บาท
        </div>
      )}

      <div className="table-wrap" style={{ overflowX: 'auto' }}>
        <table style={{ minWidth: 380 + items.length * 110 }}>
          <thead>
            <tr>
              <th>ชื่อ</th><th style={{ textAlign: 'right' }}>วันออฟฟิศ</th>
              {items.map(i => <th key={i.id} style={{ textAlign: 'right' }}>{i.name}</th>)}
              <th style={{ textAlign: 'right' }}>อื่นๆ</th>
              <th style={{ textAlign: 'right' }}>จ่ายสุทธิ</th><th></th>
            </tr>
          </thead>
          <tbody>
            {records.map(r => (
              <tr key={r.id}>
                <td>{r.workers?.name}{r.workers?.nickname ? ` (${r.workers.nickname})` : ''}{workerById[r.worker_id]?.inactive ? ' (ออกแล้ว)' : ''}</td>
                <td style={{ textAlign: 'right' }}>{r.facts && Object.keys(r.facts).length ? (officeDays(r) || '–') : '—'}</td>
                {items.map(i => (
                  <td key={i.id} style={{ textAlign: 'right' }}>
                    {i.method === 'advances'
                      ? advanceCell(r, i)
                      : i.method === 'manual_monthly' && canEdit && status === 'draft'
                      ? <input key={cell(r, i)} className="input input-sm" style={{ width: 90, textAlign: 'right' }} defaultValue={cell(r, i) || ''}
                          onBlur={e => { if (String(cell(r, i) || '') !== e.target.value) onManual(r, i, e.target.value) }} />
                      : (cell(r, i) ? fmt(cell(r, i)) : '–')}
                  </td>
                ))}
                <td style={{ textAlign: 'right' }}>{otherAmt(r) ? fmt(otherAmt(r)) : '–'}</td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(r.net_pay)}</td>
                <td><button className="btn btn-ghost btn-sm" onClick={() => setSlip(r)} aria-label="สลิป">📄</button></td>
              </tr>
            ))}
            {!records.length && (
              <tr><td colSpan={items.length + 5} style={{ textAlign: 'center', color: 'var(--text3)' }}>
                {canEdit ? 'ยังไม่ได้คำนวณเดือนนี้ กด “คำนวณ”' : 'ยังไม่มีสลิปของเดือนนี้'}
              </td></tr>
            )}
          </tbody>
          {records.length > 0 && (
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td>ยอดรวม</td><td></td>
                {items.map(i => <td key={i.id} style={{ textAlign: 'right' }}>{fmt(total(i))}</td>)}
                <td style={{ textAlign: 'right' }}>{fmt(totalOther)}</td>
                <td style={{ textAlign: 'right' }}>{fmt(totalNet)}</td><td></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {preview && (
        <Modal title={`ตรวจก่อนบันทึก — ${periodLabel(year, month)}`} onClose={() => setPreview(null)} maxWidth={720}>
          <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
            {preview.assignGaps.length > 0 && (
              <details open style={{ border: '1px solid var(--red)', borderRadius: 6, padding: 8 }}>
                <summary style={{ color: 'var(--red)', fontWeight: 700 }}>⚠️ Assign ยังไม่ครบ {preview.assignGaps.length} คน (เงินเดือนอาจไม่ถูก) ไปเติมที่หน้า Assign ก่อนได้</summary>
                {preview.assignGaps.map(g => (
                  <div key={g.worker_id} style={{ fontSize: 13 }}>
                    <b>{g.name}</b> {g.dates.length} วัน: {g.dates.slice(0, 8).map(d => `${+d.date.slice(8)}${d.missing.length === 1 ? (d.missing[0] === 'morning' ? '(เช้า)' : '(บ่าย)') : ''}`).join(', ')}{g.dates.length > 8 ? ' …' : ''}
                  </div>
                ))}
              </details>
            )}
            {warnings.map(r => <div key={r.worker_id} style={{ color: 'var(--red)' }}>⚠️ {r.worker.name}: {r.warnings.map(w => WARN[w] || w).join(', ')}</div>)}
            {preview.diff.length === 0 ? <div>ไม่มีตัวเลขเปลี่ยน</div> : preview.diff.map(d => (
              <div key={d.worker_id}>
                <b>{d.name}</b>
                {d.changes.map(c => <div key={c.name} style={{ fontSize: 13 }}>{c.name}: {fmt(c.before)} → <b>{fmt(c.after)}</b></div>)}
              </div>
            ))}
            <div>รวมจ่ายสุทธิ {preview.run.length} คน: <b>{fmt(preview.run.reduce((s, r) => s + r.totals.net, 0))}</b> บาท</div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-ghost" onClick={() => setPreview(null)}>ยกเลิก</button>
            <button className="btn btn-primary" disabled={busy} onClick={onSavePreview}>💾 บันทึก</button>
          </div>
        </Modal>
      )}

      {closeOpen && (
        <Modal title="ปิดงวด" onClose={() => setCloseOpen(false)} maxWidth={420}>
          <div className="modal-body">
            <p>ปิดงวดหลังโอนเงินเสร็จแล้ว หลังปิดจะแก้ไขไม่ได้ (เจ้าของเปิดใหม่ได้)</p>
            <label className="label">วันที่จ่าย</label>
            <input className="input" type="date" value={paidDate} onChange={e => setPaidDate(e.target.value)} />
          </div>
          <div className="modal-footer">
            <button className="btn btn-ghost" onClick={() => setCloseOpen(false)}>ยกเลิก</button>
            <button className="btn btn-primary" disabled={busy || !paidDate} onClick={() => run(async () => { await closeMonth(year, month, paidDate); setCloseOpen(false) })}>🔒 ปิดงวด</button>
          </div>
        </Modal>
      )}

      {exportOpen && <BankExportModal records={records} year={year} month={month} onClose={() => setExportOpen(false)} />}
      {slip && <PayslipModal record={slip} year={year} month={month} period={data?.period} onClose={() => setSlip(null)} />}
    </div>
  )
}
