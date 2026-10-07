// src/components/ReceivePoLinesModal.jsx
// รับของ: receive all / some lines (whole lines, R1), received date (dates the stock, R2), deposit deduction
// (percent | value, VAT-inclusive, R4/R5) and the bill preview. receive_po_lines is the authority and does
// everything (bill, deduction, stock, status) in one transaction.
// Deposits: the PO's own deposit is pre-ticked with the R4 default and follows the chosen lines until the user edits
// it; other open deposits of the supplier not tied to another PO are listed unticked (R6).
import { useState, useMemo, useRef } from 'react'
import { Modal } from './Modal.jsx'
import { fmt } from '../lib/supabase.js'
import { usePoLedger, useSupplierDeposits, receivePoLines } from '../hooks/useSupabase.js'
import { calcPoTotals } from '../lib/poTotals.js'
import { round2, depositRemaining } from '../lib/depositMath.js'
import { computeWeightedAverageCost } from '../lib/inventoryCost.js'
import { receiptValue, outstandingItems, defaultDeduction, computeReceiveDeductions, DEDUCTION_INPUT_TEXT } from '../lib/poReceiptMath.js'
import { mapPoReceiptRpcError, receiveDialogDeposits } from '../lib/poReceiptErrors.js'
import { bangkokTodayIso } from '../lib/photoUpload.js'

const depGross = d => round2(Number(d.expense.amount_no_vat) + Number(d.expense.vat))

export default function ReceivePoLinesModal({ po, stockPlanFor, stockBalances, onDone, onClose }) {
  const today = bangkokTodayIso()
  const { data: ledger, error: ledgerError } = usePoLedger(po.id)
  const { data: depRows, error: depError } = useSupplierDeposits(po.supplier_id)
  const [mode, setMode] = useState('all')
  const [picked, setPicked] = useState(() => new Set())
  const [receivedDate, setReceivedDate] = useState(today)
  const [sel, setSel] = useState({})        // user edits only: {[depositId]: {checked, mode, value}}
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)            // double-click guard: state updates are async, a ref is not

  const loaded = ledger != null && (depRows != null || depError != null)
  const receivedIds = useMemo(() => new Set((ledger?.receipts || []).flatMap(r => (r.po_receipt_items || []).map(i => i.po_item_id))), [ledger])
  const allItems = po.purchase_order_items || []
  const outstanding = useMemo(() => outstandingItems(po.purchase_order_items, receivedIds), [po, receivedIds])
  const lineIds = !loaded ? [] : mode === 'all' ? outstanding.map(i => i.id) : outstanding.filter(i => picked.has(i.id)).map(i => i.id)
  const lineKey = lineIds.join(',')
  const receipt = useMemo(() => receiptValue({
    items: po.purchase_order_items, hasVat: po.has_vat, priceIncludesVat: po.price_includes_vat,
    lineIds, receivedItemIds: receivedIds, priorReceipts: ledger?.receipts || [],
  }), [po, lineKey, receivedIds, ledger]) // eslint-disable-line react-hooks/exhaustive-deps
  const ownId = ledger?.deposit?.id || null
  const deposits = useMemo(() => (depError ? [] : receiveDialogDeposits(depRows, po.id, ownId)), [depRows, depError, po.id, ownId])
  const poTotal = calcPoTotals(po.purchase_order_items, po.has_vat, po.price_includes_vat).total

  // the own deposit follows the chosen lines with the R4 default until the user edits it
  const selection = useMemo(() => {
    const out = { ...sel }
    const own = deposits.find(d => d.id === ownId)
    if (own && !sel[own.id] && lineIds.length) {
      const v = defaultDeduction({ own: true, depositGross: depGross(own), poTotal,
        remaining: own.remaining, receiptTotal: receipt.total, isFinal: receipt.isFinal })
      out[own.id] = { checked: v !== '', mode: 'value', value: v }
    }
    return out
  }, [sel, deposits, ownId, lineKey, receipt, poTotal]) // eslint-disable-line react-hooks/exhaustive-deps
  const result = useMemo(() => computeReceiveDeductions({ deposits, supplierId: po.supplier_id, selection, receipt }), [deposits, po.supplier_id, selection, receipt])
  const stock = po.stock_from_invoice ? [] : stockPlanFor(po, lineIds)
  const stockBad = stock.some(s => !(s.baseQty > 0))
  const dateBad = !receivedDate || receivedDate > today
  // the PO's own deposit (from the ledger) still has money left but is not usable here (e.g. its expense has no VAT
  // split): receiving without it would leave it stranded, so block until it is fixed
  const ownLedger = ledger?.deposit || null
  const ownExp = ownLedger?.expenses || null
  const ownSplit = !!ownExp && ownExp.amount_no_vat != null && ownExp.vat != null
  const ownLedgerRem = ownSplit ? depositRemaining(ownExp, ownLedger.po_deposit_applications || []) : null
  const ownMissing = !depError && !!ownLedger && !deposits.some(d => d.id === ownLedger.id) && (!ownSplit || ownLedgerRem.net > 0.005)
  const ownUnpaid = !!ownExp && ownExp.status && ownExp.status !== 'paid'
  const canConfirm = loaded && !ledgerError && !depError && !ownMissing && !busy && lineIds.length > 0 && result.valid && !stockBad && !dateBad

  const covered = id => deposits.reduce((s, d) => (d.id !== id && result.lines[d.id] ? s + result.lines[d.id].gross : s), 0)
  const toggle = (d, checked) => setSel(prev => {
    // re-ticking the own deposit hands it back to the R4 default, which follows the chosen lines
    if (checked && d.id === ownId) { const n = { ...prev }; delete n[d.id]; return n }
    const cur = prev[d.id] || selection[d.id]
    return { ...prev, [d.id]: {
      checked, mode: checked ? 'value' : (cur?.mode || 'value'),
      value: checked
        ? defaultDeduction({ own: d.id === ownId, depositGross: depGross(d), poTotal, remaining: d.remaining,
          receiptTotal: receipt.total, isFinal: receipt.isFinal, alreadyCovered: covered(d.id) })
        : (cur?.value ?? ''),
    } }
  })
  const edit = (d, patch) => setSel(prev => ({ ...prev, [d.id]: { ...(selection[d.id] || { checked: true, mode: 'value', value: '' }), checked: true, ...patch } }))
  // switching บาท <-> % keeps the same deduction when the current one is valid
  const switchMode = (d, m) => {
    const s = selection[d.id] || {}
    if (s.mode === m) return
    const line = result.lines[d.id]
    let value = ''
    // 6 decimals, not 2: a rounded percent could miss the exact remainder by a satang and strand it
    if (line && m === 'percent' && receipt.total > 0) value = String(Math.round((line.gross / receipt.total) * 100 * 1e6) / 1e6)
    else if (line && m === 'value') value = String(line.gross)
    edit(d, { mode: m, value })
  }

  const confirm = async () => {
    if (!canConfirm || inFlight.current) return
    inFlight.current = true
    setBusy(true); setError('')
    let res
    try {
      res = await receivePoLines({
        poId: po.id, lineIds, receivedDate, deductions: result.deductions, subtotal: receipt.subtotal, vat: receipt.vat,
        stock: stock.map(s => ({ po_item_id: s.poItemId, base_qty: s.baseQty, unit_cost: s.unitCostPerBase })),
      })
    } catch (e) {
      // the RPC is atomic: nothing was saved, so the dialog stays open with the reason and the user may retry
      inFlight.current = false
      setError(mapPoReceiptRpcError(e)); setBusy(false)
      return
    }
    // saved: never re-enable confirm from here (a retry would receive again)
    onDone(res || {})
  }

  const { plan } = result
  const muted = { color: 'var(--text3)' }
  return (
    <Modal title={`รับของ — ${po.po_number}`} onClose={() => { if (busy) return false; onClose() }} maxWidth={620}>
      <div className="modal-body" style={{ display: 'grid', gap: 12, fontSize: 13 }}>
        <div>{po.suppliers?.name || '—'} · ยอดใบสั่งซื้อ <span className="font-mono">{fmt(poTotal)}</span> · รับแล้ว {receivedIds.size}/{allItems.length} รายการ</div>
        {!loaded && !ledgerError && <div style={muted}>⏳ กำลังโหลด...</div>}
        {ledgerError && <div style={{ color: 'var(--red)' }}>โหลดข้อมูลการรับของไม่สำเร็จ — ปิดแล้วเปิดใหม่</div>}
        {depError && <div role="alert" style={{ color: 'var(--red)' }}>โหลดข้อมูลมัดจำไม่สำเร็จ — ปิดแล้วเปิดใหม่</div>}
        {ownMissing && (
          <div role="alert" style={{ color: 'var(--red)' }}>
            มัดจำของใบสั่งซื้อนี้ ({ownLedger.deposit_invoice_no || 'มัดจำ'}) ยังมียอดคงเหลือแต่ใช้หักไม่ได้{ownSplit ? '' : ' (รายจ่ายมัดจำยังไม่แยก VAT)'} — แก้ที่หน้ารายจ่ายก่อน แล้วเปิดใหม่
          </div>
        )}
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
            <input type="radio" name="rcv-mode" checked={mode === 'all'} onChange={() => setMode('all')} /> รับทั้งหมด ({outstanding.length} รายการ)
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
            <input type="radio" name="rcv-mode" checked={mode === 'some'} onChange={() => setMode('some')} /> รับบางรายการ
          </label>
        </div>
        {mode === 'some' && (
          <div style={{ display: 'grid', gap: 4 }}>
            {allItems.map(it => {
              const done = receivedIds.has(it.id)
              return (
                <label key={it.id} style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: done ? 'default' : 'pointer', opacity: done ? 0.5 : 1 }}>
                  <input type="checkbox" aria-label={done ? `${it.description} (รับแล้ว)` : it.description} disabled={done || !loaded}
                    checked={!done && picked.has(it.id)}
                    onChange={e => { if (done) return; const on = e.target.checked; setPicked(prev => { const n = new Set(prev); if (on) n.add(it.id); else n.delete(it.id); return n }) }} />
                  <span style={{ flex: 1, minWidth: 0 }}>{it.description} ({it.quantity} {it.unit || ''}){done ? ' — รับแล้ว' : ''}</span>
                  <span className="font-mono">{fmt(it.line_total)}</span>
                </label>
              )
            })}
            {loaded && lineIds.length === 0 && <div style={{ color: 'var(--red)' }}>เลือกอย่างน้อย 1 รายการ</div>}
          </div>
        )}
        <div>
          <label className="label" htmlFor="rcv-date">วันที่รับสินค้า ★</label>
          <input id="rcv-date" aria-label="วันที่รับสินค้า" type="date" className="input" style={{ maxWidth: 220 }} max={today} value={receivedDate} onChange={e => setReceivedDate(e.target.value)} />
          {!receivedDate && <div style={{ color: 'var(--red)', marginTop: 2 }}>กรุณาเลือกวันที่รับสินค้า</div>}
          {receivedDate > today && <div style={{ color: 'var(--red)', marginTop: 2 }}>วันที่รับสินค้าต้องไม่เกินวันนี้</div>}
          <div style={{ ...muted, fontSize: 12, marginTop: 2 }}>บิลรายจ่ายใช้วันที่ใบสั่งซื้อ วันที่รับของใช้กับสต็อก</div>
        </div>
        <div>
          มูลค่ารับครั้งนี้: ก่อน VAT <span className="font-mono">{fmt(receipt.subtotal)}</span> · VAT <span className="font-mono">{fmt(receipt.vat)}</span> · รวม <span className="font-mono">{fmt(receipt.total)}</span>
          {receipt.isFinal && receivedIds.size > 0 && <span style={muted}> (ครั้งสุดท้าย — ปัดเศษให้ครบยอดใบสั่งซื้อ)</span>}
        </div>
        {deposits.length > 0 && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            <strong>หักมัดจำ</strong> <span style={{ ...muted, fontSize: 12 }}>(ยอดรวม VAT)</span>
            {deposits.map(d => {
              const s = selection[d.id] || {}
              const err = result.errors[d.id]
              const remGross = round2(Number(d.remaining.net) + Number(d.remaining.vat))
              const no = d.deposit_invoice_no || 'มัดจำ'
              return (
                <div key={d.id} style={{ marginTop: 6 }}>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                    <input type="checkbox" aria-label={`ใช้มัดจำ ${no}`} checked={!!s.checked} onChange={e => toggle(d, e.target.checked)} />
                    <span>{no}{d.id === ownId ? ' (มัดจำของใบสั่งซื้อนี้)' : ''} · คงเหลือ <span className="font-mono">{fmt(remGross)}</span>
                      {d.id === ownId && ownUnpaid && <span data-testid="own-deposit-unpaid" style={{ color: '#b45309', fontSize: 12 }}> (ยังไม่ได้จ่ายใบมัดจำ — อย่าลืมจ่ายใบมัดจำ)</span>}
                    </span>
                  </label>
                  {d.id === ownId && receipt.isFinal && lineIds.length > 0 && round2(remGross - (result.lines[d.id]?.gross || 0)) > 0.005 && (
                    <div data-testid="own-deposit-left" style={{ marginLeft: 22, color: '#b45309', fontSize: 12 }}>
                      รับครั้งสุดท้ายแล้ว แต่มัดจำของใบสั่งซื้อนี้จะเหลือ {fmt(round2(remGross - (result.lines[d.id]?.gross || 0)))} บาท ที่ไม่ได้หัก
                    </div>
                  )}
                  {s.checked && (
                    <div style={{ marginLeft: 22, marginTop: 4, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <button type="button" className={`btn btn-sm ${s.mode === 'value' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => switchMode(d, 'value')}>บาท</button>
                      <button type="button" className={`btn btn-sm ${s.mode === 'percent' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => switchMode(d, 'percent')}>%</button>
                      <input className="input font-mono" type="number" min="0" step="0.01" style={{ width: 140 }} aria-label={`ยอดหัก ${no}`}
                        value={s.value ?? ''} onChange={e => edit(d, { value: e.target.value })} />
                      <span>{s.mode === 'percent' ? '% ของมูลค่ารับครั้งนี้ (รวม VAT)' : 'บาท (รวม VAT)'}</span>
                      {result.lines[d.id] && (
                        <div style={{ ...muted, width: '100%' }}>หัก <span className="font-mono">{fmt(result.lines[d.id].gross)}</span> = ก่อน VAT {fmt(result.lines[d.id].net)} + VAT {fmt(result.lines[d.id].vat)} · คงเหลือก่อนหัก {fmt(remGross)} → หลังหัก <span className="font-mono">{fmt(round2(remGross - result.lines[d.id].gross))}</span></div>
                      )}
                      {err && <div style={{ color: 'var(--red)', width: '100%' }}>{DEDUCTION_INPUT_TEXT[err] || err}</div>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        <div style={{ fontWeight: 600 }}>
          {lineIds.length === 0
            ? <span style={muted}>ยังไม่ได้เลือกรายการ</span>
            : result.receiptBad
              ? <span style={{ color: 'var(--red)' }}>{result.deductions.length > 0 ? 'มูลค่าการรับครั้งนี้ติดลบจากการปัดเศษ — ไม่สามารถหักมัดจำในการรับครั้งนี้' : 'มูลค่าการรับครั้งนี้ติดลบ — ติดต่อผู้ดูแลระบบ'}</span>
            : (plan.overNet || plan.overVat)
              ? <span style={{ color: 'var(--red)' }}>{plan.overVat && !plan.overNet ? 'VAT ที่หักเกิน VAT ของการรับครั้งนี้' : 'ยอดหักเกินมูลค่าที่รับครั้งนี้'}</span>
              : plan.createExpense
                ? <>บิลที่จะสร้าง: ก่อน VAT <span className="font-mono">{fmt(plan.netToPay)}</span> · VAT <span className="font-mono">{fmt(plan.vatToPay)}</span> · ยอดชำระ <span className="font-mono">{fmt(plan.total)}</span></>
                : result.deductions.length > 0 ? 'ไม่สร้างบิล (หักครบ)' : 'ไม่สร้างบิล (มูลค่า 0 บาท)'}
          {lineIds.length > 0 && <div style={{ ...muted, fontWeight: 400, fontSize: 12 }}>ยอดที่บันทึกจริงคำนวณโดยระบบ อาจต่างจากที่แสดง ±0.01 บาท (ปัดเศษ)</div>}
        </div>
        {po.stock_from_invoice && <div style={{ color: '#b45309' }}>📦 ไม่ลงสต็อกตอนรับของ — สต็อกจะเข้าเมื่อบันทึกใบกำกับภาษีผู้ขาย</div>}
        {!po.stock_from_invoice && stock.length > 0 && (
          <div style={{ fontSize: 12, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            <strong>จะบันทึกเข้าสต็อก (วันที่ {receivedDate || '—'}):</strong>
            {stock.map(p => {
              if (!(p.baseQty > 0)) return <div key={p.poItemId} style={{ marginTop: 4, color: 'var(--red)' }}>⚠️ {p.name}: จำนวนลงสต็อกเป็น 0 — แก้รายการก่อนรับของ</div>
              if (p.unconverted) return <div key={p.poItemId} style={{ marginTop: 4, color: 'var(--red)' }}>⚠️ {p.name}: ไม่พบข้อมูลหน้าตัด/ขนาดที่ต้องใช้แปลงหน่วย — จะบันทึกเป็น {fmt(p.baseQty)} {p.baseUnit} (อาจไม่ถูกต้อง) กรุณาตรวจสอบก่อนยืนยัน</div>
              const bal = (stockBalances || []).find(b => b.inventory_item_id === p.inventoryItemId && b.site_id === po.site_id)
              const oldQty = Number(bal?.quantity_on_hand || 0)
              const newWac = computeWeightedAverageCost(oldQty, Number(bal?.weighted_average_cost || 0), p.baseQty, p.unitCostPerBase)
              return <div key={p.poItemId} style={{ marginTop: 4 }}>📦 {p.name}: +{fmt(p.baseQty)} {p.baseUnit} → คงเหลือ {fmt(oldQty + p.baseQty)} {p.baseUnit} @ เฉลี่ย {fmt(newWac)}/{p.baseUnit}</div>
            })}
          </div>
        )}
        {error && <div role="alert" style={{ color: 'var(--red)' }}>{error}</div>}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>ยกเลิก</button>
        <button type="button" className="btn btn-primary" disabled={!canConfirm} onClick={confirm}>{busy ? '⏳ ' : ''}✅ ยืนยันรับของ</button>
      </div>
    </Modal>
  )
}
