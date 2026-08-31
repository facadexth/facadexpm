// ============================================================
// Invoices — ใบแจ้งหนี้ (progress billing against a signed quotation)
// ✅ One invoice always bills exactly one accepted quotation with a site
// ✅ Work-completion % tracked per physical unit (quotation_item_units),
//    the single source of truth both โหมดง่าย and โหมดละเอียด read/write
// ✅ โหมดง่าย (default): tick = 100% of what's left, or type a quantity.
//    โหมดละเอียด: per-unit % control, one row per physical unit (2.1, 2.2, ...)
// ✅ Area-type lines (large/fractional quantity) always bill in their own
//    unit, never fragment, ignore the mode switch entirely
// ✅ Status: unpaid -> paid (reconciles into incomes, Task 8) | void
//    (reverses the ledger, Task 8) -- PDF export in Task 9
// ============================================================
import { useState, useMemo, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { useInvoices, useQuotationItemUnits, useQuotations, useSites, useReceipts, useInvoicePhotos, useDocumentReceipt } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { useTenant } from '../hooks/useTenant.js'
import { calcDepositDeduction, round2 } from '../lib/depositCalc.js'
import { canEditPage } from '../lib/permissions.js'
import { fmt, fmtDate } from '../lib/supabase.js'
import { auditLog } from '../lib/audit.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import SearchableSelect from '../components/SearchableSelect.jsx'
import { format, startOfYear, endOfYear } from 'date-fns'
import { isCountable, waterfall, openQty, drawQty, drawAmount, calcInvoiceTotals, VAT_RATE } from '../lib/invoiceCalc.js'
import { calcQuotationTotals } from '../lib/quotationCalc.js'
import { downloadPDF, downloadJPG } from '../lib/pdf.js'
import SignLinkModal from '../components/SignLinkModal.jsx'

const siteOpts = (sites) => (sites || []).map(s => ({
  value: s.id, label: `${s.site_number} · ${s.name}`, keywords: `${s.site_number} ${s.name}`,
}))

const INV_STATUSES = ['unpaid', 'paid', 'void']
const INV_STATUS_LABELS = { unpaid: '🕓 ยังไม่ชำระ', paid: '✅ ชำระแล้ว', void: '✕ ยกเลิก' }

// One entry per quotation_item: { quotationItemId, description, unit,
// unitPrice, totalQty, units: [{ id, unitIndex, unitQty, cumulativePct,
// target }] }. `checked` (โหมดง่าย full-remaining lock) lives per entry.
function buildLineState(quotationItems, unitsByQuotationItem, priceMultiplier) {
  return (quotationItems || []).map(qi => {
    const rawUnits = unitsByQuotationItem[qi.id] || []
    const units = rawUnits.map(u => ({
      id: u.id, unitIndex: u.unit_index, unitQty: u.unit_qty, cumulativePct: u.cumulative_pct,
      target: u.cumulative_pct < 100 ? 100 : u.cumulative_pct,
    }))
    return {
      quotationItemId: qi.id, description: qi.description, unit: qi.unit,
      unitPrice: round2(qi.unit_price * priceMultiplier), totalQty: qi.quantity, checked: true, units,
    }
  })
}

// The quotation's discount lives only at the header level (quotationCalc.js
// applies it to rawTotal, but quotation_items.line_total is stored
// UNDISCOUNTED) -- so invoicing must derive a per-quotation price
// multiplier and apply it to every line's unit price, or invoices bill the
// full undiscounted amount regardless of any discount the client agreed to.
// Reuses calcQuotationTotals (not reimplemented) so this stays exactly in
// sync with how the quotation's own printed total is computed.
function discountMultiplier(quotation) {
  const items = quotation.quotation_items || []
  const rawTotal = items.reduce((s, it) => s + (it.line_total || 0), 0)
  if (rawTotal <= 0) return 1
  const totals = calcQuotationTotals(items, {
    hasVat: false, // hasVat:false makes `subtotal` equal the discounted raw total exactly, before any VAT math -- that's the ratio we need
    discountAmount: quotation.discount_amount,
    discountPct: quotation.discount_pct,
  })
  return totals.subtotal / rawTotal
}

function InvoiceItemsEditor({ lines, onChange, mode, onModeChange }) {
  // Raw in-progress text for the two number inputs below, keyed by line
  // (qty) and by `lineId:unitIndex` (per-unit %). Both inputs otherwise
  // display a value re-derived from the unit ledger on every render, which
  // clobbers a half-typed decimal: after typing "12." the ledger still
  // reads 12, so React would rewrite the field back to "12" and the user
  // could never type past the decimal point. The draft wins while an edit
  // is in progress and is dropped on blur, so the ledger stays the single
  // source of truth everywhere else.
  //
  // Both inputs also need step="any", not step="1" -- an integer step on
  // type="number" makes some browsers (confirmed: this exact symptom,
  // typing stopping dead right after the decimal point) reject or discard
  // the "." keystroke at the native control level, before it ever reaches
  // this component's onChange. The draft-state fix above can't help with
  // that: it never sees a keystroke the browser itself swallowed.
  const [qtyDrafts, setQtyDrafts] = useState({})
  const [amtDrafts, setAmtDrafts] = useState({})
  const [pctDrafts, setPctDrafts] = useState({})
  // Any programmatic change to the ledger (ticking a box) invalidates every
  // in-progress draft -- keeping one around would show a stale number after
  // the box is unticked again.
  const clearDrafts = () => { setQtyDrafts({}); setAmtDrafts({}); setPctDrafts({}) }

  const setLine = (qiId, updater) => onChange(lines.map(l => l.quotationItemId === qiId ? updater(l) : l))

  const toggleChecked = (qiId, checked) => {
    clearDrafts()
    setLine(qiId, l => ({
      ...l, checked, units: checked ? waterfall(l.units, openQty(l.units)) : l.units,
    }))
  }
  const setQty = (qiId, qty) => setLine(qiId, l => {
    const max = openQty(l.units)
    const clamped = Math.max(0, Math.min(max, qty))
    return { ...l, units: waterfall(l.units, clamped) }
  })
  // กรอกจำนวนเงิน (บาท) ที่ต้องการเรียกเก็บสำหรับรายการนี้โดยตรง แทนที่จะต้อง
  // แปลงเป็นจำนวนหน่วยเอง -- ตัวเลือกนี้อยู่แยกจาก "กรอกยอดที่ต้องการเรียกเก็บ"
  // ของทั้งใบแจ้งหนี้ (ซึ่งกระจายสัดส่วนให้ทุกรายการพร้อมกัน) เพราะเมื่อมีหลาย
  // รายการในใบเดียว การกระจายอัตโนมัติทั้งใบดูสับสน -- ผู้ใช้อยากคุมทีละ
  // รายการโดยตรงมากกว่า
  const setAmount = (qiId, amount) => setLine(qiId, l => {
    const max = openQty(l.units)
    const qty = l.unitPrice > 0 ? amount / l.unitPrice : 0
    const clamped = Math.max(0, Math.min(max, qty))
    return { ...l, units: waterfall(l.units, clamped) }
  })
  const setUnitTarget = (qiId, unitIndex, target) => setLine(qiId, l => ({
    ...l,
    units: l.units.map(u => u.unitIndex === unitIndex
      ? { ...u, target: Math.max(u.cumulativePct, Math.min(100, target)) }
      : u),
  }))

  const billableLines = lines.filter(l => openQty(l.units) > 0)
  const allChecked = billableLines.length > 0 && billableLines.every(l => l.checked)

  const toggleAll = (checked) => {
    clearDrafts()
    onChange(lines.map(l => {
      if (openQty(l.units) <= 0) return l
      return { ...l, checked, units: checked ? waterfall(l.units, openQty(l.units)) : l.units }
    }))
  }

  const subtotal = lines.reduce((s, l) => s + drawAmount(l.units, l.unitPrice), 0)

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <button type="button" className={`btn btn-sm ${mode === 'easy' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => onModeChange('easy')}>โหมดง่าย</button>
        <button type="button" className={`btn btn-sm ${mode === 'advanced' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => onModeChange('advanced')}>โหมดละเอียด</button>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontSize: 13, fontWeight: 600 }}>
        <input type="checkbox" checked={allChecked} onChange={e => toggleAll(e.target.checked)} />
        เลือกทั้งหมด
      </label>

      <div style={{ display: 'grid', gap: 10 }}>
        {lines.map((l, no) => {
          const remaining = openQty(l.units)
          const fullyBilled = remaining <= 0
          const totalValue = l.unitPrice * l.totalQty
          const lineAmount = drawAmount(l.units, l.unitPrice)
          const showAdvanced = mode === 'advanced' && isCountable(l.totalQty) && l.units.length > 1
          const isMixed = l.units.length > 1 && l.units.some(u => u.cumulativePct !== l.units[0].cumulativePct)

          if (fullyBilled) {
            return (
              <div key={l.quotationItemId} style={{ display: 'grid', gridTemplateColumns: '28px 1fr 100px', gap: 8, alignItems: 'center', padding: '8px 0', opacity: 0.5 }}>
                <span style={{ fontSize: 12, color: 'var(--text3)' }}>{no + 1}</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{l.description}</div>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>{l.totalQty} {l.unit} × {fmt(l.unitPrice)} = {fmt(totalValue)} บาท</div>
                </div>
                <span className="badge badge-accepted" style={{ justifySelf: 'end' }}>เรียกเก็บครบแล้ว</span>
              </div>
            )
          }

          return (
            <div key={l.quotationItemId} style={{ borderBottom: '1px solid var(--border)', paddingBottom: 10 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '28px 1fr 90px 100px', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--text3)' }}>{no + 1}</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{l.description}</div>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                    {l.totalQty} {l.unit} × {fmt(l.unitPrice)} = {fmt(totalValue)} บาท · เหลือ {fmt(remaining)} {l.unit}
                    {isMixed && !showAdvanced && <span style={{ fontStyle: 'italic' }}> · เฉลี่ยจากความคืบหน้าที่ไม่เท่ากันต่อชิ้น</span>}
                  </div>
                </div>
                {showAdvanced ? (
                  <span style={{ fontSize: 12, color: 'var(--text3)', fontStyle: 'italic', textAlign: 'right' }}>{fmt(drawQty(l.units))} {l.unit}</span>
                ) : (
                  <input type="number" min="0" max={remaining} step="any" className="input input-sm"
                    style={{ textAlign: 'right' }}
                    value={qtyDrafts[l.quotationItemId] ?? String(drawQty(l.units))}
                    disabled={l.checked}
                    onChange={e => {
                      const raw = e.target.value
                      setQtyDrafts(d => ({ ...d, [l.quotationItemId]: raw }))
                      const v = parseFloat(raw)
                      if (!isNaN(v)) setQty(l.quotationItemId, Math.max(0, Math.min(remaining, v)))
                    }}
                    onBlur={() => setQtyDrafts(d => {
                      const next = { ...d }
                      delete next[l.quotationItemId]
                      return next
                    })} />
                )}
                {showAdvanced ? (
                  <span className="font-mono" style={{ fontWeight: 700, textAlign: 'right' }}>{fmt(lineAmount)}</span>
                ) : (
                  <input type="number" min="0" max={remaining * l.unitPrice} step="any"
                    className="input input-sm font-mono" title="กรอกจำนวนเงินที่ต้องการเรียกเก็บสำหรับรายการนี้"
                    style={{ textAlign: 'right', fontWeight: 700, color: l.checked ? 'var(--accent)' : undefined }}
                    value={amtDrafts[l.quotationItemId] ?? String(round2(lineAmount))}
                    disabled={l.checked}
                    onChange={e => {
                      const raw = e.target.value
                      setAmtDrafts(d => ({ ...d, [l.quotationItemId]: raw }))
                      const v = parseFloat(raw)
                      if (!isNaN(v)) setAmount(l.quotationItemId, Math.max(0, Math.min(remaining * l.unitPrice, v)))
                    }}
                    onBlur={() => setAmtDrafts(d => {
                      const next = { ...d }
                      delete next[l.quotationItemId]
                      return next
                    })} />
                )}
              </div>
              {!showAdvanced && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, marginLeft: 36, fontSize: 11, color: 'var(--text3)' }}>
                  <input type="checkbox" checked={l.checked} onChange={e => toggleChecked(l.quotationItemId, e.target.checked)} />
                  เก็บเต็มจำนวนที่เหลือ ({fmt(remaining)} {l.unit})
                </label>
              )}
              {showAdvanced && (
                <div style={{ marginLeft: 36, marginTop: 6, display: 'grid', gap: 4 }}>
                  {l.units.map(u => {
                    const label = `${no + 1}.${u.unitIndex + 1}`
                    if (u.cumulativePct >= 100) {
                      return (
                        <div key={u.unitIndex} style={{ display: 'grid', gridTemplateColumns: '40px 1fr 80px', gap: 8, fontSize: 11, color: 'var(--text3)', opacity: 0.6 }}>
                          <span>{label}</span><span>เสร็จสมบูรณ์แล้ว</span><span style={{ textAlign: 'right' }}>ครบแล้ว</span>
                        </div>
                      )
                    }
                    const amount = (u.target - u.cumulativePct) / 100 * u.unitQty * l.unitPrice
                    return (
                      <div key={u.unitIndex} style={{ display: 'grid', gridTemplateColumns: '40px 1fr 90px 90px', gap: 8, alignItems: 'center', fontSize: 12 }}>
                        <span style={{ color: 'var(--text3)' }}>{label}</span>
                        <span style={{ color: 'var(--text3)' }}>{u.cumulativePct > 0 ? `เดิม ${u.cumulativePct}%` : 'ยังไม่เริ่ม'}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifySelf: 'end' }}>
                          <input type="number" min={u.cumulativePct} max="100" step="any" className="input input-sm"
                            style={{ width: 60, textAlign: 'right' }}
                            value={pctDrafts[`${l.quotationItemId}:${u.unitIndex}`] ?? String(u.target)}
                            onChange={e => {
                              const raw = e.target.value
                              setPctDrafts(d => ({ ...d, [`${l.quotationItemId}:${u.unitIndex}`]: raw }))
                              const v = parseFloat(raw)
                              if (!isNaN(v)) setUnitTarget(l.quotationItemId, u.unitIndex, Math.max(u.cumulativePct, Math.min(100, v)))
                            }}
                            onBlur={() => setPctDrafts(d => {
                              const next = { ...d }
                              delete next[`${l.quotationItemId}:${u.unitIndex}`]
                              return next
                            })} />
                          <span style={{ fontSize: 11, color: 'var(--text3)' }}>%</span>
                        </div>
                        <span className="font-mono" style={{ textAlign: 'right', color: amount === 0 ? 'var(--text3)' : 'var(--accent)' }}>{amount === 0 ? '—' : fmt(amount)}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div style={{ marginTop: 12, textAlign: 'right', fontWeight: 700, fontSize: 15 }}>
        รวมงวดนี้: <span className="font-mono" style={{ color: 'var(--accent)' }}>{fmt(subtotal)}</span> บาท
      </div>
    </div>
  )
}

function CreateInvoiceModal({ quotation, site, onClose, onSaved }) {
  const items = quotation.quotation_items || []
  const { data: unitsByQuotationItem, loading: unitsLoading, error: unitsError } = useQuotationItemUnits(quotation.id, items)
  const [lines, setLines] = useState(null)
  const [mode, setMode] = useState('easy')
  const [saving, setSaving] = useState(false)
  // วันออกเอกสาร -- separate from วันที่รับเงิน, which only gets set later
  // when the invoice is actually marked paid (see MarkPaidModal).
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'))

  // "กรอกยอดที่ต้องการเรียกเก็บ" -- ผู้ใช้พิมพ์ยอดสุทธิที่อยากได้จริง (หลัง VAT
  // และหัก ณ ที่จ่าย) แทนที่จะต้องคำนวณ % เองด้วยเครื่องคิดเลข (100000/1.04 ฯลฯ)
  // ระบบคำนวณย้อนกลับเป็นยอดที่ต้องกดในแต่ละรายการให้ แล้วกระจายเท่าๆ กัน
  // ตามสัดส่วนมูลค่าที่เหลือของแต่ละรายการ -- กรอกครั้งเดียว เห็นผลเป็นจำนวน/
  // บาทจริงในแต่ละแถวเหมือนเดิม ไม่ต้องยุ่งกับ % เลย
  const [targetNet, setTargetNet] = useState('')
  const [includeWht, setIncludeWht] = useState(true)
  const [whtPct, setWhtPct] = useState(site?.default_tax_withheld_pct ?? 3)

  useEffect(() => {
    if (unitsByQuotationItem && !lines) {
      setLines(buildLineState(items, unitsByQuotationItem, discountMultiplier(quotation)))
    }
  }, [unitsByQuotationItem]) // eslint-disable-line react-hooks/exhaustive-deps

  if (unitsError) {
    return <Modal title={`สร้างใบแจ้งหนี้ — ${quotation.quotation_number}`} onClose={onClose} maxWidth={760}><div className="modal-body">เกิดข้อผิดพลาดในการโหลดข้อมูล: {unitsError}</div></Modal>
  }
  if (unitsLoading || !lines) {
    return <Modal title={`สร้างใบแจ้งหนี้ — ${quotation.quotation_number}`} onClose={onClose} maxWidth={760}><div className="modal-body">⏳ กำลังโหลด...</div></Modal>
  }

  const billedLines = lines.filter(l => drawQty(l.units) > 1e-9)
  // round2 here for the same reason handleSave rounds before persisting
  // (Fix 7): the header subtotal must equal the SUM of the line_totals
  // actually stored, or a printed invoice's line items visibly fail to add
  // up to its own total by a satang.
  const invoiceItemsForTotals = billedLines.map(l => ({ line_total: round2(drawAmount(l.units, l.unitPrice)) }))
  const totals = calcInvoiceTotals(invoiceItemsForTotals, { hasVat: quotation.has_vat, priceIncludesVat: quotation.price_includes_vat })
  // ยอดสุทธิจริงที่จะได้รับ ณ ตอนนี้ (หลัง VAT ถ้ามี แล้วหักภาษี ณ ที่จ่ายถ้าติ๊กไว้)
  // -- โชว์ไว้ให้เห็นผลจริงหลังกดเติมอัตโนมัติ หรือหลังปรับมือเองต่อ
  //
  // หัก ณ ที่จ่ายคิดจากมูลค่างานก่อน VAT (subtotal) เสมอ ไม่ใช่จากยอดรวมหลัง VAT
  // -- ตามหลักจริง (WHT คิดจากค่าจ้าง/ค่าบริการ ไม่รวม VAT) ดังนั้น
  // net = total (รวม VAT ถ้ามี) - subtotal*wht% ตัวอย่างที่ user ใช้เอง:
  // VAT 7% หัก ณ ที่จ่าย 3% -> net = subtotal*(1.07-0.03) = subtotal*1.04
  // (เทียบเท่ากับ 100000/1.04 ที่ user คำนวณด้วยเครื่องคิดเลขเอง)
  const effectiveWhtPct = includeWht ? (parseFloat(whtPct) || 0) : 0
  const achievedNet = round2(totals.total - totals.subtotal * effectiveWhtPct / 100)

  // กรอกยอดสุทธิที่ต้องการ -> คำนวณย้อนกลับเป็นยอดที่ต้องกด โดยกลับสมการ
  // achievedNet ด้านบนตามความสัมพันธ์ระหว่าง drawn amount (target) กับ
  // subtotal/total ในแต่ละกรณีของ calcInvoiceTotals:
  //   ไม่มี VAT:        target = subtotal = total  -> net = target(1-wht)
  //   VAT รวมในราคา:    target = total             -> net = target(1 - wht/(1+VAT_RATE))
  //   VAT แยกจากราคา:   target = subtotal          -> net = target(1+VAT_RATE-wht)
  // แล้วกระจายเท่าๆ กันตามสัดส่วนมูลค่าที่เหลือของแต่ละรายการ
  // (ครอบที่ 100% ของยอดที่เหลือทั้งหมด ไม่มีทางเกิน)
  const applyTargetFill = () => {
    const net = parseFloat(targetNet)
    if (!net || net <= 0) return
    const whtFraction = effectiveWhtPct / 100
    let target
    if (!quotation.has_vat) {
      target = net / (1 - whtFraction)
    } else if (quotation.price_includes_vat) {
      target = net / (1 - whtFraction / (1 + VAT_RATE))
    } else {
      target = net / (1 + VAT_RATE - whtFraction)
    }

    const totalOpenValue = lines.reduce((s, l) => s + openQty(l.units) * l.unitPrice, 0)
    if (totalOpenValue <= 0) return
    const pct = Math.min(1, target / totalOpenValue)

    setMode('easy')
    setLines(lines.map(l => {
      const remaining = openQty(l.units)
      if (remaining <= 0) return l
      return { ...l, checked: false, units: waterfall(l.units, remaining * pct) }
    }))
  }

  const handleSave = async () => {
    if (!billedLines.length) { alert('กรุณาเลือกอย่างน้อย 1 รายการ'); return }
    setSaving(true)
    // Captured so the catch below can name the orphan: the invoices row is
    // written before its items/draws, so a mid-loop failure leaves a real,
    // partially-populated invoice the user has to void before retrying.
    let createdInvoiceNumber = null
    try {
      const { data: invoice, error: invError } = await supabase.from('invoices').insert({
        quotation_id: quotation.id, site_id: quotation.site_id, date,
        has_vat: quotation.has_vat, price_includes_vat: quotation.price_includes_vat,
        subtotal: totals.subtotal, vat: totals.vat, total: totals.total,
      }).select().single()
      if (invError) throw invError
      createdInvoiceNumber = invoice.invoice_number
      await auditLog('invoices', invoice.id, 'INSERT', null, { quotation_id: quotation.id, total: totals.total })

      for (const [sortOrder, l] of billedLines.entries()) {
        const lineDrawQty = drawQty(l.units)
        // Waterfall-derived floats, unlike a user-typed decimal, are not
        // guaranteed to land on a clean 2-decimal value -- round before
        // persisting so the stored line/draw amounts can't drift from the
        // invoice's own already-rounded subtotal.
        const lineAmount = round2(drawAmount(l.units, l.unitPrice))
        const { data: invoiceItem, error: itemError } = await supabase.from('invoice_items').insert({
          invoice_id: invoice.id, quotation_item_id: l.quotationItemId,
          description: l.description, unit: l.unit, unit_price: l.unitPrice,
          draw_qty: lineDrawQty, line_total: lineAmount, sort_order: sortOrder,
        }).select().single()
        if (itemError) throw itemError

        for (const u of l.units) {
          if (u.target === u.cumulativePct) continue
          const drawAmt = round2((u.target - u.cumulativePct) / 100 * u.unitQty * l.unitPrice)
          const { error: drawError } = await supabase.from('invoice_item_draws').insert({
            invoice_item_id: invoiceItem.id, quotation_item_unit_id: u.id,
            prior_pct: u.cumulativePct, target_pct: u.target, amount: drawAmt,
          })
          if (drawError) throw drawError

          const { data: updateResult, error: updateError } = await supabase.from('quotation_item_units')
            .update({ cumulative_pct: u.target, updated_at: new Date().toISOString() })
            .eq('id', u.id)
            .eq('cumulative_pct', u.cumulativePct)
            .select('id')
          if (updateError) throw updateError
          if (!updateResult || updateResult.length === 0) {
            throw new Error('รายการนี้ถูกแก้ไขโดยผู้ใช้อื่นระหว่างที่คุณกำลังสร้างใบแจ้งหนี้ กรุณาปิดหน้าต่างนี้แล้วลองใหม่')
          }
        }
      }

      onSaved()
    } catch (e) {
      const recovery = createdInvoiceNumber
        ? ` ระบบได้สร้างใบแจ้งหนี้เลขที่ ${createdInvoiceNumber} ไปบางส่วนแล้ว กรุณากดปุ่ม "✕ ยกเลิก" ใบแจ้งหนี้นี้แล้วลองสร้างใหม่อีกครั้ง`
        : ''
      alert('บันทึกไม่สำเร็จ: ' + e.message + recovery)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`สร้างใบแจ้งหนี้ — ${quotation.quotation_number}`} onClose={onClose} maxWidth={760}>
      <div className="modal-body">
        <div style={{ marginBottom: 12 }}>
          <label className="label">วันที่ออกเอกสาร</label>
          <input type="date" className="input" style={{ maxWidth: 200 }} value={date} onChange={e => setDate(e.target.value)} />
        </div>

        <InvoiceItemsEditor lines={lines} onChange={setLines} mode={mode} onModeChange={setMode} />
        <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: 8, padding: '10px 14px', fontSize: 13, marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>รวมงวดนี้ (ก่อน VAT)</span><span className="font-mono">{fmt(totals.subtotal)}</span></div>
          {quotation.has_vat && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>VAT (7%)</span><span className="font-mono">{fmt(totals.vat)}</span></div>}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4 }}><span>รวมเรียกเก็บงวดนี้</span><span className="font-mono" style={{ color: 'var(--accent)' }}>{fmt(totals.total)}</span></div>
        </div>

        <div className="card card-body" style={{ marginTop: 12, display: 'grid', gap: 8 }}>
          <label className="label" style={{ marginBottom: 0 }}>กรอกยอดที่ต้องการเรียกเก็บ (สุทธิ หลัง VAT และหัก ณ ที่จ่าย)</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="number" min="0" step="any" className="input input-sm" style={{ width: 160 }}
              placeholder="เช่น 100000" value={targetNet} onChange={e => setTargetNet(e.target.value)}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text2)' }}>
              <input type="checkbox" checked={includeWht} onChange={e => setIncludeWht(e.target.checked)} />
              รวมหัก ณ ที่จ่าย
            </label>
            {includeWht && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="number" min="0" max="100" step="any" className="input input-sm" style={{ width: 60 }}
                  value={whtPct} onChange={e => setWhtPct(e.target.value)} />
                <span style={{ fontSize: 12, color: 'var(--text3)' }}>%</span>
              </div>
            )}
            <button type="button" className="btn btn-sm btn-primary" onClick={applyTargetFill} disabled={!targetNet}>
              🎯 เติมให้อัตโนมัติ
            </button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>
            ยอดสุทธิที่จะได้จริงจากรายการที่เลือกอยู่ตอนนี้: <strong style={{ color: 'var(--accent)' }}>{fmt(achievedNet)}</strong> บาท
          </div>
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onClose}>ยกเลิก</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSave}>
          {saving ? '⏳...' : '✅ สร้างใบแจ้งหนี้'}
        </button>
      </div>
    </Modal>
  )
}

// Design A letterhead -- same pattern as QuotationPaper (Quotations.jsx)
// and PODocumentModal: logo-or-colored-box header, tag+title top right,
// bordered info-fields grid, client block, #f4f3ff table header, #6c63ff
// totals rule, #f9f9fc notes box, signature lines. Shared between
// InvoiceDocumentModal and ReceiptDocumentModal specifically (they're the
// same billing family, one combined document per the spec) -- unlike
// Quotation/PO, which stay separate top-level document types and keep
// their own independent copy of this JSX per existing precedent.
function DocumentPaper({ elementId, tenant, tag, title, infoFields, siteName, clientName, clientAddress, clientTaxId, items, totalsLabel, totalsAmount, subtotal, vat, hasVat, withholdingTaxPct, withholdingTaxAmount, isWithholdingEstimate, notesBlock, signatures, recipientSignature }) {
  return (
    <div id={elementId} style={{ fontFamily: 'Sarabun,sans-serif', padding: '40px 44px', background: '#fff', color: '#17181f' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 20 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          {tenant?.logo_url
            ? <img src={tenant.logo_url} alt="" style={{ width: 40, height: 40, objectFit: 'contain', flexShrink: 0 }} crossOrigin="anonymous" />
            : <div style={{ width: 40, height: 40, borderRadius: 8, background: '#6c63ff', flexShrink: 0 }} />}
          <div>
            <div style={{ fontSize: 17, fontWeight: 800 }}>{tenant?.company_name}</div>
            <div style={{ fontSize: 11, color: '#6a6f85', lineHeight: 1.6, marginTop: 2 }}>
              {tenant?.address}
              {tenant?.address && <br />}
              {tenant?.tax_id && `เลขผู้เสียภาษี ${tenant.tax_id}`}
              {tenant?.tax_id && tenant?.phone && ' · '}
              {tenant?.phone && `โทร ${tenant.phone}`}
            </div>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#6c63ff', border: '1px solid #6c63ff', borderRadius: 4, padding: '2px 8px', display: 'inline-block', marginBottom: 6 }}>ต้นฉบับ</div>
          <div style={{ fontSize: 22, fontWeight: 800 }}>{title}</div>
        </div>
      </div>

      <div style={{ marginTop: 20, border: '1px solid #e4e6ef', borderRadius: 8, padding: '14px 16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 24px', fontSize: 12 }}>
        {infoFields.map(f => (
          <div key={f.label}><span style={{ color: '#6a6f85' }}>{f.label}</span><br />{f.value}</div>
        ))}
      </div>

      <div style={{ marginTop: 16, fontSize: 12.5, lineHeight: 1.9, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px' }}>
        <span style={{ color: '#6a6f85' }}>ไซท์งาน</span><strong>{siteName || '—'}</strong>
        <span style={{ color: '#6a6f85' }}>ลูกค้า</span><strong>{clientName || '—'}</strong>
        {clientTaxId && <><span style={{ color: '#6a6f85' }}>เลขประจำตัวผู้เสียภาษี</span><span>{clientTaxId}</span></>}
        {clientAddress && <><span style={{ color: '#6a6f85' }}>ที่อยู่</span><span>{clientAddress}</span></>}
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 18 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: '9px 8px', fontSize: 11, color: '#4a4d63', background: '#f4f3ff', borderBottom: '2px solid #6c63ff' }}>รายการ</th>
            <th style={{ textAlign: 'right', padding: '9px 8px', fontSize: 11, color: '#4a4d63', background: '#f4f3ff', borderBottom: '2px solid #6c63ff' }}>จำนวน</th>
            <th style={{ textAlign: 'right', padding: '9px 8px', fontSize: 11, color: '#4a4d63', background: '#f4f3ff', borderBottom: '2px solid #6c63ff' }}>ราคา/หน่วย</th>
            <th style={{ textAlign: 'right', padding: '9px 8px', fontSize: 11, color: '#4a4d63', background: '#f4f3ff', borderBottom: '2px solid #6c63ff' }}>รวม</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={it.id || i}>
              <td style={{ padding: '9px 8px', borderBottom: '1px solid #eee' }}>{it.description}</td>
              <td style={{ textAlign: 'right', padding: '9px 8px', borderBottom: '1px solid #eee' }}>{fmt(it.draw_qty).replace(/\.00$/, '')} {it.unit || ''}</td>
              <td style={{ textAlign: 'right', padding: '9px 8px', borderBottom: '1px solid #eee' }}>{fmt(it.unit_price)}</td>
              <td style={{ textAlign: 'right', padding: '9px 8px', borderBottom: '1px solid #eee' }}>{fmt(it.line_total)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
        <table style={{ width: 260, fontSize: 12.5 }}>
          <tbody>
            {subtotal != null && (
              <tr><td style={{ padding: '5px 4px', color: '#6a6f85' }}>รวมก่อน VAT</td><td style={{ textAlign: 'right', padding: '5px 4px' }}>{fmt(subtotal)}</td></tr>
            )}
            {hasVat && vat != null && (
              <tr><td style={{ padding: '5px 4px', color: '#6a6f85' }}>VAT (7%)</td><td style={{ textAlign: 'right', padding: '5px 4px' }}>{fmt(vat)}</td></tr>
            )}
            <tr>
              <td style={{ padding: '10px 4px 4px', fontWeight: 800, fontSize: 15, color: '#6c63ff', borderTop: '2px solid #6c63ff' }}>{totalsLabel}</td>
              <td style={{ textAlign: 'right', padding: '10px 4px 4px', fontWeight: 800, fontSize: 15, color: '#6c63ff', borderTop: '2px solid #6c63ff' }}>{fmt(totalsAmount)} บาท</td>
            </tr>
            {withholdingTaxAmount > 0 && (
              <>
                <tr>
                  <td style={{ padding: '5px 4px', color: '#c0392b' }}>
                    หัก ณ ที่จ่าย ({withholdingTaxPct}%){isWithholdingEstimate ? ' (ประมาณการ)' : ''}
                  </td>
                  <td style={{ textAlign: 'right', padding: '5px 4px', color: '#c0392b' }}>({fmt(withholdingTaxAmount)})</td>
                </tr>
                <tr>
                  <td style={{ padding: '8px 4px 4px', fontWeight: 700, fontSize: 13, borderTop: '1px solid #e4e6ef' }}>ยอดรับสุทธิ</td>
                  <td style={{ textAlign: 'right', padding: '8px 4px 4px', fontWeight: 700, fontSize: 13, borderTop: '1px solid #e4e6ef' }}>{fmt(totalsAmount - withholdingTaxAmount)} บาท</td>
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>

      {notesBlock}

      <div style={{ marginTop: 44, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, textAlign: 'center', fontSize: 11.5 }}>
        <div style={{ borderTop: '1px solid #999', paddingTop: 8 }}>{signatures[0]}</div>
        <div style={{ borderTop: '1px solid #999', paddingTop: recipientSignature ? 4 : 8 }}>
          {recipientSignature && (
            <img src={recipientSignature.url} alt="" crossOrigin="anonymous"
              style={{ height: 36, display: 'block', margin: '0 auto 4px' }} />
          )}
          {signatures[1]}
          {recipientSignature && (
            <div style={{ marginTop: 2, color: '#6a6f85', fontSize: 10 }}>
              {recipientSignature.signerName} · เซ็นเมื่อ {new Date(recipientSignature.signedAt).toLocaleDateString('th-TH')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// เมื่อชำระแล้ว ตัวเลขจริงมาจาก incomes.tax_withheld ที่ handleMarkPaid
// คำนวณไว้แล้ว (ที่มา: sites.default_tax_withheld_pct ณ วันที่ชำระ) --
// เชื่อถือได้กว่า เพราะบันทึกไว้ตอนชำระจริง ไม่ขยับตามถ้า default % ของไซท์
// เปลี่ยนทีหลัง ส่วนใบแจ้งหนี้ที่ยังไม่ชำระ ยังไม่มี income row ให้อ้างอิง --
// ประมาณการจาก default % ปัจจุบันของไซท์แทน (isEstimate: true)
function computeWithholding(invoice) {
  const income = invoice.incomes
  if (income && income.tax_withheld > 0) {
    const pct = invoice.subtotal > 0 ? round2(income.tax_withheld / invoice.subtotal * 100) : 0
    return { amount: income.tax_withheld, pct, isEstimate: false }
  }
  if (invoice.status === 'void') return { amount: 0, pct: 0, isEstimate: false }
  const defaultPct = invoice.sites?.default_tax_withheld_pct || 0
  if (defaultPct > 0) {
    return { amount: round2(invoice.subtotal * defaultPct / 100), pct: defaultPct, isEstimate: true }
  }
  return { amount: 0, pct: 0, isEstimate: false }
}

function InvoiceDocumentModal({ invoice, tenant, onClose }) {
  const elementId = `inv-doc-${invoice.id}`
  const items = invoice.invoice_items || []
  const client = invoice.quotations?.clients
  const wht = computeWithholding(invoice)
  const { data: receipt } = useDocumentReceipt('invoice', invoice.id)
  const [signatureUrl, setSignatureUrl] = useState(null)
  useEffect(() => {
    if (!receipt) { setSignatureUrl(null); return }
    let cancelled = false
    supabase.storage.from('document-receipts').createSignedUrl(receipt.signature_path, 300)
      .then(({ data }) => { if (!cancelled) setSignatureUrl(data?.signedUrl) })
    return () => { cancelled = true }
  }, [receipt])
  return (
    <Modal title={`ใบแจ้งหนี้ ${invoice.invoice_number}`} onClose={onClose} maxWidth={720}>
      <div className="modal-body">
        <DocumentPaper
          elementId={elementId} tenant={tenant} title="ใบแจ้งหนี้/ใบส่งมอบงาน"
          infoFields={[
            { label: 'เลขที่เอกสาร', value: invoice.invoice_number },
            { label: 'วันที่ออก', value: new Date(invoice.date).toLocaleDateString('th-TH') },
            { label: 'อ้างอิงใบเสนอราคา', value: invoice.quotations?.quotation_number },
          ]}
          siteName={invoice.sites?.name} clientName={client?.name} clientAddress={client?.address} clientTaxId={client?.tax_id}
          items={items} totalsLabel="รวมทั้งสิ้น" totalsAmount={invoice.total}
          subtotal={invoice.subtotal} vat={invoice.vat} hasVat={invoice.has_vat}
          withholdingTaxPct={wht.pct} withholdingTaxAmount={wht.amount} isWithholdingEstimate={wht.isEstimate}
          notesBlock={(tenant?.bank_name || tenant?.bank_account_no) && (
            <div style={{ marginTop: 20, fontSize: 11.5, background: '#f9f9fc', borderRadius: 8, padding: '12px 16px', lineHeight: 1.8 }}>
              <strong>ชำระเงินไปที่:</strong> {tenant.bank_name} {tenant.bank_account_name ? `ชื่อบัญชี ${tenant.bank_account_name}` : ''} {tenant.bank_account_no ? `เลขที่ ${tenant.bank_account_no}` : ''}
            </div>
          )}
          signatures={['ผู้ออกใบแจ้งหนี้', 'ผู้รับเอกสาร']}
          recipientSignature={receipt && signatureUrl ? { url: signatureUrl, signerName: receipt.signer_name, signedAt: receipt.signed_at } : null}
        />
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={() => downloadPDF(elementId, invoice.invoice_number)}>📄 PDF</button>
        <button className="btn btn-ghost" onClick={() => downloadJPG(elementId, invoice.invoice_number)}>🖼️ JPG</button>
        <button className="btn btn-primary" onClick={onClose}>ปิด</button>
      </div>
    </Modal>
  )
}

function ReceiptDocumentModal({ invoice, receipt, tenant, onClose }) {
  const elementId = `rcp-doc-${receipt.id}`
  const items = invoice.invoice_items || []
  const client = invoice.quotations?.clients
  const wht = computeWithholding(invoice)
  return (
    <Modal title={`ใบเสร็จรับเงิน/ใบกำกับภาษี ${receipt.receipt_number}`} onClose={onClose} maxWidth={720}>
      <div className="modal-body">
        <DocumentPaper
          elementId={elementId} tenant={tenant} title="ใบเสร็จรับเงิน / ใบกำกับภาษี"
          infoFields={[
            { label: 'เลขที่ใบเสร็จ', value: receipt.receipt_number },
            { label: 'เลขที่ใบกำกับภาษี', value: receipt.tax_invoice_number },
            { label: 'วันที่', value: new Date(receipt.date).toLocaleDateString('th-TH') },
            { label: 'อ้างอิงใบแจ้งหนี้', value: invoice.invoice_number },
          ]}
          siteName={invoice.sites?.name} clientName={client?.name} clientAddress={client?.address} clientTaxId={client?.tax_id}
          items={items} totalsLabel="รวมรับชำระ" totalsAmount={receipt.amount}
          subtotal={invoice.subtotal} vat={invoice.vat} hasVat={invoice.has_vat}
          withholdingTaxPct={wht.pct} withholdingTaxAmount={wht.amount} isWithholdingEstimate={wht.isEstimate}
          notesBlock={null}
          signatures={['ผู้รับเงิน', 'ผู้จ่ายเงิน']}
        />
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={() => downloadPDF(elementId, receipt.receipt_number)}>📄 PDF</button>
        <button className="btn btn-ghost" onClick={() => downloadJPG(elementId, receipt.receipt_number)}>🖼️ JPG</button>
        <button className="btn btn-primary" onClick={onClose}>ปิด</button>
      </div>
    </Modal>
  )
}

const PHOTOS_PER_PAGE = 6

// จัดการรูปประกอบการส่งงาน -- อัปโหลด/ใส่คำอธิบาย/จัดลำดับ/ลบ ก่อนพิมพ์เป็น
// เอกสารจริง (WorkPhotosDocumentModal) แยกสองโมดัลเพราะการจัดการ (แก้ไขได้
// ตลอด) กับการพิมพ์ (สแนปช็อตสิ่งที่มีอยู่ตอนนั้น) เป็นคนละงานกัน
function WorkPhotosModal({ invoice, tenant, onClose, onPrint }) {
  const { data: photos, refetch } = useInvoicePhotos(invoice.id)
  const [urls, setUrls] = useState({})
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const entries = await Promise.all((photos || []).map(async p => {
        const { data } = await supabase.storage.from('invoice-photos').createSignedUrl(p.photo_path, 300)
        return [p.id, data?.signedUrl]
      }))
      if (!cancelled) setUrls(Object.fromEntries(entries))
    })()
    return () => { cancelled = true }
  }, [photos])

  const handleUpload = async (files) => {
    if (!files?.length) return
    setUploading(true)
    try {
      let nextOrder = (photos || []).length
      for (const file of files) {
        const filePath = `${tenant.id}/${invoice.id}/${Date.now()}-${file.name}`
        const { error: upErr } = await supabase.storage.from('invoice-photos').upload(filePath, file)
        if (upErr) throw upErr
        const { error: insErr } = await supabase.from('invoice_photos').insert({
          invoice_id: invoice.id, photo_path: filePath, sort_order: nextOrder,
        })
        if (insErr) { await supabase.storage.from('invoice-photos').remove([filePath]); throw insErr }
        nextOrder += 1
      }
      await refetch()
    } catch (err) {
      alert('Error: ' + err.message)
    } finally {
      setUploading(false)
    }
  }

  const handleDescriptionChange = async (photo, description) => {
    const { error } = await supabase.from('invoice_photos').update({ description }).eq('id', photo.id)
    if (error) alert('Error: ' + error.message)
  }

  const handleMove = async (index, dir) => {
    const list = [...(photos || [])]
    const j = index + dir
    if (j < 0 || j >= list.length) return
    const a = list[index], b = list[j]
    const { error } = await supabase.from('invoice_photos').upsert([
      { id: a.id, sort_order: b.sort_order },
      { id: b.id, sort_order: a.sort_order },
    ])
    if (error) { alert('Error: ' + error.message); return }
    await refetch()
  }

  const handleDelete = async (photo) => {
    if (!confirm('ลบรูปนี้?')) return
    const { error: rmErr } = await supabase.storage.from('invoice-photos').remove([photo.photo_path])
    if (rmErr) { alert('Error: ' + rmErr.message); return }
    const { error: delErr } = await supabase.from('invoice_photos').delete().eq('id', photo.id)
    if (delErr) { alert('Error: ' + delErr.message); return }
    await refetch()
  }

  return (
    <Modal title={`รูปประกอบการส่งงาน — ${invoice.invoice_number}`} onClose={onClose} maxWidth={640}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => {
            e.preventDefault(); setDragOver(false)
            handleUpload(Array.from(e.dataTransfer.files || []).filter(f => f.type.startsWith('image/')))
          }}
          style={{
            border: `2px dashed ${dragOver ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: 8, padding: 16, textAlign: 'center',
            background: dragOver ? 'rgba(108,99,255,0.06)' : 'transparent',
          }}
        >
          <div style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 8 }}>ลากรูปมาวางที่นี่ (เลือกได้หลายรูปพร้อมกัน) หรือ</div>
          <input
            type="file" accept="image/*" multiple disabled={uploading}
            onChange={e => { handleUpload(Array.from(e.target.files || [])); e.target.value = '' }}
          />
          {uploading && <span style={{ fontSize: 12, color: 'var(--text3)', marginLeft: 8 }}>⏳ กำลังอัปโหลด...</span>}
        </div>
        <div style={{ display: 'grid', gap: 10 }}>
          {(photos || []).map((p, i) => (
            <div key={p.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
              {urls[p.id]
                ? <img src={urls[p.id]} alt="" style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} />
                : <div style={{ width: 80, height: 80, background: 'var(--bg3)', borderRadius: 6, flexShrink: 0 }} />}
              <div style={{ flex: 1 }}>
                <input
                  className="input input-sm" placeholder="คำอธิบายรูป" defaultValue={p.description || ''}
                  onBlur={e => handleDescriptionChange(p, e.target.value)}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
                <button type="button" className="btn btn-ghost btn-sm" disabled={i === 0} onClick={() => handleMove(i, -1)}>↑</button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={i === (photos || []).length - 1} onClick={() => handleMove(i, 1)}>↓</button>
                <button type="button" className="btn btn-danger btn-sm" onClick={() => handleDelete(p)}>✕</button>
              </div>
            </div>
          ))}
          {!(photos || []).length && <div style={{ color: 'var(--text3)', fontSize: 13 }}>ยังไม่มีรูป</div>}
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onClose}>ปิด</button>
        <button type="button" className="btn btn-primary" disabled={!(photos || []).length} onClick={() => onPrint(photos || [], urls)}>
          👁️ ดูตัวอย่าง
        </button>
      </div>
    </Modal>
  )
}

// เอกสาร "รูปประกอบการส่งงาน" -- 6 รูปต่อหน้า A4 แนวตั้ง (2 คอลัมน์ × 3 แถว)
// พร้อมคำอธิบายใต้รูป หัวเอกสาร (โลโก้/ชื่อบริษัท/อ้างอิงใบแจ้งหนี้) และเลขหน้า
// ซ้ำทุกหน้า ลายเซ็นผู้จัดทำ/ผู้รับสินค้า้งาน + วันที่จัดทำอยู่ท้ายหน้าสุดท้าย
// เท่านั้น แต่ละหน้าตั้ง height ตายตัวเป็น PAGE_HEIGHT_MM แล้วใช้ flex column +
// spacer (flex:1) ดันลายเซ็น/เลขหน้าลงไปชิดขอบล่างเสมอ แทนที่จะลอยติดรูปสุดท้าย
// -- PAGE_HEIGHT_MM ตั้งไว้ที่ 270mm ไม่ใช่เต็ม 277mm (พื้นที่พิมพ์จริงหลังหัก
// margin 10mm รอบด้านของ downloadPDF) เพราะทดสอบจริงพบว่า html2pdf.js คำนวณ
// ช่องว่างระหว่างหน้า (page-break padding) ด้วย modulo ของความสูง -- ถ้า div
// สูงตรงเป๊ะเท่า page height พอดี การปัดเศษ sub-pixel เพียงเล็กน้อยจาก
// html2canvas จะทำให้ modulo เกือบเป็น 0 แล้วมันแทรกช่องว่างเกือบเต็มหน้า
// กลายเป็นหน้าเปล่าเพิ่มมาโดยไม่ตั้งใจ (ยืนยันจากการทดสอบจริง: 277mm พอดี ->
// 7 รูปกลายเป็น 3 หน้าแทนที่จะเป็น 2) เผื่อ margin 7mm กันปัญหานี้
const PAGE_HEIGHT_MM = 270

function WorkPhotosDocumentModal({ invoice, tenant, photos, urls, onClose }) {
  const elementId = `work-photos-doc-${invoice.id}`
  const client = invoice.quotations?.clients
  const pages = []
  for (let i = 0; i < photos.length; i += PHOTOS_PER_PAGE) pages.push(photos.slice(i, i + PHOTOS_PER_PAGE))
  if (!pages.length) pages.push([])

  return (
    <Modal title="รูปประกอบการส่งงาน" onClose={onClose} maxWidth={720}>
      <div className="modal-body" style={{ maxHeight: '70vh', overflow: 'auto' }}>
        <div id={elementId} style={{ fontFamily: 'Sarabun,sans-serif', background: '#fff', color: '#17181f', width: '190mm' }}>
          {pages.map((pagePhotos, pageIndex) => {
            const isLast = pageIndex === pages.length - 1
            return (
              <div
                key={pageIndex}
                style={{
                  height: `${PAGE_HEIGHT_MM}mm`, boxSizing: 'border-box',
                  padding: '6mm 8mm', display: 'flex', flexDirection: 'column',
                  pageBreakAfter: pageIndex < pages.length - 1 ? 'always' : 'auto',
                  breakAfter: pageIndex < pages.length - 1 ? 'page' : 'auto',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '5mm', marginBottom: '4mm' }}>
                  <div style={{ display: 'flex', gap: '3mm', alignItems: 'flex-start' }}>
                    {tenant?.logo_url
                      ? <img src={tenant.logo_url} alt="" style={{ width: '10mm', height: '10mm', objectFit: 'contain', flexShrink: 0 }} crossOrigin="anonymous" />
                      : <div style={{ width: '10mm', height: '10mm', borderRadius: 4, background: '#6c63ff', flexShrink: 0 }} />}
                    <div style={{ fontSize: 13, fontWeight: 800 }}>{tenant?.company_name}</div>
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 800 }}>รูปประกอบการส่งงาน</div>
                </div>
                <div style={{ marginBottom: '5mm', border: '1px solid #e4e6ef', borderRadius: 6, padding: '3mm 4mm', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5mm 6mm', fontSize: 10 }}>
                  <div><span style={{ color: '#6a6f85' }}>เลขที่ใบแจ้งหนี้</span><br />{invoice.invoice_number}</div>
                  <div><span style={{ color: '#6a6f85' }}>วันที่</span><br />{new Date(invoice.date).toLocaleDateString('th-TH')}</div>
                  <div><span style={{ color: '#6a6f85' }}>ไซท์งาน</span><br />{invoice.sites?.name || '—'}</div>
                  <div><span style={{ color: '#6a6f85' }}>ลูกค้า</span><br />{client?.name || '—'}</div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4mm' }}>
                  {pagePhotos.map(p => (
                    <div key={p.id} style={{ border: '1px solid #e4e6ef', borderRadius: 6, overflow: 'hidden' }}>
                      <div style={{ height: '50mm', background: '#f4f3ff' }}>
                        {urls[p.id] && <img src={urls[p.id]} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} crossOrigin="anonymous" />}
                      </div>
                      <div style={{ padding: '1.5mm 2.5mm', fontSize: 9.5, color: '#4a4d63', height: '8mm', overflow: 'hidden' }}>{p.description || ''}</div>
                    </div>
                  ))}
                </div>

                <div style={{ flex: 1 }} />

                {isLast && (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6mm', textAlign: 'center', fontSize: 10 }}>
                      <div style={{ borderTop: '1px solid #999', paddingTop: '2mm' }}>ผู้จัดทำ</div>
                      <div style={{ borderTop: '1px solid #999', paddingTop: '2mm' }}>ผู้รับสินค้า/งาน</div>
                    </div>
                    <div style={{ marginTop: '4mm', textAlign: 'center', fontSize: 9.5 }}>
                      วันที่จัดทำเอกสาร {new Date().toLocaleDateString('th-TH')}
                    </div>
                  </>
                )}

                <div style={{ marginTop: '3mm', textAlign: 'center', fontSize: 9, color: '#9296a8' }}>
                  หน้า {pageIndex + 1} / {pages.length}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={() => downloadPDF(elementId, `รูปประกอบการส่งงาน-${invoice.invoice_number}`)}>📄 PDF</button>
        <button className="btn btn-primary" onClick={onClose}>ปิด</button>
      </div>
    </Modal>
  )
}

// วันที่รับเงิน (paid_date/receipt.date/income.date) is its own field,
// separate from the invoice's own `date` (document issue date, set once
// at creation) -- defaults to today since that's when payment is usually
// actually confirmed, but editable for recording a payment a few days
// after it actually arrived.
function MarkPaidModal({ invoice, onConfirm, onCancel }) {
  const [paidDate, setPaidDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  return (
    <Modal title="ทำเครื่องหมายว่าชำระแล้ว" onClose={onCancel} maxWidth={420}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <p style={{ color: 'var(--text2)', lineHeight: 1.6, margin: 0 }}>
          ยืนยันว่าได้รับชำระเงินตามใบแจ้งหนี้ {invoice.invoice_number} แล้ว? ระบบจะออกใบเสร็จรับเงิน/ใบกำกับภาษีให้อัตโนมัติ
        </p>
        <div>
          <label className="label">วันที่รับเงิน</label>
          <input type="date" className="input" value={paidDate} onChange={e => setPaidDate(e.target.value)} />
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
        <button className="btn btn-primary" onClick={() => onConfirm(paidDate)}>ยืนยัน</button>
      </div>
    </Modal>
  )
}

export default function Invoices({ navigateTo, navState, openSiteOverview }) {
  const { isAtLeast, role } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'invoices')
  const today = new Date()
  const ytdFrom = format(startOfYear(today), 'yyyy-MM-dd')
  const ytdTo   = format(endOfYear(today),   'yyyy-MM-dd')

  const [dateFrom, setDateFrom] = useState(ytdFrom)
  const [dateTo,   setDateTo]   = useState(ytdTo)
  const [siteId,   setSiteId]   = useState('')
  const [status,   setStatus]   = useState('')
  const [pickQuotation, setPickQuotation] = useState(false)
  const [createFor, setCreateFor] = useState(null)
  const [toast, setToast] = useState(null)

  const filters = { from: dateFrom, to: dateTo, siteId, status }
  const { data: invoices, error: invoicesError, refetch } = useInvoices(filters)
  const { data: sites } = useSites()
  const { data: acceptedQuotations } = useQuotations({ status: 'accepted' })

  const billableQuotations = useMemo(() =>
    (acceptedQuotations || []).filter(q => q.site_id), [acceptedQuotations])

  const [payingId, setPayingId] = useState(null)
  const [voidingId, setVoidingId] = useState(null)
  const [voidRow, setVoidRow] = useState(null)
  const [payRow, setPayRow] = useState(null)
  const { tenant, hasModuleAccess } = useTenant()

  const [docRow, setDocRow] = useState(null)
  const [receiptRow, setReceiptRow] = useState(null)
  const [photosRow, setPhotosRow] = useState(null)
  const [linkTarget, setLinkTarget] = useState(null)
  // แยก state คนละก้อนกับ photosRow เพราะ Modal ของแอปนี้ไม่รองรับ modal
  // ซ้อน modal (ดูคอมเมนต์ใน Modal.jsx) -- คลิก "พิมพ์เอกสาร" ในโมดัลจัดการรูป
  // จึงต้องปิดโมดัลนั้นแล้วเปิดโมดัลพิมพ์แทนที่ ไม่ใช่เปิดซ้อนกัน
  const [photosPrint, setPhotosPrint] = useState(null) // { invoice, photos, urls }
  const { data: receipts, refetch: refetchReceipts } = useReceipts((invoices || []).map(i => i.id))

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3000) }

  // Computes retention/deposit_deduction/received_amount the exact same
  // way IncomeForm does today (src/pages/Income.jsx): site default %s
  // applied to the pre-VAT amount, deposit deduction additionally capped
  // by calcDepositDeduction() against whatever deposit balance the site
  // has left, and only applied at all if the client_deposits module is on
  // (matches IncomeForm's `depositModuleOn` gate).
  const handleMarkPaid = async (invoice, paidDate) => {
    if (invoice.status !== 'unpaid' || payingId || voidingId) return
    setPayingId(invoice.id)
    try {
      // `receipts.invoice_id` is UNIQUE -- if an earlier attempt inserted the
      // receipt but failed on a later step, reuse it on retry instead of
      // blowing up on a unique-constraint violation (which would otherwise
      // leave this invoice permanently stuck unable to reach paid).
      let receipt
      const { data: existingReceipt } = await supabase.from('receipts').select('*').eq('invoice_id', invoice.id).maybeSingle()
      if (existingReceipt) {
        receipt = existingReceipt
      } else {
        const { data: newReceipt, error: receiptError } = await supabase.from('receipts').insert({
          invoice_id: invoice.id, date: paidDate, amount: invoice.total,
        }).select().single()
        if (receiptError) throw receiptError
        receipt = newReceipt
        await auditLog('receipts', receipt.id, 'INSERT', null, { invoice_id: invoice.id, amount: invoice.total })
      }

      // incomes.source_invoice_id IS UNIQUE at the DB level (unlike
      // invoice_no, which src/pages/Income.jsx lets users type freely --
      // real data already has that column legitimately shared across
      // unrelated manual entries). .maybeSingle() is safe here specifically
      // because the constraint guarantees at most one row can ever match;
      // a genuine cross-tab race loses the INSERT below to a unique
      // violation instead of silently duplicating the income row, and
      // self-heals on retry via this same lookup.
      let income
      const { data: existingIncome, error: existingIncomeError } = await supabase
        .from('incomes').select('*').eq('source_invoice_id', invoice.id).maybeSingle()
      if (existingIncomeError) throw existingIncomeError
      if (existingIncome) {
        income = existingIncome
      } else {
        const { data: site, error: siteError } = await supabase
          .from('sites')
          .select('default_tax_withheld_pct, default_retention_pct, default_deposit_pct')
          .eq('id', invoice.site_id)
          .single()
        if (siteError) throw siteError

        const noVat = invoice.subtotal
        const taxAmt = noVat * (site.default_tax_withheld_pct || 0) / 100
        const retentionAmt = noVat * (site.default_retention_pct || 0) / 100

        let depositAmt = 0
        if (hasModuleAccess('client_deposits')) {
          const { data: depositBalance } = await supabase
            .from('site_deposit_summary')
            .select('remaining_balance')
            .eq('site_id', invoice.site_id)
            .maybeSingle()
          if (depositBalance) {
            depositAmt = calcDepositDeduction(noVat, site.default_deposit_pct || 0, depositBalance.remaining_balance)
          }
        }

        const receivedAmount = round2(noVat + invoice.vat - taxAmt - retentionAmt - depositAmt)

        const incomePayload = {
          invoice_no: invoice.invoice_number,
          source_invoice_id: invoice.id,
          date: paidDate,
          site_id: invoice.site_id,
          client_name: invoice.quotations?.clients?.name || null,
          description: `${invoice.invoice_number} — ${invoice.quotations?.quotation_number || ''}`,
          amount_no_vat: noVat,
          vat: invoice.vat,
          tax_withheld: round2(taxAmt),
          retention: round2(retentionAmt),
          income_type: 'ปกติ',
          deposit_deduction: round2(depositAmt),
          received_amount: receivedAmount,
        }
        const { data: newIncome, error: incomeError } = await supabase.from('incomes').insert(incomePayload).select().single()
        if (incomeError) throw incomeError
        income = newIncome
        await auditLog('incomes', income.id, 'INSERT', null, incomePayload)
      }

      const invUpdate = { status: 'paid', paid_date: paidDate, income_id: income.id }
      const { data: updateResult, error: invError } = await supabase.from('invoices').update(invUpdate).eq('id', invoice.id).eq('status', 'unpaid').select('id')
      if (invError) throw invError
      if (!updateResult || updateResult.length === 0) {
        throw new Error('ใบแจ้งหนี้นี้ถูกทำเครื่องหมายว่าชำระแล้วโดยผู้ใช้อื่นไปแล้ว กรุณารีเฟรชหน้าจอ')
      }
      await auditLog('invoices', invoice.id, 'UPDATE', null, invUpdate)

      refetch(); refetchReceipts(); showToast('ทำเครื่องหมายว่าชำระแล้ว')
    } catch (e) {
      alert('เกิดข้อผิดพลาด (โปรดตรวจสอบและกระทบยอดด้วยตนเองหากมีการบันทึกไปแล้วบางส่วน): ' + e.message)
    } finally {
      setPayingId(null)
    }
  }

  const handleVoid = async (invoice) => {
    if (invoice.status !== 'unpaid' || payingId || voidingId) return
    setVoidingId(invoice.id)
    try {
      const { data: invoiceItems, error: itemsError } = await supabase
        .from('invoice_items').select('id').eq('invoice_id', invoice.id)
      if (itemsError) throw itemsError

      const { data: draws, error: drawsError } = await supabase
        .from('invoice_item_draws').select('quotation_item_unit_id, prior_pct, target_pct')
        .in('invoice_item_id', invoiceItems.map(it => it.id))
        .order('prior_pct')
      if (drawsError) throw drawsError

      // Same optimistic lock Task 7's create flow uses when writing forward:
      // only revert a unit if it still sits at the pct THIS draw left it at.
      // If another (still-unpaid) invoice has since drawn further progress
      // on the same unit, reverting unconditionally would silently erase
      // that other invoice's billed work.
      //
      // A 0-row result has two possible causes, and they must be told
      // apart: (a) a genuine conflict as above, or (b) THIS invoice's own
      // create flow never actually finished writing this unit -- it wrote
      // the invoice_item_draws row but failed (network drop, tab closed)
      // before the matching quotation_item_units update below it, leaving
      // the unit still sitting at prior_pct. (b) was previously
      // misreported as (a), permanently blocking void on a half-written
      // invoice with no way to retry creating it either. Checking the
      // unit's current value distinguishes them: still at prior_pct means
      // the forward write never happened, so there's nothing to revert.
      for (const d of draws) {
        const { data: revertResult, error } = await supabase.from('quotation_item_units')
          .update({ cumulative_pct: d.prior_pct, updated_at: new Date().toISOString() })
          .eq('id', d.quotation_item_unit_id)
          .eq('cumulative_pct', d.target_pct)
          .select('id')
        if (error) throw error
        if (!revertResult || revertResult.length === 0) {
          const { data: current, error: checkError } = await supabase
            .from('quotation_item_units').select('cumulative_pct').eq('id', d.quotation_item_unit_id).single()
          if (checkError) throw checkError
          if (current.cumulative_pct !== d.prior_pct) {
            throw new Error('ไม่สามารถยกเลิกได้ เนื่องจากมีการเรียกเก็บเงินเพิ่มเติมกับรายการนี้ในใบแจ้งหนี้อื่นแล้ว')
          }
          // else: already at prior_pct -- this draw's forward write never
          // completed, so it's already correct. Nothing to revert.
        }
      }

      const { data: voidResult, error: voidError } = await supabase.from('invoices').update({ status: 'void' }).eq('id', invoice.id).eq('status', 'unpaid').select('id')
      if (voidError) throw voidError
      if (!voidResult || voidResult.length === 0) {
        throw new Error('ใบแจ้งหนี้นี้ถูกเปลี่ยนสถานะโดยผู้ใช้อื่นไปแล้ว กรุณารีเฟรชหน้าจอ')
      }
      await auditLog('invoices', invoice.id, 'UPDATE', null, { status: 'void' })

      setVoidRow(null); refetch(); showToast('ยกเลิกใบแจ้งหนี้แล้ว')
    } catch (e) {
      alert('ยกเลิกไม่สำเร็จ: ' + e.message)
    } finally {
      setVoidingId(null)
    }
  }

  return (
    <div>
      {toast && <div className="alert alert-success" style={{ marginBottom: 12 }}>✅ {toast}</div>}

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        {canEdit && <button className="btn btn-primary" onClick={() => setPickQuotation(true)}>+ สร้างใบแจ้งหนี้</button>}
        <div style={{ flex: 1 }} />
        <input type="date" className="input input-sm" style={{ width: 140 }} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        <span style={{ color: 'var(--text3)' }}>—</span>
        <input type="date" className="input input-sm" style={{ width: 140 }} value={dateTo} onChange={e => setDateTo(e.target.value)} />
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ minWidth: 200 }}>
          <SearchableSelect value={siteId} onChange={setSiteId} placeholder="ทุกไซท์งาน" options={siteOpts(sites)} />
        </div>
        <select className="select select-sm" style={{ width: 160 }} value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">ทุกสถานะ</option>
          {INV_STATUSES.map(s => <option key={s} value={s}>{INV_STATUS_LABELS[s]}</option>)}
        </select>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>เลขที่</th><th>วันที่</th><th>ไซท์งาน</th><th>ลูกค้า</th><th>รายการ</th><th>ยอดรวม</th><th>สถานะ</th><th></th></tr>
            </thead>
            <tbody>
              {(invoices || []).map(inv => (
                <tr key={inv.id}>
                  <td className="font-mono" style={{ fontSize: 12 }}>{inv.invoice_number}</td>
                  <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDate(inv.date)}</td>
                  <td style={{ fontSize: 11, color: 'var(--accent)', cursor: inv.site_id ? 'pointer' : 'default' }}
                    onClick={() => inv.site_id && openSiteOverview(inv.site_id)}>{inv.sites?.name || '—'}</td>
                  <td style={{ fontSize: 12 }}>{inv.quotations?.clients?.name || '—'}</td>
                  <td style={{ fontSize: 11, color: 'var(--text3)' }}>{(inv.invoice_items || []).length} รายการ</td>
                  <td className="font-mono" style={{ fontWeight: 700 }}>
                    {fmt(inv.total)}
                    {(() => {
                      const wht = computeWithholding(inv)
                      return wht.amount > 0 ? (
                        <div style={{ fontSize: 10, fontWeight: 400, color: 'var(--text3)' }}>
                          สุทธิ {fmt(inv.total - wht.amount)}{wht.isEstimate ? ' (ประมาณ)' : ''}
                        </div>
                      ) : null
                    })()}
                  </td>
                  <td><span className={`badge badge-${inv.status}`}>{INV_STATUS_LABELS[inv.status] || inv.status}</span></td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {canEdit && inv.status === 'unpaid' && (
                      <>
                        <button className="btn btn-sm btn-primary" disabled={payingId === inv.id} onClick={() => setPayRow(inv)}>
                          {payingId === inv.id ? '⏳...' : '✅ ชำระแล้ว'}
                        </button>
                        <button className="btn btn-sm btn-danger" disabled={voidingId === inv.id} onClick={() => setVoidRow(inv)}>
                          {voidingId === inv.id ? '⏳...' : '✕ ยกเลิก'}
                        </button>
                      </>
                    )}
                    <button className="btn btn-sm btn-ghost" onClick={() => setDocRow(inv)}>📄</button>
                    {inv.status === 'paid' && (
                      <button className="btn btn-sm btn-ghost" onClick={() => setReceiptRow(inv)}>🧾</button>
                    )}
                    {canEdit && (
                      <button className="btn btn-sm btn-ghost" onClick={() => setPhotosRow(inv)} title="รูปประกอบการส่งงาน">📷</button>
                    )}
                    {canEdit && (
                      <button className="btn btn-sm btn-ghost" onClick={() => setLinkTarget(inv)} title="ลิงก์เซ็นรับระยะไกล">🔗</button>
                    )}
                  </td>
                </tr>
              ))}
              {!(invoices || []).length && (
                <tr><td colSpan={8} style={{ textAlign: 'center', color: invoicesError ? 'var(--red)' : 'var(--text3)', padding: 32 }}>
                  {invoicesError ? `โหลดใบแจ้งหนี้ไม่สำเร็จ: ${invoicesError}` : 'ไม่พบใบแจ้งหนี้ในช่วงเวลานี้'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {pickQuotation && (
        <Modal title="เลือกใบเสนอราคาที่จะแจ้งหนี้" onClose={() => setPickQuotation(false)} maxWidth={520}>
          <div className="modal-body">
            <SearchableSelect
              value={null}
              onChange={id => { const q = billableQuotations.find(x => x.id === id); setPickQuotation(false); setCreateFor(q) }}
              placeholder="— เลือกใบเสนอราคา —"
              options={billableQuotations.map(q => ({
                // Post-acceptance, the site name is the live identity (renameable,
                // reflects reality on the ground) -- the quotation_number is only
                // a fixed reference kept for traceability. Never fall back to the
                // client name here: once a quotation is accepted, sites.name always
                // exists (Quotations.jsx's accept-flow requires it).
                value: q.id, label: `${q.sites?.name || q.quotation_number} · ${q.quotation_number}`,
                keywords: `${q.sites?.name || ''} ${q.quotation_number} ${q.clients?.name || ''}`,
              }))}
            />
            {!billableQuotations.length && <p style={{ color: 'var(--text3)', fontSize: 12, marginTop: 8 }}>ไม่มีใบเสนอราคาที่ยอมรับแล้วและมีไซท์งานผูกอยู่</p>}
          </div>
        </Modal>
      )}

      {createFor && (
        <CreateInvoiceModal
          quotation={createFor}
          site={(sites || []).find(s => s.id === createFor.site_id)}
          onClose={() => setCreateFor(null)}
          onSaved={() => { setCreateFor(null); refetch(); showToast('สร้างใบแจ้งหนี้สำเร็จ') }}
        />
      )}

      {voidRow && (
        <ConfirmDialog
          title="ยกเลิกใบแจ้งหนี้"
          message={`ยืนยันการยกเลิกใบแจ้งหนี้ ${voidRow.invoice_number}? การกระทำนี้ไม่สามารถย้อนกลับได้`}
          onConfirm={() => handleVoid(voidRow)}
          onCancel={() => setVoidRow(null)}
          danger
        />
      )}

      {payRow && (
        <MarkPaidModal
          invoice={payRow}
          onConfirm={(paidDate) => { handleMarkPaid(payRow, paidDate); setPayRow(null) }}
          onCancel={() => setPayRow(null)}
        />
      )}

      {docRow && <InvoiceDocumentModal invoice={docRow} tenant={tenant} onClose={() => setDocRow(null)} />}
      {receiptRow && (receipts || []).find(r => r.invoice_id === receiptRow.id) && (
        <ReceiptDocumentModal
          invoice={receiptRow}
          receipt={(receipts || []).find(r => r.invoice_id === receiptRow.id)}
          tenant={tenant}
          onClose={() => setReceiptRow(null)}
        />
      )}
      {photosRow && (
        <WorkPhotosModal
          invoice={photosRow} tenant={tenant} onClose={() => setPhotosRow(null)}
          onPrint={(photos, urls) => { setPhotosRow(null); setPhotosPrint({ invoice: photosRow, photos, urls }) }}
        />
      )}
      {photosPrint && (
        <WorkPhotosDocumentModal
          invoice={photosPrint.invoice} tenant={tenant} photos={photosPrint.photos} urls={photosPrint.urls}
          onClose={() => setPhotosPrint(null)}
        />
      )}
      {linkTarget && (
        <SignLinkModal documentType="invoice" documentId={linkTarget.id} onClose={() => setLinkTarget(null)} />
      )}
    </div>
  )
}
