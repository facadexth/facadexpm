// src/pages/Inventory.jsx
// ============================================================
// Inventory — Phase 1: item definitions + unit factors, stock
// balances (valuation report), stock movement ledger (stock card).
// Admin/owner-only, gated on has_module_access('purchase_orders')
// (see the inventory Phase 1 plan's Ruling A for why this rides on
// the PO module instead of a new module key).
// ============================================================
import { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { useAllInventoryItems, useInventoryItemUnitFactors, useStockBalances, useStockMovements } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import { fmt } from '../lib/supabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import { useDraftForm } from '../hooks/useDraftForm.js'
import SearchableSelect from '../components/SearchableSelect.jsx'

const EMPTY_ITEM_FORM = { name: '', base_unit: '', active: true }
const EMPTY_FACTOR_FORM = { unit_name: '', factor_to_base: '1' }

const MOVEMENT_TYPE_LABELS = {
  purchase_in: '📥 รับเข้าจากใบสั่งซื้อ',
  transfer_in: '↩️ โอนเข้า',
  transfer_out: '↪️ โอนออก',
  sale_out: '📤 ขายออก',
  sale_reversal: '↩️ ยกเลิกการขาย',
  adjustment: '✏️ ปรับปรุงยอด',
}

function ItemForm({ initial = EMPTY_ITEM_FORM, onSave, onCancel, loading }) {
  const isAdd = !initial?.id
  const [form, setForm, clearDraft] = useDraftForm('inventory-item-form', { ...EMPTY_ITEM_FORM, ...initial }, isAdd)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  return (
    <form onSubmit={e => { e.preventDefault(); clearDraft(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div>
          <label className="label">ชื่อสินค้าคงคลัง ★</label>
          <input className="input" required value={form.name} onChange={e => set('name', e.target.value)} placeholder="เช่น อลูมิเนียมโปรไฟล์ 6063" />
        </div>
        <div>
          <label className="label">หน่วยหลัก (base unit) ★</label>
          <input className="input" required value={form.base_unit} onChange={e => set('base_unit', e.target.value)} placeholder="เช่น kg, ตร.ม." />
        </div>
        {!isAdd && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
            <input type="checkbox" checked={form.active} onChange={e => set('active', e.target.checked)} />
            ใช้งานอยู่ (ปิดไว้เพื่อไม่ให้ขึ้นในตัวเลือกผูกกับสต็อกของใบสั่งซื้อใหม่)
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

function UnitFactorsPanel({ item, factors, onChanged }) {
  const [form, setForm] = useState(EMPTY_FACTOR_FORM)
  const [saving, setSaving] = useState(false)
  const itemFactors = factors.filter(f => f.inventory_item_id === item.id)

  const add = async (e) => {
    e.preventDefault()
    if (!form.unit_name.trim() || !form.factor_to_base) return
    setSaving(true)
    try {
      const { error } = await supabase.from('inventory_item_unit_factors').insert({
        inventory_item_id: item.id, unit_name: form.unit_name.trim(), factor_to_base: parseFloat(form.factor_to_base),
      })
      if (error) throw error
      setForm(EMPTY_FACTOR_FORM); onChanged()
    } catch (e2) { alert('Error: ' + e2.message) }
    finally { setSaving(false) }
  }

  const remove = async (id) => {
    const { error } = await supabase.from('inventory_item_unit_factors').delete().eq('id', id)
    if (!error) onChanged(); else alert('Error: ' + error.message)
  }

  return (
    <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <label className="label">หน่วยแปลง (เทียบเป็น {item.base_unit})</label>
      <div style={{ display: 'grid', gap: 6, marginBottom: 8 }}>
        {itemFactors.map(f => (
          <div key={f.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
            <span>1 {f.unit_name} = {f.factor_to_base} {item.base_unit}</span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => remove(f.id)}>✕</button>
          </div>
        ))}
        {!itemFactors.length && <div style={{ fontSize: 12, color: 'var(--text3)' }}>ยังไม่มีหน่วยแปลง — ใช้ {item.base_unit} ตรงๆ ในใบสั่งซื้อ</div>}
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input className="input input-sm" style={{ flex: 1 }} placeholder="ชื่อหน่วย เช่น piece" value={form.unit_name} onChange={e => setForm(f => ({ ...f, unit_name: e.target.value }))} />
        <span style={{ fontSize: 12, color: 'var(--text3)' }}>=</span>
        <input className="input input-sm" style={{ width: 90 }} type="number" step="0.0001" min="0" placeholder="อัตรา" value={form.factor_to_base} onChange={e => setForm(f => ({ ...f, factor_to_base: e.target.value }))} />
        <span style={{ fontSize: 12, color: 'var(--text3)' }}>{item.base_unit}</span>
        <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={add}>+ เพิ่ม</button>
      </div>
    </div>
  )
}

export default function Inventory() {
  const { isAtLeast, role } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'inventory')
  const [view, setView] = useState('items')

  // Unfiltered (active + inactive) -- this is the item-management view's own
  // list, so deactivating an item must not strand it with no UI path to see,
  // edit, or reactivate it (final-review Fix 5). PurchaseOrders.jsx's picker
  // still correctly uses the active-only useInventoryItems().
  const { data: items, refetch: refetchItems } = useAllInventoryItems()
  const { data: factors, refetch: refetchFactors } = useInventoryItemUnitFactors()
  const { data: balances } = useStockBalances()
  const [movementItemFilter, setMovementItemFilter] = useState('')
  const { data: movements } = useStockMovements({ inventoryItemId: movementItemFilter || undefined })

  const [showForm, setShowForm] = useState(false)
  const [editItem, setEditItem] = useState(null)
  const [deleteId, setDeleteId] = useState(null)
  const [saving, setSaving] = useState(false)

  const totalValue = useMemo(() => (balances || []).reduce((s, b) => s + b.quantity_on_hand * b.weighted_average_cost, 0), [balances])
  const itemOpts = (items || []).map(it => ({ value: it.id, label: `${it.name} (${it.base_unit})`, keywords: it.name }))

  const handleSave = async (form) => {
    setSaving(true)
    try {
      const payload = { name: form.name, base_unit: form.base_unit, active: form.active !== false }
      if (editItem) {
        const { error } = await supabase.from('inventory_items').update(payload).eq('id', editItem.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('inventory_items').insert(payload)
        if (error) throw error
      }
      setShowForm(false); setEditItem(null); refetchItems()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setSaving(false) }
  }

  const handleDelete = async () => {
    if (!deleteId) return
    const { error } = await supabase.from('inventory_items').delete().eq('id', deleteId)
    if (!error) { setDeleteId(null); refetchItems() }
    else alert('ลบไม่สำเร็จ (อาจมีสต็อกหรือประวัติผูกอยู่): ' + error.message)
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className={`btn btn-sm ${view === 'items' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('items')}>📦 รายการสินค้าคงคลัง</button>
        <button className={`btn btn-sm ${view === 'stock' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('stock')}>💰 มูลค่าสต็อก</button>
        <button className={`btn btn-sm ${view === 'movements' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('movements')}>📜 ประวัติการเคลื่อนไหว</button>
      </div>

      {view === 'items' && (
        <>
          {canEdit && <button className="btn btn-primary" style={{ marginBottom: 14 }} onClick={() => { setEditItem(null); setShowForm(true) }}>+ เพิ่มสินค้าคงคลัง</button>}
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead><tr><th>ชื่อ</th><th>หน่วยหลัก</th><th>สถานะ</th><th></th></tr></thead>
                <tbody>
                  {(items || []).map(it => (
                    <tr key={it.id}>
                      <td style={{ fontWeight: 600 }}>{it.name}</td>
                      <td style={{ fontSize: 12 }}>{it.base_unit}</td>
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
                  {!(items || []).length && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีสินค้าคงคลัง</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {view === 'stock' && (
        <div className="card">
          <div style={{ padding: '12px 16px', fontWeight: 700 }}>มูลค่าสต็อกรวม: <span className="font-mono" style={{ color: 'var(--accent)' }}>{fmt(totalValue)}</span> บาท</div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>สินค้า</th><th>ไซท์งาน</th><th>คงเหลือ</th><th>ต้นทุนเฉลี่ย/หน่วย</th><th>มูลค่ารวม</th></tr></thead>
              <tbody>
                {(balances || []).map(b => (
                  <tr key={b.id}>
                    <td>{b.inventory_items?.name}</td>
                    <td style={{ fontSize: 12 }}>{b.sites?.name}</td>
                    <td className="font-mono">{fmt(b.quantity_on_hand)} {b.inventory_items?.base_unit}</td>
                    <td className="font-mono">{fmt(b.weighted_average_cost)}</td>
                    <td className="font-mono" style={{ fontWeight: 700 }}>{fmt(b.quantity_on_hand * b.weighted_average_cost)}</td>
                  </tr>
                ))}
                {!(balances || []).length && <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีสต็อก</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {view === 'movements' && (
        <>
          <div style={{ marginBottom: 14, maxWidth: 320 }}>
            <SearchableSelect value={movementItemFilter} onChange={setMovementItemFilter} placeholder="ทุกรายการสินค้า" options={itemOpts} />
          </div>
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead><tr><th>วันที่</th><th>สินค้า</th><th>ไซท์งาน</th><th>ประเภท</th><th>จำนวน</th><th>ต้นทุน/หน่วย</th></tr></thead>
                <tbody>
                  {(movements || []).map(m => (
                    <tr key={m.id}>
                      <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{new Date(m.created_at).toLocaleString('th-TH')}</td>
                      <td>{m.inventory_items?.name}</td>
                      <td style={{ fontSize: 12 }}>{m.sites?.name}</td>
                      <td style={{ fontSize: 12 }}>{MOVEMENT_TYPE_LABELS[m.movement_type] || m.movement_type}</td>
                      <td className="font-mono">{fmt(m.quantity)} {m.inventory_items?.base_unit}</td>
                      <td className="font-mono">{m.unit_cost != null ? fmt(m.unit_cost) : '—'}</td>
                    </tr>
                  ))}
                  {!(movements || []).length && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีประวัติ</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {showForm && (
        <Modal title={editItem ? `แก้ไข ${editItem.name}` : 'เพิ่มสินค้าคงคลังใหม่'} onClose={() => { setShowForm(false); setEditItem(null) }} maxWidth={520}>
          <ItemForm initial={editItem || EMPTY_ITEM_FORM} onSave={handleSave} onCancel={() => { setShowForm(false); setEditItem(null) }} loading={saving} />
          {editItem && (
            <div className="modal-body" style={{ paddingTop: 0 }}>
              <UnitFactorsPanel item={editItem} factors={factors || []} onChanged={refetchFactors} />
            </div>
          )}
        </Modal>
      )}

      {deleteId && (
        <ConfirmDialog title="ลบสินค้าคงคลัง" message="ยืนยันการลบ? (ถ้ามีประวัติสต็อกผูกอยู่ การลบจะไม่สำเร็จ)" onConfirm={handleDelete} onCancel={() => setDeleteId(null)} />
      )}
    </div>
  )
}
