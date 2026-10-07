// src/components/CreatePoDepositModal.jsx
// สร้างใบจ่ายมัดจำจากใบสั่งซื้อ: percent of the PO total or an amount (both incl. VAT); VAT split follows the PO.
// create_po_deposit (supabase/migrations/2026-10-09-02-po-receipt-rpcs.sql) is the authority; depositFromPo shows the
// same numbers first. The RPC creates NO cheque record, so a cheque deposit must be recorded on the cheque page.
import { useState } from 'react'
import { Modal } from './Modal.jsx'
import { fmt } from '../lib/supabase.js'
import { createPoDeposit } from '../hooks/useSupabase.js'
import { calcPoTotals } from '../lib/poTotals.js'
import { depositFromPo, DEPOSIT_INPUT_TEXT } from '../lib/poPaymentMath.js'
import { mapPoReceiptRpcError } from '../lib/poReceiptErrors.js'
import { bangkokTodayIso } from '../lib/photoUpload.js'

export default function CreatePoDepositModal({ po, onDone, onClose }) {
  const t = calcPoTotals(po.purchase_order_items, po.has_vat, po.price_includes_vat)
  const today = bangkokTodayIso()
  const [mode, setMode] = useState('percent')
  const [value, setValue] = useState('')
  const [invoiceNo, setInvoiceNo] = useState('')
  const [date, setDate] = useState(today)
  const [method, setMethod] = useState('transfer')
  const [status, setStatus] = useState('paid')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // po.has_vat is the boolean the RPC reads; price_includes_vat only changes how the PO total is built
  const calc = depositFromPo({ mode, value, poTotal: t.total, hasVat: po.has_vat === true })
  const futureDate = !!date && date > today
  const notOrdered = po.status !== 'ordered'
  const canSave = !busy && !notOrdered && !calc.code && invoiceNo.trim() !== '' && !!date && !futureDate

  const save = async () => {
    if (!canSave) return
    setBusy(true); setError('')
    let res
    try {
      res = await createPoDeposit({ poId: po.id, mode, value, invoiceNo: invoiceNo.trim(), date, paymentMethod: method, status })
    } catch (e) {
      setError(mapPoReceiptRpcError(e)); setBusy(false)
      return
    }
    onDone(res)
  }

  return (
    <Modal title={`สร้างใบจ่ายมัดจำ — ${po.po_number}`} onClose={() => { if (!busy) onClose() }} maxWidth={480}>
      <div className="modal-body" style={{ display: 'grid', gap: 12, fontSize: 13 }}>
        <div>{po.suppliers?.name || '—'} · ยอดใบสั่งซื้อ <span className="font-mono">{fmt(t.total)}</span> บาท (รวม VAT)</div>
        {notOrdered && <div style={{ color: 'var(--red)' }}>สร้างมัดจำได้เฉพาะใบสั่งซื้อที่สถานะ "สั่งซื้อแล้ว"</div>}
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
            <input type="radio" name="dep-mode" checked={mode === 'percent'} onChange={() => setMode('percent')} /> เปอร์เซ็นต์ของใบสั่งซื้อ
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
            <input type="radio" name="dep-mode" checked={mode === 'amount'} onChange={() => setMode('amount')} /> จำนวนเงิน (รวม VAT)
          </label>
        </div>
        <div>
          <label className="label" htmlFor="dep-value">ยอด</label>
          <input id="dep-value" aria-label="ยอด" className="input font-mono" type="number" min="0" step="0.01" value={value} onChange={e => setValue(e.target.value)}
            placeholder={mode === 'percent' ? 'เช่น 50' : 'เช่น 110600.55'} />
          {value !== '' && calc.code && <div style={{ color: 'var(--red)', marginTop: 4 }}>{DEPOSIT_INPUT_TEXT[calc.code]}</div>}
          {!calc.code && (
            <div style={{ marginTop: 4, color: 'var(--text2)' }}>
              มัดจำ <span className="font-mono">{fmt(calc.gross)}</span> = ก่อน VAT <span className="font-mono">{fmt(calc.net)}</span> + VAT <span className="font-mono">{fmt(calc.vat)}</span> ({calc.pctOfPo}% ของใบสั่งซื้อ)
            </div>
          )}
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label" htmlFor="dep-no">เลขที่ใบเสร็จ/ใบกำกับมัดจำ ★</label>
            <input id="dep-no" aria-label="เลขที่ใบเสร็จ/ใบกำกับมัดจำ" className="input" value={invoiceNo} onChange={e => setInvoiceNo(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="dep-date">วันที่จ่ายมัดจำ ★</label>
            <input id="dep-date" type="date" className="input" max={today} value={date} onChange={e => setDate(e.target.value)} />
            {futureDate && <div style={{ color: 'var(--red)', marginTop: 4 }}>วันที่จ่ายมัดจำต้องไม่เกินวันนี้</div>}
          </div>
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label" htmlFor="dep-method">วิธีชำระ</label>
            <select id="dep-method" className="select" value={method} onChange={e => setMethod(e.target.value)}>
              <option value="transfer">โอนเงิน</option><option value="check">เช็ค</option><option value="cash">เงินสด</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="dep-status">สถานะ</label>
            <select id="dep-status" className="select" value={status} onChange={e => setStatus(e.target.value)}>
              <option value="paid">✅ จ่ายแล้ว</option><option value="pending">⏳ ค้างจ่าย</option>
            </select>
          </div>
        </div>
        {method === 'check' && <div style={{ fontSize: 11.5, color: 'var(--text3)' }}>การเลือกเช็คไม่สร้างรายการเช็คให้ — ต้องบันทึกเช็คแยกที่หน้าเช็ค</div>}
        <div style={{ fontSize: 11.5, color: 'var(--text3)' }}>มัดจำจะถูกบันทึกเป็นรายจ่ายรายการแรกของใบสั่งซื้อนี้ และหักได้ตอนรับของ</div>
        {error && <div style={{ color: 'var(--red)' }}>{error}</div>}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>ยกเลิก</button>
        <button type="button" className="btn btn-primary" disabled={!canSave} onClick={save}>✅ สร้างใบมัดจำ{busy ? ' ⏳' : ''}</button>
      </div>
    </Modal>
  )
}
