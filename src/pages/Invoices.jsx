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
import { useState, useMemo, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase.js'
import { useInvoices, useQuotationItemUnits, useQuotations, useSites, useReceipts, useInvoicePhotos, useDocumentReceipt, useMySignatureUrl, useMyWorkerName, useBankAccounts, useSiteDepositBalance, useQuotationDepositTaxOffset, getQuotationDepositTaxOffset, logDocumentPrint, useInvoiceDepositChoiceReady, useSiteReservedDeposit } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { useTenant } from '../hooks/useTenant.js'
import { calcDepositDeduction, round2 } from '../lib/depositCalc.js'
import { computeInvoiceNet, solveRawForNet, availableDeposit } from '../lib/invoiceNet.js'
import InvoiceTotalsCard, { useDepositChoiceState } from '../components/InvoiceTotalsCard.jsx'
import { thaiBahtText } from '../lib/thaiBahtText.js'
import { sanitizeStorageFileName } from '../lib/storageKey.js'
import { canEditPage } from '../lib/permissions.js'
import { fmt, fmtDate } from '../lib/supabase.js'
import { auditLog } from '../lib/audit.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import SearchableSelect from '../components/SearchableSelect.jsx'
import { format, startOfYear, endOfYear } from 'date-fns'
import { isCountable, waterfall, openQty, drawQty, drawAmount, calcInvoiceTotals, sumMaterialLabor, VAT_RATE, effectiveInvoiceTaxOffset, invoiceBillingTotal } from '../lib/invoiceCalc.js'
import { calcQuotationTotals } from '../lib/quotationCalc.js'
import { downloadPDF, downloadJPG } from '../lib/pdf.js'
import SignLinkModal from '../components/SignLinkModal.jsx'
import RowActionsMenu from '../components/RowActionsMenu.jsx'
import { usePaginatedDocument, PAGE_HEIGHT_PX, PAGE_WIDTH_PX, PAGE_PADDING_CSS, PAGE_PADDING_V_PX, TABLE_MARGIN_TOP_PX, ScaleToFit } from '../hooks/usePaginatedDocument.jsx'
import { resolveDocumentStyle } from '../lib/documentStyle.js'

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
      // Carries the source quotation item's material/labor split forward
      // (scaled by the same discount multiplier as unitPrice) so a split
      // quotation's invoices -- and the receipt/tax-invoice printed from
      // the same invoice_items -- can show the same breakdown. Null on a
      // 'combined' quotation, same marker convention as quotation_items.
      unitPriceMaterial: qi.unit_price_material != null ? round2(qi.unit_price_material * priceMultiplier) : null,
      unitPriceLabor: qi.unit_price_labor != null ? round2(qi.unit_price_labor * priceMultiplier) : null,
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
      {mode === 'advanced' && !lines.some(l => isCountable(l.totalQty) && l.units.length > 1) && (
        <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>
          โหมดละเอียดแยก % รายชิ้นให้เฉพาะรายการที่มีจำนวน 2–20 ชิ้น (จำนวนเต็ม) ใบนี้ไม่มีรายการแบบนั้น หน้าจอจึงเหมือนโหมดง่าย
        </div>
      )}
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
                  <input type="number" min="0" max={remaining} step="any" className="input input-sm num-spin"
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
  const { hasModuleAccess } = useTenant()
  const items = quotation.quotation_items || []
  const { data: unitsByQuotationItem, loading: unitsLoading, error: unitsError } = useQuotationItemUnits(quotation.id, items)
  // VAT/WHT tax-base offset -- see calcInvoiceTotals' own comment. Applies
  // regardless of hasModuleAccess('client_deposits'): this corrects for
  // VAT already charged on a deposit invoice's own value, which is a tax
  // fact independent of whether the deposit-BALANCE-tracking module is on.
  const { data: depositTaxOffset } = useQuotationDepositTaxOffset(quotation.id, quotation.has_vat, quotation.price_includes_vat)
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

  // หักมัดจำสำหรับใบนี้ -- เลือกตอนสร้างใบ (ไม่หัก / % ของยอดก่อน VAT / มูลค่าเป็นบาท) ผูกกับใบนี้ใบเดียว
  // กล่องนี้โผล่เมื่อ migration 2026-10-09-07 ลงแล้ว + โมดูลมัดจำเปิดอยู่ + ไซต์ยังมีมัดจำคงเหลือ
  // ไม่งั้นใช้พฤติกรรมเดิม (คำนวณตอนกดยืนยันชำระ)
  const depositChoiceReady = useInvoiceDepositChoiceReady()
  const depositModule = hasModuleAccess('client_deposits')
  const { data: depositBalance } = useSiteDepositBalance(depositModule && depositChoiceReady ? quotation.site_id : null)
  const depositRemaining = depositBalance?.remaining_balance || 0
  // มัดจำที่ใบอื่นที่ยังไม่ชำระ "จอง" ไว้แล้ว (ตัวคงเหลือของไซท์ลดตอนกดชำระเท่านั้น) -- หักซ้ำไม่ได้
  const { data: reservedData } = useSiteReservedDeposit(depositModule && depositChoiceReady ? quotation.site_id : null)
  const reserved = reservedData || { total: 0, invoices: [] }
  const depositFree = availableDeposit(depositRemaining, reserved.total)
  // รอข้อมูลที่จองไว้โหลดก่อน ไม่งั้นจะเห็นมัดจำเต็มชั่วขณะแล้วบันทึกเกินได้
  const showDepositBox = depositModule && depositChoiceReady && depositRemaining > 0 && !!reservedData
  const siteDepositPct = Number(site?.default_deposit_pct) || 0
  const depositChoice = useDepositChoiceState(siteDepositPct)
  const [showTargetCard, setShowTargetCard] = useState(false)

  useEffect(() => {
    if (unitsByQuotationItem && !lines) {
      setLines(buildLineState(items, unitsByQuotationItem, discountMultiplier(quotation)))
    }
  }, [unitsByQuotationItem]) // eslint-disable-line react-hooks/exhaustive-deps

  if (unitsError) {
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <button className="btn btn-ghost" onClick={onClose}>← กลับ</button>
          <h2 style={{ margin: 0, fontSize: 18 }}>สร้างใบแจ้งหนี้ — {quotation.quotation_number}</h2>
        </div>
        <div className="card" style={{ maxWidth: 960, margin: '0 auto' }}>
          <div className="modal-body">เกิดข้อผิดพลาดในการโหลดข้อมูล: {unitsError}</div>
        </div>
      </div>
    )
  }
  if (unitsLoading || !lines) {
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <button className="btn btn-ghost" onClick={onClose}>← กลับ</button>
          <h2 style={{ margin: 0, fontSize: 18 }}>สร้างใบแจ้งหนี้ — {quotation.quotation_number}</h2>
        </div>
        <div className="card" style={{ maxWidth: 960, margin: '0 auto' }}>
          <div className="modal-body">⏳ กำลังโหลด...</div>
        </div>
      </div>
    )
  }

  const billedLines = lines.filter(l => drawQty(l.units) > 1e-9)
  // round2 here for the same reason handleSave rounds before persisting
  // (Fix 7): the header subtotal must equal the SUM of the line_totals
  // actually stored, or a printed invoice's line items visibly fail to add
  // up to its own total by a satang.
  const invoiceItemsForTotals = billedLines.map(l => ({ line_total: round2(drawAmount(l.units, l.unitPrice)) }))
  // ทุกตัวเลขของการ์ดสรุปและช่อง "กรอกยอดที่ต้องการเรียกเก็บ" มาจากสูตรเดียวกัน (lib/invoiceNet.js)
  const rawDrawn = invoiceItemsForTotals.reduce((s, it) => s + it.line_total, 0)
  // หัก ณ ที่จ่ายใช้ค่าของไซท์เสมอ (ไม่มีช่องกรอกเอง) 0 = ไม่หัก
  const effectiveWhtPct = Number(site?.default_tax_withheld_pct) || 0
  const netParams = {
    hasVat: quotation.has_vat, priceIncludesVat: quotation.price_includes_vat,
    whtPct: effectiveWhtPct, retentionPct: Number(site?.default_retention_pct) || 0,
    availableOffset: depositTaxOffset || 0,
    deposit: { enabled: showDepositBox, mode: depositChoice.mode, text: depositChoice.text, balance: depositFree },
  }
  const calc = computeInvoiceNet({ ...netParams, raw: rawDrawn })
  const totals = { subtotal: calc.subtotal, vat: calc.vat, total: calc.total }
  const deposit = calc.dep
  const isSplit = quotation.pricing_mode === 'split'
  const materialLabor = isSplit
    ? sumMaterialLabor(billedLines.map(l => ({ draw_qty: drawQty(l.units), unit_price_material: l.unitPriceMaterial, unit_price_labor: l.unitPriceLabor })))
    : null
  // ยอดที่จะได้รับจริง ณ ตอนนี้ (หลัง VAT, หัก ณ ที่จ่าย, ประกันผลงาน และมัดจำที่เลือกไว้) -- โชว์ให้เห็นผลหลังเติมอัตโนมัติ
  const achievedNet = calc.net

  // กรอกยอดที่ต้องการ -> คำนวณย้อนกลับเป็นยอดที่ต้องกด (ค้นหาแบบแบ่งครึ่งบนสูตรเดียวกับการ์ดสรุป จึงรวมมัดจำและ
  // ฐานภาษีที่ตัดไว้ด้วย) แล้วกระจายเท่าๆ กันตามสัดส่วนมูลค่าที่เหลือของแต่ละรายการ (ครอบที่ 100% ของยอดที่เหลือ)
  const applyTargetFill = () => {
    const net = parseFloat(targetNet)
    if (!net || net <= 0) return
    const totalOpenValue = lines.reduce((s, l) => s + openQty(l.units) * l.unitPrice, 0)
    if (totalOpenValue <= 0) return
    const target = solveRawForNet(net, netParams, totalOpenValue)
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
        // สืบมาจากใบเสนอราคาต้นทาง (หมวด VAT ตรงกันอยู่แล้วเพราะ has_vat มาจาก
        // quotation เดียวกัน) เปลี่ยนได้ทีหลังจากตัว InvoiceDocumentModal เอง
        bank_account_id: quotation.bank_account_id || null,
        // ผูกกับใบแจ้งหนี้นี้ใบเดียว (0 = ตั้งใจไม่หัก) -- handleMarkPaid ใช้
        // ค่านี้เสมอตอนกดยืนยันชำระ แทนที่จะไปอ่าน sites.default_tax_withheld_pct
        // สดๆ ตอนนั้น ซึ่งอาจเปลี่ยนไปแล้วนับจากตอนสร้างใบนี้
        wht_pct: effectiveWhtPct,
        // เลือกตอนสร้างใบ (0 = ตั้งใจไม่หัก) -- ไม่ส่งคอลัมน์นี้ถ้า migration ยังไม่ลง/ไม่มีมัดจำคงเหลือ
        ...(deposit ? { deposit_deduction_amount: deposit.amount, deposit_deduction_pct: deposit.pct } : {}),
      }).select().single()
      if (invError) throw invError
      createdInvoiceNumber = invoice.invoice_number
      await auditLog('invoices', invoice.id, 'INSERT', null, { quotation_id: quotation.id, total: totals.total })

      // Not billedLines.entries() any more -- interleaving each item's
      // glued item_description row (below) needs sort_order to keep
      // counting up across both, not restart per item.
      let nextSortOrder = 0
      for (const l of billedLines) {
        const lineDrawQty = drawQty(l.units)
        // Waterfall-derived floats, unlike a user-typed decimal, are not
        // guaranteed to land on a clean 2-decimal value -- round before
        // persisting so the stored line/draw amounts can't drift from the
        // invoice's own already-rounded subtotal.
        const lineAmount = round2(drawAmount(l.units, l.unitPrice))
        const { data: invoiceItem, error: itemError } = await supabase.from('invoice_items').insert({
          invoice_id: invoice.id, quotation_item_id: l.quotationItemId,
          description: l.description, unit: l.unit, unit_price: l.unitPrice,
          unit_price_material: l.unitPriceMaterial, unit_price_labor: l.unitPriceLabor,
          draw_qty: lineDrawQty, line_total: lineAmount, sort_order: nextSortOrder++,
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

        // Carry the source quotation item's glued item_description along --
        // same positional convention as Quotations.jsx (no FK, just "the
        // row directly after"), not a billable line of its own (0
        // quantity/price/total, see DocumentPaper's renderRow for how this
        // prints). Previously silently dropped: billedLines only keeps
        // rows with a real drawn quantity, and a description row has none
        // of its own quotation_item_units to draw from -- confirmed live,
        // 212 real item_description rows existed across quotations and
        // none had ever reached an invoice.
        const srcIndex = items.findIndex(qi => qi.id === l.quotationItemId)
        const descRow = srcIndex >= 0 ? items[srcIndex + 1] : null
        if (descRow?.item_type === 'item_description' && descRow.description?.trim()) {
          const { error: descError } = await supabase.from('invoice_items').insert({
            invoice_id: invoice.id, quotation_item_id: descRow.id,
            description: descRow.description, unit: null, unit_price: 0,
            draw_qty: 0, line_total: 0, sort_order: nextSortOrder++, item_type: 'item_description',
          })
          if (descError) throw descError
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
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <button className="btn btn-ghost" onClick={onClose}>← กลับ</button>
        <h2 style={{ margin: 0, fontSize: 18 }}>สร้างใบแจ้งหนี้ — {quotation.quotation_number}</h2>
      </div>
      <div className="card" style={{ maxWidth: 960, margin: '0 auto' }}>
      <div className="modal-body">
        <div style={{ marginBottom: 12 }}>
          <label className="label">วันที่ออกเอกสาร</label>
          <input type="date" className="input" style={{ maxWidth: 200 }} value={date} onChange={e => setDate(e.target.value)} />
        </div>

        <InvoiceItemsEditor lines={lines} onChange={setLines} mode={mode} onModeChange={setMode} />
        <InvoiceTotalsCard
          calc={calc} hasVat={quotation.has_vat} isSplit={isSplit} materialLabor={materialLabor}
          showDeposit={showDepositBox} choice={depositChoice} siteDepositPct={siteDepositPct}
          remaining={depositRemaining} reservedTotal={reserved.total} reservedInvoices={reserved.invoices}
          free={depositFree} availableOffset={depositTaxOffset || 0}
          whtPct={effectiveWhtPct}
          legacyDepositPct={!showDepositBox && depositModule ? siteDepositPct : 0}
        />

        <div className="card card-body" style={{ marginTop: 12, display: 'grid', gap: 8 }}>
          <button type="button" onClick={() => setShowTargetCard(v => !v)} aria-expanded={showTargetCard} aria-controls="inv-target-card"
            style={{ display: 'flex', justifyContent: 'space-between', gap: 8, width: '100%', textAlign: 'left', background: 'none', border: 0, padding: 0, color: 'inherit', font: 'inherit', cursor: 'pointer' }}>
            <span className="label" style={{ marginBottom: 0 }}>{showDepositBox
              ? 'กรอกยอดที่ต้องการเรียกเก็บ (สุทธิ หลัง VAT หัก ณ ที่จ่ายตามค่าของไซท์ และหักมัดจำตามที่ตั้งไว้ด้านบน)'
              : 'กรอกยอดที่ต้องการเรียกเก็บ (สุทธิ หลัง VAT และหัก ณ ที่จ่ายตามค่าของไซท์)'}</span>
            <span style={{ fontSize: 12, color: 'var(--accent)', whiteSpace: 'nowrap' }}>{showTargetCard ? '▴ ซ่อน' : '▾ แสดง'}</span>
          </button>
          <div id="inv-target-card" hidden={!showTargetCard} style={{ display: showTargetCard ? 'grid' : 'none', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="number" min="0" step="any" className="input input-sm" style={{ width: 160 }}
              placeholder="เช่น 100000" value={targetNet} onChange={e => setTargetNet(e.target.value)}
            />
            <button type="button" className="btn btn-sm btn-primary" onClick={applyTargetFill} disabled={!targetNet}>
              🎯 เติมให้อัตโนมัติ
            </button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>
            ยอดสุทธิที่จะได้จริงจากรายการที่เลือกอยู่ตอนนี้: <strong style={{ color: 'var(--accent)' }}>{fmt(achievedNet)}</strong> บาท
          </div>
          </div>
        </div>

      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onClose}>ยกเลิก</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSave}>
          {saving ? '⏳...' : '✅ สร้างใบแจ้งหนี้'}
        </button>
      </div>
      </div>
    </div>
  )
}

// สร้างใบมัดจำ -- ต่างจาก CreateInvoiceModal ตรงที่ไม่มีการเลือก/draw
// รายการทีละบรรทัดจาก quotation_items เลย (มัดจำไม่ผูกกับความคืบหน้าของ
// รายการใดรายการหนึ่ง) แค่กรอก % ของมูลค่างานก่อน VAT แล้วระบบสร้างใบแจ้งหนี้
// ที่มี invoice_items แถวเดียว ("เงินมัดจำ") ใช้เลขที่เอกสารชุดเดียวกับ
// ใบแจ้งหนี้ปกติ (IN-prefix) ตามที่ผู้ใช้ยืนยัน -- ไม่ใช่เลขชุดใหม่แยกต่างหาก
function CreateDepositInvoiceModal({ quotation, onClose, onSaved }) {
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [pct, setPct] = useState('')
  const [saving, setSaving] = useState(false)

  const quotationTotals = calcQuotationTotals(quotation.quotation_items, {
    hasVat: quotation.has_vat, priceIncludesVat: quotation.price_includes_vat,
    discountAmount: quotation.discount_amount, discountPct: quotation.discount_pct,
  })
  const depositBase = round2(quotationTotals.subtotal * (parseFloat(pct) || 0) / 100)
  const totals = calcInvoiceTotals([{ line_total: depositBase }], { hasVat: quotation.has_vat, priceIncludesVat: quotation.price_includes_vat })

  const handleSave = async () => {
    const pctNum = parseFloat(pct)
    if (!pctNum || pctNum <= 0) { alert('กรุณาระบุ % มัดจำ'); return }
    setSaving(true)
    try {
      const { data: invoice, error: invError } = await supabase.from('invoices').insert({
        quotation_id: quotation.id, site_id: quotation.site_id, date,
        has_vat: quotation.has_vat, price_includes_vat: quotation.price_includes_vat,
        subtotal: totals.subtotal, vat: totals.vat, total: totals.total,
        bank_account_id: quotation.bank_account_id || null,
        is_deposit: true, deposit_pct: pctNum,
      }).select().single()
      if (invError) throw invError
      await auditLog('invoices', invoice.id, 'INSERT', null, { quotation_id: quotation.id, total: totals.total, is_deposit: true })

      const { error: itemError } = await supabase.from('invoice_items').insert({
        invoice_id: invoice.id, quotation_item_id: null,
        description: `เงินมัดจำ ${pctNum}% ของมูลค่างาน`, unit: null, unit_price: totals.subtotal,
        draw_qty: 1, line_total: totals.subtotal, sort_order: 0,
      })
      if (itemError) throw itemError

      onSaved()
    } catch (e) {
      alert('บันทึกไม่สำเร็จ: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`สร้างใบมัดจำ — ${quotation.quotation_number}`} onClose={onClose} maxWidth={480}>
      <div className="modal-body" style={{ display: 'grid', gap: 14 }}>
        <div>
          <label className="label">วันที่ออกเอกสาร</label>
          <input type="date" className="input" value={date} onChange={e => setDate(e.target.value)} />
        </div>
        <div>
          <label className="label">% มัดจำ (ของมูลค่างานก่อน VAT {fmt(quotationTotals.subtotal)} บาท)</label>
          <input type="number" min="0" max="100" step="0.01" className="input" placeholder="เช่น 30"
            value={pct} onChange={e => setPct(e.target.value)} />
        </div>
        <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: 8, padding: '10px 14px', fontSize: 13 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>เงินมัดจำ (ก่อน VAT)</span><span className="font-mono">{fmt(totals.subtotal)}</span></div>
          {quotation.has_vat && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>VAT (7%)</span><span className="font-mono">{fmt(totals.vat)}</span></div>}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4 }}><span>รวมเรียกเก็บ</span><span className="font-mono" style={{ color: 'var(--accent)' }}>{fmt(totals.total)}</span></div>
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onClose}>ยกเลิก</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSave}>
          {saving ? '⏳...' : '✅ สร้างใบมัดจำ'}
        </button>
      </div>
    </Modal>
  )
}

// Both the top row (logo/contact/title) and the client-info/doc-info row
// below it repeat identically on every page (per the spec's explicit
// "repeat the whole header" requirement) -- kept as one component so the
// pagination hook's renderHeader has a single, simple call.
//
// Hoisted OUT of DocumentPaper (rather than defined inline in its render
// body) deliberately: a function defined inside a component's render body
// gets a brand-new identity every render, so React treats every render as
// a brand-new component type and unmounts/remounts the whole subtree --
// including the <img crossOrigin> logo below -- even when nothing it reads
// actually changed. Real props instead of closed-over variables.
//
// Unlike QuotationHeader (Quotations.jsx), this component takes NO
// hardcoded quotation-specific fields (no revision suffix, no quotationNumber
// /date/validUntil/siteName props) -- invoices/receipts have no revision
// column, and the doc-info box stays fully caller-driven via `infoFields`,
// exactly as it already was before this rewrite. โครงการ (site name) now
// arrives as one more entry in that array rather than its own dedicated
// client-info line.
function DocumentHeader({ tenant, tag, title, infoFields, clientName, clientAddress, clientTaxId, pageNumber, totalPages, style }) {
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'stretch', gap: style.headerRowGap }}>
        <div style={{ display: 'flex', gap: style.logoGap }}>
          {tenant?.logo_url
            ? (
              <div style={{ position: 'relative', width: style.logoWidth, maxHeight: style.logoMaxHeight, flexShrink: 0 }}>
                <img src={tenant.logo_url} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', objectPosition: 'left center' }} crossOrigin="anonymous" />
              </div>
            )
            : <div style={{ width: 40, height: 40, borderRadius: 8, background: style.accent, flexShrink: 0 }} />}
          <div>
            <div style={{ fontSize: style.nameSize, fontWeight: 800 }}>{tenant?.company_name}</div>
            {tenant?.address && <div style={{ fontSize: style.addressSize, color: '#6a6f85', lineHeight: 1.6, marginTop: 2 }}>{tenant.address}</div>}
            {tenant?.tax_id && <div style={{ fontSize: style.addressSize, color: '#6a6f85' }}>เลขผู้เสียภาษี {tenant.tax_id}</div>}
            {style.showContactIcons && (tenant?.phone || tenant?.email || tenant?.website) && (
              <div style={{ fontSize: style.contactSize, color: '#4a4d63', marginTop: style.contactLineGap }}>
                {tenant?.phone && <>📞&nbsp;{tenant.phone}</>}
                {tenant?.phone && (tenant?.email || tenant?.website) && <>&nbsp;&nbsp;&nbsp;</>}
                {tenant?.email && <>✉️&nbsp;{tenant.email}</>}
                {tenant?.email && tenant?.website && <>&nbsp;&nbsp;&nbsp;</>}
                {tenant?.website && <>🌐&nbsp;{tenant.website}</>}
              </div>
            )}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: style.addressSize, color: '#6a6f85', marginBottom: 4 }}>หน้า {pageNumber}/{totalPages}</div>
          <div style={{ fontSize: style.addressSize, fontWeight: 700, color: style.accent, border: `1px solid ${style.accent}`, borderRadius: 4, padding: '2px 8px', display: 'inline-block', marginBottom: 6 }}>{tag || 'ต้นฉบับ'}</div>
          <div style={{ fontSize: style.titleSize, fontWeight: 800 }}>{title}</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: `${style.splitRatioClient}fr ${100 - style.splitRatioClient}fr`, gap: 20 }}>
        <div style={{ marginTop: style.clientInfoOffset, fontSize: 12.5, lineHeight: 2 }}>
          <div><span style={{ color: '#6a6f85' }}>ลูกค้า&nbsp;:</span> <strong>{clientName || '—'}</strong></div>
          <div><span style={{ color: '#6a6f85' }}>ที่อยู่&nbsp;:</span> {clientAddress || '—'}</div>
          {clientTaxId && <div><span style={{ color: '#6a6f85' }}>เลขที่ภาษี&nbsp;:</span> {clientTaxId}</div>}
        </div>
        <div style={{ marginTop: style.docInfoBoxOffset, border: '1px solid #e4e6ef', borderRadius: 8, padding: '14px 16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px', fontSize: style.infoSize }}>
          {infoFields.map(f => (
            <div key={f.label}><span style={{ color: '#6a6f85' }}>{f.label}</span><br />{f.value}</div>
          ))}
        </div>
      </div>
    </>
  )
}

// Design A letterhead -- same pattern as QuotationPaper (Quotations.jsx)
// and PODocumentModal: logo-or-colored-box header, tag+title top right,
// bordered info-fields grid, client block, table header, totals rule,
// notes box, signature lines. Shared between InvoiceDocumentModal and
// ReceiptDocumentModal specifically (they're the same billing family, one
// combined document per the spec) -- unlike Quotation/PO, which stay
// separate top-level document types and keep their own independent copy of
// this JSX per existing precedent.
//
// Real multi-page pagination via the shared usePaginatedDocument hook --
// same treatment as QuotationPaper. Differences from QuotationPaper, all
// deliberate: no revision suffix (invoices/receipts have no revision
// column), `infoFields` stays a caller-supplied {label,value}[] rendered
// generically (not hardcoded per-field like QuotationHeader), the footer
// has a withholding-tax sub-block instead of a discount line, `notesBlock`
// is a caller-supplied JSX prop rather than being assembled internally from
// paymentTerms/notes/bankAccount, and there are two independently-labeled
// signatures (signatures[0]/[1] + mySignature/recipientSignature) instead
// of a fixed "ผู้เสนอราคา"/"ผู้ยอมรับ (ลูกค้า)" pair.
export function DocumentPaper({ elementId, tenant, tag, title, infoFields, clientName, clientAddress, clientTaxId, items, totalsLabel, totalsAmount, subtotal, vat, hasVat, withholdingTaxPct = 0, withholdingTaxAmount = 0, isWithholdingEstimate, depositDeductionPct = 0, depositDeductionAmount = 0, isDepositEstimate, depositBeforeVat = false, notesBlock, signatures, recipientSignature, onPageCountChange, extraRemeasureKey }) {
  const mySignature = useMySignatureUrl()
  const { data: myWorkerName } = useMyWorkerName()
  const style = resolveDocumentStyle(tenant?.document_style)
  const headerProps = { tenant, tag, title, infoFields, clientName, clientAddress, clientTaxId, style }
  // Marker convention matches quotation_items: presence of a non-null
  // unit_price_material means this invoice's items carry the source
  // quotation's material/labor split forward (see buildLineState). No
  // separate flag needed -- invoice/receipt/tax-invoice all read the same
  // invoice_items rows through this one component.
  const isSplit = (items || []).some(it => it.unit_price_material != null)
  const materialLabor = isSplit ? sumMaterialLabor(items) : null

  // item_description: glued to the item row directly above it, same
  // positional convention as quotation_items (see Quotations.jsx) -- not a
  // billable line of its own (unit_price/draw_qty/line_total all 0, see
  // handleSave), so it prints as one indented, full-width text row instead
  // of repeating "0" across the qty/price/total columns.
  const renderRow = (it, i) => it.item_type === 'item_description' ? (
    <tr key={it.id || i}>
      <td colSpan={isSplit ? 5 : 4} style={{ padding: '0 8px 9px 20px', borderBottom: '1px solid #eee', whiteSpace: 'pre-line', fontSize: '0.92em', color: '#6a6f85' }}>{it.description}</td>
    </tr>
  ) : (
    <tr key={it.id || i}>
      <td style={{ padding: '9px 8px', borderBottom: '1px solid #eee', whiteSpace: 'pre-line' }}>{it.description}</td>
      <td style={{ textAlign: 'right', padding: '9px 8px', borderBottom: '1px solid #eee' }}>{fmt(it.draw_qty).replace(/\.00$/, '')} {it.unit || ''}</td>
      {isSplit ? (
        <>
          <td style={{ textAlign: 'right', padding: '9px 8px', borderBottom: '1px solid #eee' }}>{fmt(it.unit_price_material)}</td>
          <td style={{ textAlign: 'right', padding: '9px 8px', borderBottom: '1px solid #eee' }}>{fmt(it.unit_price_labor)}</td>
        </>
      ) : (
        <td style={{ textAlign: 'right', padding: '9px 8px', borderBottom: '1px solid #eee' }}>{fmt(it.unit_price)}</td>
      )}
      <td style={{ textAlign: 'right', padding: '9px 8px', borderBottom: '1px solid #eee' }}>{fmt(it.line_total)}</td>
    </tr>
  )

  // Pins every column to the same width in both the hidden measurement
  // pass and every real page's table -- see usePaginatedDocument's
  // renderColGroup comment for why auto layout (the previous behavior)
  // measured row heights wrong. Widths must sum to 100 and match
  // renderTableHeader/renderRow's column order+count exactly.
  const renderColGroup = () => isSplit ? (
    <colgroup>
      <col style={{ width: '42%' }} />
      <col style={{ width: '13%' }} />
      <col style={{ width: '13%' }} />
      <col style={{ width: '13%' }} />
      <col style={{ width: '19%' }} />
    </colgroup>
  ) : (
    <colgroup>
      <col style={{ width: '46%' }} />
      <col style={{ width: '17%' }} />
      <col style={{ width: '18%' }} />
      <col style={{ width: '19%' }} />
    </colgroup>
  )

  const thStyle = { textAlign: 'right', padding: `${style.tableHeaderPadding}px 8px`, fontSize: style.tableHeaderSize, fontWeight: style.tableHeaderBold ? 700 : 400, color: style.tableHeaderColor, background: style.tableHeaderBg, borderBottom: `${style.tableHeaderBorder}px solid ${style.accent}` }
  const renderTableHeader = () => (
    <tr>
      <th style={{ ...thStyle, textAlign: 'left' }}>รายการ</th>
      <th style={thStyle}>จำนวน</th>
      {isSplit ? (
        <>
          <th style={thStyle}>ค่าของ/หน่วย</th>
          <th style={thStyle}>ค่าแรง/หน่วย</th>
        </>
      ) : (
        <th style={thStyle}>ราคา/หน่วย</th>
      )}
      <th style={thStyle}>รวม</th>
    </tr>
  )

  // depositBeforeVat: the deposit is already inside totalsAmount (shown above the VAT line), so it is not deducted again below
  const deductedBelow = depositBeforeVat ? 0 : depositDeductionAmount
  const netAmount = totalsAmount - withholdingTaxAmount - deductedBelow
  const hasDeductions = withholdingTaxAmount > 0 || deductedBelow > 0

  // สรุป box (totals) + caller-supplied notesBlock + signature grid --
  // rendered ONLY on the true last page, but also handed to
  // usePaginatedDocument as `renderFooter` so it can measure this
  // content's real height once and reserve that much room out of the
  // last page's budget specifically. Without that reservation, a
  // fixed-height page-div has nowhere for this block to go if the packed
  // rows above it leave too little room -- it would render past the
  // bottom of the visible page.
  //
  // The flex:1 spacer sits FIRST, ahead of this whole block (not between
  // the totals box and the signature grid the way an earlier version had
  // it) -- that pushes the totals+notes+signature group down as ONE unit
  // to sit flush at the page bottom regardless of how few item rows are
  // on this page, instead of leaving the totals box stranded right under
  // a short item table with a big gap below it. Peak Accounting's layout
  // (a Thai accounting SaaS the tenant referenced directly) does the
  // same -- totals + signatures anchored to the bottom edge every time.
  const renderFooter = () => (
    <>
      <div style={{ flex: 1 }} />

      <div>
        <div style={{ marginTop: 14, display: 'flex', gap: 24, alignItems: 'flex-start', borderTop: '1px solid #e4e6ef', paddingTop: 14 }}>
          <div style={{ flex: 1, fontSize: 12.5, minWidth: 0 }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>📄 สรุป</div>
            <div style={{ display: 'grid', gap: 5 }}>
              {isSplit && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><span style={{ color: '#6a6f85' }}>รวมค่าของ</span><span>{fmt(materialLabor.material)} บาท</span></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><span style={{ color: '#6a6f85' }}>รวมค่าแรง</span><span>{fmt(materialLabor.labor)} บาท</span></div>
                </>
              )}
              {subtotal != null && depositBeforeVat && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><span style={{ color: '#6a6f85' }}>รวมงวดนี้ (ก่อน VAT)</span><span>{fmt(subtotal)} บาท</span></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><span style={{ color: '#6a6f85' }}>หักเงินมัดจำ{depositDeductionPct ? ` (${depositDeductionPct}%)` : ''}</span><span>({fmt(depositDeductionAmount)}) บาท</span></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontWeight: 600 }}><span style={{ color: '#6a6f85' }}>รวมเบิก หลังหักมัดจำ</span><span>{fmt(subtotal - depositDeductionAmount)} บาท</span></div>
                </>
              )}
              {subtotal != null && !depositBeforeVat && (
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><span style={{ color: '#6a6f85' }}>มูลค่าที่คำนวณภาษี 7%</span><span>{fmt(subtotal)} บาท</span></div>
              )}
              {hasVat && vat != null && (
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><span style={{ color: '#6a6f85' }}>ภาษีมูลค่าเพิ่ม 7%</span><span>{fmt(vat)} บาท</span></div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 4, paddingTop: 6, borderTop: '1px solid #eee' }}>
                <span style={{ color: '#6a6f85' }}>จำนวนเงินทั้งสิ้น</span>
                <span style={{ textAlign: 'right', color: '#6a6f85', fontStyle: 'italic' }}>{thaiBahtText(totalsAmount)}</span>
              </div>
            </div>
          </div>
          <div style={{ width: 220, flexShrink: 0 }}>
            <div style={{ background: `${style.accent}14`, border: `1px solid ${style.accent}55`, borderRadius: 10, padding: '10px 14px' }}>
              <div style={{ fontSize: 11, color: '#6a6f85' }}>{totalsLabel}</div>
              <div style={{ fontWeight: 800, fontSize: 17, color: style.accent }}>{fmt(totalsAmount)} บาท</div>
            </div>
            {hasDeductions && (
              <div style={{ marginTop: 10, display: 'grid', gap: 5, fontSize: 12 }}>
                {withholdingTaxAmount > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, color: '#c0392b' }}>
                    <span>จำนวนเงินที่ถูกหัก ณ ที่จ่าย ({withholdingTaxPct}%){isWithholdingEstimate ? ' (ประมาณการ)' : ''}</span>
                    <span>({fmt(withholdingTaxAmount)})</span>
                  </div>
                )}
                {deductedBelow > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, color: '#c0392b' }}>
                    <span>หักเงินมัดจำ ({depositDeductionPct}%){isDepositEstimate ? ' (ประมาณการ)' : ''}</span>
                    <span>({fmt(depositDeductionAmount)})</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontWeight: 700, borderTop: '1px solid #e4e6ef', paddingTop: 5, marginTop: 1 }}>
                  <span>จำนวนเงินที่ชำระ</span>
                  <span>{fmt(netAmount)} บาท</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {notesBlock}

        {/* footerBoxOffset stays a real margin here (not fighting a
            flex-grow sibling for it -- see the block comment above for
            why the spacer moved to the top of this whole group instead). */}
        <div style={{ marginTop: style.footerBoxOffset, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 20, textAlign: 'center', fontSize: 11.5 }}>
          <div>
            <div style={{ height: 40, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
              {mySignature && <img src={mySignature.url} alt="" crossOrigin="anonymous" style={{ height: 36, display: 'block' }} />}
            </div>
            <div style={{ borderTop: '1px solid #999', paddingTop: 8 }}>{signatures[0]}</div>
            {myWorkerName && (
              <div style={{ marginTop: 2, color: '#6a6f85', fontSize: 10 }}>{myWorkerName}</div>
            )}
          </div>
          <div>
            <div style={{ height: 40, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
              {recipientSignature && <img src={recipientSignature.url} alt="" crossOrigin="anonymous" style={{ height: 36, display: 'block' }} />}
            </div>
            <div style={{ borderTop: '1px solid #999', paddingTop: 8 }}>{signatures[1]}</div>
            {recipientSignature && (
              <div style={{ marginTop: 2, color: '#6a6f85', fontSize: 10 }}>
                {recipientSignature.signerName} · เซ็นเมื่อ {new Date(recipientSignature.signedAt).toLocaleDateString('th-TH')}
              </div>
            )}
          </div>
          <div>
            <div style={{ height: 40, border: '1px dashed #ccc', borderRadius: 6 }} />
            <div style={{ borderTop: '1px solid #999', paddingTop: 8, marginTop: 8 }}>ตราประทับ</div>
          </div>
        </div>
      </div>
    </>
  )

  const { pages, pageCount, measurementNode } = usePaginatedDocument({
    items,
    renderHeader: () => <DocumentHeader {...headerProps} pageNumber={1} totalPages={1} />,
    renderTableHeader,
    renderRow,
    renderFooter,
    renderColGroup,
    // mySignature/recipientSignature resolve asynchronously (a Storage
    // signed-URL fetch), often after `items` has already settled -- without
    // this, the hidden measurement pass can capture the footer's height
    // BEFORE either signature image is present, under-measuring by however
    // tall that image is right when the footer-overflow guarantee above
    // needs that number to be accurate. Recomputed only when either URL
    // actually changes (not every render), so this can't spin into a
    // remeasurement loop.
    //
    // extraRemeasureKey covers mutable inputs that live in the CALLER's own
    // state rather than in `items` -- unlike QuotationPaper, where every
    // footer input (paymentTerms/notes/bankAccount) arrives fixed with the
    // query row, DocumentPaper's callers can change footer/header content
    // mid-session without `items` ever changing identity:
    // InvoiceDocumentModal's bank-account <select> changes `notesBlock`
    // (~65-70px), and ReceiptDocumentModal's ใบเสร็จ/ใบกำกับภาษี toggle
    // changes infoFields[0].label, which can wrap to an extra line and
    // shift the HEADER height every page's row budget is computed from.
    // Neither of those would otherwise trigger a remeasure, silently
    // reopening the same footer-overflow risk Task 5's Critical 2 fixed.
    remeasureKey: `${mySignature?.url || ''}|${recipientSignature?.url || ''}|${extraRemeasureKey || ''}`,
    pagePaddingCss: `${style.pagePaddingV}px ${style.pagePaddingH}px`,
    pageHeight: (PAGE_HEIGHT_PX + PAGE_PADDING_V_PX * 2) - style.pagePaddingV * 2,
    tableMarginTop: style.tableMarginTop,
  })

  useEffect(() => { onPageCountChange?.(pageCount) }, [pageCount, onPageCountChange])

  // PAGE_WIDTH_PX still comes from usePaginatedDocument.jsx and drives both
  // this page-div's width and the hook's own pageWidth default (neither
  // side overrides it), so width can never drift between the hidden
  // measurement pass and this real render. Padding no longer comes from
  // that module's PAGE_PADDING_CSS constant on either side -- both this
  // page-div's padding and the pagePaddingCss passed to the hook above now
  // derive from the tenant's own `style` (resolveDocumentStyle), which is
  // still a single source shared by both the hidden pass and this real
  // render, just per-tenant instead of module-level. PAGE_PADDING_V_PX
  // itself is only used below for the fixed page-height budget math, not
  // for actual padding (that drift -- 700px measured vs a narrower real
  // content box once padding + box-sizing were accounted for -- previously
  // measured Thai text as wrapping to fewer lines than it really did,
  // letting real pages come out over-full; see usePaginatedDocument.jsx's
  // own comments for the full page-height budget math this height is
  // calibrated against). Same fixed-width
  // treatment as QuotationPaper -- this deliberately supersedes
  // DocumentPaper's previous no-inline-width behaviour that the print CSS
  // fallback rule in index.css was written around; that fallback rule is
  // left in place (untouched) for any future printable-document consumer
  // that still has no inline width of its own.
  //
  // Fixed total page-div height regardless of the tenant's chosen padding --
  // see the usePaginatedDocument call above, which derives its content
  // budget as (this fixed total) minus the tenant's tunable padding, so the
  // physical page-div height driving the PDF/print budget never moves.
  const PAGE_DIV_HEIGHT_PX = PAGE_HEIGHT_PX + PAGE_PADDING_V_PX * 2

  return (
    <div id={elementId} className="printable-document" style={{ fontFamily: 'Sarabun,sans-serif', width: PAGE_WIDTH_PX }}>
      {pages.map((pageItems, pageIndex) => {
        const isLast = pageIndex === pages.length - 1
        return (
          <div
            key={pageIndex}
            style={{
              padding: `${style.pagePaddingV}px ${style.pagePaddingH}px`, background: '#fff', color: '#17181f', boxSizing: 'border-box',
              // Fixed height, not minHeight -- see QuotationPaper's identical
              // comment (Quotations.jsx) for why: a page-div allowed to grow
              // past PAGE_DIV_HEIGHT_PX reintroduces the same
              // overflow-past-budget bug this fixed width+height pairing
              // exists to prevent. The footer -- rendered below only when
              // isLast -- is guaranteed to fit inside this fixed height
              // because usePaginatedDocument already reserved its measured
              // height out of the last page's row budget.
              height: PAGE_DIV_HEIGHT_PX, display: 'flex', flexDirection: 'column',
              pageBreakAfter: isLast ? 'auto' : 'always', breakAfter: isLast ? 'auto' : 'page',
              marginBottom: isLast ? 0 : 16,
              boxShadow: pages.length > 1 ? '0 1px 4px rgba(0,0,0,.08)' : 'none',
            }}
          >
            <DocumentHeader {...headerProps} pageNumber={pageIndex + 1} totalPages={pages.length} />

            {pageItems.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: style.tableMarginTop, tableLayout: 'fixed' }}>
                {renderColGroup()}
                <thead>{renderTableHeader()}</thead>
                <tbody>{pageItems.map(renderRow)}</tbody>
              </table>
            )}

            {isLast && renderFooter()}
          </div>
        )
      })}
      {measurementNode}
    </div>
  )
}

// เมื่อชำระแล้ว ตัวเลขจริงมาจาก incomes.tax_withheld ที่ handleMarkPaid
// คำนวณไว้แล้ว (ที่มา: sites.default_tax_withheld_pct ณ วันที่ชำระ) --
// เชื่อถือได้กว่า เพราะบันทึกไว้ตอนชำระจริง ไม่ขยับตามถ้า default % ของไซท์
// เปลี่ยนทีหลัง ส่วนใบแจ้งหนี้ที่ยังไม่ชำระ ยังไม่มี income row ให้อ้างอิง --
// ประมาณการจาก default % ปัจจุบันของไซท์แทน (isEstimate: true)
// depositTaxOffset (default 0, backward compatible for callers that don't
// have it handy -- e.g. the invoice list's row-level net-amount estimate,
// where fetching it per row would be an N+1 query) -- see
// calcInvoiceTotals' own comment for why WHT, like VAT, is levied only on
// the slice of subtotal not already taxed via an earlier deposit invoice
// on the same quotation. Reconstructing `pct` against the SAME adjusted
// base recovers the real rate (e.g. 3%) instead of a diluted-looking
// figure that would result from dividing back against the full subtotal.
function computeWithholding(invoice, depositTaxOffset = 0) {
  const taxableBase = Math.max(0, invoice.subtotal - depositTaxOffset)
  const income = invoice.incomes
  // `income` existing at all (not `income.tax_withheld > 0`) is what makes
  // this value real rather than an estimate -- an income row only exists
  // once the invoice is actually paid (see this function's own comment
  // above), so its tax_withheld is always a deliberately-recorded number,
  // including a deliberate 0 (e.g. WHT manually waived/zeroed for this
  // invoice in the ตัดรายรับ edit form). The old `> 0` check treated that
  // zero the same as "no income row yet," so it fell through to the
  // site's CURRENT default % below and showed a nonzero "estimated" WHT
  // on the invoice/printed document/list that directly contradicted the
  // real (zero) incomes.tax_withheld shown on the Income page -- reported
  // live as "invoice and income show different numbers" (IN2609-023: real
  // tax_withheld = 0.00, site default_tax_withheld_pct = 3, so the invoice
  // side kept showing a 3% deduction the income side had already removed).
  if (income) {
    const pct = taxableBase > 0 ? round2(income.tax_withheld / taxableBase * 100) : 0
    return { amount: income.tax_withheld, pct, isEstimate: false }
  }
  if (invoice.status === 'void') return { amount: 0, pct: 0, isEstimate: false }
  // Prefer what was actually chosen when this invoice was created
  // (invoice.wht_pct -- see CreateInvoiceModal's handleSave) over the
  // site's current default, since that's what handleMarkPaid will
  // actually use once this invoice is paid. null only for invoices
  // created before this column existed.
  const defaultPct = invoice.wht_pct != null ? invoice.wht_pct : (invoice.sites?.default_tax_withheld_pct || 0)
  if (defaultPct > 0) {
    return { amount: round2(taxableBase * defaultPct / 100), pct: defaultPct, isEstimate: true }
  }
  return { amount: 0, pct: 0, isEstimate: false }
}

// Same real-vs-estimate pattern as computeWithholding just above: once
// paid, incomes.deposit_deduction is what handleMarkPaid actually deducted
// (reliable -- doesn't drift if the site's default % or remaining balance
// changes later). Unpaid, estimate from the site's CURRENT default % and
// CURRENT remaining deposit balance (depositBalance, from
// useSiteDepositBalance -- a live query, since this must reflect today's
// balance, not a stale prop). A deposit invoice never deducts against
// itself (see handleMarkPaid's identical comment) -- always zero.
function computeDepositDeduction(invoice, depositBalance) {
  if (invoice.is_deposit) return { amount: 0, pct: 0, isEstimate: false }
  const income = invoice.incomes
  // Same `income` (not `income.deposit_deduction > 0`) fix as
  // computeWithholding just above -- a real income row with a genuine
  // zero deduction must not fall through to a nonzero site-default
  // estimate.
  if (income) {
    const pct = invoice.subtotal > 0 ? round2(income.deposit_deduction / invoice.subtotal * 100) : 0
    return { amount: income.deposit_deduction, pct, isEstimate: false }
  }
  if (invoice.status === 'void') return { amount: 0, pct: 0, isEstimate: false }
  // เลือกไว้ตอนสร้างใบ (migration 2026-10-09-07) -- เป็นยอดที่ตั้งใจ ไม่ใช่ประมาณการ (0 = ตั้งใจไม่หัก)
  if (invoice.deposit_deduction_amount != null) {
    const chosen = Number(invoice.deposit_deduction_amount) || 0
    return { amount: chosen, pct: invoice.subtotal > 0 ? round2(chosen / invoice.subtotal * 100) : 0, isEstimate: false }
  }
  const defaultPct = invoice.sites?.default_deposit_pct || 0
  if (defaultPct > 0 && depositBalance?.remaining_balance > 0) {
    const amount = calcDepositDeduction(invoice.subtotal, defaultPct, depositBalance.remaining_balance)
    if (amount > 0) return { amount, pct: defaultPct, isEstimate: true }
  }
  return { amount: 0, pct: 0, isEstimate: false }
}

// เอกสารใบเดียวกัน (invoice_number, ข้อมูลเดียวกันทุกอย่าง) แค่เปลี่ยนหัวเรื่อง
// ที่พิมพ์ตามขั้นตอนธุรกิจที่ใช้ส่งเอกสารนั้น -- ไม่ใช่เอกสารคนละใบ ไม่มีเลขที่
// แยกต่างหาก
const INVOICE_TITLE_OPTIONS = [
  { value: 'billing', label: 'ใบวางบิล', title: 'ใบวางบิล' },
  { value: 'invoice', label: 'ใบแจ้งหนี้', title: 'ใบแจ้งหนี้' },
  { value: 'delivery', label: 'ใบส่งมอบงาน', title: 'ใบส่งมอบงาน' },
]

function InvoiceDocumentModal({ invoice, tenant, onClose }) {
  const elementId = `inv-doc-${invoice.id}`
  // footerTextSize/footerBoxOffset used here (matching QuotationPaper's
  // footer sizing/position for visual consistency) -- this block is
  // bank-account-only, no notes/payment-terms to order it against.
  const style = resolveDocumentStyle(tenant?.document_style)
  const items = invoice.invoice_items || []
  const client = invoice.quotations?.clients
  const { hasModuleAccess } = useTenant()
  const { data: depositTaxOffset } = useQuotationDepositTaxOffset(invoice.quotation_id, invoice.has_vat, invoice.price_includes_vat, invoice.id)
  const wht = computeWithholding(invoice, effectiveInvoiceTaxOffset(invoice, depositTaxOffset))
  const { data: depositBalance } = useSiteDepositBalance(hasModuleAccess('client_deposits') ? invoice.site_id : null)
  const deposit = computeDepositDeduction(invoice, depositBalance)
  // ใบที่เลือกยอดหักมัดจำตอนสร้าง: เอกสารแสดงหักมัดจำก่อน VAT ใช้ยอดที่เลือกไว้ ณ วันออกใบ (VAT คิดจากยอดนี้ไปแล้ว)
  const chosenDeposit = !invoice.is_deposit && invoice.deposit_deduction_amount != null ? Number(invoice.deposit_deduction_amount) || 0 : 0
  const depositBeforeVat = chosenDeposit > 0
  const { data: receipt } = useDocumentReceipt('invoice', invoice.id)
  const [signatureUrl, setSignatureUrl] = useState(null)
  const [titleVariant, setTitleVariant] = useState('invoice')
  useEffect(() => {
    if (!receipt) { setSignatureUrl(null); return }
    let cancelled = false
    supabase.storage.from('document-receipts').createSignedUrl(receipt.signature_path, 300)
      .then(({ data }) => { if (!cancelled) setSignatureUrl(data?.signedUrl) })
    return () => { cancelled = true }
  }, [receipt])
  const docTitle = INVOICE_TITLE_OPTIONS.find(o => o.value === titleVariant).title

  // เปลี่ยนบัญชีธนาคารที่จะใช้รับชำระได้ตรงนี้เลย (ไม่มีฟอร์มแก้ไขใบแจ้งหนี้
  // แยกต่างหากเหมือนใบเสนอราคา) เขียนลง DB ทันทีที่เปลี่ยน จำกัดตัวเลือกไว้
  // แค่บัญชีที่อยู่หมวด VAT เดียวกับ invoice นี้เท่านั้น
  const { data: allBankAccounts } = useBankAccounts()
  const bankCategory = invoice.has_vat ? 'vat' : 'non_vat'
  const bankAccountsInCategory = (allBankAccounts || []).filter(a => a.vat_category === bankCategory)
  const [bankAccount, setBankAccount] = useState(invoice.bank_accounts || null)
  const handleChangeBankAccount = async (accountId) => {
    const account = bankAccountsInCategory.find(a => a.id === accountId) || null
    setBankAccount(account)
    const { error } = await supabase.from('invoices').update({ bank_account_id: accountId || null }).eq('id', invoice.id)
    if (error) alert('Error: ' + error.message)
  }

  // ผู้ใช้เลือกเองว่าจะบันทึก/พิมพ์เป็น "ต้นฉบับ" หรือ "สำเนา" -- ไม่ auto
  // นับจากประวัติการพิมพ์อีกต่อไป (ดูเหตุผลเดียวกันใน Quotations.jsx)
  const [printTag, setPrintTag] = useState('ต้นฉบับ')
  const [pageCount, setPageCount] = useState(1)
  const scaleRef = useRef(null)
  const handleDownload = async (format, exportFn) => {
    await logDocumentPrint(tenant?.id, 'invoice', invoice.id, format)
    const suffix = invoice.sites?.name ? `-${invoice.sites.name}` : ''
    await scaleRef.current?.withNaturalScale(() => exportFn(elementId, `${printTag}-${docTitle}-${invoice.invoice_number}${suffix}`))
  }
  // See ScaleToFit's comment (usePaginatedDocument.jsx) for why print must
  // go through the same natural-scale guard as downloadPDF/downloadJPG.
  const handlePrint = () => {
    scaleRef.current?.withNaturalScale(() => new Promise(resolve => {
      window.print()
      window.addEventListener('afterprint', resolve, { once: true })
      setTimeout(resolve, 5000)
    }))
  }

  return (
    <Modal title={`ใบแจ้งหนี้ ${invoice.invoice_number}`} onClose={onClose} maxWidth={720}>
      <div className="modal-body">
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          {INVOICE_TITLE_OPTIONS.map(o => (
            <button key={o.value} type="button" className={`btn btn-sm ${titleVariant === o.value ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setTitleVariant(o.value)}>{o.label}</button>
          ))}
        </div>
        {bankAccountsInCategory.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <label className="label">บัญชีธนาคารสำหรับรับชำระเงิน</label>
            <select className="input" style={{ maxWidth: 400 }} value={bankAccount?.id || ''} onChange={e => handleChangeBankAccount(e.target.value)}>
              {bankAccountsInCategory.map(a => (
                <option key={a.id} value={a.id}>{a.bank_name} · {a.account_name} · {a.account_no}{a.is_default ? ' (default)' : ''}</option>
              ))}
            </select>
          </div>
        )}
        {/* margin: '0 -24px' -- this modal-body has other sibling content
            (title-variant buttons, bank-account selector) that still needs
            its normal 24px side padding, so we can't zero modal-body itself
            the way QuotationDocumentModal does; reclaiming just this
            element's own horizontal slice of that padding via negative
            margin gets ScaleToFit the full-width measurement it needs (see
            usePaginatedDocument.jsx's ScaleToFit comment and
            QuotationDocumentModal's identical fix for the full reasoning).
            Tied to .modal-body's actual CSS padding (index.css) -- if that
            value changes, this drifts a few px out of sync with it. */}
        <div style={{ overflow: 'auto', margin: '0 -24px' }}>
          <ScaleToFit ref={scaleRef} width={PAGE_WIDTH_PX}>
            <DocumentPaper
              elementId={elementId} tenant={tenant} title={docTitle} tag={printTag}
              infoFields={[
                { label: 'เลขที่เอกสาร', value: invoice.invoice_number },
                { label: 'วันที่ออก', value: new Date(invoice.date).toLocaleDateString('th-TH') },
                { label: 'อ้างอิงใบเสนอราคา', value: invoice.quotations?.quotation_number },
                { label: 'โครงการ', value: invoice.sites?.name || '—' },
              ]}
              clientName={client?.name} clientAddress={client?.address} clientTaxId={client?.tax_id}
              items={items} totalsLabel="รวมทั้งสิ้น" totalsAmount={invoiceBillingTotal(invoice)}
              subtotal={invoice.subtotal} vat={invoice.vat} hasVat={invoice.has_vat}
              withholdingTaxPct={wht.pct} withholdingTaxAmount={wht.amount} isWithholdingEstimate={wht.isEstimate}
              depositDeductionPct={depositBeforeVat ? round2(chosenDeposit / (invoice.subtotal || 1) * 100) : deposit.pct}
              depositDeductionAmount={depositBeforeVat ? chosenDeposit : deposit.amount}
              isDepositEstimate={depositBeforeVat ? false : deposit.isEstimate}
              depositBeforeVat={depositBeforeVat}
              notesBlock={bankAccount && (
                <div style={{ marginTop: 20, fontSize: style.footerTextSize, background: '#f9f9fc', borderRadius: 8, padding: '12px 16px', lineHeight: 1.8 }}>
                  <strong>ชำระเงินไปที่:</strong> {bankAccount.bank_name} ชื่อบัญชี {bankAccount.account_name} เลขที่ {bankAccount.account_no}
                </div>
              )}
              signatures={['ผู้ออกใบแจ้งหนี้', 'ผู้รับเอกสาร']}
              recipientSignature={receipt && signatureUrl ? { url: signatureUrl, signerName: receipt.signer_name, signedAt: receipt.signed_at } : null}
              onPageCountChange={setPageCount}
              // bankAccount is local <select> state (handleChangeBankAccount)
              // that changes notesBlock's presence/content without `items`
              // ever changing identity -- must be part of the remeasure key
              // or a mid-session bank-account switch leaves the footer's
              // reserved height stale (see DocumentPaper's own comment).
              // titleVariant (ใบวางบิล/ใบแจ้งหนี้/ใบส่งมอบงาน) drives `title`,
              // a fresh closure input to renderHeader every render -- switching
              // to a longer variant (esp. ใบส่งมอบงาน) can wrap the 28px header
              // title differently and shift every page's row budget, the
              // identical failure mode as ReceiptDocumentModal's own
              // titleVariant below. deposit.amount resolves asynchronously
              // too (useSiteDepositBalance is its own query, often settling
              // after the first render) -- same reasoning as
              // mySignature/recipientSignature above: if it changes the
              // footer's rendered height (adding/removing the deposit-line
              // row) after the hidden pass already measured, the reserved
              // budget goes stale unless this key changes to force a remeasure.
              extraRemeasureKey={`${bankAccount?.id || ''}|${titleVariant}|${deposit.amount}|${wht.amount}`}
            />
          </ScaleToFit>
        </div>
      </div>
      <div className="modal-footer" style={{ alignItems: 'center' }}>
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          {['ต้นฉบับ', 'สำเนา'].map(t => (
            <button key={t} type="button" className={`btn btn-sm ${printTag === t ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setPrintTag(t)}>{t}</button>
          ))}
        </div>
        <RowActionsMenu
          trigger="💾 บันทึกเอกสาร ▾" triggerClassName="btn btn-primary"
          items={[
            { label: '🖨️ พิมพ์', onClick: handlePrint },
            { label: '📄 บันทึกเป็น PDF', onClick: () => handleDownload('pdf', downloadPDF) },
            { label: '🖼️ บันทึกเป็น JPG', onClick: () => handleDownload('jpg', downloadJPG), disabled: pageCount > 1, disabledTitle: 'เอกสารหลายหน้า บันทึกเป็น PDF แทน' },
          ]}
        />
      </div>
    </Modal>
  )
}

// ใบเสร็จกับใบกำกับภาษีออกพร้อมกันเสมอ (receipt แถวเดียวมีทั้งสองเลขที่) --
// นี่คือแค่เลือกว่าจะพิมพ์เป็นเอกสารไหน (บางลูกค้าขอแยก ไม่เอาแบบรวม) ไม่ใช่
// เลือกว่าจะออกอันไหน ทั้งสองเลขที่ยังอยู่ในระบบเสมอไม่ว่าจะเลือกพิมพ์แบบไหน
const RECEIPT_TITLE_OPTIONS = [
  { value: 'receipt', label: 'ใบเสร็จ', title: 'ใบเสร็จรับเงิน', numberLabel: 'เลขที่ใบเสร็จ', numberField: 'receipt_number' },
  { value: 'tax_invoice', label: 'ใบกำกับภาษี', title: 'ใบกำกับภาษี', numberLabel: 'เลขที่ใบกำกับภาษี', numberField: 'tax_invoice_number' },
]

function ReceiptDocumentModal({ invoice, receipt, tenant, onClose }) {
  const elementId = `rcp-doc-${receipt.id}`
  const items = invoice.invoice_items || []
  const client = invoice.quotations?.clients
  const { hasModuleAccess } = useTenant()
  const { data: depositTaxOffset } = useQuotationDepositTaxOffset(invoice.quotation_id, invoice.has_vat, invoice.price_includes_vat, invoice.id)
  const wht = computeWithholding(invoice, effectiveInvoiceTaxOffset(invoice, depositTaxOffset))
  const { data: depositBalance } = useSiteDepositBalance(hasModuleAccess('client_deposits') ? invoice.site_id : null)
  const deposit = computeDepositDeduction(invoice, depositBalance)
  const [titleVariant, setTitleVariant] = useState('receipt')
  const variant = RECEIPT_TITLE_OPTIONS.find(o => o.value === titleVariant)

  const [printTag, setPrintTag] = useState('ต้นฉบับ')
  const [pageCount, setPageCount] = useState(1)
  const scaleRef = useRef(null)
  const handleDownload = async (format, exportFn) => {
    await logDocumentPrint(tenant?.id, 'receipt', receipt.id, format)
    const suffix = invoice.sites?.name ? `-${invoice.sites.name}` : ''
    await scaleRef.current?.withNaturalScale(() => exportFn(elementId, `${printTag}-${variant.title}-${receipt[variant.numberField]}${suffix}`))
  }
  // See ScaleToFit's comment (usePaginatedDocument.jsx) for why print must
  // go through the same natural-scale guard as downloadPDF/downloadJPG.
  const handlePrint = () => {
    scaleRef.current?.withNaturalScale(() => new Promise(resolve => {
      window.print()
      window.addEventListener('afterprint', resolve, { once: true })
      setTimeout(resolve, 5000)
    }))
  }

  return (
    <Modal title={`ใบเสร็จรับเงิน/ใบกำกับภาษี ${receipt.receipt_number}`} onClose={onClose} maxWidth={720}>
      <div className="modal-body">
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          {RECEIPT_TITLE_OPTIONS.map(o => (
            <button key={o.value} type="button" className={`btn btn-sm ${titleVariant === o.value ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setTitleVariant(o.value)}>{o.label}</button>
          ))}
        </div>
        {/* margin: '0 -24px' -- reclaims modal-body's own horizontal padding
            for ScaleToFit's full-width measurement, same reasoning as
            InvoiceDocumentModal's identical wrapper above. */}
        <div style={{ overflow: 'auto', margin: '0 -24px' }}>
          <ScaleToFit ref={scaleRef} width={PAGE_WIDTH_PX}>
            <DocumentPaper
              elementId={elementId} tenant={tenant} title={variant.title} tag={printTag}
              infoFields={[
                { label: variant.numberLabel, value: receipt[variant.numberField] },
                { label: 'วันที่', value: new Date(receipt.date).toLocaleDateString('th-TH') },
                { label: 'อ้างอิงใบแจ้งหนี้', value: invoice.invoice_number },
                { label: 'โครงการ', value: invoice.sites?.name || '—' },
              ]}
              clientName={client?.name} clientAddress={client?.address} clientTaxId={client?.tax_id}
              items={items} totalsLabel="รวมรับชำระ" totalsAmount={receipt.amount}
              subtotal={invoice.subtotal} vat={invoice.vat} hasVat={invoice.has_vat}
              withholdingTaxPct={wht.pct} withholdingTaxAmount={wht.amount} isWithholdingEstimate={wht.isEstimate}
              depositDeductionPct={deposit.pct} depositDeductionAmount={deposit.amount} isDepositEstimate={deposit.isEstimate}
              notesBlock={null}
              signatures={['ผู้รับเงิน', 'ผู้จ่ายเงิน']}
              onPageCountChange={setPageCount}
              // titleVariant (ใบเสร็จ <-> ใบกำกับภาษี) changes
              // infoFields[0].label, which can wrap to an extra line and
              // shift the HEADER height every page's row budget is computed
              // from -- must be part of the remeasure key (see DocumentPaper's
              // own comment). deposit.amount included for the same async-
              // settling reason as InvoiceDocumentModal's identical key above.
              extraRemeasureKey={`${titleVariant}|${deposit.amount}|${wht.amount}`}
            />
          </ScaleToFit>
        </div>
      </div>
      <div className="modal-footer" style={{ alignItems: 'center' }}>
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          {['ต้นฉบับ', 'สำเนา'].map(t => (
            <button key={t} type="button" className={`btn btn-sm ${printTag === t ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setPrintTag(t)}>{t}</button>
          ))}
        </div>
        <RowActionsMenu
          trigger="💾 บันทึกเอกสาร ▾" triggerClassName="btn btn-primary"
          items={[
            { label: '🖨️ พิมพ์', onClick: handlePrint },
            { label: '📄 บันทึกเป็น PDF', onClick: () => handleDownload('pdf', downloadPDF) },
            { label: '🖼️ บันทึกเป็น JPG', onClick: () => handleDownload('jpg', downloadJPG), disabled: pageCount > 1, disabledTitle: 'เอกสารหลายหน้า บันทึกเป็น PDF แทน' },
          ]}
        />
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
        const filePath = `${tenant.id}/${invoice.id}/${Date.now()}-${sanitizeStorageFileName(file.name)}`
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
            background: dragOver ? 'rgba(var(--accent-rgb), 0.06)' : 'transparent',
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
  const mySignature = useMySignatureUrl()
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
                  <div style={{ display: 'flex', gap: '3mm', alignItems: 'stretch' }}>
                    {tenant?.logo_url
                      ? <img src={tenant.logo_url} alt="" style={{ height: '100%', maxHeight: '16mm', width: 'auto', objectFit: 'contain', flexShrink: 0 }} crossOrigin="anonymous" />
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
                      <div>
                        <div style={{ height: '9mm', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
                          {mySignature && <img src={mySignature.url} alt="" crossOrigin="anonymous" style={{ height: '8mm', display: 'block' }} />}
                        </div>
                        <div style={{ borderTop: '1px solid #999', paddingTop: '2mm' }}>ผู้จัดทำ</div>
                      </div>
                      <div>
                        <div style={{ height: '9mm' }} />
                        <div style={{ borderTop: '1px solid #999', paddingTop: '2mm' }}>ผู้รับสินค้า/งาน</div>
                      </div>
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
  const { hasModuleAccess } = useTenant()
  const depositEligible = !invoice.is_deposit && hasModuleAccess('client_deposits')
  const { data: depositBalance } = useSiteDepositBalance(depositEligible ? invoice.site_id : null)
  const chosenDeposit = invoice.deposit_deduction_amount != null ? Number(invoice.deposit_deduction_amount) || 0 : null
  const suggestedDeposit = depositBalance
    ? (chosenDeposit != null
        ? Math.min(chosenDeposit, Math.max(0, depositBalance.remaining_balance || 0))
        : calcDepositDeduction(invoice.subtotal, invoice.sites?.default_deposit_pct || 0, depositBalance.remaining_balance))
    : 0
  // Pre-fill once the real balance loads, then leave it alone -- a plain
  // `value={suggestedDeposit}` would snap the user's edit back to the
  // auto-calculated figure on every re-render (e.g. paidDate changing).
  const [depositInput, setDepositInput] = useState(null)
  useEffect(() => {
    if (depositInput === null && depositBalance) setDepositInput(String(suggestedDeposit))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depositBalance])
  const showDeposit = depositEligible && depositBalance && depositBalance.remaining_balance > 0

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
        {showDeposit && (
          <div>
            <label className="label">หักเงินมัดจำ (บาท) — แก้ไขได้ถ้าไม่อยากใช้ยอดที่คำนวณอัตโนมัติ</label>
            <input
              type="number" min="0" max={depositBalance.remaining_balance} step="any" className="input"
              value={depositInput ?? ''} onChange={e => setDepositInput(e.target.value)}
            />
            <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 4 }}>
              ค่าเริ่มต้น {fmt(suggestedDeposit)} บาท ({chosenDeposit != null ? 'ยอดที่เลือกไว้ตอนสร้างใบ' : `${invoice.sites?.default_deposit_pct || 0}% ของยอดก่อน VAT`}) — มัดจำคงเหลืออยู่ {fmt(depositBalance.remaining_balance)} บาท
              {' '}เช่น ถ้ายอดนี้เคยถูกหัก ณ ที่จ่ายไปแล้วบางส่วนตอนรับมัดจำ จะลดยอดหักมัดจำตรงนี้ลงเพื่อไม่ให้ซ้ำซ้อนกันก็ได้
            </div>
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
        <button className="btn btn-primary" onClick={() => onConfirm(paidDate, showDeposit ? (parseFloat(depositInput) || 0) : null)}>ยืนยัน</button>
      </div>
    </Modal>
  )
}

export default function Invoices({ navigateTo, navState, openSiteOverview }) {
  const { isAtLeast, role } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'invoices')
  // Hard-gated to OWNER, not routed through the customizable per-role
  // permissions.js system like canEdit -- unlike voiding an unpaid draft,
  // unmarking a paid invoice deletes a real income record that may already
  // be reflected in reports/reconciliation. Same pattern Settings.jsx uses
  // for its OWNER-only document style customizer.
  const isOwner = isAtLeast('OWNER')
  const today = new Date()
  const ytdFrom = format(startOfYear(today), 'yyyy-MM-dd')
  const ytdTo   = format(endOfYear(today),   'yyyy-MM-dd')

  const [dateFrom, setDateFrom] = useState(ytdFrom)
  const [dateTo,   setDateTo]   = useState(ytdTo)
  const [siteId,   setSiteId]   = useState('')
  const [status,   setStatus]   = useState('')
  const [hideVoid, setHideVoid] = useState(true)
  const [search,   setSearch]   = useState('')
  const [sortCol,  setSortCol]  = useState('date')
  const [sortDir,  setSortDir]  = useState('desc')
  const [pickQuotation, setPickQuotation] = useState(false)
  const [createFor, setCreateFor] = useState(null)
  const [pickQuotationDeposit, setPickQuotationDeposit] = useState(false)
  const [createDepositFor, setCreateDepositFor] = useState(null)
  const [toast, setToast] = useState(null)

  const filters = { from: dateFrom, to: dateTo, siteId, status }
  const { data: invoices, error: invoicesError, refetch } = useInvoices(filters)
  const { data: sites } = useSites()

  // เรียง/ค้นหาแบบ client-side ทับผลลัพธ์ที่กรองมาจาก server แล้ว (date/site/status)
  // -- accessor ต่อคอลัมน์ เพราะบางคอลัมน์ (ไซท์งาน, ลูกค้า) เป็น field ที่ join มา
  const SORT_ACCESSORS = {
    invoice_number: inv => inv.invoice_number || '',
    date:           inv => inv.date || '',
    site:           inv => inv.sites?.name || '',
    client:         inv => inv.quotations?.clients?.name || '',
    total:          inv => invoiceBillingTotal(inv),
    status:         inv => inv.status || '',
  }
  const sortedInvoices = useMemo(() => {
    const rows = (invoices || [])
      .filter(inv => !search || (inv.quotations?.clients?.name || '').toLowerCase().includes(search.toLowerCase()))
      .filter(inv => !hideVoid || inv.status !== 'void')
    const acc = SORT_ACCESSORS[sortCol]
    return [...rows].sort((a, b) => {
      const va = acc(a), vb = acc(b)
      if (typeof va === 'number') return sortDir === 'asc' ? va - vb : vb - va
      return sortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va))
    })
  }, [invoices, search, hideVoid, sortCol, sortDir])
  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }
  const si = (col) => sortCol === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕'
  const { data: acceptedQuotations } = useQuotations({ status: 'accepted' })

  const billableQuotations = useMemo(() =>
    (acceptedQuotations || []).filter(q => q.site_id), [acceptedQuotations])

  const [payingId, setPayingId] = useState(null)
  const [voidingId, setVoidingId] = useState(null)
  const [unmarkingPaidId, setUnmarkingPaidId] = useState(null)
  const [voidRow, setVoidRow] = useState(null)
  const [payRow, setPayRow] = useState(null)
  const [unmarkPaidRow, setUnmarkPaidRow] = useState(null)
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
  const handleMarkPaid = async (invoice, paidDate, depositOverride) => {
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
        // WHT (like VAT -- see calcInvoiceTotals' depositTaxOffset comment)
        // is levied only on the slice of this invoice's value that hasn't
        // already been taxed once via an earlier deposit invoice for the
        // same quotation. Retention is deliberately NOT adjusted here --
        // it's a holdback against the full delivered contract value, not
        // a tax, so deposit timing doesn't affect its base.
        // ใบที่เลือกยอดหักมัดจำตอนสร้าง (deposit_deduction_amount) ใช้ส่วนที่ตัดฐานภาษีจริงของใบนั้นเอง
        // ใบเก่าคงพฤติกรรมเดิม (ภาษีมัดจำที่ยังไม่ถูกใช้ ณ ตอนนี้)
        const depositTaxOffset = invoice.is_deposit
          ? 0
          : effectiveInvoiceTaxOffset(
              invoice,
              invoice.deposit_deduction_amount != null
                ? 0
                : await getQuotationDepositTaxOffset(invoice.quotation_id, invoice.has_vat, invoice.price_includes_vat, invoice.id),
            )
        const whtBase = Math.max(0, noVat - depositTaxOffset)
        // invoice.wht_pct (set once, at invoice-creation time -- see
        // CreateInvoiceModal's handleSave) wins over the site's CURRENT
        // default whenever it's set, including an explicit 0 (WHT
        // deliberately turned off for this invoice). null only for
        // invoices created before this column existed -- those keep the
        // old behavior of reading the site's live default at payment time.
        const taxPct = invoice.wht_pct != null ? invoice.wht_pct : (site.default_tax_withheld_pct || 0)
        const taxAmt = whtBase * taxPct / 100
        const retentionAmt = noVat * (site.default_retention_pct || 0) / 100

        // ใบมัดจำ "เป็น" เงินมัดจำเอง ไม่ใช่การเบิกที่ต้องหักจากยอดมัดจำที่มีอยู่
        // (ดู client-deposit-tracking design spec) -- ข้ามการคำนวณ depositAmt
        // ทั้งหมด ตั้ง deposit_deduction=0 เสมอ เหมือน income_type='มัดจำ' ที่
        // กรอกเองในหน้า Income
        let depositAmt = 0
        if (!invoice.is_deposit && hasModuleAccess('client_deposits')) {
          const { data: depositBalance } = await supabase
            .from('site_deposit_summary')
            .select('remaining_balance')
            .eq('site_id', invoice.site_id)
            .maybeSingle()
          if (depositBalance) {
            // depositOverride comes from MarkPaidModal's editable field --
            // lets the user correct/reduce the auto-suggested % amount for
            // a specific invoice (e.g. avoiding a double withholding-tax
            // deduction when this invoice's subtotal already overlaps with
            // a portion covered by an earlier deposit invoice, which the
            // automatic % calc has no way to know about). Still clamped to
            // the real remaining balance -- can never deduct more than the
            // deposit pool actually has left, override or not.
            const balance = Math.max(0, depositBalance.remaining_balance || 0)
            depositAmt = depositOverride != null
              ? Math.min(Math.max(0, depositOverride), balance)
              : invoice.deposit_deduction_amount != null
                ? Math.min(Number(invoice.deposit_deduction_amount) || 0, balance)
                : calcDepositDeduction(noVat, site.default_deposit_pct || 0, depositBalance.remaining_balance)
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
          income_type: invoice.is_deposit ? 'มัดจำ' : 'ปกติ',
          deposit_deduction: round2(depositAmt),
          received_amount: receivedAmount,
        }
        const { data: newIncome, error: incomeError } = await supabase.from('incomes').insert(incomePayload).select().single()
        if (incomeError) throw incomeError
        income = newIncome

        // เหมือน Income.jsx: บันทึกมัดจำแล้วตั้ง default_deposit_pct ของไซท์
        // ทันที เพื่อให้ใบแจ้งหนี้ปกติงวดถัดไปหักมัดจำอัตโนมัติโดยไม่ต้องไปตั้งซ้ำ
        if (invoice.is_deposit && invoice.deposit_pct != null) {
          const { error: pctError } = await supabase.from('sites')
            .update({ default_deposit_pct: invoice.deposit_pct })
            .eq('id', invoice.site_id)
          if (pctError) throw pctError
        }
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

  // OWNER-only: reverses a paid invoice back to unpaid by deleting its
  // linked income + receipt. Deliberately does NOT touch billed line-item
  // progress (quotation_item_units.cumulative_pct) -- that stays exactly
  // where handleMarkPaid last drew it. Once this invoice is unpaid again,
  // the existing "✕ ยกเลิก" void action (already visible to canEdit on any
  // unpaid invoice) becomes available and handles reverting that progress
  // itself, the same way it does for a plain unpaid draft. This two-step
  // split keeps the risky "delete a real income record" action separate
  // from the already-reviewed void logic instead of duplicating it.
  const handleUnmarkPaid = async (invoice) => {
    if (invoice.status !== 'paid' || payingId || voidingId || unmarkingPaidId) return
    setUnmarkingPaidId(invoice.id)
    try {
      const receipt = (receipts || []).find(r => r.invoice_id === invoice.id)
      const { data: income, error: incomeFetchError } = await supabase
        .from('incomes').select('*').eq('id', invoice.income_id).maybeSingle()
      if (incomeFetchError) throw incomeFetchError

      if (receipt) {
        const { error: receiptDeleteError } = await supabase.from('receipts').delete().eq('id', receipt.id)
        if (receiptDeleteError) throw receiptDeleteError
        await auditLog('receipts', receipt.id, 'DELETE', receipt, null)
      }
      if (income) {
        const { error: incomeDeleteError } = await supabase.from('incomes').delete().eq('id', income.id)
        if (incomeDeleteError) throw incomeDeleteError
        await auditLog('incomes', income.id, 'DELETE', income, null)
      }

      const oldValues = { status: invoice.status, income_id: invoice.income_id, paid_date: invoice.paid_date }
      const { data: updateResult, error: updateError } = await supabase.from('invoices')
        .update({ status: 'unpaid', paid_date: null, income_id: null })
        .eq('id', invoice.id).eq('status', 'paid').select('id')
      if (updateError) throw updateError
      if (!updateResult || updateResult.length === 0) {
        throw new Error('ใบแจ้งหนี้นี้ถูกเปลี่ยนสถานะโดยผู้ใช้อื่นไปแล้ว กรุณารีเฟรชหน้าจอ')
      }
      await auditLog('invoices', invoice.id, 'UPDATE', oldValues, { status: 'unpaid', income_id: null, paid_date: null })

      refetch(); refetchReceipts(); showToast('ยกเลิกการชำระเงินแล้ว')
    } catch (e) {
      alert('ยกเลิกการชำระเงินไม่สำเร็จ (โปรดตรวจสอบและกระทบยอดด้วยตนเองหากมีการบันทึกไปแล้วบางส่วน): ' + e.message)
    } finally {
      setUnmarkingPaidId(null)
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

  // สร้างใบแจ้งหนี้เป็นหน้าเต็มแทน popup (เหมือน Quotations.jsx/PurchaseOrders.jsx
  // -- ฟอร์มยาว มีทั้งรายการงวดงานและช่องกรอกยอดที่ต้องการเรียกเก็บ)
  if (createFor) {
    return (
      <CreateInvoiceModal
        quotation={createFor}
        site={(sites || []).find(s => s.id === createFor.site_id)}
        onClose={() => setCreateFor(null)}
        onSaved={() => { setCreateFor(null); refetch(); showToast('สร้างใบแจ้งหนี้สำเร็จ') }}
      />
    )
  }

  return (
    <div>
      {toast && <div className="alert alert-success" style={{ marginBottom: 12 }}>✅ {toast}</div>}

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        {canEdit && <button className="btn btn-primary" onClick={() => setPickQuotation(true)}>+ สร้างใบแจ้งหนี้</button>}
        {canEdit && <button className="btn btn-ghost" onClick={() => setPickQuotationDeposit(true)}>+ สร้างใบมัดจำ</button>}
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
        <input className="input input-sm" style={{ width: 180 }} placeholder="ค้นหาลูกค้า..." value={search} onChange={e => setSearch(e.target.value)} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={hideVoid} onChange={e => setHideVoid(e.target.checked)} />
          ซ่อนใบที่ยกเลิก
        </label>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="sortable" onClick={() => toggleSort('invoice_number')}>เลขที่{si('invoice_number')}</th>
                <th className="sortable" onClick={() => toggleSort('date')}>วันที่{si('date')}</th>
                <th className="sortable" onClick={() => toggleSort('site')}>ไซท์งาน{si('site')}</th>
                <th className="sortable" onClick={() => toggleSort('client')}>ลูกค้า{si('client')}</th>
                <th>รายการ</th>
                <th className="sortable" onClick={() => toggleSort('total')}>ยอดรวม{si('total')}</th>
                <th className="sortable" onClick={() => toggleSort('status')}>สถานะ{si('status')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sortedInvoices.map(inv => (
                <tr key={inv.id}>
                  <td className="font-mono" style={{ fontSize: 12 }}>
                    {inv.invoice_number}
                    {inv.is_deposit && <span className="badge" style={{ marginLeft: 6, fontSize: 10 }}>มัดจำ</span>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDate(inv.date)}</td>
                  <td style={{ fontSize: 11, color: 'var(--accent)', cursor: inv.site_id ? 'pointer' : 'default' }}
                    onClick={() => inv.site_id && openSiteOverview(inv.site_id)}>{inv.sites?.name || '—'}</td>
                  <td style={{ fontSize: 12 }}>{inv.quotations?.clients?.name || '—'}</td>
                  <td style={{ fontSize: 11, color: 'var(--text3)' }}>{(inv.invoice_items || []).length} รายการ</td>
                  <td className="font-mono" style={{ fontWeight: 700 }}>
                    {fmt(invoiceBillingTotal(inv))}
                    {(() => {
                      const wht = computeWithholding(inv, effectiveInvoiceTaxOffset(inv, 0))
                      return wht.amount > 0 ? (
                        <div style={{ fontSize: 10, fontWeight: 400, color: 'var(--text3)' }}>
                          สุทธิ {fmt(invoiceBillingTotal(inv) - wht.amount)}{wht.isEstimate ? ' (ประมาณ)' : ''}
                        </div>
                      ) : null
                    })()}
                  </td>
                  <td><span className={`badge badge-${inv.status}`}>{INV_STATUS_LABELS[inv.status] || inv.status}</span></td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {canEdit && inv.status === 'unpaid' && (
                      <button className="btn btn-sm btn-primary" disabled={payingId === inv.id} onClick={() => setPayRow(inv)}>
                        {payingId === inv.id ? '⏳...' : '✅ ชำระแล้ว'}
                      </button>
                    )}
                    <button className="btn btn-sm btn-ghost" onClick={() => setDocRow(inv)}>📄</button>
                    <RowActionsMenu items={[
                      ...(canEdit && inv.status === 'unpaid' ? [{ label: '✕ ยกเลิก', onClick: () => setVoidRow(inv), danger: true }] : []),
                      ...(isOwner && inv.status === 'paid' ? [{ label: '↩️ ยกเลิกการชำระเงิน', onClick: () => setUnmarkPaidRow(inv), danger: true }] : []),
                      ...(inv.status === 'paid' ? [{ label: '🧾 ใบเสร็จ', onClick: () => setReceiptRow(inv) }] : []),
                      ...(canEdit ? [{ label: '📷 รูปประกอบการส่งงาน', onClick: () => setPhotosRow(inv) }] : []),
                      ...(canEdit ? [{ label: '🔗 ลิงก์เซ็นรับระยะไกล', onClick: () => setLinkTarget(inv) }] : []),
                    ]} />
                  </td>
                </tr>
              ))}
              {!sortedInvoices.length && (
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

      {pickQuotationDeposit && (
        <Modal title="เลือกใบเสนอราคาที่จะออกใบมัดจำ" onClose={() => setPickQuotationDeposit(false)} maxWidth={520}>
          <div className="modal-body">
            <SearchableSelect
              value={null}
              onChange={id => { const q = billableQuotations.find(x => x.id === id); setPickQuotationDeposit(false); setCreateDepositFor(q) }}
              placeholder="— เลือกใบเสนอราคา —"
              options={billableQuotations.map(q => ({
                value: q.id, label: `${q.sites?.name || q.quotation_number} · ${q.quotation_number}`,
                keywords: `${q.sites?.name || ''} ${q.quotation_number} ${q.clients?.name || ''}`,
              }))}
            />
            {!billableQuotations.length && <p style={{ color: 'var(--text3)', fontSize: 12, marginTop: 8 }}>ไม่มีใบเสนอราคาที่ยอมรับแล้วและมีไซท์งานผูกอยู่</p>}
          </div>
        </Modal>
      )}

      {createDepositFor && (
        <CreateDepositInvoiceModal
          quotation={createDepositFor}
          onClose={() => setCreateDepositFor(null)}
          onSaved={() => { setCreateDepositFor(null); refetch(); showToast('สร้างใบมัดจำสำเร็จ') }}
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

      {unmarkPaidRow && (
        <ConfirmDialog
          title="ยกเลิกการชำระเงิน"
          message={`ยืนยันการยกเลิกการชำระเงินของใบแจ้งหนี้ ${unmarkPaidRow.invoice_number}? ระบบจะลบรายรับที่บันทึกไว้ (฿${fmt(unmarkPaidRow.total)}) และใบเสร็จที่ออกไปแล้ว แล้วเปลี่ยนสถานะกลับเป็น "ยังไม่ชำระ" — การกระทำนี้ไม่สามารถย้อนกลับได้ หลังจากนี้คุณจะสามารถกด "✕ ยกเลิก" เพื่อยกเลิกใบแจ้งหนี้ต่อได้ตามปกติ`}
          onConfirm={() => { handleUnmarkPaid(unmarkPaidRow); setUnmarkPaidRow(null) }}
          onCancel={() => setUnmarkPaidRow(null)}
          danger
        />
      )}

      {payRow && (
        <MarkPaidModal
          invoice={payRow}
          onConfirm={(paidDate, depositOverride) => { handleMarkPaid(payRow, paidDate, depositOverride); setPayRow(null) }}
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
