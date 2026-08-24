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
import { useInvoices, useQuotationItemUnits, useQuotations, useSites, useReceipts } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { useTenant } from '../hooks/useTenant.js'
import { calcDepositDeduction, round2 } from '../lib/depositCalc.js'
import { canEditPage } from '../lib/permissions.js'
import { fmt, fmtDate } from '../lib/supabase.js'
import { auditLog } from '../lib/audit.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import SearchableSelect from '../components/SearchableSelect.jsx'
import { format, startOfYear, endOfYear } from 'date-fns'
import { isCountable, waterfall, openQty, drawQty, drawAmount, calcInvoiceTotals } from '../lib/invoiceCalc.js'
import { calcQuotationTotals } from '../lib/quotationCalc.js'
import { downloadPDF, downloadJPG } from '../lib/pdf.js'

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
      unitPrice: qi.unit_price * priceMultiplier, totalQty: qi.quantity, checked: true, units,
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
  const [qtyDrafts, setQtyDrafts] = useState({})
  const [pctDrafts, setPctDrafts] = useState({})
  // Any programmatic change to the ledger (ticking a box) invalidates every
  // in-progress draft -- keeping one around would show a stale number after
  // the box is unticked again.
  const clearDrafts = () => { setQtyDrafts({}); setPctDrafts({}) }

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
                  <input type="number" min="0" max={remaining} step="1" className="input input-sm"
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
                <span className="font-mono" style={{ fontWeight: 700, textAlign: 'right', color: l.checked ? 'var(--accent)' : undefined }}>{fmt(lineAmount)}</span>
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
                          <input type="number" min={u.cumulativePct} max="100" step="1" className="input input-sm"
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

function CreateInvoiceModal({ quotation, onClose, onSaved }) {
  const items = quotation.quotation_items || []
  const { data: unitsByQuotationItem, loading: unitsLoading, error: unitsError } = useQuotationItemUnits(quotation.id, items)
  const [lines, setLines] = useState(null)
  const [mode, setMode] = useState('easy')
  const [saving, setSaving] = useState(false)

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

  const handleSave = async () => {
    if (!billedLines.length) { alert('กรุณาเลือกอย่างน้อย 1 รายการ'); return }
    setSaving(true)
    // Captured so the catch below can name the orphan: the invoices row is
    // written before its items/draws, so a mid-loop failure leaves a real,
    // partially-populated invoice the user has to void before retrying.
    let createdInvoiceNumber = null
    try {
      const { data: invoice, error: invError } = await supabase.from('invoices').insert({
        quotation_id: quotation.id, site_id: quotation.site_id, date: format(new Date(), 'yyyy-MM-dd'),
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
        ? ` ระบบได้สร้างใบแจ้งหนี้เลขที่ ${createdInvoiceNumber} ไปบางส่วนแล้ว กรุณายกเลิก (ยกเลิก) ใบแจ้งหนี้นี้แล้วลองสร้างใหม่อีกครั้ง`
        : ''
      alert('บันทึกไม่สำเร็จ: ' + e.message + recovery)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`สร้างใบแจ้งหนี้ — ${quotation.quotation_number}`} onClose={onClose} maxWidth={760}>
      <div className="modal-body">
        <InvoiceItemsEditor lines={lines} onChange={setLines} mode={mode} onModeChange={setMode} />
        <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: 8, padding: '10px 14px', fontSize: 13, marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>รวมงวดนี้ (ก่อน VAT)</span><span className="font-mono">{fmt(totals.subtotal)}</span></div>
          {quotation.has_vat && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>VAT (7%)</span><span className="font-mono">{fmt(totals.vat)}</span></div>}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4 }}><span>รวมเรียกเก็บงวดนี้</span><span className="font-mono" style={{ color: 'var(--accent)' }}>{fmt(totals.total)}</span></div>
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

function InvoiceDocumentModal({ invoice, tenant, onClose }) {
  const items = invoice.invoice_items || []
  return (
    <Modal title={`ใบแจ้งหนี้ ${invoice.invoice_number}`} onClose={onClose} maxWidth={640}>
      <div className="modal-body">
        <div id={`inv-doc-${invoice.id}`} style={{ fontFamily: 'Sarabun,sans-serif', padding: '20px 24px', background: '#fff', color: '#111' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, gap: 12 }}>
            <div>
              {tenant?.logo_url && <img src={tenant.logo_url} alt="" style={{ maxHeight: 48, marginBottom: 6 }} crossOrigin="anonymous" />}
              <div style={{ fontSize: 16, fontWeight: 800 }}>{tenant?.company_name}</div>
              {tenant?.address && <div style={{ fontSize: 11 }}>{tenant.address}</div>}
              {tenant?.tax_id && <div style={{ fontSize: 11 }}>เลขประจำตัวผู้เสียภาษี: {tenant.tax_id}</div>}
              {tenant?.phone && <div style={{ fontSize: 11 }}>โทร: {tenant.phone}</div>}
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>ใบแจ้งหนี้</div>
              <div style={{ fontSize: 12 }}>เลขที่: {invoice.invoice_number}</div>
              <div style={{ fontSize: 12 }}>วันที่: {new Date(invoice.date).toLocaleDateString('th-TH')}</div>
              <div style={{ fontSize: 12 }}>อ้างอิงใบเสนอราคา: {invoice.quotations?.quotation_number}</div>
            </div>
          </div>
          <div style={{ fontSize: 13, marginBottom: 12 }}><strong>ลูกค้า:</strong> {invoice.quotations?.clients?.name}</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #111' }}>
                <th style={{ textAlign: 'left', padding: '6px 4px' }}>รายการ</th>
                <th style={{ textAlign: 'right', padding: '6px 4px' }}>งวดนี้</th>
                <th style={{ textAlign: 'right', padding: '6px 4px' }}>ราคา/หน่วย</th>
                <th style={{ textAlign: 'right', padding: '6px 4px' }}>รวม</th>
              </tr>
            </thead>
            <tbody>
              {items.map(it => (
                <tr key={it.id} style={{ borderBottom: '1px solid #ddd' }}>
                  <td style={{ padding: '6px 4px' }}>{it.description}</td>
                  <td style={{ textAlign: 'right', padding: '6px 4px' }}>{fmt(it.draw_qty)} {it.unit || ''}</td>
                  <td style={{ textAlign: 'right', padding: '6px 4px' }}>{fmt(it.unit_price)}</td>
                  <td style={{ textAlign: 'right', padding: '6px 4px' }}>{fmt(it.line_total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3} style={{ padding: '6px 4px', borderTop: '2px solid #111' }}>รวมก่อน VAT</td>
                <td style={{ textAlign: 'right', padding: '6px 4px', borderTop: '2px solid #111' }}>{fmt(invoice.subtotal)}</td>
              </tr>
              {invoice.has_vat && (
                <tr>
                  <td colSpan={3} style={{ padding: '6px 4px' }}>VAT (7%)</td>
                  <td style={{ textAlign: 'right', padding: '6px 4px' }}>{fmt(invoice.vat)}</td>
                </tr>
              )}
              <tr style={{ fontWeight: 700, fontSize: 15 }}>
                <td colSpan={3} style={{ padding: '8px 4px', borderTop: '1px solid #111' }}>รวมทั้งสิ้น</td>
                <td style={{ textAlign: 'right', padding: '8px 4px', borderTop: '1px solid #111' }}>{fmt(invoice.total)} บาท</td>
              </tr>
            </tfoot>
          </table>
          {(tenant?.bank_name || tenant?.bank_account_no) && (
            <div style={{ fontSize: 12, marginTop: 16 }}>
              <strong>ชำระเงินไปที่:</strong> {tenant.bank_name} {tenant.bank_account_name ? `ชื่อบัญชี ${tenant.bank_account_name}` : ''} {tenant.bank_account_no ? `เลขที่ ${tenant.bank_account_no}` : ''}
            </div>
          )}
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={() => downloadPDF(`inv-doc-${invoice.id}`, invoice.invoice_number)}>📄 PDF</button>
        <button className="btn btn-ghost" onClick={() => downloadJPG(`inv-doc-${invoice.id}`, invoice.invoice_number)}>🖼️ JPG</button>
        <button className="btn btn-primary" onClick={onClose}>ปิด</button>
      </div>
    </Modal>
  )
}

function ReceiptDocumentModal({ invoice, receipt, tenant, onClose }) {
  return (
    <Modal title={`ใบเสร็จรับเงิน/ใบกำกับภาษี ${receipt.receipt_number}`} onClose={onClose} maxWidth={640}>
      <div className="modal-body">
        <div id={`rcp-doc-${receipt.id}`} style={{ fontFamily: 'Sarabun,sans-serif', padding: '20px 24px', background: '#fff', color: '#111' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, gap: 12 }}>
            <div>
              {tenant?.logo_url && <img src={tenant.logo_url} alt="" style={{ maxHeight: 48, marginBottom: 6 }} crossOrigin="anonymous" />}
              <div style={{ fontSize: 16, fontWeight: 800 }}>{tenant?.company_name}</div>
              {tenant?.address && <div style={{ fontSize: 11 }}>{tenant.address}</div>}
              {tenant?.tax_id && <div style={{ fontSize: 11 }}>เลขประจำตัวผู้เสียภาษี: {tenant.tax_id}</div>}
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>ใบเสร็จรับเงิน / ใบกำกับภาษี</div>
              <div style={{ fontSize: 12 }}>เลขที่ใบเสร็จ: {receipt.receipt_number}</div>
              <div style={{ fontSize: 12 }}>เลขที่ใบกำกับภาษี: {receipt.tax_invoice_number}</div>
              <div style={{ fontSize: 12 }}>วันที่: {new Date(receipt.date).toLocaleDateString('th-TH')}</div>
              <div style={{ fontSize: 12 }}>อ้างอิงใบแจ้งหนี้: {invoice.invoice_number}</div>
            </div>
          </div>
          <div style={{ fontSize: 13, marginBottom: 12 }}><strong>ลูกค้า:</strong> {invoice.quotations?.clients?.name}</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <tbody>
              <tr style={{ borderBottom: '2px solid #111' }}>
                <td style={{ padding: '8px 4px' }}>ชำระเงินตามใบแจ้งหนี้ {invoice.invoice_number}</td>
                <td style={{ textAlign: 'right', padding: '8px 4px' }}>{fmt(receipt.amount)} บาท</td>
              </tr>
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700, fontSize: 15 }}>
                <td style={{ padding: '8px 4px', borderTop: '1px solid #111' }}>รวมรับชำระ</td>
                <td style={{ textAlign: 'right', padding: '8px 4px', borderTop: '1px solid #111' }}>{fmt(receipt.amount)} บาท</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={() => downloadPDF(`rcp-doc-${receipt.id}`, receipt.receipt_number)}>📄 PDF</button>
        <button className="btn btn-ghost" onClick={() => downloadJPG(`rcp-doc-${receipt.id}`, receipt.receipt_number)}>🖼️ JPG</button>
        <button className="btn btn-primary" onClick={onClose}>ปิด</button>
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
  const { data: invoices, refetch } = useInvoices(filters)
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
  const { data: receipts, refetch: refetchReceipts } = useReceipts((invoices || []).map(i => i.id))

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3000) }

  // Computes retention/deposit_deduction/received_amount the exact same
  // way IncomeForm does today (src/pages/Income.jsx): site default %s
  // applied to the pre-VAT amount, deposit deduction additionally capped
  // by calcDepositDeduction() against whatever deposit balance the site
  // has left, and only applied at all if the client_deposits module is on
  // (matches IncomeForm's `depositModuleOn` gate).
  const handleMarkPaid = async (invoice) => {
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
          invoice_id: invoice.id, date: format(new Date(), 'yyyy-MM-dd'), amount: invoice.total,
        }).select().single()
        if (receiptError) throw receiptError
        receipt = newReceipt
        await auditLog('receipts', receipt.id, 'INSERT', null, { invoice_id: invoice.id, amount: invoice.total })
      }

      // incomes.invoice_no has no UNIQUE constraint at the DB level -- guard
      // duplication in app code the same way the receipt reuse above does.
      // Deliberately NOT .maybeSingle(): that errors out on a non-unique
      // column the moment more than one row already matches, and a
      // swallowed error here would insert yet another duplicate -- the very
      // thing this block exists to prevent. limit(1) reuses the oldest
      // match whether there are 0, 1 or many, and a genuine query failure
      // throws instead of falling through to an insert.
      let income
      const { data: existingIncomes, error: existingIncomeError } = await supabase
        .from('incomes').select('*').eq('invoice_no', invoice.invoice_number)
        .order('created_at', { ascending: true }).limit(1)
      if (existingIncomeError) throw existingIncomeError
      if (existingIncomes && existingIncomes.length) {
        income = existingIncomes[0]
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
          date: format(new Date(), 'yyyy-MM-dd'),
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

      const invUpdate = { status: 'paid', paid_date: format(new Date(), 'yyyy-MM-dd'), income_id: income.id }
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
      for (const d of draws) {
        const { data: revertResult, error } = await supabase.from('quotation_item_units')
          .update({ cumulative_pct: d.prior_pct, updated_at: new Date().toISOString() })
          .eq('id', d.quotation_item_unit_id)
          .eq('cumulative_pct', d.target_pct)
          .select('id')
        if (error) throw error
        if (!revertResult || revertResult.length === 0) {
          throw new Error('ไม่สามารถยกเลิกได้ เนื่องจากมีการเรียกเก็บเงินเพิ่มเติมกับรายการนี้ในใบแจ้งหนี้อื่นแล้ว')
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
                  <td className="font-mono" style={{ fontWeight: 700 }}>{fmt(inv.total)}</td>
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
                  </td>
                </tr>
              ))}
              {!(invoices || []).length && (
                <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>ไม่พบใบแจ้งหนี้ในช่วงเวลานี้</td></tr>
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
              options={billableQuotations.map(q => ({ value: q.id, label: `${q.quotation_number} · ${q.clients?.name || ''}`, keywords: `${q.quotation_number} ${q.clients?.name || ''}` }))}
            />
            {!billableQuotations.length && <p style={{ color: 'var(--text3)', fontSize: 12, marginTop: 8 }}>ไม่มีใบเสนอราคาที่ยอมรับแล้วและมีไซท์งานผูกอยู่</p>}
          </div>
        </Modal>
      )}

      {createFor && (
        <CreateInvoiceModal
          quotation={createFor}
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
        <ConfirmDialog
          title="ทำเครื่องหมายว่าชำระแล้ว"
          message={`ยืนยันว่าได้รับชำระเงินตามใบแจ้งหนี้ ${payRow.invoice_number} แล้ว? ระบบจะออกใบเสร็จรับเงิน/ใบกำกับภาษีให้อัตโนมัติ`}
          onConfirm={() => { handleMarkPaid(payRow); setPayRow(null) }}
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
    </div>
  )
}
