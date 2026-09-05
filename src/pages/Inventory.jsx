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
import { useAllInventoryItems, useInventoryItemUnitFactors, useStockBalances, useStockMovements, useAllAluminumProfiles, useInventoryCategories, useSites, usePurchaseOrders } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import { fmt } from '../lib/supabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import { useDraftForm } from '../hooks/useDraftForm.js'
import SearchableSelect from '../components/SearchableSelect.jsx'
import QuickAddSelect from '../components/QuickAddSelect.jsx'
import ExcelUpload from '../components/ExcelUpload.jsx'

const EMPTY_ITEM_FORM = { name: '', base_unit: '', unit_conversion_mode: 'plain', reference_area_sqm: '', category_id: '', active: true }
const EMPTY_FACTOR_FORM = { unit_name: '', factor_to_base: '1' }

const MOVEMENT_TYPE_LABELS = {
  purchase_in: '📥 รับเข้าจากใบสั่งซื้อ',
  transfer_in: '↩️ โอนเข้า',
  transfer_out: '↪️ โอนออก',
  sale_out: '📤 ขายออก',
  sale_reversal: '↩️ ยกเลิกการขาย',
  adjustment: '✏️ ปรับปรุงยอด',
}

function ItemForm({ initial = EMPTY_ITEM_FORM, onSave, onCancel, loading, categories, onCategoryCreated }) {
  const isAdd = !initial?.id
  const [form, setForm, clearDraft] = useDraftForm('inventory-item-form', { ...EMPTY_ITEM_FORM, ...initial, reference_area_sqm: initial?.reference_area_sqm ?? '', category_id: initial?.category_id ?? '' }, isAdd)
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
        <div>
          <label className="label">หมวดหมู่</label>
          <QuickAddSelect
            value={form.category_id} onChange={v => set('category_id', v)}
            placeholder="— ไม่มีหมวดหมู่ —" options={(categories || []).map(c => ({ value: c.id, label: c.name, keywords: c.name }))}
            table="inventory_categories" namePlaceholder="ชื่อหมวดหมู่ใหม่"
            onCreated={onCategoryCreated}
            addLabel="+ สร้างใหม่"
          />
        </div>
        <div>
          <label className="label">รูปแบบการแปลงหน่วยตอนรับของ</label>
          <select className="select" value={form.unit_conversion_mode} onChange={e => set('unit_conversion_mode', e.target.value)}>
            <option value="plain">ปกติ (ใช้หน่วยแปลงคงที่ ถ้ามีตั้งไว้)</option>
            <option value="aluminum_profile">อลูมิเนียม (เลือกหน้าตัด + ความยาว ตอนรับของ)</option>
            <option value="glass_dimension">กระจก (กรอกกว้าง×ยาว ตอนรับของ)</option>
          </select>
        </div>
        {form.unit_conversion_mode === 'glass_dimension' && (
          <div>
            <label className="label">ขนาดแผ่นอ้างอิง (ตรม.) — สำหรับรายงานประมาณจำนวนแผ่น</label>
            <input className="input" type="number" min="0" step="0.01" value={form.reference_area_sqm}
              onChange={e => set('reference_area_sqm', e.target.value)} placeholder="เช่น 2.88 (สำหรับแผ่น 1.2×2.4ม.)" />
          </div>
        )}
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

const EMPTY_PROFILE_FORM = { name: '', linear_weight_kg_per_m: '', default_length_m: '6.4' }

function ProfileForm({ initial = EMPTY_PROFILE_FORM, onSave, onCancel, loading }) {
  const isAdd = !initial?.id
  const [form, setForm, clearDraft] = useDraftForm('aluminum-profile-form', { ...EMPTY_PROFILE_FORM, ...initial }, isAdd)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  return (
    <form onSubmit={e => { e.preventDefault(); clearDraft(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div>
          <label className="label">ชื่อหน้าตัด ★</label>
          <input className="input" required value={form.name} onChange={e => set('name', e.target.value)} placeholder="เช่น หน้าตัด X" />
        </div>
        <div>
          <label className="label">น้ำหนัก (กก./เมตร) ★</label>
          <input className="input" required type="number" min="0" step="0.0001" value={form.linear_weight_kg_per_m}
            onChange={e => set('linear_weight_kg_per_m', e.target.value)} />
        </div>
        <div>
          <label className="label">ความยาวมาตรฐาน (เมตร)</label>
          <input className="input" type="number" min="0" step="0.01" value={form.default_length_m}
            onChange={e => set('default_length_m', e.target.value)} placeholder="ค่าเริ่มต้น 6.4" />
        </div>
        {!isAdd && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
            <input type="checkbox" checked={form.active} onChange={e => set('active', e.target.checked)} />
            ใช้งานอยู่
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

function BalanceRow({ item, balance, isFirstForItem, centralSite, canEdit, savingKey, resolveSource, onSaveBalance, onEditItem, onDeleteItem }) {
  const siteId = balance ? balance.site_id : centralSite?.id
  const isCentralRow = !!centralSite && siteId === centralSite.id
  const [editing, setEditing] = useState(false)
  const [qtyDraft, setQtyDraft] = useState(String(balance?.quantity_on_hand ?? 0))
  const [costDraft, setCostDraft] = useState(String(balance?.weighted_average_cost ?? 0))
  const key = siteId ? `${item.id}-${siteId}` : null
  const saving = savingKey === key

  const siteName = balance ? balance.sites?.name : (centralSite?.name || 'ส่วนกลาง (ยังไม่มีไซท์นี้)')
  const quantity = balance?.quantity_on_hand ?? 0
  const cost = balance?.weighted_average_cost ?? 0

  const save = async () => {
    if (!siteId) { alert('ไม่พบไซท์งาน "ส่วนกลาง" — กรุณาสร้างไซท์งานชื่อนี้ก่อน'); return }
    await onSaveBalance(item.id, siteId, qtyDraft, costDraft)
    setEditing(false)
  }

  return (
    <tr>
      <td style={{ fontWeight: 600 }}>{item.name}</td>
      <td style={{ fontSize: 12 }}>{item.inventory_categories?.name || '—'}</td>
      <td>{isFirstForItem ? (item.active ? <span className="badge badge-paid">ใช้งานอยู่</span> : <span className="badge badge-finished">ปิดใช้งาน</span>) : null}</td>
      <td style={{ fontSize: 12 }}>{siteName}</td>
      <td className="font-mono">
        {editing ? (
          <input className="input input-sm" style={{ width: 90 }} type="number" min="0" step="0.0001" value={qtyDraft} onChange={e => setQtyDraft(e.target.value)} />
        ) : `${fmt(quantity)} ${item.base_unit}`}
      </td>
      <td className="font-mono">
        {editing ? (
          <input className="input input-sm" style={{ width: 90 }} type="number" min="0" step="0.0001" value={costDraft} onChange={e => setCostDraft(e.target.value)} />
        ) : fmt(cost)}
      </td>
      <td className="font-mono" style={{ fontWeight: 700 }}>{fmt(quantity * cost)}</td>
      <td style={{ fontSize: 12, color: 'var(--text3)' }}>{balance ? resolveSource(item.id, balance.site_id) : '—'}</td>
      <td style={{ whiteSpace: 'nowrap' }}>
        {canEdit && isCentralRow && (
          editing ? (
            <>
              <button className="btn btn-sm btn-primary" disabled={saving} onClick={save}>{saving ? '⏳' : '✅ บันทึก'}</button>
              <button className="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>ยกเลิก</button>
            </>
          ) : (
            <button className="btn btn-sm btn-ghost" onClick={() => setEditing(true)}>ปรับยอด</button>
          )
        )}
        {canEdit && isFirstForItem && (
          <>
            <button className="btn btn-sm btn-ghost" onClick={onEditItem}>แก้ไข</button>
            <button className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={onDeleteItem}>ลบ</button>
          </>
        )}
      </td>
    </tr>
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
  const { data: categories, refetch: refetchCategories } = useInventoryCategories()
  const { data: factors, refetch: refetchFactors } = useInventoryItemUnitFactors()
  const { data: balances, refetch: refetchBalances } = useStockBalances()
  const { data: profiles, refetch: refetchProfiles } = useAllAluminumProfiles()
  const [movementItemFilter, setMovementItemFilter] = useState('')
  const { data: movements, refetch: refetchMovements } = useStockMovements({ inventoryItemId: movementItemFilter || undefined })
  const { data: sites } = useSites()
  const { data: allMovements, refetch: refetchAllMovements } = useStockMovements({})
  const { data: allPos } = usePurchaseOrders({})
  const [itemsCategoryFilter, setItemsCategoryFilter] = useState('')
  const [savingBalance, setSavingBalance] = useState(null) // the balance-row key currently saving, or null

  const [showForm, setShowForm] = useState(false)
  const [editItem, setEditItem] = useState(null)
  const [deleteId, setDeleteId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [showProfileForm, setShowProfileForm] = useState(false)
  const [editProfile, setEditProfile] = useState(null)
  const [deleteProfileId, setDeleteProfileId] = useState(null)
  const [savingProfile, setSavingProfile] = useState(false)
  const [showImportItems, setShowImportItems] = useState(false)
  const [showImportProfiles, setShowImportProfiles] = useState(false)

  const totalValue = useMemo(() => (balances || []).reduce((s, b) => s + b.quantity_on_hand * b.weighted_average_cost, 0), [balances])
  const itemOpts = (items || []).map(it => ({ value: it.id, label: `${it.name} (${it.base_unit})`, keywords: it.name }))

  const centralSite = (sites || []).find(s => s.name === 'ส่วนกลาง')

  const resolveSource = (itemId, siteId) => {
    const itemMovements = (allMovements || []).filter(m => m.inventory_item_id === itemId && m.site_id === siteId)
    if (!itemMovements.length) return '—'
    const latest = itemMovements.reduce((a, b) => new Date(a.created_at) > new Date(b.created_at) ? a : b)
    if (latest.reference_type === 'purchase_order') {
      const po = (allPos || []).find(p => p.id === latest.reference_id)
      return po ? `PO ${po.po_number}` : 'ใบสั่งซื้อ'
    }
    if (latest.reference_type === 'site_completion') {
      const fromSite = (sites || []).find(s => s.id === latest.reference_id)
      return fromSite ? `โอนจาก ${fromSite.name}` : 'โอนจากไซท์งาน'
    }
    if (latest.reference_type === 'manual_adjustment') return 'ปรับยอด'
    return latest.reference_type || '—'
  }

  const tableRows = useMemo(() => {
    const filteredItems = itemsCategoryFilter
      ? (items || []).filter(it => it.category_id === itemsCategoryFilter)
      : (items || [])
    const rows = []
    for (const item of filteredItems) {
      const itemBalances = (balances || []).filter(b => b.inventory_item_id === item.id)
      const hasCentralBalance = centralSite && itemBalances.some(b => b.site_id === centralSite.id)
      if (!itemBalances.length) {
        rows.push({ item, balance: null, isFirstForItem: true })
      } else {
        itemBalances.forEach((balance, i) => rows.push({ item, balance, isFirstForItem: i === 0 }))
        if (!hasCentralBalance) {
          rows.push({ item, balance: null, isFirstForItem: false })
        }
      }
    }
    return rows
  }, [items, balances, itemsCategoryFilter, centralSite])

  const handleSaveBalance = async (itemId, siteId, quantityStr, costStr) => {
    const quantity = parseFloat(quantityStr)
    const cost = parseFloat(costStr)
    if (isNaN(quantity) || quantity < 0 || isNaN(cost) || cost < 0) {
      alert('กรุณากรอกปริมาณและราคาเป็นตัวเลขไม่ติดลบ')
      return
    }
    const key = `${itemId}-${siteId}`
    setSavingBalance(key)
    try {
      const { error } = await supabase.rpc('record_stock_movement', {
        p_inventory_item_id: itemId, p_site_id: siteId, p_movement_type: 'adjustment',
        p_quantity: quantity, p_unit_cost: cost,
        p_reference_type: 'manual_adjustment', p_reference_id: null, p_notes: null,
      })
      if (error) throw error
      refetchBalances(); refetchItems(); refetchAllMovements(); refetchMovements()
    } catch (e) { alert('ปรับยอดไม่สำเร็จ: ' + e.message) }
    finally { setSavingBalance(null) }
  }

  const handleSave = async (form) => {
    setSaving(true)
    try {
      const payload = {
        name: form.name, base_unit: form.base_unit, active: form.active !== false,
        unit_conversion_mode: form.unit_conversion_mode || 'plain',
        reference_area_sqm: form.unit_conversion_mode === 'glass_dimension' && form.reference_area_sqm ? parseFloat(form.reference_area_sqm) : null,
        category_id: form.category_id || null,
      }
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

  const handleSaveProfile = async (form) => {
    setSavingProfile(true)
    try {
      const payload = {
        name: form.name,
        linear_weight_kg_per_m: parseFloat(form.linear_weight_kg_per_m) || 0,
        default_length_m: form.default_length_m ? parseFloat(form.default_length_m) : 6.4,
        active: form.active !== false,
      }
      if (editProfile) {
        const { error } = await supabase.from('aluminum_profiles').update(payload).eq('id', editProfile.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('aluminum_profiles').insert(payload)
        if (error) throw error
      }
      setShowProfileForm(false); setEditProfile(null); refetchProfiles()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setSavingProfile(false) }
  }

  const handleDeleteProfile = async () => {
    if (!deleteProfileId) return
    const { error } = await supabase.from('aluminum_profiles').delete().eq('id', deleteProfileId)
    if (!error) { setDeleteProfileId(null); refetchProfiles() }
    else alert('ลบไม่สำเร็จ (อาจมีใบสั่งซื้อผูกอยู่): ' + error.message)
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className={`btn btn-sm ${view === 'items' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('items')}>📦 รายการสินค้าคงคลัง</button>
        <button className={`btn btn-sm ${view === 'movements' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('movements')}>📜 ประวัติการเคลื่อนไหว</button>
        <button className={`btn btn-sm ${view === 'profiles' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('profiles')}>🔧 หน้าตัดอลูมิเนียม</button>
      </div>

      {view === 'items' && (
        <>
          {canEdit && <button className="btn btn-primary" style={{ marginBottom: 14 }} onClick={() => { setEditItem(null); setShowForm(true) }}>+ เพิ่มสินค้าคงคลัง</button>}
          {canEdit && <button className="btn btn-ghost" style={{ marginBottom: 14, marginLeft: 8 }} onClick={() => setShowImportItems(v => !v)}>📥 Import Excel</button>}
          <a className="btn btn-ghost" style={{ marginBottom: 14, marginLeft: 8 }} href="/templates/TEMPLATE_รายการสินค้าคงคลัง.xlsx" download>📄 Template</a>
          {showImportItems && (
            <div style={{ marginBottom: 14 }}>
              <ExcelUpload type="inventory_item" onSuccess={() => { setShowImportItems(false); refetchItems() }} />
            </div>
          )}
          {!centralSite && (
            <div className="alert alert-error">ไม่พบไซท์งานชื่อ "ส่วนกลาง" — กรุณาสร้างไซท์งานชื่อนี้ก่อน จึงจะปรับยอดสต็อกได้</div>
          )}
          <div style={{ marginBottom: 14, maxWidth: 260 }}>
            <SearchableSelect value={itemsCategoryFilter} onChange={setItemsCategoryFilter} placeholder="ทุกหมวดหมู่"
              options={(categories || []).map(c => ({ value: c.id, label: c.name, keywords: c.name }))} />
          </div>
          <div className="card">
            <div style={{ padding: '12px 16px', fontWeight: 700 }}>มูลค่าสต็อกรวม: <span className="font-mono" style={{ color: 'var(--accent)' }}>{fmt(totalValue)}</span> บาท</div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>ชื่อ</th><th>หมวดหมู่</th><th>สถานะ</th><th>ไซท์งาน</th><th>ปริมาณ</th><th>ราคา/หน่วย</th><th>มูลค่ารวม</th><th>แหล่งที่มาล่าสุด</th><th></th></tr></thead>
                <tbody>
                  {tableRows.map(({ item, balance, isFirstForItem }) => (
                    <BalanceRow
                      key={balance ? balance.id : `${item.id}-empty`}
                      item={item} balance={balance} isFirstForItem={isFirstForItem}
                      centralSite={centralSite} canEdit={canEdit} savingKey={savingBalance}
                      resolveSource={resolveSource}
                      onSaveBalance={handleSaveBalance}
                      onEditItem={() => { setEditItem(item); setShowForm(true) }}
                      onDeleteItem={() => setDeleteId(item.id)}
                    />
                  ))}
                  {!tableRows.length && <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีสินค้าคงคลัง</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
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

      {view === 'profiles' && (
        <>
          {canEdit && <button className="btn btn-primary" style={{ marginBottom: 14 }} onClick={() => { setEditProfile(null); setShowProfileForm(true) }}>+ เพิ่มหน้าตัด</button>}
          {canEdit && <button className="btn btn-ghost" style={{ marginBottom: 14, marginLeft: 8 }} onClick={() => setShowImportProfiles(v => !v)}>📥 Import Excel</button>}
          <a className="btn btn-ghost" style={{ marginBottom: 14, marginLeft: 8 }} href="/templates/TEMPLATE_หน้าตัดอลูมิเนียม.xlsx" download>📄 Template</a>
          {showImportProfiles && (
            <div style={{ marginBottom: 14 }}>
              <ExcelUpload type="aluminum_profile" onSuccess={() => { setShowImportProfiles(false); refetchProfiles() }} />
            </div>
          )}
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead><tr><th>ชื่อหน้าตัด</th><th>กก./เมตร</th><th>ความยาวมาตรฐาน</th><th>สถานะ</th><th></th></tr></thead>
                <tbody>
                  {(profiles || []).map(p => (
                    <tr key={p.id}>
                      <td style={{ fontWeight: 600 }}>{p.name}</td>
                      <td className="font-mono">{fmt(p.linear_weight_kg_per_m)}</td>
                      <td className="font-mono">{fmt(p.default_length_m)} ม.</td>
                      <td>{p.active ? <span className="badge badge-paid">ใช้งานอยู่</span> : <span className="badge badge-finished">ปิดใช้งาน</span>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {canEdit && (
                          <>
                            <button className="btn btn-sm btn-ghost" onClick={() => { setEditProfile(p); setShowProfileForm(true) }}>แก้ไข</button>
                            <button className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => setDeleteProfileId(p.id)}>ลบ</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!(profiles || []).length && <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีหน้าตัด</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {showForm && (
        <Modal title={editItem ? `แก้ไข ${editItem.name}` : 'เพิ่มสินค้าคงคลังใหม่'} onClose={() => { setShowForm(false); setEditItem(null) }} maxWidth={520}>
          <ItemForm initial={editItem || EMPTY_ITEM_FORM} onSave={handleSave} onCancel={() => { setShowForm(false); setEditItem(null) }} loading={saving} categories={categories} onCategoryCreated={refetchCategories} />
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

      {showProfileForm && (
        <Modal title={editProfile ? `แก้ไข ${editProfile.name}` : 'เพิ่มหน้าตัดใหม่'} onClose={() => { setShowProfileForm(false); setEditProfile(null) }} maxWidth={480}>
          <ProfileForm initial={editProfile || EMPTY_PROFILE_FORM} onSave={handleSaveProfile} onCancel={() => { setShowProfileForm(false); setEditProfile(null) }} loading={savingProfile} />
        </Modal>
      )}

      {deleteProfileId && (
        <ConfirmDialog title="ลบหน้าตัด" message="ยืนยันการลบ? (ถ้ามีใบสั่งซื้อผูกอยู่ การลบจะไม่สำเร็จ)" onConfirm={handleDeleteProfile} onCancel={() => setDeleteProfileId(null)} />
      )}
    </div>
  )
}
