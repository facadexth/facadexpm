// Deposit (หักมัดจำ) picker for the PO receive dialog. Renders nothing when the
// supplier has no open deposits and the PO has no scanned deposit hint, so
// receiving a PO without deposits looks and behaves exactly as before.
import { useState, useEffect, useMemo, useRef } from 'react'
import { useSupplierDeposits } from '../hooks/useSupabase.js'
import { fmt } from '../lib/supabase.js'
import { openDeposits, selectionFromHint, defaultAmount, computeReceiveSelection, unavailableDeposits, unmatchedHintText, isDepositQuerySettled, DEDUCTION_ERROR_TEXT } from '../lib/receiveDeposits.js'

export default function ReceiveDepositBlock({ po, totals, onChange }) {
  const { data: rows, error } = useSupplierDeposits(po.supplier_id)
  const deposits = useMemo(() => (error ? [] : openDeposits(rows)), [rows, error])
  const unavailable = useMemo(() => (error ? [] : unavailableDeposits(rows)), [rows, error])
  const ready = isDepositQuerySettled(rows, error)
  const [selection, setSelection] = useState({})
  const [unmatched, setUnmatched] = useState([])
  const initRef = useRef(false)

  // Pre-tick deposits named by the scanned document (once, when data arrives).
  useEffect(() => {
    if (initRef.current || rows == null) return
    initRef.current = true
    const r = selectionFromHint(po.deposit_hint, deposits, po.supplier_id, rows)
    setSelection(r.selection)
    setUnmatched(r.unmatched)
  }, [rows, deposits, po.deposit_hint, po.supplier_id])

  const result = useMemo(
    () => computeReceiveSelection({ deposits, supplierId: po.supplier_id, totals, selection }),
    [deposits, po.supplier_id, totals.subtotal, totals.vat, selection], // eslint-disable-line
  )

  useEffect(() => { onChange({ ...result, ready }) }, [result, ready]) // eslint-disable-line

  if (rows == null || (deposits.length === 0 && unmatched.length === 0 && unavailable.length === 0)) return null

  const coveredExcept = (id) => deposits.reduce((s, d) => (d.id !== id && result.lines[d.id] ? s + result.lines[d.id].net : s), 0)

  const toggle = (d, checked) => {
    setSelection(prev => ({
      ...prev,
      [d.id]: { checked, amount: checked ? defaultAmount(d.remaining.net, totals.subtotal - coveredExcept(d.id)) : (prev[d.id]?.amount ?? '') },
    }))
  }
  const setAmount = (d, amount) => setSelection(prev => ({ ...prev, [d.id]: { checked: true, amount } }))

  const { plan } = result
  return (
    <div style={{ marginTop: 10, fontSize: 12, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
      <strong>หักมัดจำ</strong>
      {unmatched.map(u => (
        <div key={u.ref} style={{ marginTop: 4, color: '#b45309' }}>⚠️ {unmatchedHintText(u)}</div>
      ))}
      {unavailable.map(u => (
        <div key={u.id} style={{ marginTop: 4, color: 'var(--text3)' }}>🚫 {u.no || 'มัดจำ'}: {u.reason}</div>
      ))}
      {deposits.map(d => {
        const sel = selection[d.id] || {}
        const err = result.errors[d.id]
        return (
          <div key={d.id} style={{ marginTop: 6 }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={!!sel.checked} onChange={e => toggle(d, e.target.checked)} />
              <span>{d.deposit_invoice_no || 'มัดจำ'} · คงเหลือก่อน VAT <span className="font-mono">{fmt(d.remaining.net)}</span></span>
            </label>
            {sel.checked && (
              <div style={{ marginLeft: 22, marginTop: 4 }}>
                <input
                  className="input font-mono" type="number" min="0" step="0.01" style={{ width: 150 }}
                  value={sel.amount ?? ''} onChange={e => setAmount(d, e.target.value)}
                  aria-label="ยอดหักก่อน VAT"
                />
                <span style={{ marginLeft: 6 }}>บาท (ก่อน VAT)</span>
                {result.lines[d.id] && <span style={{ marginLeft: 8, color: 'var(--text3)' }}>VAT ที่หัก {fmt(result.lines[d.id].vat)}</span>}
                {err && <div style={{ color: 'var(--red)', marginTop: 2 }}>{DEDUCTION_ERROR_TEXT[err] || err}</div>}
              </div>
            )}
          </div>
        )
      })}
      {(plan.overNet || plan.overVat) && (
        <div style={{ marginTop: 6, color: 'var(--red)' }}>{plan.overVat && !plan.overNet ? 'VAT ที่หักเกิน VAT ของใบสั่งซื้อ' : 'ยอดหักเกินยอดสินค้าที่เหลือ'}</div>
      )}
      <div style={{ marginTop: 8, fontWeight: 600 }}>
        {plan.createExpense
          ? <>รายจ่ายใหม่: ก่อน VAT {fmt(plan.netToPay)} · VAT {fmt(plan.vatToPay)}</>
          : 'ไม่สร้างรายจ่าย (หักครบ)'}
      </div>
    </div>
  )
}
