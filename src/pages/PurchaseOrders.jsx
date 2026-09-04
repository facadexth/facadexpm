// ============================================================
// PurchaseOrders — ใบสั่งซื้อ
// ✅ Itemized PO tied to site/supplier/category
// ✅ Auto-number PO-YYYY-NNN
// ✅ Status: ordered -> received (auto-creates expense) | cancelled
// ============================================================
import { useState, useMemo, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { usePurchaseOrders, useSites, useSuppliers, useCategories, useUnits, useInventoryItems, useInventoryItemUnitFactors, useStockBalances } from '../hooks/useSupabase.js'
import { computeWeightedAverageCost, convertToBaseUnit } from '../lib/inventoryCost.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import { useDraftForm } from '../hooks/useDraftForm.js'
import { useTenant } from '../hooks/useTenant.js'
import { fmt, fmtDate } from '../lib/supabase.js'
import { auditLog } from '../lib/audit.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import SearchableSelect from '../components/SearchableSelect.jsx'
import QuickAddSelect from '../components/QuickAddSelect.jsx'
import UnitSelect from '../components/UnitSelect.jsx'
import AttachmentsSection from '../components/AttachmentsSection.jsx'
import { format, startOfYear, endOfYear } from 'date-fns'
import { downloadPDF, downloadJPG } from '../lib/pdf.js'
import { TrashIcon, PencilIcon } from '../components/icons.jsx'

const siteOpts = (sites) => (sites || []).map(s => ({
  value: s.id, label: `${s.site_number} · ${s.name}`, keywords: `${s.site_number} ${s.name}`,
}))
const catOpts = (categories) => (categories || []).map(c => ({ value: c.id, label: c.name, keywords: c.name }))
const supplierOpts = (suppliers) => (suppliers || []).map(s => ({
  value: s.id, label: `${s.supplier_number} · ${s.name}`, keywords: `${s.supplier_number} ${s.name}`,
}))

const PO_STATUSES = ['ordered', 'received', 'cancelled']
const PO_STATUS_LABELS = { ordered: '📦 สั่งแล้ว', received: '✅ รับของแล้ว', cancelled: '✕ ยกเลิก' }

const EMPTY_ITEM = { description: '', quantity: '1', unit: '', unit_price: '', inventory_item_id: '' }
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

const inventoryItemOpts = (items) => (items || []).map(it => ({
  value: it.id, label: `${it.name} (${it.base_unit})`, keywords: it.name,
}))

function ItemsEditor({ items, onChange, inventoryItems, onInventoryItemCreated }) {
  const { data: units, refetch: refetchUnits } = useUnits()
  const set = (i, k, v) => onChange(items.map((it, idx) => idx === i ? { ...it, [k]: v } : it))
  const add = () => onChange([...items, { ...EMPTY_ITEM }])
  const remove = (i) => onChange(items.length > 1 ? items.filter((_, idx) => idx !== i) : items)
  const grandTotal = items.reduce((sum, it) => sum + lineTotal(it), 0)

  return (
    <div>
      <label className="label">รายการสินค้า ★</label>
      <div style={{ display: 'grid', gap: 8 }}>
        {items.map((it, i) => (
          <div key={i} style={{ display: 'grid', gap: 4 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 150px 100px 32px', gap: 6, alignItems: 'center' }}>
              <input className="input input-sm" placeholder="รายละเอียดสินค้า" required
                value={it.description} onChange={e => set(i, 'description', e.target.value)} />
              <input className="input input-sm" type="number" min="0" step="0.01" placeholder="จำนวน"
                value={it.quantity} onChange={e => set(i, 'quantity', e.target.value)} />
              <UnitSelect value={it.unit} onChange={v => set(i, 'unit', v)} units={units} onUnitAdded={refetchUnits} />
              <input className="input input-sm" type="number" min="0" step="0.01" placeholder="ราคา/หน่วย"
                value={it.unit_price} onChange={e => set(i, 'unit_price', e.target.value)} />
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => remove(i)} disabled={items.length === 1}>✕</button>
            </div>
            <div style={{ marginLeft: 4, fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: 'var(--text3)', flexShrink: 0 }}>📦 ผูกกับสต็อก:</span>
              <div style={{ flex: 1, maxWidth: 340 }}>
                <QuickAddSelect
                  value={it.inventory_item_id} onChange={v => set(i, 'inventory_item_id', v)}
                  placeholder="— ไม่ผูกกับสต็อก —" options={inventoryItemOpts(inventoryItems)}
                  table="inventory_items" namePlaceholder="ชื่อสินค้าคงคลังใหม่"
                  extraPayload={{ base_unit: it.unit || 'หน่วย' }}
                  onCreated={onInventoryItemCreated}
                  addLabel="+ สร้างใหม่"
                />
              </div>
            </div>
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

function PurchaseOrderForm({ initial = EMPTY_FORM, sites, suppliers, categories, onSave, onCancel, loading, onSiteCreated, onSupplierCreated, inventoryItems, onInventoryItemCreated }) {
  const isAdd = !initial?.id
  const [form, setForm, clearFormDraft] = useDraftForm('purchase-order-form', { ...EMPTY_FORM, ...initial }, isAdd)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  return (
    <form onSubmit={e => { e.preventDefault(); clearFormDraft(); onSave(form) }}>
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
        {/* Site/supplier names can run long (full project names, company names) —
            stacked full-width rows instead of side-by-side so the name has room
            to breathe, on both desktop and mobile. */}
        <div style={{ display: 'grid', gap: 12 }}>
          <div>
            <label className="label">ไซท์งาน ★</label>
            <QuickAddSelect required value={form.site_id} onChange={id => set('site_id', id)}
              placeholder="— เลือกไซท์ —" options={siteOpts(sites)}
              table="sites" namePlaceholder="ชื่อไซท์งานใหม่" onCreated={onSiteCreated} />
          </div>
          <div>
            <label className="label">Supplier ★</label>
            <QuickAddSelect required value={form.supplier_id} onChange={id => set('supplier_id', id)}
              placeholder="— เลือก Supplier —" options={supplierOpts(suppliers)}
              table="suppliers" namePlaceholder="ชื่อ Supplier ใหม่" onCreated={onSupplierCreated} />
          </div>
        </div>
        <ItemsEditor items={form.items} onChange={items => set('items', items)} inventoryItems={inventoryItems} onInventoryItemCreated={onInventoryItemCreated} />
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
            <AttachmentsSection table="purchase_order_attachments" bucket="po-attachments" foreignKey="po_id" entityId={po.id} tenantId={tenantId} />
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
      </div>
    </Modal>
  )
}

// Same letterhead pattern as QuotationDocumentModal (src/pages/Quotations.jsx)
// — logo/company block, bordered doc-info box + ต้นฉบับ tag, light-purple
// table header, boxed notes, purple-accented (unfilled) grand total.
function PODocumentModal({ po, tenant, onClose }) {
  const items = po.purchase_order_items || []
  const { subtotal, vat, total } = calcPoTotals(items, po.has_vat, po.price_includes_vat)

  return (
    <Modal title={`ใบสั่งซื้อ ${po.po_number}`} onClose={onClose} maxWidth={720}>
      <div className="modal-body">
        <div id={`po-doc-${po.id}`} style={{ fontFamily: 'Sarabun,sans-serif', padding: '40px 44px', background: '#fff', color: '#17181f' }}>
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
              <div style={{ fontSize: 22, fontWeight: 800 }}>ใบสั่งซื้อ</div>
            </div>
          </div>

          <div style={{ marginTop: 20, border: '1px solid #e4e6ef', borderRadius: 8, padding: '14px 16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 24px', fontSize: 12 }}>
            <div><span style={{ color: '#6a6f85' }}>เลขที่เอกสาร</span><br />{po.po_number}</div>
            <div><span style={{ color: '#6a6f85' }}>วันที่สั่งซื้อ</span><br />{new Date(po.date).toLocaleDateString('th-TH')}</div>
            <div><span style={{ color: '#6a6f85' }}>ไซท์งาน</span><br />{po.sites?.name} ({po.sites?.site_number})</div>
            <div><span style={{ color: '#6a6f85' }}>Supplier</span><br />{po.suppliers?.name}</div>
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
              {items.map(it => (
                <tr key={it.id}>
                  <td style={{ padding: '9px 8px', borderBottom: '1px solid #eee' }}>{it.description}</td>
                  <td style={{ textAlign: 'right', padding: '9px 8px', borderBottom: '1px solid #eee' }}>{it.quantity} {it.unit || ''}</td>
                  <td style={{ textAlign: 'right', padding: '9px 8px', borderBottom: '1px solid #eee' }}>{fmt(it.unit_price)}</td>
                  <td style={{ textAlign: 'right', padding: '9px 8px', borderBottom: '1px solid #eee' }}>{fmt(it.line_total)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
            <table style={{ width: 260, fontSize: 12.5 }}>
              <tbody>
                <tr><td style={{ padding: '5px 4px', color: '#6a6f85' }}>รวมก่อน VAT</td><td style={{ textAlign: 'right', padding: '5px 4px' }}>{fmt(subtotal)}</td></tr>
                {po.has_vat && (
                  <tr><td style={{ padding: '5px 4px', color: '#6a6f85' }}>VAT (7%)</td><td style={{ textAlign: 'right', padding: '5px 4px' }}>{fmt(vat)}</td></tr>
                )}
                <tr>
                  <td style={{ padding: '10px 4px 4px', fontWeight: 800, fontSize: 15, color: '#6c63ff', borderTop: '2px solid #6c63ff' }}>รวมทั้งสิ้น</td>
                  <td style={{ textAlign: 'right', padding: '10px 4px 4px', fontWeight: 800, fontSize: 15, color: '#6c63ff', borderTop: '2px solid #6c63ff' }}>{fmt(total)} บาท</td>
                </tr>
              </tbody>
            </table>
          </div>

          {po.notes && (
            <div style={{ marginTop: 20, fontSize: 11.5, background: '#f9f9fc', borderRadius: 8, padding: '12px 16px', lineHeight: 1.8 }}>
              <strong style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>หมายเหตุ</strong>
              <div style={{ whiteSpace: 'pre-line' }}>{po.notes}</div>
            </div>
          )}

          <div style={{ marginTop: 44, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, textAlign: 'center', fontSize: 11.5 }}>
            <div style={{ borderTop: '1px solid #999', paddingTop: 8 }}>ผู้จัดทำ</div>
            <div style={{ borderTop: '1px solid #999', paddingTop: 8 }}>ผู้อนุมัติ</div>
          </div>
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
        <button className="btn btn-ghost" onClick={() => downloadJPG(`po-doc-${po.id}`, `${po.po_number}.jpg`)}>🖼️ ดาวน์โหลด JPG</button>
        <button className="btn btn-primary" onClick={() => downloadPDF(`po-doc-${po.id}`, `${po.po_number}.pdf`)}>📄 ดาวน์โหลด PDF</button>
      </div>
    </Modal>
  )
}

export default function PurchaseOrders({ navigateTo, navState, openSiteOverview }) {
  const { isAtLeast, role } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'purchase_orders')
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
  const { data: sites, refetch: refetchSites }      = useSites()
  const { data: categories } = useCategories()
  const { data: suppliers, refetch: refetchSuppliers }  = useSuppliers()
  const { data: inventoryItems, refetch: refetchInventoryItems } = useInventoryItems()
  const { data: unitFactors } = useInventoryItemUnitFactors()
  const { data: stockBalances } = useStockBalances()

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3000) }

  // Arrived via "จาก PO" click from Expenses — the PO might be outside the
  // default YTD range, so drop the date filter entirely to make sure it's
  // findable, then open its detail once the (now wider) list has loaded.
  useEffect(() => {
    if (navState?.poId) { setDateFrom(''); setDateTo('') }
  }, [navState?.poId])

  useEffect(() => {
    if (navState?.poId && pos) {
      const match = pos.find(p => p.id === navState.poId)
      if (match) setDetailRow(match)
    }
  }, [navState?.poId, pos])

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
          inventory_item_id: it.inventory_item_id || null,
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

  const receiveStockPlan = (po) => {
    if (!po) return []
    return (po.purchase_order_items || [])
      .filter(it => it.inventory_item_id)
      .map(it => {
        const invItem = (inventoryItems || []).find(i => i.id === it.inventory_item_id)
        const factor = (unitFactors || []).find(f => f.inventory_item_id === it.inventory_item_id && f.unit_name === it.unit)
        const baseQty = factor ? convertToBaseUnit(it.quantity, factor.factor_to_base) : it.quantity
        let unitCostPerBase = baseQty > 0 ? (it.quantity * it.unit_price) / baseQty : it.unit_price
        // The expense is posted ex-VAT (calcPoTotals backs VAT out of a
        // VAT-inclusive price via subtotal = total / 1.07). Stock must be
        // capitalized at the same ex-VAT cost, or every VAT-inclusive PO
        // overvalues inventory by ~7% and folds recoverable input VAT into
        // COGS (final-review Fix 3).
        if (po.has_vat && po.price_includes_vat) {
          unitCostPerBase = unitCostPerBase / (1 + VAT_RATE)
        }
        return { inventoryItemId: it.inventory_item_id, name: invItem?.name || it.description, baseUnit: invItem?.base_unit || it.unit, baseQty, unitCostPerBase }
      })
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

      for (const plan of receiveStockPlan(receiveRow)) {
        const { error: moveErr } = await supabase.rpc('record_stock_movement', {
          p_inventory_item_id: plan.inventoryItemId, p_site_id: receiveRow.site_id, p_movement_type: 'purchase_in',
          p_quantity: plan.baseQty, p_unit_cost: plan.unitCostPerBase,
          p_reference_type: 'purchase_order', p_reference_id: receiveRow.id, p_notes: null,
        })
        if (moveErr) throw moveErr
      }
      refetchInventoryItems()

      setReceiveRow(null); refetch(); showToast('รับของแล้ว สร้างรายจ่ายอัตโนมัติ')
    } catch (e) {
      // Close the dialog so a stray click can't re-run this whole function
      // (same stale closure/ConfirmDialog) and re-post a second expense +
      // duplicate stock movements for whatever already succeeded before the
      // failure (final-review Fix 2). The expense insert and PO status
      // update run BEFORE the stock-posting loop, so by the time any error
      // reaches here those two may already be committed — tell the admin to
      // check the actual ledger rather than inviting a blind retry.
      setReceiveRow(null)
      alert(
        'Error: ' + e.message +
        ' — รายจ่ายและสถานะใบสั่งซื้ออาจถูกบันทึกไปแล้วก่อนเกิดข้อผิดพลาดนี้ ' +
        'กรุณาตรวจสอบหน้ารายจ่าย และตรวจสอบประวัติการเคลื่อนไหวสต็อกที่หน้าคลังสินค้า (คลังสินค้า → ประวัติการเคลื่อนไหว) ' +
        'ว่ามีการบันทึกเข้าสต็อกไปแล้วเท่าใด ก่อนแก้ไขข้อมูลด้วยตนเอง — อย่ากดรับของซ้ำโดยไม่ตรวจสอบก่อน'
      )
    } finally {
      setReceiving(false)
    }
  }

  const editFormInitial = useMemo(() => {
    if (!editRow) return null
    return {
      id: editRow.id,
      site_id: editRow.site_id, supplier_id: editRow.supplier_id, category_id: editRow.category_id,
      date: editRow.date, has_vat: editRow.has_vat, price_includes_vat: editRow.price_includes_vat || false, notes: editRow.notes || '',
      items: (editRow.purchase_order_items?.length ? editRow.purchase_order_items : [{ ...EMPTY_ITEM }])
        .map(it => ({ description: it.description, quantity: String(it.quantity), unit: it.unit || '', unit_price: String(it.unit_price), inventory_item_id: it.inventory_item_id || '' })),
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
                    <td style={{ fontSize: 11, color: 'var(--accent)', cursor: po.site_id ? 'pointer' : 'default' }}
                      onClick={() => po.site_id && openSiteOverview(po.site_id)}>{po.sites?.name || '—'}</td>
                    <td style={{ fontSize: 12 }}>{po.suppliers?.name || '—'}</td>
                    <td style={{ fontSize: 11, color: 'var(--text3)' }}>{(po.purchase_order_items || []).length} รายการ</td>
                    <td className="font-mono" style={{ fontWeight: 700 }}>{fmt(total)}</td>
                    <td><span className={`badge badge-po-${po.status}`}>{PO_STATUS_LABELS[po.status] || po.status}</span></td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <div className="actions-cell">
                        <button className="btn btn-sm btn-ghost" onClick={() => setDetailRow(po)}>👁️</button>
                        <button className="btn btn-sm btn-ghost" onClick={() => setDocRow(po)}>📄</button>
                        {canEdit && po.status === 'ordered' && (
                          <>
                            <button className="btn btn-sm btn-primary" onClick={() => setReceiveRow(po)}>✅ รับของแล้ว</button>
                            <button className="btn btn-sm btn-edit" onClick={() => { setEditRow(po); setShowAdd(true) }}><PencilIcon /></button>
                            <button className="btn btn-sm btn-danger" onClick={() => setDeleteId(po.id)}><TrashIcon /></button>
                          </>
                        )}
                      </div>
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
            onSiteCreated={refetchSites} onSupplierCreated={refetchSuppliers}
            inventoryItems={inventoryItems} onInventoryItemCreated={refetchInventoryItems}
          />
          {editRow && tenant?.id && (
            <div className="modal-body" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <AttachmentsSection table="purchase_order_attachments" bucket="po-attachments" foreignKey="po_id" entityId={editRow.id} tenantId={tenant.id} />
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

      {docRow && <PODocumentModal po={docRow} tenant={tenant} onClose={() => setDocRow(null)} />}

      {detailRow && <PODetailModal po={detailRow} tenantId={tenant?.id} onClose={() => setDetailRow(null)} />}

      {receiveRow && (
        <ConfirmDialog
          title="ยืนยันรับของ"
          message={
            <div>
              <div>สร้างรายจ่ายอัตโนมัติจากใบสั่งซื้อ {receiveRow.po_number} ยอดรวม {fmt(calcPoTotals(receiveRow.purchase_order_items, receiveRow.has_vat, receiveRow.price_includes_vat).total)} บาท?</div>
              {receiveStockPlan(receiveRow).length > 0 && (
                <div style={{ marginTop: 10, fontSize: 12, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  <strong>จะบันทึกเข้าสต็อก:</strong>
                  {receiveStockPlan(receiveRow).map((plan, i) => {
                    const bal = (stockBalances || []).find(b => b.inventory_item_id === plan.inventoryItemId && b.site_id === receiveRow.site_id)
                    const oldQty = bal?.quantity_on_hand || 0
                    const oldWac = bal?.weighted_average_cost || 0
                    const newQty = oldQty + plan.baseQty
                    const newWac = computeWeightedAverageCost(oldQty, oldWac, plan.baseQty, plan.unitCostPerBase)
                    return (
                      <div key={i} style={{ marginTop: 4 }}>
                        📦 {plan.name}: +{fmt(plan.baseQty)} {plan.baseUnit} → คงเหลือ {fmt(newQty)} {plan.baseUnit} @ เฉลี่ย {fmt(newWac)}/{plan.baseUnit}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          }
          onConfirm={handleReceive}
          onCancel={() => setReceiveRow(null)}
        />
      )}
    </div>
  )
}
