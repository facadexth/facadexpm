// ============================================================
// PurchaseOrders — ใบสั่งซื้อ
// ✅ Itemized PO tied to site/supplier/category
// ✅ Auto-number PO-YYYY-NNN
// ✅ Status: ordered -> received (auto-creates expense) | cancelled
// ============================================================
import { useState, useMemo, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { usePurchaseOrders, useSites, useSuppliers, useCategories } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { useTenant } from '../hooks/useTenant.js'
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
const EMPTY_FORM = { site_id: '', supplier_id: '', category_id: '', date: '', has_vat: true, price_includes_vat: false, notes: '', items: [{ ...EMPTY_ITEM }] }

function lineTotal(item) {
  return (parseFloat(item.quantity) || 0) * (parseFloat(item.unit_price) || 0)
}

const VAT_RATE = 0.07

/**
 * priceIncludesVat: some suppliers quote a unit price that already
 * includes VAT. When true, the entered line-item prices ARE the grand
 * total — subtotal/VAT are backed out of it (subtotal = total / 1.07)
 * instead of VAT being added on top of the raw item sum.
 */
function calcPoTotals(items, hasVat, priceIncludesVat) {
  const rawTotal = (items || []).reduce((s, it) => s + (it.line_total != null ? it.line_total : lineTotal(it)), 0)
  if (!hasVat) return { subtotal: rawTotal, vat: 0, total: rawTotal }
  if (priceIncludesVat) {
    const total = Math.round(rawTotal * 100) / 100
    const subtotal = Math.round((total / (1 + VAT_RATE)) * 100) / 100
    const vat = Math.round((total - subtotal) * 100) / 100
    return { subtotal, vat, total }
  }
  const subtotal = rawTotal
  const vat = Math.round(subtotal * VAT_RATE * 100) / 100
  const total = Math.round((subtotal + vat) * 100) / 100
  return { subtotal, vat, total }
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
          <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
              <input type="radio" name="po-has-vat" checked={form.has_vat === true} onChange={() => set('has_vat', true)} />
              รวม VAT
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
              <input type="radio" name="po-has-vat" checked={form.has_vat === false} onChange={() => set('has_vat', false)} />
              ไม่มี VAT
            </label>
          </div>
          {form.has_vat && (
            <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                <input type="radio" name="po-price-includes-vat" checked={form.price_includes_vat === false} onChange={() => set('price_includes_vat', false)} />
                ราคา/หน่วยยังไม่รวม VAT
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                <input type="radio" name="po-price-includes-vat" checked={form.price_includes_vat === true} onChange={() => set('price_includes_vat', true)} />
                ราคา/หน่วยรวม VAT แล้ว
              </label>
            </div>
          )}
          {(() => {
            const { subtotal, vat, total } = calcPoTotals(form.items, form.has_vat, form.price_includes_vat)
            return (
              <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: 8, padding: '10px 14px', fontSize: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>รวมก่อน VAT</span><span className="font-mono">{fmt(subtotal)}</span></div>
                {form.has_vat && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>VAT (7%)</span><span className="font-mono">{fmt(vat)}</span></div>}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4 }}><span>รวมสุทธิ</span><span className="font-mono" style={{ color: 'var(--accent)' }}>{fmt(total)}</span></div>
              </div>
            )
          })()}
        </div>
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

function PODetailModal({ po, tenantId, onClose }) {
  const items = po.purchase_order_items || []
  const { subtotal, vat, total } = calcPoTotals(items, po.has_vat, po.price_includes_vat)

  return (
    <Modal title={`ใบสั่งซื้อ ${po.po_number}`} onClose={onClose} maxWidth={700}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className={`badge badge-po-${po.status}`}>{PO_STATUS_LABELS[po.status] || po.status}</span>
          <span style={{ fontSize: 12, color: 'var(--text3)' }}>{fmtDate(po.date)}</span>
        </div>
        <div className="form-grid-2" style={{ fontSize: 13 }}>
          <div><strong>ไซท์งาน:</strong> {po.sites?.name || '—'}</div>
          <div><strong>Supplier:</strong> {po.suppliers?.name || '—'}</div>
        </div>
        {po.notes && <div style={{ fontSize: 13 }}><strong>หมายเหตุ:</strong> {po.notes}</div>}
        <div>
          <label className="label">รายการสินค้า</label>
          <div style={{ display: 'grid', gap: 6 }}>
            {items.map(it => (
              <div key={it.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, borderBottom: '1px solid var(--border)', paddingBottom: 4 }}>
                <span>{it.description} ({it.quantity} {it.unit || ''})</span>
                <span className="font-mono">{fmt(it.line_total)}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 8, textAlign: 'right', fontSize: 13 }}>
            <div>รวมก่อน VAT: <span className="font-mono">{fmt(subtotal)}</span></div>
            {po.has_vat && <div>VAT (7%): <span className="font-mono">{fmt(vat)}</span></div>}
            <div style={{ fontWeight: 700 }}>รวมสุทธิ: <span className="font-mono" style={{ color: 'var(--accent)' }}>{fmt(total)}</span></div>
          </div>
        </div>
        {tenantId && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <AttachmentsSection poId={po.id} tenantId={tenantId} />
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
      </div>
    </Modal>
  )
}

function PODocumentModal({ po, onClose }) {
  const items = po.purchase_order_items || []
  const { subtotal, vat, total } = calcPoTotals(items, po.has_vat, po.price_includes_vat)

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
              <tr>
                <td colSpan={3} style={{ padding: '6px 4px', borderTop: '2px solid #111' }}>รวมก่อน VAT</td>
                <td style={{ textAlign: 'right', padding: '6px 4px', borderTop: '2px solid #111' }}>{fmt(subtotal)}</td>
              </tr>
              {po.has_vat && (
                <tr>
                  <td colSpan={3} style={{ padding: '6px 4px' }}>VAT (7%)</td>
                  <td style={{ textAlign: 'right', padding: '6px 4px' }}>{fmt(vat)}</td>
                </tr>
              )}
              <tr style={{ fontWeight: 700, fontSize: 15 }}>
                <td colSpan={3} style={{ padding: '8px 4px', borderTop: '1px solid #111' }}>รวมทั้งสิ้น</td>
                <td style={{ textAlign: 'right', padding: '8px 4px', borderTop: '1px solid #111' }}>{fmt(total)} บาท</td>
              </tr>
            </tfoot>
          </table>
          <div style={{ marginTop: 24, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, textAlign: 'center', fontSize: 12 }}>
            <div style={{ borderTop: '1px solid #999', paddingTop: 6 }}>ลายเซ็นผู้จัดทำ</div>
            <div style={{ borderTop: '1px solid #999', paddingTop: 6 }}>ลายเซ็นผู้อนุมัติ</div>
          </div>
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
        <button className="btn btn-primary" onClick={() => downloadPDF(`po-doc-${po.id}`, `${po.po_number}.pdf`)}>📄 ดาวน์โหลด PDF</button>
      </div>
    </Modal>
  )
}

function AttachmentsSection({ poId, tenantId }) {
  const [attachments, setAttachments] = useState([])
  const [uploading, setUploading] = useState(false)

  const load = async () => {
    const { data } = await supabase.from('purchase_order_attachments').select('*').eq('po_id', poId).order('uploaded_at')
    setAttachments(data || [])
  }
  useEffect(() => { load() }, [poId])

  const handleUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const filePath = `${tenantId}/${poId}/${Date.now()}-${file.name}`
      const { error: upErr } = await supabase.storage.from('po-attachments').upload(filePath, file)
      if (upErr) throw upErr
      const { error: dbErr } = await supabase.from('purchase_order_attachments').insert({ po_id: poId, file_path: filePath, file_name: file.name })
      if (dbErr) {
        // Uploaded file has no DB row yet — remove it so it doesn't become
        // an orphan invisible to this UI (no other path can find/delete it).
        await supabase.storage.from('po-attachments').remove([filePath])
        throw dbErr
      }
      await load()
    } catch (err) {
      alert('Error: ' + err.message)
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  const handleDownload = async (att) => {
    const { data, error } = await supabase.storage.from('po-attachments').createSignedUrl(att.file_path, 60)
    if (error) { alert('Error: ' + error.message); return }
    window.open(data.signedUrl, '_blank')
  }

  const handleRemove = async (att) => {
    try {
      const { error: rmErr } = await supabase.storage.from('po-attachments').remove([att.file_path])
      if (rmErr) throw rmErr
      const { error: dbErr } = await supabase.from('purchase_order_attachments').delete().eq('id', att.id)
      if (dbErr) throw dbErr
      await load()
    } catch (err) {
      alert('Error: ' + err.message)
    }
  }

  return (
    <div>
      <label className="label">ไฟล์แนบ</label>
      <div style={{ display: 'grid', gap: 6, marginBottom: 8 }}>
        {attachments.map(att => (
          <div key={att.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => handleDownload(att)}>📎 {att.file_name}</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => handleRemove(att)}>✕</button>
          </div>
        ))}
      </div>
      <input type="file" onChange={handleUpload} disabled={uploading} accept=".pdf,.xlsx,.xls,.jpg,.jpeg,.png" />
    </div>
  )
}

export default function PurchaseOrders({ navigateTo, navState }) {
  const { isAtLeast } = useUserRole()
  const canEdit = isAtLeast('ADMIN')
  const { tenant } = useTenant()
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
  const [detailRow, setDetailRow] = useState(null)
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
        date: form.date, has_vat: form.has_vat,
        price_includes_vat: form.has_vat ? form.price_includes_vat : false,
        notes: form.notes || null,
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
    const { subtotal, vat, total } = calcPoTotals(receiveRow.purchase_order_items, receiveRow.has_vat, receiveRow.price_includes_vat)
    try {
      const expensePayload = {
        date: new Date().toISOString().slice(0, 10),
        description: `จากใบสั่งซื้อ ${receiveRow.po_number}`,
        site_id: receiveRow.site_id,
        category_id: receiveRow.category_id,
        supplier_id: receiveRow.supplier_id,
        supplier: receiveRow.suppliers?.name || null,
        amount_no_vat: subtotal,
        vat: vat,
        amount: total,
        payment_method: receiveRow.suppliers?.credit_days != null ? 'check' : 'transfer',
        status: receiveRow.suppliers?.credit_days != null ? 'awaiting_billing' : 'pending',
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
      date: editRow.date, has_vat: editRow.has_vat, price_includes_vat: editRow.price_includes_vat || false, notes: editRow.notes || '',
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
        <input type="date" className="input input-sm" style={{ width: 140 }} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        <span style={{ color: 'var(--text3)' }}>—</span>
        <input type="date" className="input input-sm" style={{ width: 140 }} value={dateTo} onChange={e => setDateTo(e.target.value)} />
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ minWidth: 200 }}>
          <SearchableSelect value={siteId} onChange={setSiteId} placeholder="ทุกไซท์งาน" options={siteOpts(sites)} />
        </div>
        <div style={{ minWidth: 190 }}>
          <SearchableSelect value={supplierId} onChange={setSupplierId} placeholder="ทุก Supplier" options={supplierOpts(suppliers)} />
        </div>
        <select className="select select-sm" style={{ width: 190 }} value={status} onChange={e => setStatus(e.target.value)}>
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
                const { total } = calcPoTotals(po.purchase_order_items, po.has_vat, po.price_includes_vat)
                return (
                  <tr key={po.id}>
                    <td className="font-mono" style={{ fontSize: 12 }}>
                      {po.po_number}
                      {po.purchase_order_attachments?.length > 0 && <span title="มีไฟล์แนบ" style={{ marginLeft: 4 }}>📎</span>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDate(po.date)}</td>
                    <td style={{ fontSize: 11, color: 'var(--accent)' }}>{po.sites?.name || '—'}</td>
                    <td style={{ fontSize: 12 }}>{po.suppliers?.name || '—'}</td>
                    <td style={{ fontSize: 11, color: 'var(--text3)' }}>{(po.purchase_order_items || []).length} รายการ</td>
                    <td className="font-mono" style={{ fontWeight: 700 }}>{fmt(total)}</td>
                    <td><span className={`badge badge-po-${po.status}`}>{PO_STATUS_LABELS[po.status] || po.status}</span></td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm btn-ghost" onClick={() => setDetailRow(po)}>👁️</button>
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
          {editRow && tenant?.id && (
            <div className="modal-body" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <AttachmentsSection poId={editRow.id} tenantId={tenant.id} />
            </div>
          )}
          {!editRow && (
            <div className="modal-body" style={{ fontSize: 12, color: 'var(--text3)', borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              บันทึกใบสั่งซื้อก่อน จึงจะแนบไฟล์ได้
            </div>
          )}
        </Modal>
      )}

      {deleteId && (
        <ConfirmDialog title="ยกเลิกใบสั่งซื้อ" message="ยืนยันการยกเลิกใบสั่งซื้อนี้?" onConfirm={handleCancel} onCancel={() => setDeleteId(null)} danger />
      )}

      {docRow && <PODocumentModal po={docRow} onClose={() => setDocRow(null)} />}

      {detailRow && <PODetailModal po={detailRow} tenantId={tenant?.id} onClose={() => setDetailRow(null)} />}

      {receiveRow && (
        <ConfirmDialog
          title="ยืนยันรับของ"
          message={`สร้างรายจ่ายอัตโนมัติจากใบสั่งซื้อ ${receiveRow.po_number} ยอดรวม ${fmt(calcPoTotals(receiveRow.purchase_order_items, receiveRow.has_vat, receiveRow.price_includes_vat).total)} บาท?`}
          onConfirm={handleReceive}
          onCancel={() => setReceiveRow(null)}
        />
      )}
    </div>
  )
}
