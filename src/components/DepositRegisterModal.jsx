import { useState } from 'react'
import { Modal } from './Modal.jsx'
import { fmt, fmtDate } from '../lib/supabase.js'
import { registerSupplierDeposit } from '../hooks/useSupabase.js'

function mapError(err) {
  const msg = String(err?.message || '')
  if (err?.code === '23505') return 'เลขที่ใบมัดจำนี้มีอยู่แล้ว'
  if (msg.includes('deposit_expense_needs_vat_split')) return 'รายจ่ายนี้ไม่มียอดก่อน VAT/VAT แยก ลงทะเบียนเป็นมัดจำไม่ได้'
  if (msg.includes('deposit_expense_needs_supplier')) return 'รายจ่ายนี้ยังไม่ระบุซัพพลายเออร์'
  if (msg.includes('deposit_expense_bad_split')) return 'ยอดก่อน VAT + VAT ไม่ตรงกับยอดรวมของรายจ่าย'
  if (msg.includes('deposit_expense_is_po_generated')) return 'รายจ่ายนี้สร้างจากใบสั่งซื้อ ลงทะเบียนเป็นมัดจำไม่ได้'
  return 'Error: ' + msg
}

export default function DepositRegisterModal({ expense, onClose, onSaved }) {
  const [no, setNo] = useState(expense.invoice_no || '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const save = async () => {
    if (!no.trim()) { setErr('กรุณากรอกเลขที่ใบมัดจำ'); return }
    setSaving(true); setErr('')
    try {
      await registerSupplierDeposit(expense.id, no)
      onSaved?.()
    } catch (e) {
      setErr(mapError(e)); setSaving(false)
    }
  }

  return (
    <Modal title="ลงทะเบียนเป็นมัดจำ" onClose={onClose} maxWidth={440}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div style={{ fontSize: 13, color: 'var(--text2)' }}>
          <div style={{ fontWeight: 600 }}>{expense.description}</div>
          <div>{expense.supplier || expense.supplier_name || '—'} · {fmtDate(expense.date)}</div>
          <div>ก่อน VAT {fmt(expense.amount_no_vat)} · VAT {fmt(expense.vat || 0)} · รวม {fmt(expense.amount)}</div>
        </div>
        <div>
          <label className="label">เลขที่ใบมัดจำ ★</label>
          <input className="input" value={no} onChange={e => setNo(e.target.value)} autoFocus />
        </div>
        {err && <div style={{ color: 'var(--red)', fontSize: 12 }}>{err}</div>}
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ยกเลิก</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'กำลังบันทึก...' : 'บันทึก'}</button>
      </div>
    </Modal>
  )
}
