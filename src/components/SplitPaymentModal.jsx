// src/components/SplitPaymentModal.jsx
// จ่ายบางส่วน (R3): the paid amount becomes this bill (status จ่ายแล้ว), the rest a new pending bill with the same
// invoice number and PO. split_payment is the authority; splitPaymentAmounts shows the same numbers first.
import { useState, useRef } from 'react'
import { Modal } from './Modal.jsx'
import { fmt } from '../lib/supabase.js'
import { splitPayment } from '../hooks/useSupabase.js'
import { splitPaymentAmounts, SPLIT_INPUT_TEXT } from '../lib/poPaymentMath.js'
import { mapPoReceiptRpcError } from '../lib/poReceiptErrors.js'
import { bangkokTodayIso } from '../lib/photoUpload.js'

export default function SplitPaymentModal({ expense, onDone, onClose }) {
  const today = bangkokTodayIso()
  const [amount, setAmount] = useState('')
  const [paidDate, setPaidDate] = useState(today)
  const [method, setMethod] = useState('transfer')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)   // state updates are async: a fast double click must still call the RPC once
  const calc = splitPaymentAmounts(expense, amount)
  const canSave = !busy && amount !== '' && !calc.code && !!paidDate && paidDate <= today

  const save = async () => {
    if (!canSave || inFlight.current) return
    inFlight.current = true
    setBusy(true); setError('')
    let result
    try { result = await splitPayment({ expenseId: expense.id, amount, paidDate, method }) }
    catch (e) { setError(mapPoReceiptRpcError(e)); setBusy(false); inFlight.current = false; return }
    onDone(result)   // saved: the parent closes this dialog (busy stays on meanwhile)
  }

  return (
    <Modal title="จ่ายบางส่วน (แยกบิล)" onClose={() => { if (!busy) onClose() }} maxWidth={440}>
      <div className="modal-body" style={{ display: 'grid', gap: 12, fontSize: 13 }}>
        <div>{expense.description}{expense.invoice_no ? ` · #${expense.invoice_no}` : ''}</div>
        <div>ยอดบิล <span className="font-mono" style={{ color: 'var(--red)', fontWeight: 700 }}>{fmt(expense.amount)}</span> บาท</div>
        <div>
          <label className="label" htmlFor="sp-amt">ยอดที่จ่ายครั้งนี้ ★</label>
          <input id="sp-amt" aria-label="ยอดที่จ่ายครั้งนี้" className="input font-mono" type="number" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} />
          {amount !== '' && calc.code && <div style={{ color: 'var(--red)', marginTop: 4 }}>{SPLIT_INPUT_TEXT[calc.code]}</div>}
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label" htmlFor="sp-date">วันที่จ่าย ★</label>
            <input id="sp-date" aria-label="วันที่จ่าย" type="date" className="input" max={today} value={paidDate} onChange={e => setPaidDate(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="sp-method">วิธีชำระ</label>
            <select id="sp-method" className="select" value={method} onChange={e => setMethod(e.target.value)}>
              <option value="transfer">โอนเงิน</option><option value="check">เช็ค</option><option value="cash">เงินสด</option>
            </select>
          </div>
        </div>
        {paidDate > today && <div style={{ color: 'var(--red)' }}>วันที่จ่ายต้องไม่เกินวันนี้</div>}
        {!calc.code && amount !== '' && (
          <div style={{ background: 'rgba(0,0,0,0.15)', borderRadius: 8, padding: '8px 12px' }}>
            <div>จ่ายแล้ว <span className="font-mono">{fmt(calc.paid.amount)}</span>{calc.paid.vat != null && <> (ก่อน VAT {fmt(calc.paid.net)} · VAT {fmt(calc.paid.vat)})</>}</div>
            <div>คงค้าง (บิลใหม่) <span className="font-mono">{fmt(calc.rest.amount)}</span>{calc.rest.vat != null && <> (ก่อน VAT {fmt(calc.rest.net)} · VAT {fmt(calc.rest.vat)})</>}</div>
          </div>
        )}
        {error && <div role="alert" style={{ color: 'var(--red)' }}>{error}</div>}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>ยกเลิก</button>
        <button type="button" className="btn btn-primary" disabled={!canSave} onClick={save}>{busy ? '⏳...' : '✅ บันทึกการจ่ายบางส่วน'}</button>
      </div>
    </Modal>
  )
}
