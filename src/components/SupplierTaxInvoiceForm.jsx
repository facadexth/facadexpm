// ============================================================
// SupplierTaxInvoiceForm -- header, optional scan, month PO picker and lines for a supplier
// tax invoice (ใบกำกับภาษีผู้ขาย). Pure form: it never writes to Supabase. The page (Task 7)
// receives the whole form through onSaveDraft / onPreview, and watches onChange for its
// stale-preview guard. Spec: docs/superpowers/specs/2026-10-06-supplier-tax-invoice-matching-design.md
// ============================================================
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  useReceivedPosForSupplier, useSuppliers, useSites, useCategories, useInventoryItems, useAllInventoryItems,
  useInventoryItemUnitFactors, useSupplierDocumentExamples, extractPoDocument, useSupplierDeposits,
  useActiveTaxInvoiceLinks,
} from '../hooks/useSupabase.js'
import { fileToExtractionPayload } from '../lib/poDocumentExtraction.js'
import { calcPoTotals } from '../lib/poTotals.js'
import { round2 } from '../lib/depositMath.js'
import { lineAmount, evaluateMatch, proposePos, lineBase } from '../lib/supplierTaxInvoice.js'
import {
  emptyLine, validateFormForSave, poRowsFor, computeAutoVat, applyLineChange, reconcileBaseManual, missingPoIds,
} from '../lib/taxInvoiceForm.js'
import { SCAN_REMINDER } from '../lib/scanNotice.js'
import { bangkokTodayIso } from '../lib/photoUpload.js'
import { fmt, fmtDate } from '../lib/supabase.js'
import SearchableSelect from './SearchableSelect.jsx'
import QuickAddSelect from './QuickAddSelect.jsx'
import ScanNotice from './ScanNotice.jsx'
import ScanDocPreview from './ScanDocPreview.jsx'

const amber = { background: 'rgba(245,158,11,.12)', border: '1px solid rgba(245,158,11,.5)', borderRadius: 8, padding: 10, fontSize: 13 }
const badge = (color, bg) => ({ fontSize: 11, padding: '1px 6px', borderRadius: 6, color, background: bg, marginLeft: 6, whiteSpace: 'nowrap' })
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export default function SupplierTaxInvoiceForm({ initial, invoiceId, busy, onSaveDraft, onPreview, onChange, onCancel, children }) {
  const today = bangkokTodayIso()
  const [form, setForm] = useState(initial)
  const formRef = useRef(form)
  formRef.current = form
  useEffect(() => { onChange?.(form) }, [form])   // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  // A saved invoice's date / VAT are real data: a scan must not overwrite them.
  const touched = useRef({ date: !!invoiceId, vat: !!invoiceId })

  const { data: suppliers } = useSuppliers()
  const { data: sites } = useSites()
  const { data: categories } = useCategories()
  const { data: inventoryItems, refetch: refetchItems } = useInventoryItems()
  const { data: allItems, refetch: refetchAllItems } = useAllInventoryItems()
  const { data: unitFactors } = useInventoryItemUnitFactors()
  const { data: links } = useActiveTaxInvoiceLinks()
  // useQuery keeps the previous data while a new supplier loads: poRowsFor() only returns rows that were
  // fetched for the CURRENT supplier, so a stale list is never shown or auto-ticked.
  const { data: poResult } = useReceivedPosForSupplier(form.supplier_id)
  const posRows = poRowsFor(poResult, form.supplier_id)
  const { data: deposits } = useSupplierDeposits(form.supplier_id || undefined)
  const { data: examples } = useSupplierDocumentExamples(form.supplier_id || null)

  const itemById = useMemo(() => new Map((allItems || []).map(i => [i.id, i])), [allItems])
  const factorFor = (itemId, unit) => (unitFactors || []).find(f => f.inventory_item_id === itemId && f.unit_name === unit) || null

  const proposal = useMemo(() => proposePos({ pos: posRows, supplierId: form.supplier_id, invoiceDate: form.invoice_date, activeLinks: links, invoiceId }),
    [posRows, form.supplier_id, form.invoice_date, links, invoiceId])
  const poById = useMemo(() => new Map((posRows || []).map(p => [p.id, p])), [posRows])
  const poSubtotal = po => calcPoTotals(po.purchase_order_items, po.has_vat, po.price_includes_vat).subtotal
  const depositOnPo = poId => round2((deposits || []).flatMap(d => d.applications || []).filter(a => a.po_id === poId)
    .reduce((s, a) => s + Number(a.amount_no_vat || 0), 0))

  // Pre-tick the month's POs ONCE per supplier choice on a NEW invoice, and only when the PO data
  // provably belongs to that supplier (posRows !== null).
  const [autoTickedFor, setAutoTickedFor] = useState(null)
  useEffect(() => {
    if (invoiceId || !posRows || !links || !form.supplier_id || autoTickedFor === form.supplier_id) return
    const supplierId = form.supplier_id
    // never overwrite a selection that is already there (e.g. an initial form that came with po_ids)
    setForm(f => (f.supplier_id === supplierId && f.po_ids.length === 0 ? { ...f, po_ids: proposal.proposed.map(p => p.id) } : f))
    setAutoTickedFor(supplierId)
  }, [invoiceId, posRows, links, form.supplier_id, proposal, autoTickedFor])

  const selectedPos = form.po_ids.map(id => poById.get(id)).filter(Boolean)
  const missing = missingPoIds(form.po_ids, posRows)
  const match = evaluateMatch({
    netBeforeVat: form.net_before_vat, poSubtotals: selectedPos.map(poSubtotal), lineAmounts: form.lines.map(lineAmount),
  })
  const netNum = Number(form.net_before_vat)
  const unlinkedInMonth = proposal.proposed.filter(p => !form.po_ids.includes(p.id))
  const commonSite = selectedPos.length && selectedPos.every(p => p.site_id === selectedPos[0].site_id) ? selectedPos[0].site_id : ''

  // Line changes go through applyLineChange (pure, tested). Lookups come from a ref so a change made
  // after an await (quick create) never uses stale closures.
  const lookupsRef = useRef({})
  lookupsRef.current = { itemById, unitFactors: unitFactors || [], commonSite }
  const updateLine = (key, patch) => setForm(f => ({ ...f, lines: f.lines.map(l => (l.key === key ? applyLineChange(l, patch, lookupsRef.current) : l)) }))

  // Saved invoice: once the lookups are loaded, a stored base quantity that equals the conversion is not "typed".
  const reconciled = useRef(false)
  useEffect(() => {
    if (!invoiceId || reconciled.current || !allItems || !unitFactors) return
    reconciled.current = true
    setForm(f => ({ ...f, lines: reconcileBaseManual(f.lines, { itemById, unitFactors }) }))
  }, [invoiceId, allItems, unitFactors, itemById])

  // A quick-created stock item is not in itemById until the refetch has rendered: recompute its base then.
  const recalcKeys = useRef(new Set())
  useEffect(() => {
    if (!recalcKeys.current.size) return
    const ready = formRef.current.lines
      .filter(x => recalcKeys.current.has(x.key) && x.inventory_item_id && itemById.has(x.inventory_item_id)).map(x => x.key)
    if (!ready.length) return
    ready.forEach(k => recalcKeys.current.delete(k))
    setForm(f => ({ ...f, lines: f.lines.map(x => (ready.includes(x.key) ? applyLineChange(x, {}, lookupsRef.current) : x)) }))
  }, [itemById, form.lines])

  const togglePo = id => set('po_ids', form.po_ids.includes(id) ? form.po_ids.filter(x => x !== id) : [...form.po_ids, id])
  const [showOutsideOpen, setShowOutsideOpen] = useState(false)
  const showOutside = showOutsideOpen || proposal.outsideMonth.some(p => form.po_ids.includes(p.id))

  const pickSupplier = v => setForm(f => ({ ...f, supplier_id: v, po_ids: [] }))

  // ── optional scan (same pattern as SwapTaxInvoiceModal). Never posts anything. ──
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState(null)
  const [scanCode, setScanCode] = useState(null)
  const [scanFile, setScanFile] = useState(null)
  const handleScan = async e => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setScanError(null); setScanCode(null); setScanFile(file); setScanning(true)
    try {
      const { base64, mimeType } = await fileToExtractionPayload(file)
      const result = await extractPoDocument(base64, mimeType, examples || [])
      if (!result.ok) { setScanError(result.error); setScanCode(result.code || null); return }
      if (formRef.current.lines.length && !window.confirm('มีรายการอยู่แล้ว — การอ่านเอกสารใหม่จะแทนที่รายการทั้งหมด ต้องการแทนที่หรือไม่?')) return
      const { reference_no_guess, document_date_guess, line_items } = result.data
      setForm(f => {
        const lines = (line_items || []).map(it => ({
          ...emptyLine(), description: it.description, qty: String(it.quantity), unit: it.unit || '',
          unit_price: String(it.unit_price), discount_pct: String(it.discount_pct || 0),
        }))
        const net = f.net_before_vat === '' && lines.length ? String(round2(lines.reduce((s, l) => s + lineAmount(l), 0))) : f.net_before_vat
        const validDate = document_date_guess && ISO_DATE.test(document_date_guess) && document_date_guess <= today
        return {
          ...f,
          invoice_no: f.invoice_no || reference_no_guess || '',
          invoice_date: !touched.current.date && validDate ? document_date_guess : f.invoice_date,
          net_before_vat: net,
          vat: touched.current.vat ? f.vat : (computeAutoVat(net) || f.vat),
          lines,
        }
      })
    } catch (err) {
      setScanError(err.message)
    } finally {
      setScanning(false)
    }
  }

  const run = fn => {
    const errs = validateFormForSave(form)
    if (form.supplier_id && !posRows && form.po_ids.length) errs.push('กำลังโหลดใบสั่งซื้อ กรุณารอสักครู่')
    if (missing.length) errs.push(`มีใบสั่งซื้อที่เลือกไว้ ${missing.length} ใบที่ไม่พบในรายการ — เอาออกก่อนบันทึก`)
    if (errs.length) { alert(errs.join('\n')); return }
    return fn(form)
  }

  const siteOpts = (sites || []).map(s => ({ value: s.id, label: s.name, keywords: s.name }))
  const itemOpts = (inventoryItems || []).map(it => ({ value: it.id, label: `${it.name} (${it.base_unit})`, keywords: it.name }))
  const catOpts = (categories || []).map(c => ({ value: c.id, label: c.name, keywords: c.name }))

  // a render function (not a component) so rows keep their DOM between renders
  const renderPoRow = (po, { disabled, link } = {}) => {
    const dep = depositOnPo(po.id)
    return (
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, padding: '4px 0', opacity: disabled ? 0.6 : 1 }}>
        <input type="checkbox" disabled={disabled} checked={form.po_ids.includes(po.id)} onChange={() => togglePo(po.id)} style={{ marginTop: 3 }} />
        <span>
          <b>{po.po_number}</b> · {fmtDate(po.date)} · {po.sites?.name || '—'}
          {' · '}มูลค่าสินค้า {fmt(poSubtotal(po))}
          {' · '}{po.expense_id ? `รายจ่าย ${fmt(po.expenses?.amount_no_vat ?? 0)}` : 'ไม่มีรายจ่าย'}
          {dep > 0 && <span style={badge('#b45309', 'rgba(245,158,11,.15)')}>หักมัดจำ {fmt(dep)}</span>}
          {po.stock_from_invoice && <span style={badge('#1d4ed8', 'rgba(59,130,246,.15)')}>สต็อกเข้าจากใบกำกับ</span>}
          {link && <span style={{ color: 'var(--text3)', marginLeft: 6 }}>ผูกกับใบกำกับ {link.invoice_no}</span>}
        </span>
      </label>
    )
  }

  return (
    <form onSubmit={e => e.preventDefault()}>
      <fieldset disabled={!!busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'contents' }}>
        <div className="modal-body" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
            <div>
              <label className="label">ซัพพลายเออร์ ★</label>
              <SearchableSelect required value={form.supplier_id} onChange={pickSupplier} disabled={!!busy}
                placeholder="— เลือก Supplier —" options={(suppliers || []).map(s => ({ value: s.id, label: s.name, keywords: s.name }))} />
            </div>
            <div>
              <label className="label">เลขที่ใบกำกับภาษี ★</label>
              <input className="input" required value={form.invoice_no} onChange={e => set('invoice_no', e.target.value)} />
            </div>
            <div>
              <label className="label">วันที่ใบกำกับ ★</label>
              <input type="date" className="input" required max={today} value={form.invoice_date}
                onChange={e => { touched.current.date = true; set('invoice_date', e.target.value) }} />
            </div>
            <div>
              <label className="label">ยอดก่อน VAT ★</label>
              <input className="input" type="number" min="0" step="0.01" required value={form.net_before_vat}
                onChange={e => set('net_before_vat', e.target.value)}
                onBlur={() => { if (!touched.current.vat) { const v = computeAutoVat(form.net_before_vat); if (v !== '') set('vat', v) } }} />
            </div>
            <div>
              <label className="label">VAT</label>
              <input className="input" type="number" min="0" step="0.01" value={form.vat}
                onChange={e => { touched.current.vat = true; set('vat', e.target.value) }} />
            </div>
            <div>
              <label className="label">ยอดรวม</label>
              <div className="input" style={{ display: 'flex', alignItems: 'center' }}>
                {fmt(round2((Number.isFinite(netNum) ? netNum : 0) + (Number.isFinite(Number(form.vat)) ? Number(form.vat) : 0)))}
              </div>
            </div>
          </div>

          <div>
            <label className="label">อัปโหลดรูป/PDF ใบกำกับภาษี (ไม่บังคับ)</label>
            <input type="file" accept="image/*,application/pdf" onChange={handleScan} disabled={scanning || !!busy} />
            {scanning && <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>⏳ กำลังอ่านเอกสาร...</div>}
            {scanError && <ScanNotice code={scanCode} message={scanError} />}
            {scanFile && <ScanDocPreview file={scanFile} />}
            {scanFile && !scanning && <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 4 }}>{SCAN_REMINDER}</div>}
          </div>

          <div>
            <label className="label">ใบสั่งซื้อที่รวมอยู่ในใบกำกับนี้</label>
            {!form.supplier_id ? (
              <div style={{ fontSize: 13, color: 'var(--text3)' }}>เลือกซัพพลายเออร์ก่อน</div>
            ) : !posRows || !links ? (
              <div style={{ fontSize: 13, color: 'var(--text3)' }}>⏳ กำลังโหลดใบสั่งซื้อ...</div>
            ) : (
              <>
                {proposal.proposed.length === 0 && proposal.outsideMonth.length === 0 && proposal.linkedElsewhere.length === 0 && (
                  <div style={{ fontSize: 13, color: 'var(--text3)' }}>ไม่พบใบสั่งซื้อที่รับของแล้วของซัพพลายเออร์นี้</div>
                )}
                {proposal.proposed.map(po => <div key={po.id}>{renderPoRow(po)}</div>)}
                {proposal.outsideMonth.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowOutsideOpen(s => !s)}>
                      {showOutside ? '▾' : '▸'} ใบสั่งซื้อนอกเดือน ({proposal.outsideMonth.length})
                    </button>
                    {showOutside && proposal.outsideMonth.map(po => (
                      <div key={po.id}>
                        {renderPoRow(po)}
                        <span style={{ ...badge('#b45309', 'rgba(245,158,11,.2)'), marginLeft: 26 }}>นอกเดือน</span>
                      </div>
                    ))}
                  </div>
                )}
                {proposal.linkedElsewhere.map(({ po, link }) => <div key={po.id}>{renderPoRow(po, { disabled: true, link })}</div>)}
              </>
            )}
            {missing.length > 0 && (
              <div style={{ ...amber, marginTop: 8 }}>
                ใบสั่งซื้อที่เลือกไว้ไม่พบในรายการ (อาจถูกแก้ไขหรือยกเลิก) {missing.length} ใบ — บันทึกไม่ได้จนกว่าจะเอาออก
                {missing.map(id => (
                  <button key={id} type="button" className="btn btn-sm btn-ghost" style={{ marginLeft: 6 }}
                    onClick={() => set('po_ids', form.po_ids.filter(x => x !== id))}>เอาออก {id.slice(0, 8)}</button>
                ))}
              </div>
            )}
          </div>

          {unlinkedInMonth.length > 0 && (
            <div style={amber}>
              ใบสั่งซื้อของซัพพลายเออร์นี้ในเดือนนี้ที่ยังไม่ได้รวม: {unlinkedInMonth.map(p => p.po_number).join(', ')}
            </div>
          )}

          <div style={{ fontSize: 13, padding: 10, borderRadius: 8, border: `1px solid ${match.matchOk ? 'rgba(16,185,129,.5)' : 'rgba(239,68,68,.5)'}`, background: match.matchOk ? 'rgba(16,185,129,.1)' : 'rgba(239,68,68,.08)' }}>
            {match.invalid
              ? 'กรอกยอดก่อน VAT และรายการให้ครบเพื่อเทียบกับใบสั่งซื้อ'
              : `มูลค่าสินค้าใบสั่งซื้อ ${fmt(match.poSum)} · ใบกำกับก่อน VAT ${fmt(netNum)} · ต่าง ${fmt(match.diff)} (เกณฑ์ ±${fmt(match.tolerance)})`}
          </div>
          {!match.matchOk && !match.invalid && (
            <div>
              <label className="label">เหตุผลที่ยอดไม่ตรง ★</label>
              <textarea className="input" rows={2} required value={form.match_note} onChange={e => set('match_note', e.target.value)} />
            </div>
          )}

          <div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>รายละเอียด</th><th>จำนวน</th><th>หน่วย</th><th>ราคา/หน่วย</th><th>ส่วนลด %</th><th>จำนวนเงิน</th><th>ผูกสต็อก</th><th />
                  </tr>
                </thead>
                <tbody>
                  {form.lines.map(l => {
                    const item = l.inventory_item_id ? itemById.get(l.inventory_item_id) : null
                    const r = l.inventory_item_id ? lineBase(l, item, factorFor(l.inventory_item_id, l.unit)) : null
                    return (
                      <tr key={l.key}>
                        <td style={{ minWidth: 160 }}>
                          <input className="input input-sm" value={l.description} onChange={e => updateLine(l.key, { description: e.target.value })} />
                        </td>
                        <td><input className="input input-sm num-spin" type="number" min="0" step="any" style={{ width: 80 }} value={l.qty}
                          onChange={e => updateLine(l.key, { qty: e.target.value })} /></td>
                        <td><input className="input input-sm" style={{ width: 70 }} value={l.unit} onChange={e => updateLine(l.key, { unit: e.target.value })} /></td>
                        <td><input className="input input-sm" type="number" min="0" step="0.01" style={{ width: 100 }} value={l.unit_price}
                          onChange={e => updateLine(l.key, { unit_price: e.target.value })} /></td>
                        <td><input className="input input-sm" type="number" min="0" max="100" step="0.01" style={{ width: 70 }} value={l.discount_pct}
                          onChange={e => updateLine(l.key, { discount_pct: e.target.value })} /></td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{fmt(lineAmount(l))}</td>
                        <td style={{ minWidth: 260 }}>
                          <QuickAddSelect
                            value={l.inventory_item_id} onChange={v => updateLine(l.key, { inventory_item_id: v })} disabled={!!busy}
                            placeholder="— ไม่ใช่สต็อก —" options={itemOpts}
                            table="inventory_items" namePlaceholder="ชื่อสินค้าคงคลังใหม่"
                            initialName={l.description}
                            extraPayload={{ base_unit: l.unit || 'หน่วย' }}
                            extraField={{ key: 'category_id', label: 'ประเภทสินค้า', options: catOpts }}
                            onCreated={async newId => {
                              recalcKeys.current.add(l.key)
                              await Promise.all([refetchItems(), refetchAllItems()])
                              updateLine(l.key, { inventory_item_id: newId })   // by key, on the CURRENT form (functional update)
                            }}
                            addLabel="+ สร้างใหม่"
                          />
                          {l.inventory_item_id && (
                            <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
                              <div>
                                <label className="label" style={{ fontSize: 11.5 }}>ไซท์งาน ★</label>
                                <SearchableSelect value={l.site_id} onChange={v => updateLine(l.key, { site_id: v })} disabled={!!busy}
                                  placeholder="— เลือกไซท์ —" options={siteOpts} />
                              </div>
                              <div>
                                <label className="label" style={{ fontSize: 11.5 }}>จำนวนในหน่วยหลัก ({item?.base_unit || '—'}) ★</label>
                                <input className="input input-sm" type="number" min="0" step="any" value={l.base_qty}
                                  onChange={e => updateLine(l.key, { base_qty: e.target.value, base_manual: true, base_stale: false })} />
                                {r?.unconverted && !l.base_manual && (
                                  <div style={{ fontSize: 11.5, color: '#b45309', marginTop: 2 }}>แปลงหน่วยอัตโนมัติไม่ได้ — กรอกจำนวนในหน่วยหลักเอง</div>
                                )}
                                {l.base_manual && l.base_stale && (
                                  <div style={{ fontSize: 11.5, color: '#b45309', marginTop: 2 }}>จำนวนในหน่วยหลักไม่ได้คำนวณใหม่ — ตรวจสอบให้ตรงกับจำนวน/หน่วยที่แก้</div>
                                )}
                              </div>
                            </div>
                          )}
                        </td>
                        <td>
                          <button type="button" className="btn btn-sm btn-ghost"
                            onClick={() => setForm(f => ({ ...f, lines: f.lines.filter(x => x.key !== l.key) }))}>ลบ</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <button type="button" className="btn btn-sm btn-ghost" style={{ marginTop: 6 }}
              onClick={() => setForm(f => ({ ...f, lines: [...f.lines, emptyLine()] }))}>+ เพิ่มรายการ</button>
            <div style={{ marginTop: 6, fontSize: 13, color: match.invalid || match.linesOk ? 'inherit' : 'var(--danger, #e55)' }}>
              รวมรายการ {fmt(Number.isFinite(match.linesSum) ? match.linesSum : 0)}
              {!match.invalid && !match.linesOk && ' ไม่ตรงกับยอดก่อน VAT'}
            </div>
          </div>
          {children}
        </div>
      </fieldset>

      <div className="modal-footer" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-ghost" disabled={!!busy} onClick={onCancel}>ยกเลิก</button>
        <button type="button" className="btn" disabled={!!busy} onClick={() => run(onSaveDraft)}>💾 บันทึกร่าง</button>
        <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => run(onPreview)}>👁️ ตรวจสอบก่อนบันทึก</button>
      </div>
    </form>
  )
}
