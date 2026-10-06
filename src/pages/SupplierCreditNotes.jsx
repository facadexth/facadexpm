// ============================================================
// Supplier credit notes — ใบลดหนี้ซัพพลายเออร์ (คืนสินค้า)
// ✅ Draft -> confirm (RPC: deducts stock + books a negative expense) -> void
// ✅ Settlement status (owed / offset / refunded) changed via RPC
// ✅ Client may only write DRAFT notes; every status change goes through the
//    RPCs (see supabase/migrations/2026-10-06-0*.sql)
// ============================================================
import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase, fmt } from '../lib/supabase.js'
import {
  useSupplierCreditNotes, useInventoryOnHand, useSuppliers, useSites,
  usePurchaseOrders,
  useAllInventoryItems, useInventoryItemUnitFactors, useAllAluminumProfiles,
} from '../hooks/useSupabase.js'
import {
  buildCreditLinesFromPo, validateReturnQty, defaultSelection, selectionFromSavedLines,
  describeCreditNoteConfirm, creditLineForPoItem, poItemBlocked, stockCheckStatus, poItemNetUnitPrice, poItemTotal,
} from '../lib/creditNotePo.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import { peekCreditNotePrefill, clearCreditNotePrefill } from '../lib/creditNotePrefill.js'
import SearchableSelect from '../components/SearchableSelect.jsx'
import RowActionsMenu from '../components/RowActionsMenu.jsx'
import { bangkokTodayIso } from '../lib/photoUpload.js'
import { VAT_RATE } from '../lib/invoiceCalc.js'
import { pickCreditNoteExtra } from '../lib/creditNoteExtra.js'
import { computeCreditNoteTotals, findStockShortfalls, inferVatFlags, round2, SETTLEMENT_LABELS } from '../lib/creditNoteCalc.js'

const CN_ERRORS = {
  insufficient_stock: 'สต็อกไม่พอสำหรับคืนสินค้า — ตรวจจำนวนในรายการอีกครั้ง',
  not_draft: 'ใบลดหนี้นี้ยืนยันหรือยกเลิกไปแล้ว',
  not_confirmed: 'ใบลดหนี้นี้ยังไม่ได้ยืนยัน',
  credit_note_not_found: 'ไม่พบใบลดหนี้',
  insufficient_privilege: 'ไม่มีสิทธิ์ทำรายการนี้',
  no_items: 'ใบลดหนี้นี้ไม่มีรายการสินค้า',
  bad_settlement: 'สถานะเงินไม่ถูกต้อง',
  credit_note_locked: 'ใบลดหนี้ที่ยืนยันแล้วแก้ไขไม่ได้',
  cross_tenant_reference: 'ข้อมูลอ้างอิงไม่ถูกต้อง',
}
const cnErrorText = e => CN_ERRORS[(e?.message || '').split(':')[0].trim()] || e?.message || 'เกิดข้อผิดพลาด'
async function confirmNote(id) {
  const { error } = await supabase.rpc('confirm_supplier_credit_note', { p_id: id })
  if (error) throw new Error(cnErrorText(error))
}
async function voidNote(id) {
  const { error } = await supabase.rpc('void_supplier_credit_note', { p_id: id })
  if (error) throw new Error(cnErrorText(error))
}
async function setSettlement(id, p_settlement) {
  const { error } = await supabase.rpc('set_credit_note_settlement', { p_id: id, p_settlement })
  if (error) throw new Error(cnErrorText(error))
}

const STATUS_BADGE = {
  draft: { cls: 'badge-check_issued', label: '📝 ร่าง' },
  confirmed: { cls: 'badge-check_cleared', label: '✅ ยืนยันแล้ว' },
  void: { cls: 'badge-received', label: '🚫 ยกเลิก' },
}

function makeInitialForm(prefill, note) {
  if (note) {
    const items = (note.supplier_credit_note_items || []).map(i => ({
      inventory_item_id: i.inventory_item_id || '',
      description: i.description || '',
      quantity: String(i.quantity ?? ''),
      unit: i.unit || '',
      unit_price: String(i.unit_price ?? ''),
    }))
    // vat flags are not stored; inferred here, then taken from the PO once it loads.
    const { vatEnabled, priceIncludesVat } = inferVatFlags(note)
    return {
      supplier_id: note.supplier_id, site_id: note.site_id, doc_number: note.doc_number,
      doc_date: note.doc_date, category_id: note.category_id || '', po_id: note.po_id || '',
      original_expense_id: note.original_expense_id || null,
      expense_date: note.expense_date || '', original_invoice_no: note.original_invoice_no || '',
      original_invoice_date: note.original_invoice_date || '',
      vatEnabled, priceIncludesVat, notes: note.notes || '',
      // ticked rows are rebuilt from the saved lines once the PO loads
      selection: {}, hydrateLines: note.po_id ? items : null,
    }
  }
  const p = prefill || {}
  return {
    supplier_id: p.supplier_id || '', site_id: p.site_id || '', doc_number: '',
    doc_date: bangkokTodayIso(), category_id: p.category_id || '', po_id: p.po_id || '',
    original_expense_id: p.original_expense_id || null,
    expense_date: '', original_invoice_no: '', original_invoice_date: '',
    vatEnabled: p.vatEnabled ?? true, priceIncludesVat: p.priceIncludesVat ?? false, notes: '',
    selection: {}, hydrateLines: null, hydratePending: !!p.po_id,
  }
}

// original invoice (no + date) comes from the PO's linked expense
const poInvoice = po => {
  const x = Array.isArray(po?.expenses) ? po.expenses[0] : po?.expenses
  return { original_invoice_no: x?.invoice_no || '', original_invoice_date: x?.date || '' }
}
const nz = v => (v == null ? '' : String(v))
// credit lines in string form (as stored on the form)
const toFormLines = lines => lines.map(l => ({
  inventory_item_id: l.inventory_item_id || '', description: l.description || '',
  quantity: nz(l.quantity), unit: l.unit || '', unit_price: nz(l.unit_price),
}))

const REASON_TEXT = { not_positive: 'จำนวนที่คืนต้องมากกว่า 0', above_ordered: 'จำนวนที่คืนเกินจำนวนที่สั่ง', unconvertible: 'แปลงหน่วยไม่ได้ ตรวจโปรไฟล์/ขนาดสินค้า' }

// Plain overlay on purpose (NOT <Modal>/<ConfirmDialog>): this dialog opens on top of the form
// <Modal>, and Modal's history/popstate handling is window-level and not safe for stacked modals
// (see the warning at the top of components/Modal.jsx) -- a stray popstate would close it.
function CreditNoteConfirmDialog({ info, stockStatus, onConfirm, onCancel }) {
  useEffect(() => {
    const h = e => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onCancel])
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal" style={{ maxWidth: 'min(420px, 94vw)' }}>
        <div className="modal-header">
          <span className="modal-title">ยืนยันใบลดหนี้ — โปรดตรวจสอบ</span>
          <button type="button" className="modal-close" onClick={onCancel}>✕</button>
        </div>
        <div className="modal-body">
          <div style={{ display: 'grid', gap: 8, fontSize: 13, color: 'var(--text2)', lineHeight: 1.6 }}>
            <div>เลขที่ใบลดหนี้: <b>{info.docNumber}</b></div>
            <div>
              ระบบจะ<b>ตัดสต็อก</b>{info.siteName ? <> ที่ไซต์ <b>{info.siteName}</b></> : null}:
              {info.stockTexts.length
                ? <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{info.stockTexts.map((t, i) => <li key={i}>{t}</li>)}</ul>
                : <span> (ไม่มีรายการสต็อก)</span>}
            </div>
            {info.stockTexts.length > 0 && stockStatus === 'loading' && <div>⏳ กำลังตรวจสต็อกคงเหลือ...</div>}
            {info.stockTexts.length > 0 && stockStatus === 'error' && (
              <div style={{ color: 'var(--danger, #e55)', fontWeight: 600 }}>โหลดสต็อกคงเหลือไม่สำเร็จ — ปิดแล้วลองใหม่</div>
            )}
            {info.shortTexts.length > 0 && (
              <div style={{ color: 'var(--danger, #e55)', fontWeight: 600 }}>
                ⚠️ สต็อกไม่พอ:
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{info.shortTexts.map((t, i) => <li key={i}>{t}</li>)}</ul>
              </div>
            )}
            <div>
              และบันทึก<b>รายจ่ายติดลบ</b> <b>{info.amountText}</b> บาท (รวม VAT)
              {info.month ? <> ในเดือน <b>{info.month}</b></> : null}
            </div>
            <div style={{ color: 'var(--danger, #e55)' }}>
              เมื่อยืนยันแล้วจะแก้ไขไม่ได้ — ย้อนกลับได้โดยการยกเลิกใบลดหนี้เท่านั้น
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
          <button type="button" className="btn btn-danger" disabled={stockStatus !== 'ready' && info.stockTexts.length > 0} onClick={onConfirm}>ยืนยัน</button>
        </div>
      </div>
    </div>
  )
}

// Confirm dialog for a note about to be confirmed. Stock is read LIVE here (not snapshotted at
// click time) so a late load corrects the shortfall lines; confirm stays disabled until it loaded.
function ConfirmNoteDialog({ note, form, itemById, itemNameById, onConfirm, onCancel }) {
  const siteId = note ? note.site_id : form.site_id
  const { data: onHand, error: onHandError } = useInventoryOnHand(siteId)
  const lines = note ? (note.supplier_credit_note_items || []) : form.lines
  const status = stockCheckStatus(onHand, onHandError)
  const names = note ? itemNameById : Object.fromEntries(Object.entries(itemById || {}).map(([id, it]) => [id, it.name]))
  const shortfalls = status === 'ready' ? findStockShortfalls(lines, onHand) : []
  const info = describeCreditNoteConfirm(note ? {
    docNumber: note.doc_number, siteName: note.sites?.name, lines, amount: note.amount,
    docDate: note.doc_date, expenseDate: note.expense_date, shortfalls, itemNameById: names,
  } : {
    docNumber: form.doc_number.trim(), siteName: form.siteName, lines,
    amount: round2(form.totals.amount_no_vat + form.totals.vat),
    docDate: form.doc_date, expenseDate: form.expense_date, shortfalls, itemNameById: names,
  })
  return <CreditNoteConfirmDialog info={info} stockStatus={status} onCancel={onCancel}
    onConfirm={() => {
      if (shortfalls.length) { alert('สต็อกไม่พอสำหรับคืนสินค้า:\n' + info.shortTexts.map(t => '• ' + t).join('\n')); return }
      onConfirm(onHand)
    }} />
}

function CreditNoteForm({ initial, suppliers, sites, onSave, onCancel, loading }) {
  const [form, setForm] = useState(initial)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const { data: pos } = usePurchaseOrders(form.supplier_id ? { supplierId: form.supplier_id } : {})
  const { data: allItems, error: e1 } = useAllInventoryItems()
  const { data: profiles, error: e2 } = useAllAluminumProfiles()
  const { data: unitFactors, error: e3 } = useInventoryItemUnitFactors()
  const lookupError = e1 || e2 || e3
  const lookupsReady = !!(allItems && profiles && unitFactors)
  const lookups = useMemo(() => ({ inventoryItems: allItems || [], aluminumProfiles: profiles || [], unitFactors: unitFactors || [] }), [allItems, profiles, unitFactors])
  const [includeUnreceived, setIncludeUnreceived] = useState(false)
  const [hydrateNote, setHydrateNote] = useState('')
  const selectedPo = useMemo(() => (pos || []).find(p => p.id === form.po_id) || null, [pos, form.po_id])
  // the site is always the chosen PO's site (never user-editable); stock check uses it
  const siteId = selectedPo?.site_id || ''
  const { data: onHandData, error: onHandError } = useInventoryOnHand(siteId)
  const onHand = onHandData || {}
  const stockStatus = selectedPo ? stockCheckStatus(onHandData, onHandError) : 'ready'
  useEffect(() => { if (selectedPo && form.site_id !== siteId) setForm(f => ({ ...f, site_id: siteId })) }, [selectedPo, siteId, form.site_id])
  const poOptions = (pos || []).filter(p => p.id === form.po_id || p.status === 'received' || (includeUnreceived && p.status !== 'cancelled'))
  const hydrated = useRef(false)
  useEffect(() => {
    if (hydrated.current) return
    if (!form.po_id) { hydrated.current = true; return }
    if (lookupError) return
    if (!pos || !lookupsReady) return
    hydrated.current = true
    if (!selectedPo) { setForm(f => ({ ...f, po_id: '' })); setHydrateNote('ไม่พบใบสั่งซื้อเดิมของใบลดหนี้นี้ กรุณาเลือก PO ใหม่'); return }
    if (form.hydrateLines) {
      const sel = selectionFromSavedLines(selectedPo, form.hydrateLines, lookups)
      const vat = { vatEnabled: selectedPo.has_vat !== false, priceIncludesVat: !!selectedPo.price_includes_vat }
      if (sel) setForm(f => ({ ...f, ...vat, selection: sel }))
      else {
        setForm(f => ({ ...f, ...vat, selection: defaultSelection(selectedPo, false, lookups) }))
        setHydrateNote('รายการในร่างเดิมไม่ตรงกับ PO ปัจจุบัน กรุณาติ๊กเลือกรายการที่คืนใหม่')
      }
    } else if (form.hydratePending) {
      setForm(f => ({ ...f, ...poInvoice(selectedPo), selection: defaultSelection(selectedPo, true, lookups) }))
    }
  }, [form.po_id, form.hydrateLines, form.hydratePending, pos, lookupsReady, lookupError, selectedPo, lookups])

  const pickPo = id => {
    const po = (pos || []).find(p => p.id === id)
    hydrated.current = true
    setForm(f => po ? {
      ...f, po_id: id, site_id: po.site_id || '', category_id: po.category_id || f.category_id,
      vatEnabled: po.has_vat !== false, priceIncludesVat: !!po.price_includes_vat,
      original_expense_id: po.expense_id || null, ...poInvoice(po), selection: defaultSelection(po, false, lookups),
    } : { ...f, po_id: '', selection: {}, original_expense_id: null, original_invoice_no: '', original_invoice_date: '' })
    setHydrateNote('')
  }
  const setSel = (itemId, patch) => setForm(f => ({ ...f, selection: { ...f.selection, [itemId]: { qty: String((selectedPo?.purchase_order_items || []).find(x => x.id === itemId)?.quantity ?? ''), ...f.selection[itemId], ...patch } } }))
  const poItems = selectedPo?.purchase_order_items || []
  const selectable = poItems.filter(it => !(lookupsReady && poItemBlocked(it, lookups)))
  const allTicked = selectable.length > 0 && selectable.every(it => form.selection[it.id]?.checked)
  const toggleAll = on => setForm(f => ({ ...f, selection: Object.fromEntries(poItems.map(it => [it.id, { checked: on && !(lookupsReady && poItemBlocked(it, lookups)), qty: f.selection[it.id]?.qty ?? String(it.quantity) }])) }))
  const itemById = useMemo(() => Object.fromEntries((allItems || []).map(it => [it.id, it])), [allItems])
  const poLines = useMemo(
    () => (selectedPo ? toFormLines(buildCreditLinesFromPo(selectedPo, form.selection, lookups)) : []),
    [selectedPo, form.selection, lookups])
  const activeLines = poLines
  const totals = computeCreditNoteTotals(activeLines, { vatEnabled: form.vatEnabled, vatRate: VAT_RATE, priceIncludesVat: form.priceIncludesVat })

  const submit = (confirmAfter) => {
    const missing = [!form.supplier_id && 'ซัพพลายเออร์', !form.doc_number.trim() && 'เลขที่ใบลดหนี้', !form.po_id && 'ใบสั่งซื้อ (PO)'].filter(Boolean)
    if (missing.length) { alert('ยังไม่ได้กรอก: ' + missing.join(', ')); return }
    if (lookupError) { alert('โหลดข้อมูลสินค้า/หน่วยแปลงไม่สำเร็จ: ' + lookupError); return }
    if (!lookupsReady) { alert('กำลังโหลดข้อมูลสินค้า กรุณารอสักครู่'); return }
    if (confirmAfter && stockStatus !== 'ready') { alert(stockStatus === 'error' ? 'โหลดสต็อกคงเหลือไม่สำเร็จ — ยืนยันไม่ได้' : 'กำลังโหลดสต็อกคงเหลือ กรุณารอสักครู่'); return }
    {
      if (!selectedPo) { alert('กรุณาเลือกใบสั่งซื้อ'); return }
      if (!siteId) { alert('ใบสั่งซื้อนี้ไม่มีไซต์ — กำหนดไซต์ที่ใบสั่งซื้อก่อน'); return }
      if (!form.category_id) { alert('ใบสั่งซื้อนี้ไม่มีหมวดหมู่ — กำหนดหมวดหมู่ที่ใบสั่งซื้อก่อน'); return }
      const bad = validateReturnQty(form.selection, selectedPo, lookups)
      if (bad.length) { alert(bad.map(b => `• ${b.description || ''}: ${REASON_TEXT[b.reason]}`).join('\n')); return }
      if (!activeLines.length) { alert('กรุณาติ๊กเลือกรายการที่คืนอย่างน้อย 1 รายการ'); return }
    }
    if (!activeLines.length) { alert('กรุณาเพิ่มรายการอย่างน้อย 1 รายการ'); return }
    if (activeLines.some(l => !(Number(l.quantity) > 0))) { alert('จำนวนในรายการต้องมากกว่า 0'); return }
    if (activeLines.some(l => !l.description.trim() && !l.inventory_item_id)) { alert('กรุณาระบุสินค้าหรือคำอธิบายในทุกรายการ'); return }
    onSave({ ...form, site_id: siteId, lines: activeLines, totals }, confirmAfter, onHand, itemById)
  }

  return (
    <form onSubmit={e => { e.preventDefault(); submit(false) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <div>
            <label className="label">ซัพพลายเออร์ ★</label>
            <SearchableSelect required value={form.supplier_id}
              onChange={v => { hydrated.current = true; setForm(f => ({ ...f, supplier_id: v, po_id: '', original_expense_id: null, selection: {} })) }}
              options={(suppliers || []).map(s => ({ value: s.id, label: s.name, keywords: s.name }))} />
          </div>
          <div>
            <label className="label">ไซต์ (ตามใบสั่งซื้อ — ที่คืนสินค้าออกจากสต็อก)</label>
            <input className="input" readOnly disabled
              value={selectedPo ? ((sites || []).find(x => x.id === siteId)?.name || '—') : ''}
              placeholder="ไซต์จะตามใบสั่งซื้อที่เลือก" />
          </div>
          <div>
            <label className="label">เลขที่ใบลดหนี้ ★</label>
            <input className="input" required value={form.doc_number} onChange={e => set('doc_number', e.target.value)} />
          </div>
          <div>
            <label className="label">วันที่ ★</label>
            <input type="date" className="input" required value={form.doc_date} onChange={e => set('doc_date', e.target.value)} />
          </div>
          <div>
            <label className="label">วันที่ลงรายจ่าย (เดือนที่หักรายจ่ายติดลบ ว่าง = ใช้วันที่ในใบ)</label>
            <input type="date" className="input" value={form.expense_date} onChange={e => set('expense_date', e.target.value)} />
          </div>
        </div>

        {stockStatus === 'loading' && <div style={{ fontSize: 13, color: 'var(--text3)' }}>⏳ กำลังโหลดสต็อกคงเหลือของไซต์ — ปุ่มยืนยันจะใช้ได้เมื่อโหลดเสร็จ</div>}
        {stockStatus === 'error' && <div style={{ color: 'var(--danger, #e55)', fontSize: 13 }}>โหลดสต็อกคงเหลือไม่สำเร็จ: {onHandError} — ยืนยันไม่ได้ (บันทึกร่างได้)</div>}
        {lookupError && <div style={{ color: 'var(--danger, #e55)', fontSize: 13 }}>โหลดข้อมูลสินค้า/หน่วยแปลงไม่สำเร็จ: {lookupError} — บันทึกไม่ได้ ลองเปิดหน้านี้ใหม่</div>}

        {(
          <div style={{ display: 'grid', gap: 10 }}>
            <div>
              <label className="label">ใบสั่งซื้อของซัพพลายเออร์นี้ ★</label>
              {!form.supplier_id
                ? <div style={{ fontSize: 13, color: 'var(--text3)' }}>เลือกซัพพลายเออร์ก่อน</div>
                : <SearchableSelect value={form.po_id} onChange={pickPo} placeholder="— เลือก PO —"
                    options={poOptions.map(p => ({
                      value: p.id,
                      label: `${p.po_number || p.id.slice(0, 8)} · ${p.date || ''} · ${fmt((p.purchase_order_items || []).reduce((t, it) => t + poItemTotal(it), 0))}`,
                      keywords: p.po_number || '',
                    }))} />}
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, marginTop: 6 }}>
                <input type="checkbox" checked={includeUnreceived} onChange={e => setIncludeUnreceived(e.target.checked)} /> รวมใบสั่งซื้อที่ยังไม่รับของ
              </label>
            </div>
            {selectedPo && (
              <div style={{ fontSize: 13, color: 'var(--text2)' }}>
                ใบกำกับเดิม: {form.original_invoice_no ? <b>{form.original_invoice_no}</b> : '—'}
                {form.original_invoice_no && form.original_invoice_date ? <> ลงวันที่ <b>{form.original_invoice_date}</b></> : null}
              </div>
            )}
            {hydrateNote && <div style={{ fontSize: 13, color: 'var(--danger, #e55)' }}>{hydrateNote}</div>}
            {form.supplier_id && pos && !poOptions.length && (
              <div style={{ fontSize: 13, color: 'var(--text3)' }}>ไม่พบใบสั่งซื้อที่รับของแล้วของซัพพลายเออร์นี้</div>
            )}
            {selectedPo && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th><input type="checkbox" checked={allTicked} onChange={e => toggleAll(e.target.checked)} title="เลือกทั้งหมด" /></th>
                      <th>รายการ</th><th style={{ textAlign: 'right' }}>จำนวนที่สั่ง</th>
                      <th style={{ textAlign: 'right' }}>ราคา/หน่วย (หลังส่วนลด)</th>
                      <th style={{ textAlign: 'right' }}>รวม</th><th>จำนวนที่คืน</th>
                    </tr>
                  </thead>
                  <tbody>
                    {poItems.map(it => {
                      const s = form.selection[it.id] || { checked: false, qty: String(it.quantity) }
                      const bad = s.checked && (!(Number(s.qty) > 0) || Number(s.qty) > Number(it.quantity))
                      const blocked = lookupsReady && poItemBlocked(it, lookups)
                      const line = s.checked && !bad && !blocked ? creditLineForPoItem(it, Number(s.qty), lookups) : null
                      return (
                        <tr key={it.id}>
                          <td><input type="checkbox" checked={!!s.checked} disabled={blocked} onChange={e => setSel(it.id, { checked: e.target.checked })} /></td>
                          <td>{it.description}{!it.inventory_item_id && <div style={{ fontSize: 11, color: 'var(--text3)' }}>ไม่ใช่สต็อก — ไม่ตัดสต็อก</div>}</td>
                          <td className="font-mono" style={{ textAlign: 'right' }}>{fmt(it.quantity)} {it.unit}</td>
                          <td className="font-mono" style={{ textAlign: 'right' }}>{fmt(poItemNetUnitPrice(it))}</td>
                          <td className="font-mono" style={{ textAlign: 'right' }}>{fmt(poItemTotal(it))}</td>
                          <td style={{ minWidth: 130 }}>
                            {blocked ? <span style={{ fontSize: 11, color: 'var(--danger, #e55)' }}>{REASON_TEXT.unconvertible}</span> : s.checked ? (
                              <>
                                <input className="input" type="number" min="0" step="any" style={{ width: 90 }} value={s.qty}
                                  onChange={e => setSel(it.id, { qty: e.target.value })} /> {it.unit}
                                {bad && <div style={{ fontSize: 11, color: 'var(--danger, #e55)' }}>{Number(s.qty) > 0 ? REASON_TEXT.above_ordered : REASON_TEXT.not_positive}</div>}
                                {line && line.inventory_item_id && <div style={{ fontSize: 11, color: 'var(--text3)' }}>ตัดสต็อก {fmt(line.quantity)} {line.unit}</div>}
                                {line && <div style={{ fontSize: 11, color: 'var(--text3)' }}>ยอดคืน {fmt(Number(line.quantity) * Number(line.unit_price))}</div>}
                              </>
                            ) : <span style={{ color: 'var(--text3)' }}>—</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <div>
          <label className="label">หมายเหตุ</label>
          <input className="input" value={form.notes} onChange={e => set('notes', e.target.value)} />
        </div>

        <div style={{ textAlign: 'right', fontSize: 13, lineHeight: 1.7 }}>
          <div>ยอดก่อน VAT: <span className="font-mono">{fmt(totals.amount_no_vat)}</span></div>
          <div>VAT: <span className="font-mono">{fmt(totals.vat)}</span></div>
          <div style={{ fontWeight: 700 }}>ยอดรวม: <span className="font-mono">{fmt(totals.amount)}</span> บาท</div>
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
        <button type="submit" className="btn btn-ghost" disabled={loading || !lookupsReady}>{loading ? '⏳...' : '💾 บันทึกร่าง'}</button>
        <button type="button" className="btn btn-primary" disabled={loading || !lookupsReady || stockStatus !== 'ready'} onClick={() => submit(true)}>✅ บันทึกและยืนยัน</button>
      </div>
    </form>
  )
}

const SETTLEMENT_ORDER = ['owed', 'offset', 'refunded']

export default function SupplierCreditNotes({ prefill: prefillProp } = {}) {
  const { isAtLeast, role } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'purchase_orders')
  // a PO row hands data over via the module holder; the prop overrides it
  const [prefill] = useState(() => prefillProp || peekCreditNotePrefill())
  useEffect(() => { clearCreditNotePrefill() }, [])
  const [supplierFilter, setSupplierFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const { data: notes, loading, error, refetch } = useSupplierCreditNotes({ supplierId: supplierFilter, status: statusFilter })
  const { data: suppliers } = useSuppliers()
  const { data: sites } = useSites()

  // prefill (from a PO, Task 6) opens the form once on mount
  const [showForm, setShowForm] = useState(!!prefill)
  const [editNote, setEditNote] = useState(null)
  const [formKey, setFormKey] = useState(0)
  const [formInitial, setFormInitial] = useState(() => (prefill ? makeInitialForm(prefill, null) : null))
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmId, setConfirmId] = useState(null)
  const [pendingSave, setPendingSave] = useState(null)
  const { data: allInvItems } = useAllInventoryItems()
  const itemNameById = useMemo(() => Object.fromEntries((allInvItems || []).map(i => [i.id, i.name])), [allInvItems])
  const [voidId, setVoidId] = useState(null)
  const [deleteId, setDeleteId] = useState(null)
  const [settleTarget, setSettleTarget] = useState(null)
  const [settleValue, setSettleValue] = useState('owed')

  const closeForm = () => { setShowForm(false); setEditNote(null); setFormInitial(null) }
  const openNew = () => { setEditNote(null); setFormInitial(makeInitialForm(null, null)); setFormKey(k => k + 1); setShowForm(true) }
  const openEdit = n => { setEditNote(n); setFormInitial(makeInitialForm(null, n)); setFormKey(k => k + 1); setShowForm(true) }

  const supplierNameById = useMemo(() => Object.fromEntries((suppliers || []).map(s => [s.id, s.name])), [suppliers])

  const handleSave = async (form, confirmAfter, onHand, itemById, warned = false) => {
    if (saving || busy) return
    if (!form.lines.length) { alert('ใบลดหนี้ต้องมีรายการสินค้าอย่างน้อย 1 รายการ'); return }
    if (confirmAfter && !warned) {
      // warning first; the save + RPC only run once the owner confirms
      setPendingSave({ form: { ...form, siteName: (sites || []).find(x => x.id === form.site_id)?.name }, itemById })
      return
    }
    // Stock shortfall pre-check (the RPC is the final authority).
    if (confirmAfter) {
      const short = findStockShortfalls(form.lines, onHand)
      if (short.length) {
        alert('สต็อกไม่พอสำหรับคืนสินค้า:\n' + short.map(s =>
          `• ${itemById[s.inventory_item_id]?.name || s.inventory_item_id}: ต้องการคืน ${s.requested} คงเหลือ ${s.onHand}`).join('\n'))
        return
      }
    }
    setSaving(true)
    let savedId = editNote?.id || null
    let createdNew = false
    let oldItemIds = []
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const t = form.totals
      const payload = {
        supplier_id: form.supplier_id, site_id: form.site_id, doc_number: form.doc_number.trim(),
        doc_date: form.doc_date, category_id: form.category_id, po_id: form.po_id || null,
        amount_no_vat: t.amount_no_vat, vat: t.vat, amount: round2(t.amount_no_vat + t.vat),
        notes: form.notes || null,
      }
      Object.assign(payload, pickCreditNoteExtra(form, editNote))
      if (savedId) {
        const { error } = await supabase.from('supplier_credit_notes').update(payload).eq('id', savedId)
        if (error) throw error
        const { data: oldItems, error: oldErr } = await supabase.from('supplier_credit_note_items').select('id').eq('credit_note_id', savedId)
        if (oldErr) throw oldErr
        oldItemIds = (oldItems || []).map(r => r.id)
      } else {
        const { data, error } = await supabase.from('supplier_credit_notes')
          .insert({ ...payload, status: 'draft', settlement_status: 'owed', created_by: session?.user?.email || null })
          .select('id').single()
        if (error) throw error
        savedId = data.id
        createdNew = true
      }
      const itemRows = form.lines.map(l => ({
        credit_note_id: savedId,
        inventory_item_id: l.inventory_item_id || null,
        description: l.description.trim() || itemById[l.inventory_item_id]?.name || '',
        quantity: Number(l.quantity),
        unit: l.unit || null,
        unit_price: Number(l.unit_price) || 0,
      }))
      const { error: itemErr } = await supabase.from('supplier_credit_note_items').insert(itemRows)
      if (itemErr) {
        // Don't leave an empty brand-new draft behind (best effort).
        if (createdNew) await supabase.from('supplier_credit_notes').delete().eq('id', savedId)
        throw itemErr
      }
      // new rows are in; only now remove the previous ones (a failed insert keeps the old items)
      if (oldItemIds.length) {
        const { error: delErr } = await supabase.from('supplier_credit_note_items').delete().in('id', oldItemIds)
        if (delErr) throw delErr
      }
      if (confirmAfter) {
        try { await confirmNote(savedId) }
        catch (e) {
          // Draft is saved; keep the form open on that draft so the user can fix and retry.
          refetch()
          setEditNote({ id: savedId })
          alert('บันทึกเป็นฉบับร่างแล้ว แต่ยืนยันไม่สำเร็จ: ' + e.message)
          return
        }
      }
      closeForm(); refetch()
    } catch (e) {
      if (e?.code === '23505') alert('เลขที่ใบลดหนี้นี้มีอยู่แล้วสำหรับซัพพลายเออร์นี้')
      else alert('Error: ' + (e.message || e))
    } finally { setSaving(false) }
  }

  const runRpc = async (fn, closer) => {
    if (busy) return
    setBusy(true)
    try { await fn(); closer(); refetch() }
    catch (e) { alert('Error: ' + e.message); closer(); refetch() }
    finally { setBusy(false) }
  }
  const rows = notes || []
  const confirmTarget = confirmId ? rows.find(n => n.id === confirmId) : null
  const askConfirm = n => {
    if (!(n.supplier_credit_note_items || []).length) { alert('ใบลดหนี้นี้ไม่มีรายการสินค้า — แก้ไขและเพิ่มรายการก่อนยืนยัน'); return }
    setConfirmId(n.id)
  }

  const handleDeleteDraft = async () => {
    if (!deleteId || busy) return
    setBusy(true)
    const { error } = await supabase.from('supplier_credit_notes').delete().eq('id', deleteId)
    setBusy(false)
    setDeleteId(null)
    if (error) { alert('Error: ' + cnErrorText(error)); return }
    refetch()
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        {canEdit && <button className="btn btn-primary" onClick={openNew}>+ เพิ่มใบลดหนี้</button>}
        <select className="select select-sm" style={{ width: 200 }} value={supplierFilter} onChange={e => setSupplierFilter(e.target.value)}>
          <option value="">ทุกซัพพลายเออร์</option>
          {(suppliers || []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className="select select-sm" style={{ width: 160 }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">ทุกสถานะเอกสาร</option>
          <option value="draft">📝 ร่าง</option>
          <option value="confirmed">✅ ยืนยันแล้ว</option>
          <option value="void">🚫 ยกเลิก</option>
        </select>
      </div>

      {error && <div style={{ color: 'var(--danger, #e55)', marginBottom: 12 }}>โหลดข้อมูลไม่สำเร็จ: {error}</div>}

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>เลขที่</th><th>วันที่</th><th>ซัพพลายเออร์</th><th>ไซต์</th>
                <th style={{ textAlign: 'right' }}>ยอดรวม</th><th>สถานะเอกสาร</th><th>สถานะเงิน</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(n => {
                const badge = STATUS_BADGE[n.status] || STATUS_BADGE.draft
                return (
                  <tr key={n.id}>
                    <td style={{ fontWeight: 600 }}>
                      {n.doc_number}
                      {n.original_invoice_no && <div style={{ fontSize: 11, fontWeight: 400, color: 'var(--text2)' }}>อ้างถึง {n.original_invoice_no}</div>}
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text2)' }}>{n.doc_date ? new Date(n.doc_date).toLocaleDateString('th-TH') : '—'}</td>
                    <td>{n.suppliers?.name || supplierNameById[n.supplier_id] || '—'}</td>
                    <td>{n.sites?.name || '—'}</td>
                    <td className="font-mono" style={{ textAlign: 'right' }}>{fmt(n.amount)}</td>
                    <td><span className={`badge ${badge.cls}`}>{badge.label}</span></td>
                    <td>{n.status === 'confirmed' ? (SETTLEMENT_LABELS[n.settlement_status] || n.settlement_status) : <span style={{ color: 'var(--text3)' }}>—</span>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <div className="actions-cell">
                        {canEdit && n.status === 'draft' && <button className="btn btn-sm btn-success" disabled={busy} onClick={() => askConfirm(n)}>✅ ยืนยัน</button>}
                        {canEdit && <RowActionsMenu items={[
                          ...(n.status === 'draft' ? [
                            { label: '✏️ แก้ไข', onClick: () => openEdit(n) },
                            { label: '🗑️ ลบ', onClick: () => setDeleteId(n.id), danger: true },
                          ] : []),
                          ...(n.status === 'confirmed' ? [
                            { label: '💰 เปลี่ยนสถานะเงิน', onClick: () => { setSettleTarget(n); setSettleValue(n.settlement_status || 'owed') } },
                            { label: '🚫 ยกเลิก', onClick: () => setVoidId(n.id), danger: true },
                          ] : []),
                        ]} />}
                      </div>
                    </td>
                  </tr>
                )
              })}
              {!rows.length && (
                <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>
                  {loading ? 'กำลังโหลด...' : (supplierFilter || statusFilter) ? 'ไม่พบใบลดหนี้ที่ตรงกับตัวกรอง' : 'ยังไม่มีใบลดหนี้'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showForm && formInitial && (
        <Modal title={editNote ? 'แก้ไขใบลดหนี้' : 'เพิ่มใบลดหนี้ซัพพลายเออร์'} onClose={closeForm} maxWidth={760}>
          <CreditNoteForm key={formKey} initial={formInitial}
            suppliers={suppliers} sites={sites}
            onSave={handleSave} onCancel={closeForm} loading={saving} />
        </Modal>
      )}

      {confirmTarget && (
        <ConfirmNoteDialog note={confirmTarget} itemNameById={itemNameById}
          onConfirm={() => runRpc(() => confirmNote(confirmTarget.id), () => setConfirmId(null))}
          onCancel={() => setConfirmId(null)} />
      )}

      {pendingSave && (
        <ConfirmNoteDialog form={pendingSave.form} itemById={pendingSave.itemById}
          onCancel={() => setPendingSave(null)}
          onConfirm={onHand => {
            const ps = pendingSave
            setPendingSave(null)
            handleSave(ps.form, true, onHand, ps.itemById, true)
          }} />
      )}

      {deleteId && (
        <ConfirmDialog title="ลบใบลดหนี้ฉบับร่าง" danger
          message="ลบใบลดหนี้ฉบับร่างนี้และรายการสินค้าทั้งหมด? (ยังไม่มีผลกับสต็อกหรือรายจ่าย)"
          onConfirm={handleDeleteDraft}
          onCancel={() => setDeleteId(null)} />
      )}

      {voidId && (
        <ConfirmDialog title="ยกเลิกใบลดหนี้" danger
          message="ระบบจะคืนสต็อกและลบรายจ่ายติดลบที่บันทึกไว้ ยืนยันการยกเลิก?"
          onConfirm={() => runRpc(() => voidNote(voidId), () => setVoidId(null))}
          onCancel={() => setVoidId(null)} />
      )}

      {settleTarget && (
        <Modal title={`สถานะเงิน — ${settleTarget.doc_number}`} onClose={() => setSettleTarget(null)} maxWidth={380}>
          <div className="modal-body" style={{ display: 'grid', gap: 8 }}>
            {SETTLEMENT_ORDER.map(k => (
              <label key={k} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="radio" name="settle" checked={settleValue === k} onChange={() => setSettleValue(k)} /> {SETTLEMENT_LABELS[k]}
              </label>
            ))}
          </div>
          <div className="modal-footer">
            <button className="btn btn-ghost" onClick={() => setSettleTarget(null)}>ยกเลิก</button>
            <button className="btn btn-primary" disabled={busy}
              onClick={() => runRpc(() => setSettlement(settleTarget.id, settleValue), () => setSettleTarget(null))}>บันทึก</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
