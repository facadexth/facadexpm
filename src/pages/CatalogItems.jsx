// src/pages/CatalogItems.jsx
// ============================================================
// CatalogItems — รายการสินค้า (sell-side price list for Quotations)
// ✅ Add/Edit/Delete CRUD, same shape as Suppliers.jsx
// ✅ "active" toggle instead of hard delete when an item has been used
//    on a past quotation (delete still offered; quotation_items.catalog_item_id
//    is ON DELETE SET NULL, so deleting never breaks a past document)
// ============================================================
import { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { useCatalogItems } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import { fmt } from '../lib/supabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import { useDraftForm } from '../hooks/useDraftForm.js'

const EMPTY_FORM = { name: '', unit: '', default_unit_price: '', active: true }

function CatalogItemForm({ initial = EMPTY_FORM, onSave, onCancel, loading }) {
  const isAdd = !initial?.id
  const [form, setForm, clearDraft] = useDraftForm('catalog-item-form', { ...EMPTY_FORM, ...initial }, isAdd)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  return (
    <form onSubmit={e => { e.preventDefault(); clearDraft(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div>
          <label className="label">ชื่อสินค้า/บริการ ★</label>
          <input className="input" required value={form.name} onChange={e => set('name', e.target.value)} placeholder="เช่น ประตูหน้าต่าง (ชุด)" />
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label">หน่วย</label>
            <input className="input" value={form.unit} onChange={e => set('unit', e.target.value)} placeholder="เช่น ชุด, ตร.ม., เมตร" />
          </div>
          <div>
            <label className="label">ราคา/หน่วย (ค่าเริ่มต้น)</label>
            <input type="number" min="0" step="0.01" className="input" value={form.default_unit_price} onChange={e => set('default_unit_price', e.target.value)} />
          </div>
        </div>
        {!isAdd && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
            <input type="checkbox" checked={form.active} onChange={e => set('active', e.target.checked)} />
            ใช้งานอยู่ (ปิดไว้เพื่อไม่ให้ขึ้นในรายการเลือกของใบเสนอราคาใหม่ โดยไม่กระทบใบเสนอราคาเดิมที่เคยใช้)
          </label>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={() => { clearDraft(); onCancel() }}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}
        </button>
      </div>
    </form>
  )
}

export default function CatalogItems() {
  const { isAtLeast, role } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'catalog_items')
  const { data: items, refetch } = useCatalogItems()
  const [showForm, setShowForm] = useState(false)
  const [editItem, setEditItem] = useState(null)
  const [deleteId, setDeleteId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')

  const filtered = useMemo(() =>
    (items || []).filter(it => !search || it.name.toLowerCase().includes(search.toLowerCase()))
  , [items, search])

  const handleSave = async (form) => {
    setSaving(true)
    try {
      const payload = {
        name: form.name,
        unit: form.unit || null,
        default_unit_price: parseFloat(form.default_unit_price) || 0,
        active: form.active !== false,
      }
      if (editItem) {
        const { error } = await supabase.from('catalog_items').update(payload).eq('id', editItem.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('catalog_items').insert(payload)
        if (error) throw error
      }
      setShowForm(false); setEditItem(null); refetch()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setSaving(false) }
  }

  const handleDelete = async () => {
    if (!deleteId) return
    const { error } = await supabase.from('catalog_items').delete().eq('id', deleteId)
    if (!error) { setDeleteId(null); refetch() }
    else alert('Error: ' + error.message)
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        {canEdit && <button className="btn btn-primary" onClick={() => { setEditItem(null); setShowForm(true) }}>+ เพิ่มรายการสินค้า</button>}
        <input className="input input-sm" style={{ width: 200 }}
          placeholder="ค้นหาชื่อสินค้า..."
          value={search} onChange={e => setSearch(e.target.value)} />
        <span style={{ color: 'var(--text3)', fontSize: 13 }}>{filtered.length} รายการ</span>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ชื่อสินค้า/บริการ</th>
                <th>หน่วย</th>
                <th>ราคา/หน่วย</th>
                <th>สถานะ</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(it => (
                <tr key={it.id} style={it.active ? undefined : { opacity: 0.5 }}>
                  <td style={{ fontWeight: 600 }}>{it.name}</td>
                  <td style={{ fontSize: 12 }}>{it.unit || '—'}</td>
                  <td className="font-mono">{fmt(it.default_unit_price)}</td>
                  <td>{it.active ? <span className="badge badge-paid">ใช้งานอยู่</span> : <span className="badge badge-finished">ปิดใช้งาน</span>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {canEdit && (
                      <>
                        <button className="btn btn-sm btn-ghost" onClick={() => { setEditItem(it); setShowForm(true) }}>แก้ไข</button>
                        <button className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => setDeleteId(it.id)}>ลบ</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {!filtered.length && (
                <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีรายการสินค้า</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showForm && (
        <Modal title={editItem ? `แก้ไข ${editItem.name}` : 'เพิ่มรายการสินค้าใหม่'} onClose={() => { setShowForm(false); setEditItem(null) }} maxWidth={520}>
          <CatalogItemForm initial={editItem || EMPTY_FORM} onSave={handleSave} onCancel={() => { setShowForm(false); setEditItem(null) }} loading={saving} />
        </Modal>
      )}

      {deleteId && (
        <ConfirmDialog
          title="ลบรายการสินค้า"
          message="ยืนยันการลบรายการสินค้านี้? (ใบเสนอราคาเดิมที่เคยใช้จะไม่ถูกกระทบ)"
          onConfirm={handleDelete}
          onCancel={() => setDeleteId(null)}
        />
      )}
    </div>
  )
}
