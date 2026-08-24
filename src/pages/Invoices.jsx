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
import { useInvoices, useQuotationItemUnits, useQuotations, useSites } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import { fmt, fmtDate } from '../lib/supabase.js'
import { auditLog } from '../lib/audit.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import SearchableSelect from '../components/SearchableSelect.jsx'
import { format, startOfYear, endOfYear } from 'date-fns'
import { isCountable, waterfall, openQty, drawQty, drawAmount, calcInvoiceTotals } from '../lib/invoiceCalc.js'

const siteOpts = (sites) => (sites || []).map(s => ({
  value: s.id, label: `${s.site_number} · ${s.name}`, keywords: `${s.site_number} ${s.name}`,
}))

const INV_STATUSES = ['unpaid', 'paid', 'void']
const INV_STATUS_LABELS = { unpaid: '🕓 ยังไม่ชำระ', paid: '✅ ชำระแล้ว', void: '✕ ยกเลิก' }

// One entry per quotation_item: { quotationItemId, description, unit,
// unitPrice, totalQty, units: [{ id, unitIndex, unitQty, cumulativePct,
// target }] }. `checked` (โหมดง่าย full-remaining lock) lives per entry.
function buildLineState(quotationItems, unitsByQuotationItem) {
  return (quotationItems || []).map(qi => {
    const rawUnits = unitsByQuotationItem[qi.id] || []
    const units = rawUnits.map(u => ({
      id: u.id, unitIndex: u.unit_index, unitQty: u.unit_qty, cumulativePct: u.cumulative_pct,
      target: u.cumulative_pct < 100 ? 100 : u.cumulative_pct,
    }))
    return {
      quotationItemId: qi.id, description: qi.description, unit: qi.unit,
      unitPrice: qi.unit_price, totalQty: qi.quantity, checked: true, units,
    }
  })
}

function InvoiceItemsEditor({ lines, onChange, mode, onModeChange }) {
  const setLine = (qiId, updater) => onChange(lines.map(l => l.quotationItemId === qiId ? updater(l) : l))

  const toggleChecked = (qiId, checked) => setLine(qiId, l => ({
    ...l, checked, units: checked ? waterfall(l.units, openQty(l.units)) : l.units,
  }))
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

  const toggleAll = (checked) => onChange(lines.map(l => {
    if (openQty(l.units) <= 0) return l
    return { ...l, checked, units: checked ? waterfall(l.units, openQty(l.units)) : l.units }
  }))

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
                    value={drawQty(l.units)}
                    disabled={l.checked}
                    onChange={e => {
                      let v = parseFloat(e.target.value)
                      if (isNaN(v) || v < 0) v = 0
                      if (v > remaining) v = remaining
                      setQty(l.quotationItemId, v)
                    }} />
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
                            value={u.target}
                            onChange={e => {
                              let v = parseFloat(e.target.value)
                              if (isNaN(v) || v < u.cumulativePct) v = u.cumulativePct
                              if (v > 100) v = 100
                              setUnitTarget(l.quotationItemId, u.unitIndex, v)
                            }} />
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
      setLines(buildLineState(items, unitsByQuotationItem))
    }
  }, [unitsByQuotationItem]) // eslint-disable-line react-hooks/exhaustive-deps

  if (unitsError) {
    return <Modal title={`สร้างใบแจ้งหนี้ — ${quotation.quotation_number}`} onClose={onClose} maxWidth={760}><div className="modal-body">เกิดข้อผิดพลาดในการโหลดข้อมูล: {unitsError}</div></Modal>
  }
  if (unitsLoading || !lines) {
    return <Modal title={`สร้างใบแจ้งหนี้ — ${quotation.quotation_number}`} onClose={onClose} maxWidth={760}><div className="modal-body">⏳ กำลังโหลด...</div></Modal>
  }

  const billedLines = lines.filter(l => drawQty(l.units) > 1e-9)
  const invoiceItemsForTotals = billedLines.map(l => ({ line_total: drawAmount(l.units, l.unitPrice) }))
  const totals = calcInvoiceTotals(invoiceItemsForTotals, { hasVat: quotation.has_vat, priceIncludesVat: quotation.price_includes_vat })

  const handleSave = async () => {
    if (!billedLines.length) { alert('กรุณาเลือกอย่างน้อย 1 รายการ'); return }
    setSaving(true)
    try {
      const { data: invoice, error: invError } = await supabase.from('invoices').insert({
        quotation_id: quotation.id, site_id: quotation.site_id, date: format(new Date(), 'yyyy-MM-dd'),
        has_vat: quotation.has_vat, price_includes_vat: quotation.price_includes_vat,
        subtotal: totals.subtotal, vat: totals.vat, total: totals.total,
      }).select().single()
      if (invError) throw invError
      await auditLog('invoices', invoice.id, 'INSERT', null, { quotation_id: quotation.id, total: totals.total })

      for (const [sortOrder, l] of billedLines.entries()) {
        const lineDrawQty = drawQty(l.units)
        const lineAmount = drawAmount(l.units, l.unitPrice)
        const { data: invoiceItem, error: itemError } = await supabase.from('invoice_items').insert({
          invoice_id: invoice.id, quotation_item_id: l.quotationItemId,
          description: l.description, unit: l.unit, unit_price: l.unitPrice,
          draw_qty: lineDrawQty, line_total: lineAmount, sort_order: sortOrder,
        }).select().single()
        if (itemError) throw itemError

        for (const u of l.units) {
          if (u.target === u.cumulativePct) continue
          const drawAmt = (u.target - u.cumulativePct) / 100 * u.unitQty * l.unitPrice
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
      alert('บันทึกไม่สำเร็จ: ' + e.message)
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

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3000) }

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
                  <td></td>
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
    </div>
  )
}
