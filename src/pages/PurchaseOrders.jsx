// ============================================================
// PurchaseOrders — ใบสั่งซื้อ
// ✅ Itemized PO tied to site/supplier/category
// ✅ Auto-number PO-YYYY-NNN
// ✅ Status: ordered -> received (auto-creates expense) | cancelled
// ============================================================
import { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { usePurchaseOrders, useSites, useSuppliers, useCategories } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { fmt, fmtDate } from '../lib/supabase.js'
import { auditLog } from '../lib/audit.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import SearchableSelect from '../components/SearchableSelect.jsx'
import { format, startOfYear, endOfYear } from 'date-fns'
import { downloadPDF } from '../lib/pdf.js'

const siteOpts = (sites) => (sites || []).map(s => ({
  value: s.id, label: `${s.site_number} · ${s.name}`, keywords: `${s.site_number} ${s.name}`,
}))
const catOpts = (categories) => (categories || []).map(c => ({ value: c.id, label: c.name, keywords: c.name }))
const supplierOpts = (suppliers) => (suppliers || []).map(s => ({
  value: s.id, label: `${s.supplier_number} · ${s.name}`, keywords: `${s.supplier_number} ${s.name}`,
}))

const PO_STATUSES = ['ordered', 'received', 'cancelled']
const PO_STATUS_LABELS = { ordered: '📦 สั่งแล้ว', received: '✅ รับของแล้ว', cancelled: '✕ ยกเลิก' }

const EMPTY_ITEM = { description: '', quantity: '1', unit: '', unit_price: '' }
const EMPTY_FORM = { site_id: '', supplier_id: '', category_id: '', date: '', notes: '', items: [{ ...EMPTY_ITEM }] }

function lineTotal(item) {
  return (parseFloat(item.quantity) || 0) * (parseFloat(item.unit_price) || 0)
}

function ItemsEditor({ items, onChange }) {
  const set = (i, k, v) => onChange(items.map((it, idx) => idx === i ? { ...it, [k]: v } : it))
  const add = () => onChange([...items, { ...EMPTY_ITEM }])
  const remove = (i) => onChange(items.length > 1 ? items.filter((_, idx) => idx !== i) : items)
  const grandTotal = items.reduce((sum, it) => sum + lineTotal(it), 0)

  return (
    <div>
      <label className="label">รายการสินค้า ★</label>
      <div style={{ display: 'grid', gap: 8 }}>
        {items.map((it, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 80px 100px 32px', gap: 6, alignItems: 'center' }}>
            <input className="input input-sm" placeholder="รายละเอียดสินค้า" required
              value={it.description} onChange={e => set(i, 'description', e.target.value)} />
            <input className="input input-sm" type="number" min="0" step="0.01" placeholder="จำนวน"
              value={it.quantity} onChange={e => set(i, 'quantity', e.target.value)} />
            <input className="input input-sm" placeholder="หน่วย"
              value={it.unit} onChange={e => set(i, 'unit', e.target.value)} />
            <input className="input input-sm" type="number" min="0" step="0.01" placeholder="ราคา/หน่วย"
              value={it.unit_price} onChange={e => set(i, 'unit_price', e.target.value)} />
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => remove(i)} disabled={items.length === 1}>✕</button>
          </div>
        ))}
      </div>
      <button type="button" className="btn btn-sm btn-ghost" style={{ marginTop: 8 }} onClick={add}>+ เพิ่มรายการ</button>
      <div style={{ marginTop: 10, textAlign: 'right', fontWeight: 700, fontSize: 15 }}>
        รวม: <span className="font-mono" style={{ color: 'var(--accent)' }}>{fmt(grandTotal)}</span> บาท
      </div>
    </div>
  )
}

function PurchaseOrderForm({ initial = EMPTY_FORM, sites, suppliers, categories, onSave, onCancel, loading }) {
  const [form, setForm] = useState({ ...EMPTY_FORM, ...initial })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  return (
    <form onSubmit={e => { e.preventDefault(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div className="form-grid-2">
          <div>
            <label className="label">วันที่ ★</label>
            <input type="date" className="input" required value={form.date} onChange={e => set('date', e.target.value)} />
          </div>
          <div>
            <label className="label">หมวดค่าใช้จ่าย ★</label>
            <SearchableSelect required value={form.category_id} onChange={id => set('category_id', id)}
              placeholder="— เลือกหมวด —" options={catOpts(categories)} />
          </div>
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label">ไซท์งาน ★</label>
            <SearchableSelect required value={form.site_id} onChange={id => set('site_id', id)}
              placeholder="— เลือกไซท์ —" options={siteOpts(sites)} />
          </div>
          <div>
            <label className="label">Supplier ★</label>
            <SearchableSelect required value={form.supplier_id} onChange={id => set('supplier_id', id)}
              placeholder="— เลือก Supplier —" options={supplierOpts(suppliers)} />
          </div>
        </div>
        <ItemsEditor items={form.items} onChange={items => set('items', items)} />
        <div>
          <label className="label">หมายเหตุ</label>
          <input className="input" value={form.notes} onChange={e => set('notes', e.target.value)} />
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? '⏳...' : '✅ บันทึกใบสั่งซื้อ'}
        </button>
      </div>
    </form>
  )
}

function PODocumentModal({ po, onClose }) {
  const items = po.purchase_order_items || []
  const total = items.reduce((s, it) => s + (it.line_total || 0), 0)

  return (
    <Modal title={`ใบสั่งซื้อ ${po.po_number}`} onClose={onClose} maxWidth={640}>
      <div className="modal-body">
        <div id={`po-doc-${po.id}`} style={{ fontFamily: 'Sarabun,sans-serif', padding: '20px 24px', background: '#fff', color: '#111' }}>
          <div style={{ textAlign: 'center', marginBottom: 16 }}>
            <div style={{ fontSize: 18, fontWeight: 800 }}>FACADE X</div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>ใบสั่งซื้อ</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12, fontSize: 13 }}>
            <div><strong>เลขที่:</strong> {po.po_number}</div>
            <div><strong>วันที่:</strong> {new Date(po.date).toLocaleDateString('th-TH')}</div>
            <div><strong>ไซท์งาน:</strong> {po.sites?.name} ({po.sites?.site_number})</div>
            <div><strong>Supplier:</strong> {po.suppliers?.name}</div>
          </div>
          {po.notes && <div style={{ fontSize: 13, marginBottom: 12 }}><strong>หมายเหตุ:</strong> {po.notes}</div>}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #111' }}>
                <th style={{ textAlign: 'left', padding: '6px 4px' }}>รายการ</th>
                <th style={{ textAlign: 'right', padding: '6px 4px' }}>จำนวน</th>
                <th style={{ textAlign: 'right', padding: '6px 4px' }}>ราคา/หน่วย</th>
                <th style={{ textAlign: 'right', padding: '6px 4px' }}>รวม</th>
              </tr>
            </thead>
            <tbody>
              {items.map(it => (
                <tr key={it.id} style={{ borderBottom: '1px solid #ddd' }}>
                  <td style={{ padding: '6px 4px' }}>{it.description}</td>
                  <td style={{ textAlign: 'right', padding: '6px 4px' }}>{it.quantity} {it.unit || ''}</td>
                  <td style={{ textAlign: 'right', padding: '6px 4px' }}>{fmt(it.unit_price)}</td>
                  <td style={{ textAlign: 'right', padding: '6px 4px' }}>{fmt(it.line_total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700, fontSize: 15 }}>
                <td colSpan={3} style={{ padding: '8px 4px', borderTop: '2px solid #111' }}>รวมทั้งสิ้น</td>
                <td style={{ textAlign: 'right', padding: '8px 4px', borderTop: '2px solid #111' }}>{fmt(total)} บาท</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
        <button className="btn btn-primary" onClick={() => downloadPDF(`po-doc-${po.id}`, `${po.po_number}.pdf`)}>📄 ดาวน์โหลด PDF</button>
      </div>
    </Modal>
  )
}

export default function PurchaseOrders({ navigateTo, navState }) {
  const { isAtLeast } = useUserRole()
  const canEdit = isAtLeast('ADMIN')
  const today = new Date()
  const ytdFrom = format(startOfYear(today), 'yyyy-MM-dd')
  const ytdTo   = format(endOfYear(today),   'yyyy-MM-dd')

  const [dateFrom, setDateFrom] = useState(ytdFrom)
  const [dateTo,   setDateTo]   = useState(ytdTo)
  const [siteId,     setSiteId]     = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [status,      setStatus]    = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [editRow, setEditRow] = useState(null)
  const [deleteId, setDeleteId] = useState(null)
  const [docRow, setDocRow] = useState(null)
  const [receiveRow, setReceiveRow] = useState(null)
  const [receiving, setReceiving] = useState(false)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState(null)

  const filters = { from: dateFrom, to: dateTo, siteId, supplierId, status }
  const { data: pos, refetch } = usePurchaseOrders(filters)
  const { data: sites }      = useSites()
  const { data: categories } = useCategories()
  const { data: suppliers }  = useSuppliers()

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3000) }

  const handleSave = async (form) => {
    setSaving(true)
    try {
      const poPayload = {
        site_id: form.site_id, supplier_id: form.supplier_id, category_id: form.category_id,
        date: form.date, notes: form.notes || null,
      }
      let poId = editRow?.id
      if (editRow) {
        const { error } = await supabase.from('purchase_orders').update(poPayload).eq('id', editRow.id)
        if (error) throw error
        const { error: delError } = await supabase.from('purchase_order_items').delete().eq('po_id', editRow.id)
        if (delError) throw delError
        await auditLog('purchase_orders', editRow.id, 'UPDATE', editRow, poPayload)
      } else {
        const { data, error } = await supabase.from('purchase_orders').insert(poPayload).select().single()
        if (error) throw error
        poId = data.id
        await auditLog('purchase_orders', poId, 'INSERT', null, poPayload)
      }

      const itemsPayload = form.items
        .filter(it => it.description.trim())
        .map((it, i) => ({
          po_id: poId, description: it.description,
          quantity: parseFloat(it.quantity) || 0, unit: it.unit || null,
          unit_price: parseFloat(it.unit_price) || 0, line_total: lineTotal(it), sort_order: i,
        }))
      if (itemsPayload.length) {
        const { error } = await supabase.from('purchase_order_items').insert(itemsPayload)
        if (error) throw error
      }

      setShowAdd(false); setEditRow(null); refetch(); showToast('บันทึกสำเร็จ')
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = async () => {
    if (!deleteId) return
    const { error } = await supabase.from('purchase_orders').update({ status: 'cancelled' }).eq('id', deleteId)
    if (!error) { await auditLog('purchase_orders', deleteId, 'UPDATE', null, { status: 'cancelled' }); setDeleteId(null); refetch(); showToast('ยกเลิกแล้ว') }
    else alert('Error: ' + error.message)
  }

  const handleReceive = async () => {
    if (!receiveRow || receiving) return
    setReceiving(true)
    const total = (receiveRow.purchase_order_items || []).reduce((s, it) => s + (it.line_total || 0), 0)
    try {
      const expensePayload = {
        date: new Date().toISOString().slice(0, 10),
        description: `จากใบสั่งซื้อ ${receiveRow.po_number}`,
        site_id: receiveRow.site_id,
        category_id: receiveRow.category_id,
        supplier_id: receiveRow.supplier_id,
        supplier: receiveRow.suppliers?.name || null,
        amount: total,
        payment_method: 'transfer',
        status: 'pending',
        notes: `จาก ใบสั่งซื้อ ${receiveRow.po_number}`,
        po_id: receiveRow.id,
      }
      const { data: expense, error: expError } = await supabase.from('expenses').insert(expensePayload).select().single()
      if (expError) throw expError
      await auditLog('expenses', expense.id, 'INSERT', null, expensePayload)

      const poUpdate = { status: 'received', received_date: expensePayload.date, expense_id: expense.id }
      const { error: poError } = await supabase.from('purchase_orders').update(poUpdate).eq('id', receiveRow.id)
      if (poError) throw poError
      await auditLog('purchase_orders', receiveRow.id, 'UPDATE', null, poUpdate)

      setReceiveRow(null); refetch(); showToast('รับของแล้ว สร้างรายจ่ายอัตโนมัติ')
    } catch (e) {
      alert('Error: ' + e.message + ' — หากสร้างรายจ่ายไปแล้วแต่ใบสั่งซื้อยังไม่อัปเดต ให้ตรวจสอบหน้ารายจ่ายและอัปเดตใบสั่งซื้อด้วยตนเอง')
    } finally {
      setReceiving(false)
    }
  }

  const editFormInitial = useMemo(() => {
    if (!editRow) return null
    return {
      site_id: editRow.site_id, supplier_id: editRow.supplier_id, category_id: editRow.category_id,
      date: editRow.date, notes: editRow.notes || '',
      items: (editRow.purchase_order_items?.length ? editRow.purchase_order_items : [{ ...EMPTY_ITEM }])
        .map(it => ({ description: it.description, quantity: String(it.quantity), unit: it.unit || '', unit_price: String(it.unit_price) })),
    }
  }, [editRow])

  return (
    <div>
      {toast && <div className="alert alert-success" style={{ marginBottom: 12 }}>✅ {toast}</div>}

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        {canEdit && <button className="btn btn-primary" onClick={() => { setEditRow(null); setShowAdd(true) }}>+ เพิ่มใบสั่งซื้อ</button>}
        <div style={{ flex: 1 }} />
        <input type="date" className="input input-sm" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        <span style={{ color: 'var(--text3)' }}>—</span>
        <input type="date" className="input input-sm" value={dateTo} onChange={e => setDateTo(e.target.value)} />
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ minWidth: 200 }}>
          <SearchableSelect value={siteId} onChange={setSiteId} placeholder="ทุกไซท์งาน" options={siteOpts(sites)} />
        </div>
        <div style={{ minWidth: 190 }}>
          <SearchableSelect value={supplierId} onChange={setSupplierId} placeholder="ทุก Supplier" options={supplierOpts(suppliers)} />
        </div>
        <select className="select select-sm" value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">ทุกสถานะ</option>
          {PO_STATUSES.map(s => <option key={s} value={s}>{PO_STATUS_LABELS[s]}</option>)}
        </select>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>เลขที่</th><th>วันที่</th><th>ไซท์งาน</th><th>Supplier</th><th>รายการ</th><th>ยอดรวม</th><th>สถานะ</th><th></th>
              </tr>
            </thead>
            <tbody>
              {(pos || []).map(po => {
                const total = (po.purchase_order_items || []).reduce((s, it) => s + (it.line_total || 0), 0)
                return (
                  <tr key={po.id}>
                    <td className="font-mono" style={{ fontSize: 12 }}>{po.po_number}</td>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDate(po.date)}</td>
                    <td style={{ fontSize: 11, color: 'var(--accent)' }}>{po.sites?.name || '—'}</td>
                    <td style={{ fontSize: 12 }}>{po.suppliers?.name || '—'}</td>
                    <td style={{ fontSize: 11, color: 'var(--text3)' }}>{(po.purchase_order_items || []).length} รายการ</td>
                    <td className="font-mono" style={{ fontWeight: 700 }}>{fmt(total)}</td>
                    <td><span className={`badge badge-po-${po.status}`}>{PO_STATUS_LABELS[po.status] || po.status}</span></td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm btn-ghost" onClick={() => setDocRow(po)}>📄</button>
                      {canEdit && po.status === 'ordered' && (
                        <>
                          <button className="btn btn-sm btn-primary" onClick={() => setReceiveRow(po)}>✅ รับของแล้ว</button>
                          <button className="btn btn-sm btn-ghost" onClick={() => { setEditRow(po); setShowAdd(true) }}>✏️</button>
                          <button className="btn btn-sm btn-danger" onClick={() => setDeleteId(po.id)}>✕</button>
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
              {!(pos || []).length && (
                <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>ไม่พบใบสั่งซื้อในช่วงเวลานี้</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showAdd && (
        <Modal title={editRow ? 'แก้ไขใบสั่งซื้อ' : 'เพิ่มใบสั่งซื้อ'} onClose={() => { setShowAdd(false); setEditRow(null) }} maxWidth={700}>
          <PurchaseOrderForm
            initial={editFormInitial || EMPTY_FORM}
            sites={sites} categories={categories} suppliers={suppliers || []}
            onSave={handleSave} onCancel={() => { setShowAdd(false); setEditRow(null) }} loading={saving}
          />
        </Modal>
      )}

      {deleteId && (
        <ConfirmDialog title="ยกเลิกใบสั่งซื้อ" message="ยืนยันการยกเลิกใบสั่งซื้อนี้?" onConfirm={handleCancel} onCancel={() => setDeleteId(null)} danger />
      )}

      {docRow && <PODocumentModal po={docRow} onClose={() => setDocRow(null)} />}

      {receiveRow && (
        <ConfirmDialog
          title="ยืนยันรับของ"
          message={`สร้างรายจ่ายอัตโนมัติจากใบสั่งซื้อ ${receiveRow.po_number} ยอดรวม ${fmt((receiveRow.purchase_order_items || []).reduce((s, it) => s + (it.line_total || 0), 0))} บาท?`}
          onConfirm={handleReceive}
          onCancel={() => setReceiveRow(null)}
        />
      )}
    </div>
  )
}
