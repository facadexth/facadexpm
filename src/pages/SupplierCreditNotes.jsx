// ============================================================
// Supplier credit notes — ใบลดหนี้ซัพพลายเออร์ (คืนสินค้า)
// ✅ Draft -> confirm (RPC: deducts stock + books a negative expense) -> void
// ✅ Settlement status (owed / offset / refunded) changed via RPC
// ✅ Client may only write DRAFT notes; every status change goes through the
//    RPCs (see supabase/migrations/2026-10-06-0*.sql)
// ============================================================
import { useEffect, useMemo, useState } from 'react'
import { supabase, fmt } from '../lib/supabase.js'
import {
  useSupplierCreditNotes, useInventoryOnHand, useSuppliers, useSites,
  useCategories, usePurchaseOrders, useInventoryItems, useExpenses,
} from '../hooks/useSupabase.js'
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

const EMPTY_LINE = { inventory_item_id: '', description: '', quantity: '1', unit: '', unit_price: '' }

function makeInitialForm(prefill, note) {
  if (note) {
    const items = (note.supplier_credit_note_items || []).map(i => ({
      inventory_item_id: i.inventory_item_id || '',
      description: i.description || '',
      quantity: String(i.quantity ?? ''),
      unit: i.unit || '',
      unit_price: String(i.unit_price ?? ''),
    }))
    // vat_enabled / price_includes_vat are not stored; infer from saved data.
    const { vatEnabled, priceIncludesVat } = inferVatFlags(note)
    return {
      supplier_id: note.supplier_id, site_id: note.site_id, doc_number: note.doc_number,
      doc_date: note.doc_date, category_id: note.category_id || '', po_id: note.po_id || '',
      original_expense_id: note.original_expense_id || null,
      expense_date: note.expense_date || '', original_invoice_no: note.original_invoice_no || '',
      original_invoice_date: note.original_invoice_date || '',
      vatEnabled, priceIncludesVat, notes: note.notes || '',
      lines: items.length ? items : [{ ...EMPTY_LINE }],
    }
  }
  const p = prefill || {}
  return {
    supplier_id: p.supplier_id || '', site_id: p.site_id || '', doc_number: '',
    doc_date: bangkokTodayIso(), category_id: p.category_id || '', po_id: p.po_id || '',
    original_expense_id: p.original_expense_id || null,
    expense_date: '', original_invoice_no: '', original_invoice_date: '',
    vatEnabled: p.vatEnabled ?? true, priceIncludesVat: p.priceIncludesVat ?? false, notes: '',
    lines: p.items?.length
      ? p.items.map(i => ({
          inventory_item_id: i.inventory_item_id || '', description: i.description || '',
          quantity: String(i.quantity ?? '1'), unit: i.unit || '', unit_price: String(i.unit_price ?? ''),
        }))
      : [{ ...EMPTY_LINE }],
  }
}

function CreditNoteForm({ initial, suppliers, sites, categories, inventoryItems, onSave, onCancel, loading }) {
  const [form, setForm] = useState(initial)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const setLine = (i, k, v) => setForm(f => ({ ...f, lines: f.lines.map((l, idx) => idx === i ? { ...l, [k]: v } : l) }))
  const addLine = () => setForm(f => ({ ...f, lines: [...f.lines, { ...EMPTY_LINE }] }))
  const removeLine = i => setForm(f => ({ ...f, lines: f.lines.length > 1 ? f.lines.filter((_, idx) => idx !== i) : f.lines }))

  const { data: onHandData } = useInventoryOnHand(form.site_id)
  const onHand = onHandData || {}
  const { data: supplierExpenses } = useExpenses(form.supplier_id ? { supplierId: form.supplier_id } : {})
  const { data: pos } = usePurchaseOrders(form.supplier_id ? { supplierId: form.supplier_id } : {})

  const itemOptions = useMemo(() => (inventoryItems || []).map(it => ({
    value: it.id, label: `${it.name} (${it.base_unit})`, keywords: it.name,
  })), [inventoryItems])
  const itemById = useMemo(() => Object.fromEntries((inventoryItems || []).map(it => [it.id, it])), [inventoryItems])

  const activeLines = form.lines.filter(l => l.inventory_item_id || l.description.trim() || Number(l.unit_price) > 0)
  const totals = computeCreditNoteTotals(activeLines, { vatEnabled: form.vatEnabled, vatRate: VAT_RATE, priceIncludesVat: form.priceIncludesVat })

  const pickItem = (i, id) => {
    const it = itemById[id]
    setForm(f => ({
      ...f,
      lines: f.lines.map((l, idx) => idx !== i ? l : {
        ...l,
        inventory_item_id: id || '',
        description: id ? (it?.name || l.description) : l.description,
        unit: id ? (it?.base_unit || l.unit) : l.unit,
      }),
    }))
  }

  const submit = (confirmAfter) => {
    if (!form.supplier_id || !form.site_id || !form.doc_number.trim() || !form.category_id) { alert('กรุณากรอกซัพพลายเออร์ ไซต์ เลขที่ใบลดหนี้ และหมวดหมู่'); return }
    if (!activeLines.length) { alert('กรุณาเพิ่มรายการอย่างน้อย 1 รายการ'); return }
    if (activeLines.some(l => !(Number(l.quantity) > 0))) { alert('จำนวนในรายการต้องมากกว่า 0'); return }
    if (activeLines.some(l => !l.description.trim() && !l.inventory_item_id)) { alert('กรุณาระบุสินค้าหรือคำอธิบายในทุกรายการ'); return }
    onSave({ ...form, lines: activeLines, totals }, confirmAfter, onHand, itemById)
  }

  return (
    <form onSubmit={e => { e.preventDefault(); submit(false) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <div>
            <label className="label">ซัพพลายเออร์ ★</label>
            <SearchableSelect required value={form.supplier_id}
              onChange={v => setForm(f => ({ ...f, supplier_id: v, po_id: '', original_expense_id: null }))}
              options={(suppliers || []).map(s => ({ value: s.id, label: s.name, keywords: s.name }))} />
          </div>
          <div>
            <label className="label">ไซต์ ★ (ที่คืนสินค้าออกจากสต็อก)</label>
            <SearchableSelect required value={form.site_id} onChange={v => set('site_id', v)}
              options={(sites || []).map(s => ({ value: s.id, label: s.name, keywords: s.name }))} />
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
            <label className="label">หมวดหมู่ ★</label>
            <SearchableSelect required value={form.category_id} onChange={v => set('category_id', v)}
              options={(categories || []).map(c => ({ value: c.id, label: c.name, keywords: c.name }))} />
          </div>
          <div>
            <label className="label">ผูก PO (ถ้ามี)</label>
            <SearchableSelect value={form.po_id} onChange={v => set('po_id', v)}
              placeholder="— ไม่ผูก —"
              options={(pos || []).map(p => ({ value: p.id, label: `${p.po_number || p.id.slice(0, 8)} · ${p.date || ''}`, keywords: p.po_number || '' }))} />
          </div>
          <div>
            <label className="label">วันที่ลงรายจ่าย (ว่าง = ใช้วันที่ในใบ)</label>
            <input type="date" className="input" value={form.expense_date} onChange={e => set('expense_date', e.target.value)} />
          </div>
          <div>
            <label className="label">อ้างถึงใบกำกับเดิม — เลขที่</label>
            <input className="input" value={form.original_invoice_no} onChange={e => set('original_invoice_no', e.target.value)} />
          </div>
          <div>
            <label className="label">— วันที่</label>
            <input type="date" className="input" value={form.original_invoice_date} onChange={e => set('original_invoice_date', e.target.value)} />
          </div>
          <div>
            <label className="label">รายจ่ายเดิมที่อ้างถึง (ไม่บังคับ)</label>
            <SearchableSelect value={form.original_expense_id || ''} onChange={v => set('original_expense_id', v || null)}
              placeholder="— ไม่ผูก —"
              options={(form.supplier_id ? (supplierExpenses || []) : []).map(x => ({
                value: x.id,
                label: `${x.date || ''} · ${x.invoice_no || '-'} · ${fmt(x.amount)}`,
                keywords: `${x.invoice_no || ''} ${x.date || ''}`,
              }))} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" checked={form.vatEnabled} onChange={e => set('vatEnabled', e.target.checked)} /> มี VAT
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, opacity: form.vatEnabled ? 1 : 0.5 }}>
            <input type="checkbox" disabled={!form.vatEnabled} checked={form.priceIncludesVat} onChange={e => set('priceIncludesVat', e.target.checked)} /> ราคารวม VAT แล้ว
          </label>
        </div>

        <div>
          <label className="label">รายการสินค้าที่คืน</label>
          <div style={{ display: 'grid', gap: 10 }}>
            {form.lines.map((l, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, padding: 10, border: '1px solid var(--border)', borderRadius: 8 }}>
                <div style={{ gridColumn: '1 / -1' }}>
                  <SearchableSelect value={l.inventory_item_id} onChange={v => pickItem(i, v)}
                    placeholder="— สินค้าในคลัง (หรือพิมพ์คำอธิบายด้านล่างสำหรับรายการที่ไม่ใช่สต็อก) —"
                    options={itemOptions} />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <input className="input" placeholder="คำอธิบาย" value={l.description} onChange={e => setLine(i, 'description', e.target.value)} />
                </div>
                <input className="input" type="number" min="0" step="any" placeholder="จำนวน" value={l.quantity} onChange={e => setLine(i, 'quantity', e.target.value)} />
                <input className="input" placeholder="หน่วย" value={l.unit} readOnly={!!l.inventory_item_id} title={l.inventory_item_id ? 'หน่วยฐานของสินค้าในคลัง' : undefined} onChange={e => setLine(i, 'unit', e.target.value)} />
                <input className="input" type="number" min="0" step="any" placeholder="ราคา/หน่วย" value={l.unit_price} onChange={e => setLine(i, 'unit_price', e.target.value)} />
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeLine(i)} disabled={form.lines.length <= 1}>🗑️ ลบรายการ</button>
              </div>
            ))}
            <div><button type="button" className="btn btn-ghost btn-sm" onClick={addLine}>+ เพิ่มรายการ</button></div>
          </div>
        </div>

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
        <button type="submit" className="btn btn-ghost" disabled={loading}>{loading ? '⏳...' : '💾 บันทึกร่าง'}</button>
        <button type="button" className="btn btn-primary" disabled={loading} onClick={() => submit(true)}>✅ บันทึกและยืนยัน</button>
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
  const { data: categories } = useCategories()
  const { data: inventoryItems } = useInventoryItems()

  // prefill (from a PO, Task 6) opens the form once on mount
  const [showForm, setShowForm] = useState(!!prefill)
  const [editNote, setEditNote] = useState(null)
  const [formKey, setFormKey] = useState(0)
  const [formInitial, setFormInitial] = useState(() => (prefill ? makeInitialForm(prefill, null) : null))
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmId, setConfirmId] = useState(null)
  const [voidId, setVoidId] = useState(null)
  const [deleteId, setDeleteId] = useState(null)
  const [settleTarget, setSettleTarget] = useState(null)
  const [settleValue, setSettleValue] = useState('owed')

  const closeForm = () => { setShowForm(false); setEditNote(null); setFormInitial(null) }
  const openNew = () => { setEditNote(null); setFormInitial(makeInitialForm(null, null)); setFormKey(k => k + 1); setShowForm(true) }
  const openEdit = n => { setEditNote(n); setFormInitial(makeInitialForm(null, n)); setFormKey(k => k + 1); setShowForm(true) }

  const supplierNameById = useMemo(() => Object.fromEntries((suppliers || []).map(s => [s.id, s.name])), [suppliers])

  const handleSave = async (form, confirmAfter, onHand, itemById) => {
    if (saving || busy) return
    if (!form.lines.length) { alert('ใบลดหนี้ต้องมีรายการสินค้าอย่างน้อย 1 รายการ'); return }
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

  const rows = notes || []

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
            suppliers={suppliers} sites={sites} categories={categories} inventoryItems={inventoryItems}
            onSave={handleSave} onCancel={closeForm} loading={saving} />
        </Modal>
      )}

      {confirmId && (
        <ConfirmDialog title="ยืนยันใบลดหนี้"
          message="เมื่อยืนยันแล้ว ระบบจะตัดสต็อกสินค้าที่คืนและบันทึกเป็นรายจ่ายติดลบ แก้ไขไม่ได้อีก (ยกเลิกได้เท่านั้น)"
          onConfirm={() => runRpc(() => confirmNote(confirmId), () => setConfirmId(null))}
          onCancel={() => setConfirmId(null)} />
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
