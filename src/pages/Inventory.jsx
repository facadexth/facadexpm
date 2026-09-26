// src/pages/Inventory.jsx
// ============================================================
// Inventory — Phase 1: item definitions + unit factors, stock
// balances (valuation report), stock movement ledger (stock card).
// Admin/owner-only, gated on has_module_access('purchase_orders')
// (see the inventory Phase 1 plan's Ruling A for why this rides on
// the PO module instead of a new module key).
// ============================================================
import { useState, useMemo, useEffect, Fragment } from 'react'
import { supabase } from '../lib/supabase.js'
import { useAllInventoryItems, useInventoryItemUnitFactors, useStockBalances, useStockMovements, useAllAluminumProfiles, useCategories, useSites, usePurchaseOrders, useInventoryCogsSettings, saveInventoryCogsSettings, useUnprocessedInvoices, useInvoiceNumbers, useSiteCostEstimates } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { useTenant } from '../hooks/useTenant.js'
import { canEditPage } from '../lib/permissions.js'
import { fmt } from '../lib/supabase.js'
import { computeInvoiceDeductionPlan, resolveMovementReference, computeFinishedGoodsProductionPlan, computeStockLedgerReport } from '../lib/inventoryCost.js'
import { exportToExcel } from '../lib/exportExcel.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import { useDraftForm } from '../hooks/useDraftForm.js'
import SearchableSelect from '../components/SearchableSelect.jsx'
import QuickAddSelect from '../components/QuickAddSelect.jsx'
import ExcelUpload from '../components/ExcelUpload.jsx'

const EMPTY_ITEM_FORM = { code: '', name: '', base_unit: '', unit_conversion_mode: 'plain', reference_area_sqm: '', category_id: '', active: true }
const EMPTY_FACTOR_FORM = { unit_name: '', factor_to_base: '1' }

// Reference types whose reference_id groups multiple stock_movements rows
// under one real-world document (an invoice's category deductions, a PO's
// received lines) -- clicking one of these in the ledger drills down to
// every row from that same document. site_completion/manual_adjustment
// don't group this way (their reference_id is a site id or null), so
// they're left as plain text.
const DRILLABLE_REFERENCE_TYPES = ['invoice', 'purchase_order']

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
  const [form, setForm, clearDraft] = useDraftForm('inventory-item-form', { ...EMPTY_ITEM_FORM, ...initial, code: initial?.code ?? '', reference_area_sqm: initial?.reference_area_sqm ?? '', category_id: initial?.category_id ?? '' }, isAdd)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const selectedCategory = (categories || []).find(c => c.id === form.category_id)

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
            table="expense_categories" namePlaceholder="ชื่อหมวดหมู่ใหม่"
            onCreated={onCategoryCreated}
            addLabel="+ สร้างใหม่"
          />
        </div>
        <div>
          <label className="label">รหัสสินค้า</label>
          <input className="input" value={form.code} onChange={e => set('code', e.target.value)}
            placeholder={isAdd && selectedCategory?.code_prefix ? `เว้นว่างไว้ = ตั้งอัตโนมัติ (${selectedCategory.code_prefix}-xxxx)` : 'เช่น ALU-6063'} />
          {isAdd && (
            selectedCategory?.code_prefix
              ? <p style={{ fontSize: 11.5, color: 'var(--text3)', margin: '4px 0 0' }}>เว้นว่างไว้เพื่อให้ระบบตั้งรหัสอัตโนมัติตามหมวดหมู่ "{selectedCategory.name}" ({selectedCategory.code_prefix}-xxxx)</p>
              : form.category_id && <p style={{ fontSize: 11.5, color: 'var(--text3)', margin: '4px 0 0' }}>หมวดหมู่นี้ยังไม่ได้ตั้งรหัสย่อไว้ — ตั้งได้ที่หน้า ⚙️ ตั้งค่า → หมวดหมู่ ถ้าต้องการให้ตั้งรหัสอัตโนมัติ</p>
          )}
        </div>
        {/* TODO(unit-conversion-mode): the "รูปแบบการแปลงหน่วยตอนรับของ"
            dropdown (aluminum_profile/glass_dimension special receiving
            flows) is pulled from the UI -- not finished yet. Re-enable
            here once complete; the underlying field/logic in
            PurchaseOrders.jsx and the ↓ profiles subtab are untouched.
            Every item stays on 'plain' mode until this comes back. */}
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

const EMPTY_PROFILE_FORM = { name: '', family: '', series: '', thickness_mm: '', linear_weight_kg_per_m: '', default_length_m: '6.4' }

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
          <label className="label">กลุ่มหน้าตัด (family) — สำหรับผูกกับ BOM Template</label>
          <input className="input" value={form.family} onChange={e => set('family', e.target.value)} placeholder="เช่น กล่องร่อง" />
        </div>
        <div>
          <label className="label">รุ่น/ซีรีส์ (series)</label>
          <input className="input" value={form.series} onChange={e => set('series', e.target.value)} placeholder="เช่น ทั่วไป, ยูโร, วิสดอม" />
        </div>
        <div>
          <label className="label">ความหนา (มม.)</label>
          <input className="input" type="number" min="0" step="0.1" value={form.thickness_mm} onChange={e => set('thickness_mm', e.target.value)} placeholder="เช่น 1.2" />
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

// Combines several per-site balances of the SAME item into one number set
// -- used both by the multi-site row below and by the Excel export, so a
// "how much of X do we have total" figure is computed exactly once.
function aggregateBalances(siteBalances) {
  const qty = siteBalances.reduce((s, b) => s + b.quantity_on_hand, 0)
  const value = siteBalances.reduce((s, b) => s + b.quantity_on_hand * b.weighted_average_cost, 0)
  return { qty, value, avgCost: qty > 0 ? value / qty : 0 }
}

function BalanceRow({ item, balance, multiSite, isFirstForItem, centralSite, canEdit, savingKey, resolveSource, onSaveBalance, onEditItem, onDeleteItem, onViewWarehouses }) {
  // multiSite (stock at 2+ sites) has no single siteId of its own -- must
  // NOT fall back to centralSite.id here, or isCentralRow below would
  // wrongly show the single-site "ปรับยอด" adjust control on an aggregate
  // row that has no one site to adjust.
  const siteId = multiSite ? null : (balance ? balance.site_id : centralSite?.id)
  const isCentralRow = !multiSite && !!centralSite && siteId === centralSite.id
  const [editing, setEditing] = useState(false)
  const [qtyDraft, setQtyDraft] = useState(String(balance?.quantity_on_hand ?? 0))
  const [costDraft, setCostDraft] = useState(String(balance?.weighted_average_cost ?? 0))
  const key = siteId ? `${item.id}-${siteId}` : null
  const saving = savingKey === key

  const siteName = balance ? balance.sites?.name : (centralSite?.name || 'ส่วนกลาง (ยังไม่มีไซท์นี้)')
  const agg = multiSite ? aggregateBalances(multiSite) : null
  const quantity = agg ? agg.qty : (balance?.quantity_on_hand ?? 0)
  const cost = agg ? agg.avgCost : (balance?.weighted_average_cost ?? 0)
  const value = agg ? agg.value : quantity * cost

  const save = async () => {
    if (!siteId) { alert('ไม่พบไซท์งาน "ส่วนกลาง" — กรุณาสร้างไซท์งานชื่อนี้ก่อน'); return }
    await onSaveBalance(item.id, siteId, qtyDraft, costDraft)
    setEditing(false)
  }

  return (
    <tr>
      <td style={{ fontSize: 12, color: 'var(--text3)' }}>{item.code || '—'}</td>
      <td style={{ fontWeight: 600 }}>{item.name}</td>
      <td style={{ fontSize: 12 }}>{item.expense_categories?.name || '—'}</td>
      <td>{isFirstForItem ? (item.active ? <span className="badge badge-paid">ใช้งานอยู่</span> : <span className="badge badge-finished">ปิดใช้งาน</span>) : null}</td>
      <td style={{ fontSize: 12 }}>
        {multiSite ? (
          <button className="btn btn-sm btn-ghost" onClick={onViewWarehouses}>📍 ดูคลัง ({multiSite.length} ที่)</button>
        ) : siteName}
      </td>
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
      <td className="font-mono" style={{ fontWeight: 700 }}>{fmt(value)}</td>
      <td style={{ fontSize: 12, color: 'var(--text3)' }}>{multiSite ? resolveSource(item.id) : (balance ? resolveSource(item.id, balance.site_id) : '—')}</td>
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

function CogsSettingsPanel({ settings, categories, onSaved }) {
  const [materialPct, setMaterialPct] = useState(String(settings?.material_pct ?? 70))
  const [splits, setSplits] = useState(() => {
    const initial = {}
    for (const c of categories || []) initial[c.id] = String(settings?.category_splits?.[c.id] ?? 0)
    return initial
  })
  const [saving, setSaving] = useState(false)

  const sum = Object.values(splits).reduce((s, v) => s + (parseFloat(v) || 0), 0)
  const validSum = Math.abs(sum - 100) < 0.01

  const save = async () => {
    if (!validSum) { alert('ผลรวม % ต้องเท่ากับ 100'); return }
    const pct = parseFloat(materialPct)
    if (isNaN(pct) || pct < 0 || pct > 100) { alert('% ต้นทุนวัสดุต้องอยู่ระหว่าง 0-100'); return }
    setSaving(true)
    try {
      const numericSplits = Object.fromEntries(Object.entries(splits).map(([k, v]) => [k, parseFloat(v) || 0]))
      await saveInventoryCogsSettings(pct, numericSplits)
      onSaved()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setSaving(false) }
  }

  return (
    <div className="card" style={{ padding: 16, marginBottom: 14, display: 'grid', gap: 10 }}>
      <div style={{ fontWeight: 700 }}>ตั้งค่าสัดส่วนการตัดสต็อก (ค่าเริ่มต้น แก้ไขได้ทีละใบแจ้งหนี้)</div>
      <div>
        <label className="label">% ต้นทุนวัสดุของยอดใบแจ้งหนี้ (ก่อน VAT)</label>
        <input className="input input-sm" style={{ width: 100 }} type="number" min="0" max="100" step="0.1" value={materialPct} onChange={e => setMaterialPct(e.target.value)} />
      </div>
      <div>
        <label className="label">สัดส่วนแยกตามหมวดหมู่ (ต้องรวมเป็น 100%)</label>
        <div style={{ display: 'grid', gap: 6 }}>
          {(categories || []).map(c => (
            <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 160, fontSize: 13 }}>{c.name}</span>
              <input className="input input-sm" style={{ width: 90 }} type="number" min="0" max="100" step="0.1"
                value={splits[c.id] ?? '0'} onChange={e => setSplits(s => ({ ...s, [c.id]: e.target.value }))} />
              <span style={{ fontSize: 12, color: 'var(--text3)' }}>%</span>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 12, marginTop: 6, color: validSum ? 'var(--green)' : 'var(--red)' }}>
          รวม {sum.toFixed(1)}% {validSum ? '✓' : '— ต้องเท่ากับ 100%'}
        </div>
      </div>
      <button className="btn btn-sm btn-primary" style={{ justifySelf: 'start' }} disabled={saving || !validSum} onClick={save}>{saving ? '⏳' : '💾 บันทึกค่าเริ่มต้น'}</button>
    </div>
  )
}

function InvoiceDeductionRow({ invoice, categories, items, balances, centralSite, defaultSettings, siteCostEstimates, expanded, onToggle, onConfirmed }) {
  const [materialPct, setMaterialPct] = useState(String(defaultSettings?.material_pct ?? 70))
  // ถ้าไซท์งานของใบแจ้งหนี้นี้เคยกรอก "ต้นทุนประมาณการ" ไว้ (หน้าไซท์งาน,
  // คีย์ด้วยหมวดหมู่สินค้าคงคลังเดียวกัน) ใช้สัดส่วนของไซท์นั้นเป็นค่าเริ่มต้น
  // แทนค่าเริ่มต้นรวมของบริษัท -- ยังแก้ต่อได้ตามปกติก่อนกดยืนยัน
  const [splits, setSplits] = useState(() => {
    const siteEstimates = (siteCostEstimates || []).filter(e => e.site_id === invoice.site_id)
    const siteTotal = siteEstimates.reduce((s, e) => s + (parseFloat(e.estimated_amount) || 0), 0)
    const initial = {}
    for (const c of categories || []) {
      if (siteTotal > 0) {
        const row = siteEstimates.find(e => e.inventory_category_id === c.id)
        initial[c.id] = row ? String(((parseFloat(row.estimated_amount) || 0) / siteTotal * 100).toFixed(1)) : '0'
      } else {
        initial[c.id] = String(defaultSettings?.category_splits?.[c.id] ?? 0)
      }
    }
    return initial
  })
  const usingSiteEstimate = (siteCostEstimates || []).some(e => e.site_id === invoice.site_id)
  const [confirming, setConfirming] = useState(false)

  const numericSplits = Object.fromEntries(Object.entries(splits).map(([k, v]) => [k, parseFloat(v) || 0]))
  const plan = expanded ? computeInvoiceDeductionPlan({
    invoiceSubtotal: invoice.subtotal, materialPct: parseFloat(materialPct) || 0, categorySplits: numericSplits,
    siteId: invoice.site_id, centralSiteId: centralSite?.id || null, items: items || [], balances: balances || [],
  }) : null

  const sum = Object.values(splits).reduce((s, v) => s + (parseFloat(v) || 0), 0)
  const validSum = Math.abs(sum - 100) < 0.01

  const confirm = async () => {
    if (!validSum) { alert('ผลรวม % ต้องเท่ากับ 100'); return }
    setConfirming(true)
    try {
      // Idempotency is checked per-kind (raw-material vs finished-goods)
      // rather than with one combined check, so a partial failure (e.g.
      // raw-material posts fine but finished-goods then throws) can be
      // retried and will only redo the half that's actually missing.
      const { data: existingRmRows, error: rmCheckErr } = await supabase
        .from('stock_movements').select('id, inventory_items!inner(item_kind)')
        .eq('reference_type', 'invoice').eq('reference_id', invoice.id)
        .eq('inventory_items.item_kind', 'raw_material').limit(1)
      if (rmCheckErr) throw rmCheckErr
      const rmAlreadyDone = !!existingRmRows?.length

      const { data: existingFgRows, error: fgCheckErr } = await supabase
        .from('stock_movements').select('id, inventory_items!inner(item_kind)')
        .eq('reference_type', 'invoice').eq('reference_id', invoice.id)
        .eq('inventory_items.item_kind', 'finished_goods').limit(1)
      if (fgCheckErr) throw fgCheckErr
      const fgAlreadyDone = !!existingFgRows?.length

      if (rmAlreadyDone && fgAlreadyDone) { alert('ใบแจ้งหนี้นี้ถูกตัดสต็อกไปแล้ว — กำลังรีเฟรชรายการ'); onConfirmed(); return }

      let didSomething = false

      if (!rmAlreadyDone && plan && plan.steps.length) {
        didSomething = true
        for (const step of plan.steps) {
          const { error } = await supabase.rpc('record_stock_movement', {
            p_inventory_item_id: step.inventoryItemId, p_site_id: step.siteId, p_movement_type: step.type,
            p_quantity: step.quantity, p_unit_cost: step.unitCost,
            p_reference_type: 'invoice', p_reference_id: invoice.id, p_notes: null,
          })
          if (error) throw error
        }
      }

      // Finished-goods "produce and sell" (additive to the raw-material
      // steps above, posted at this SAME confirm click) -- see
      // docs/superpowers/specs/2026-09-24-finished-goods-tax-stock-reports-design.md
      // and its 2026-09-25 redesign note. Every invoice always posts its
      // own self-contained รับเข้า+ขายออก pair per billed line -- no more
      // "already posted the opening entry" branching, since there's no
      // more shared balance to open. Deliberately NOT gated behind the
      // raw-material plan having steps -- a site with no raw-material
      // stock must still get its finished-goods ledger entry.
      if (!fgAlreadyDone) {
        const { data: invItems, error: invItemsErr } = await supabase
          .from('invoice_items')
          .select('quotation_item_id, line_total, quotation_items!inner(id, description, sort_order, item_type, quotations!inner(quotation_number))')
          .eq('invoice_id', invoice.id)
          .eq('quotation_items.item_type', 'item')
        if (invItemsErr) throw invItemsErr

        const billedLines = (invItems || [])
          .filter(li => li.quotation_item_id)
          .map(li => ({
            quotationItemId: li.quotation_item_id,
            quotationNumber: li.quotation_items.quotations?.quotation_number || '',
            sortOrder: li.quotation_items.sort_order,
            description: li.quotation_items.description,
            invoiceItemLineTotal: li.line_total,
          }))

        if (billedLines.length) {
          didSomething = true
          const quotationItemIds = billedLines.map(l => l.quotationItemId)
          const { data: existingFg, error: fgErr } = await supabase
            .from('inventory_items').select('id, quotation_item_id')
            .eq('item_kind', 'finished_goods').in('quotation_item_id', quotationItemIds)
          if (fgErr) throw fgErr
          const itemIdByQuotationItemId = new Map((existingFg || []).map(r => [r.quotation_item_id, r.id]))

          const fgPlan = computeFinishedGoodsProductionPlan({ billedLines, materialPct: parseFloat(materialPct) || 0 })

          for (const step of fgPlan.steps) {
            let itemId = itemIdByQuotationItemId.get(step.quotationItemId)
            if (!itemId) {
              const { data: created, error: createErr } = await supabase
                .from('inventory_items').insert({
                  name: step.name, code: step.code, base_unit: 'ชุด', active: true,
                  unit_conversion_mode: 'plain', item_kind: 'finished_goods', quotation_item_id: step.quotationItemId,
                }).select('id').single()
              if (createErr) throw createErr
              itemId = created.id
              itemIdByQuotationItemId.set(step.quotationItemId, itemId)
            }
            const { error: inErr } = await supabase.rpc('record_stock_movement', {
              p_inventory_item_id: itemId, p_site_id: invoice.site_id, p_movement_type: 'purchase_in',
              p_quantity: 1, p_unit_cost: step.value,
              p_reference_type: 'invoice', p_reference_id: invoice.id, p_notes: `PI-${invoice.invoice_number}`,
            })
            if (inErr) throw inErr
            const { error: outErr } = await supabase.rpc('record_stock_movement', {
              p_inventory_item_id: itemId, p_site_id: invoice.site_id, p_movement_type: 'sale_out',
              p_quantity: 1, p_unit_cost: step.value,
              p_reference_type: 'invoice', p_reference_id: invoice.id, p_notes: `PO-${invoice.invoice_number}`,
            })
            if (outErr) throw outErr
          }
        }
      }

      if (!didSomething) { alert('ไม่มีรายการให้ตัดสต็อก'); return }

      if (plan && plan.totalShortfall > 0.01) {
        alert(`ตัดสต็อกสำเร็จบางส่วน — ขาดอีก ${fmt(plan.totalShortfall)} บาท (สต็อกไม่พอทั้งที่ไซท์งานและส่วนกลาง)`)
      }
      onConfirmed()
    } catch (e) { alert('เกิดข้อผิดพลาดระหว่างตัดสต็อก: ' + e.message + ' — บางรายการอาจถูกบันทึกไปแล้ว กรุณาตรวจสอบที่แท็บ "ประวัติการเคลื่อนไหว" ก่อนลองใหม่') }
    finally { setConfirming(false) }
  }

  return (
    <div className="card" style={{ padding: 14, marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }} onClick={onToggle}>
        <div>
          <strong>{invoice.invoice_number}</strong>
          <span style={{ marginLeft: 10, fontSize: 12, color: 'var(--text3)' }}>{invoice.sites?.name} · {fmt(invoice.subtotal)} บาท (ก่อน VAT)</span>
        </div>
        <span>{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
          <div>
            <label className="label">% ต้นทุนวัสดุ (สำหรับใบนี้)</label>
            <input className="input input-sm" style={{ width: 100 }} type="number" min="0" max="100" step="0.1" value={materialPct} onChange={e => setMaterialPct(e.target.value)} />
          </div>
          {usingSiteEstimate && (
            <div style={{ fontSize: 11.5, color: 'var(--accent)' }}>
              📐 สัดส่วนเริ่มต้นนี้มาจาก "ต้นทุนประมาณการ" ที่ตั้งไว้ในหน้าไซท์งาน ({invoice.sites?.name || 'ไซท์นี้'}) ไม่ใช่ค่าเริ่มต้นรวมของบริษัท — แก้ต่อได้ตามปกติ
            </div>
          )}
          <div style={{ display: 'grid', gap: 6 }}>
            {(categories || []).map(c => (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 160, fontSize: 13 }}>{c.name}</span>
                <input className="input input-sm" style={{ width: 90 }} type="number" min="0" max="100" step="0.1"
                  value={splits[c.id] ?? '0'} onChange={e => setSplits(s => ({ ...s, [c.id]: e.target.value }))} />
                <span style={{ fontSize: 12, color: 'var(--text3)' }}>%</span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 12, color: validSum ? 'var(--green)' : 'var(--red)' }}>รวม {sum.toFixed(1)}% {validSum ? '✓' : '— ต้องเท่ากับ 100%'}</div>
          {plan && (
            <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: 8, padding: 12, fontSize: 13 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>ตัวอย่างการตัดสต็อก</div>
              {plan.categoryResults.map(cr => {
                const cat = (categories || []).find(c => c.id === cr.categoryId)
                return (
                  <div key={cr.categoryId} style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>{cat?.name || cr.categoryId}</span>
                    <span className="font-mono">
                      {fmt(cr.deductedValue)} / {fmt(cr.targetValue)} บาท
                      {cr.shortfall > 0.01 && <span style={{ color: 'var(--red)' }}> (ขาด {fmt(cr.shortfall)})</span>}
                    </span>
                  </div>
                )
              })}
              <div style={{ fontWeight: 700, marginTop: 6, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
                รวม {fmt(plan.totalDeductedValue)} บาท{plan.totalShortfall > 0.01 && <span style={{ color: 'var(--red)' }}> — ขาด {fmt(plan.totalShortfall)} บาท</span>}
              </div>
            </div>
          )}
          <button className="btn btn-sm btn-primary" style={{ justifySelf: 'start' }} disabled={confirming || !validSum} onClick={confirm}>
            {confirming ? '⏳' : '✅ ยืนยันตัดสต็อก'}
          </button>
        </div>
      )}
    </div>
  )
}

const TAX_REPORT_KINDS = [
  {
    key: 'finished_goods', label: '1. รายงานการตัดสินค้าสำเร็จรูป', badge: 'รายงานที่ 1',
    subtitle: 'บัตรสินค้า — สินค้าสำเร็จรูป (งานตามสัญญาที่ผลิตและขายในแต่ละใบแจ้งหนี้)',
  },
  {
    key: 'raw_material', label: '2. รายงานตัดวัตถุดิบ', badge: 'รายงานที่ 2',
    subtitle: 'บัตรสินค้า — วัตถุดิบและวัสดุประกอบ (อลูมิเนียม กระจก อุปกรณ์ และอื่นๆ)',
  },
  {
    key: 'all', label: '3. รายงานสินค้าและวัตถุดิบ (รวม)', badge: 'รายงานที่ 3',
    subtitle: 'บัตรสินค้า — รวมสินค้าสำเร็จรูปและวัตถุดิบทุกรายการในรอบระยะเวลาเดียวกัน',
  },
]

function fmtQty(n) { return (Math.round(n * 100) / 100).toLocaleString('th-TH') }

// PI-/PO- are the literal reference codes this component itself writes
// into stock_movements.notes for finished-goods movements (see confirm()
// above) -- showing that string verbatim (rather than resolving it
// through resolveMovementReference's generic "ใบแจ้งหนี้ X" phrasing) is
// what makes a finished-goods row's reference recognizable as the same
// code the raw-material rows for that invoice will show once you jump
// there via the cross-link below.
function isProductionRef(notes) { return notes ? /^P[IO]-/.test(notes) : false }
function invoiceNumberFromProductionRef(notes) { return notes.replace(/^P[IO]-/, '') }

// Generic in/out labels for the tax-report ledger (report 1/2/3 all share
// this table) -- MOVEMENT_TYPE_LABELS above says "รับเข้าจากใบสั่งซื้อ" for
// purchase_in, which is right for raw materials but wrong for finished-goods
// purchase_in rows (those come from an invoice's PI-/PO- production pair,
// never a PO); the reference column already names the actual source.
const LEDGER_MOVEMENT_LABELS = {
  purchase_in: '📥 รับเข้า',
  transfer_in: '↩️ โอนเข้า',
  transfer_out: '↪️ โอนออก',
  sale_out: '📤 จำหน่ายออก',
  sale_reversal: '↩️ คืนสินค้า',
  adjustment: '✏️ ปรับปรุงยอด',
}

function TaxReportsView({ categories, pos, invoiceNumbers, sites }) {
  const today = new Date().toISOString().slice(0, 10)
  const monthStart = today.slice(0, 8) + '01'
  const [reportKind, setReportKind] = useState('all')
  const [dateFrom, setDateFrom] = useState(monthStart)
  const [dateTo, setDateTo] = useState(today)
  const [categoryFilter, setCategoryFilter] = useState('')
  // Set when the user clicks a finished-goods row's PI-/PO- reference, OR
  // picks a row from either report's event list -- narrows the report down
  // to just one invoice's cut, so "which materials did this finished-goods
  // entry actually come from" (raw_material report) or "what happened on
  // this specific cut" (finished_goods report) is one click away instead
  // of a manual date+eyeball search. For both reportKind 'finished_goods'
  // AND 'raw_material', referenceFilter doubles as that report's own
  // list<->detail switch: null shows the event list, set shows the ledger.
  const [referenceFilter, setReferenceFilter] = useState(null)
  // Set when the user clicks an item WITHIN report 2's detail view (one
  // invoice's materials) -- jumps to report 3 (reportKind 'all', the only
  // report with every raw-material item's FULL history) narrowed to just
  // that one item, so "how has this material moved across every invoice,
  // not just this one" is one click away. Deliberately independent of
  // referenceFilter (which stays set the whole time) so clearing itemFilter
  // and returning to reportKind 'raw_material' lands back on the exact
  // same invoice-detail view, not the report 2 list.
  const [itemFilter, setItemFilter] = useState(null)
  // Report 2's detail view (one invoice's materials) toggle -- show the
  // full opening/movements/closing ledger, or just a flat "what got cut,
  // how much" summary per item. Defaults to showing the full ledger.
  const [rmHideDetail, setRmHideDetail] = useState(false)
  const [fgSearch, setFgSearch] = useState('')
  const [fgSortCol, setFgSortCol] = useState('date')
  const [fgSortDir, setFgSortDir] = useState('desc')
  const [rmSearch, setRmSearch] = useState('')
  const [rmSortCol, setRmSortCol] = useState('date')
  const [rmSortDir, setRmSortDir] = useState('desc')

  const switchReportKind = (kind) => { setReportKind(kind); setReferenceFilter(null); setItemFilter(null) }
  const fgToggleSort = (col) => {
    if (fgSortCol === col) setFgSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setFgSortCol(col); setFgSortDir('asc') }
  }
  const fgSi = (col) => fgSortCol === col ? (fgSortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕'
  const rmToggleSort = (col) => {
    if (rmSortCol === col) setRmSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setRmSortCol(col); setRmSortDir('asc') }
  }
  const rmSi = (col) => rmSortCol === col ? (rmSortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕'

  const { tenant } = useTenant()
  const { data: movements } = useStockMovements({ dateTo })
  const { data: allItems } = useAllInventoryItems()

  const effectiveCategoryId = reportKind === 'finished_goods' ? null : (categoryFilter || null)

  const rows = useMemo(() => computeStockLedgerReport({
    movements: movements || [], items: allItems || [], dateFrom, dateTo,
    itemKindFilter: reportKind, categoryId: effectiveCategoryId,
  }), [movements, allItems, dateFrom, dateTo, reportKind, effectiveCategoryId])

  // A movement matches the active invoice reference filter either by its
  // literal notes (finished-goods rows: "PI-IN2608-065"/"PO-IN2608-065")
  // OR by resolving reference_id through the invoiceNumbers lookup --
  // raw-material movements carry reference_type/reference_id but no
  // notes (p_notes is null on that path), so matching on notes alone
  // would silently show zero materials for every jump-to-materials click.
  const movementMatchesInvoice = (mv, invoiceNo) => {
    if (mv.notes?.includes(invoiceNo)) return true
    if (mv.referenceType !== 'invoice') return false
    return (invoiceNumbers || []).some(inv => inv.id === mv.referenceId && inv.invoice_number === invoiceNo)
  }

  // When a reference filter is active: keep only rows that actually have a
  // movement referencing that invoice, and within those rows, keep only
  // the matching movements -- a focused "what fed this invoice" view
  // rather than each item's whole history. itemFilter (report 3 only,
  // arrived at from report 2) narrows to one item's row but keeps its
  // FULL movement history, ignoring referenceFilter even if one is still
  // set in the background -- report 3's whole point here is "every
  // invoice this item has ever been touched by," not just one.
  const displayRows = useMemo(() => {
    if (reportKind === 'all' && itemFilter) {
      return rows.filter(r => r.itemId === itemFilter.itemId)
    }
    if (!referenceFilter) return rows
    return rows
      .map(r => ({ ...r, movements: r.movements.filter(mv => movementMatchesInvoice(mv, referenceFilter)) }))
      .filter(r => r.movements.length)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, referenceFilter, itemFilter, reportKind, invoiceNumbers])

  const jumpToMaterials = (notes) => {
    setReportKind('raw_material')
    setReferenceFilter(invoiceNumberFromProductionRef(notes))
  }

  // From report 2's detail view: jump to report 3 filtered to just this
  // item's complete cross-invoice history. Deliberately does NOT touch
  // referenceFilter -- it stays set to the invoice we came from, so
  // clearItemFilter can return straight to that same invoice-detail view.
  const jumpToItemDetail = (item) => {
    setReportKind('all')
    setCategoryFilter('')
    setItemFilter({ itemId: item.itemId, code: item.code, name: item.name })
  }
  const clearItemFilter = () => { setItemFilter(null); setReportKind('raw_material') }

  // Finished-goods rows computed independently of the currently active
  // reportKind (unlike `rows`, which is filtered to whichever report tab
  // is selected) -- report 2's landing list needs this same event list
  // while reportKind is 'raw_material', not just while on report 1.
  const finishedGoodsRows = useMemo(() => computeStockLedgerReport({
    movements: movements || [], items: allItems || [], dateFrom, dateTo,
    itemKindFilter: 'finished_goods', categoryId: null,
  }), [movements, allItems, dateFrom, dateTo])

  // One row per invoice's finished-goods "cut" event (the PI-/PO- pair's
  // purchase_in side stands in for the whole pair -- both movements always
  // carry the same value by design, see computeFinishedGoodsProductionPlan).
  // A single finished-goods item (one quotation line's code) can carry
  // several of these over its life -- one per invoice billed against it --
  // so this list is keyed by event, not by item. Shared by report 1's list
  // (view what was produced) and report 2's list (view what it was made
  // FROM) -- same events, different drill-in target.
  const productionEvents = useMemo(() => {
    const events = []
    for (const row of finishedGoodsRows) {
      for (const mv of row.movements) {
        if (mv.type !== 'purchase_in' || !isProductionRef(mv.notes)) continue
        events.push({
          itemId: row.itemId, code: row.code, name: row.name, unit: row.unit,
          invoiceNumber: invoiceNumberFromProductionRef(mv.notes), date: mv.date, value: mv.value,
        })
      }
    }
    return events
  }, [finishedGoodsRows])

  const sortedFgEvents = useMemo(() => {
    const q = fgSearch.trim().toLowerCase()
    const filtered = q
      ? productionEvents.filter(e => e.code.toLowerCase().includes(q) || e.name.toLowerCase().includes(q) || e.invoiceNumber.toLowerCase().includes(q))
      : productionEvents
    return [...filtered].sort((a, b) => {
      const va = a[fgSortCol] ?? ''
      const vb = b[fgSortCol] ?? ''
      if (typeof va === 'number') return fgSortDir === 'asc' ? va - vb : vb - va
      return fgSortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va))
    })
  }, [productionEvents, fgSearch, fgSortCol, fgSortDir])

  const sortedRmEvents = useMemo(() => {
    const q = rmSearch.trim().toLowerCase()
    const filtered = q
      ? productionEvents.filter(e => e.code.toLowerCase().includes(q) || e.name.toLowerCase().includes(q) || e.invoiceNumber.toLowerCase().includes(q))
      : productionEvents
    return [...filtered].sort((a, b) => {
      const va = a[rmSortCol] ?? ''
      const vb = b[rmSortCol] ?? ''
      if (typeof va === 'number') return rmSortDir === 'asc' ? va - vb : vb - va
      return rmSortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va))
    })
  }, [productionEvents, rmSearch, rmSortCol, rmSortDir])

  // Report 2's detail view, "hide details" mode: just "what got cut, how
  // much" per item within the CURRENTLY FILTERED invoice (displayRows is
  // already narrowed to referenceFilter's movements) -- no opening
  // balance, no per-movement breakdown, no closing balance.
  const rmInvoiceSummary = useMemo(() => {
    return displayRows.map(r => {
      const outMovements = r.movements.filter(mv => mv.direction === 'out')
      return {
        itemId: r.itemId, code: r.code, name: r.name, unit: r.unit,
        outQty: outMovements.reduce((s, mv) => s + mv.qty, 0),
        outValue: outMovements.reduce((s, mv) => s + mv.value, 0),
      }
    }).filter(e => e.outQty > 0)
  }, [displayRows])

  const showFgList = reportKind === 'finished_goods' && !referenceFilter
  const showRmList = reportKind === 'raw_material' && !referenceFilter

  // Print shows exactly what's on screen right now -- displayRows, which
  // already reflects referenceFilter when one is active (one invoice's
  // slice) and equals `rows` (everything) when it isn't. Report 3 has no
  // list layer of its own, so it always prints the complete statutory
  // ledger; report 1/2 print whatever single invoice they're drilled
  // into, since the print button is hidden on their list views anyway
  // (see showFgList/showRmList gating the button below).
  const printTotals = useMemo(() => displayRows.reduce((a, r) => ({
    openingValue: a.openingValue + r.openingValue, inValue: a.inValue + r.inValue,
    outValue: a.outValue + r.outValue, closingValue: a.closingValue + r.closingValue,
  }), { openingValue: 0, inValue: 0, outValue: 0, closingValue: 0 }), [displayRows])

  // Shared ledger-body renderer for both the on-screen interactive detail
  // view (displayRows, clickable PI-/PO- cross-links) and the always-
  // present print-only full report (rows, plain text -- a click target
  // means nothing on paper).
  const renderLedgerRows = (list, { interactive, onItemClick }) => {
    if (!list.length) {
      return <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ไม่มีข้อมูลในช่วงเวลาที่เลือก</td></tr>
    }
    return list.map(r => {
      let runningQty = r.openingQty
      let runningValue = r.openingValue
      const withRunning = r.movements.map(mv => {
        runningQty += mv.direction === 'in' ? mv.qty : -mv.qty
        runningValue += mv.direction === 'in' ? mv.value : -mv.value
        return { ...mv, runningQty, runningValue }
      })
      return (
        <Fragment key={r.itemId}>
          <tr className="item-header-row">
            <td colSpan={9} style={{ fontWeight: 700, background: 'var(--accent-soft, rgba(0,0,0,0.04))', color: 'var(--accent)' }}>
              {onItemClick ? (
                <button className="btn-ghost" style={{ padding: 0, font: 'inherit', fontWeight: 700, color: 'var(--accent)', textDecoration: 'underline' }}
                  onClick={() => onItemClick(r)} title="ดูประวัติทั้งหมดของรายการนี้ในรายงานที่ 3">
                  {r.code} — {r.name} →
                </button>
              ) : (
                <>{r.code} — {r.name}</>
              )}
              {' '}<span style={{ fontWeight: 400, color: 'var(--text3)', fontSize: 12 }}>หน่วย: {r.unit}</span>
            </td>
          </tr>
          <tr style={{ fontStyle: 'italic', color: 'var(--text3)' }}>
            <td>{new Date(dateFrom).toLocaleDateString('th-TH')}</td>
            <td>ยอดยกมา</td>
            <td>—</td>
            <td className="font-mono">{fmtQty(r.openingQty)}</td>
            <td className="font-mono">{fmt(r.openingValue)}</td>
            <td className="font-mono">—</td>
            <td className="font-mono">—</td>
            <td className="font-mono">{fmtQty(r.openingQty)}</td>
            <td className="font-mono">{fmt(r.openingValue)}</td>
          </tr>
          {withRunning.map((mv, i) => (
            <tr key={i}>
              <td>{new Date(mv.date).toLocaleDateString('th-TH')}</td>
              <td>{LEDGER_MOVEMENT_LABELS[mv.type] || mv.type}</td>
              <td>
                {interactive && isProductionRef(mv.notes) ? (
                  <button className="btn-ghost" style={{ padding: 0, color: 'var(--accent)', textDecoration: 'underline' }}
                    onClick={() => jumpToMaterials(mv.notes)} title="ดูรายการวัตถุดิบที่ตัดสำหรับใบแจ้งหนี้นี้">
                    {mv.notes} →
                  </button>
                ) : (
                  mv.notes || resolveMovementReference({ reference_type: mv.referenceType, reference_id: mv.referenceId, notes: mv.notes }, { pos, invoices: invoiceNumbers, sites })
                )}
              </td>
              <td className="font-mono">{mv.direction === 'in' ? fmtQty(mv.qty) : ''}</td>
              <td className="font-mono">{mv.direction === 'in' ? fmt(mv.value) : ''}</td>
              <td className="font-mono">{mv.direction === 'out' ? fmtQty(mv.qty) : ''}</td>
              <td className="font-mono">{mv.direction === 'out' ? fmt(mv.value) : ''}</td>
              <td className="font-mono">{fmtQty(mv.runningQty)}</td>
              <td className="font-mono">{fmt(mv.runningValue)}</td>
            </tr>
          ))}
          <tr style={{ fontWeight: 700, borderTop: '1.5px solid var(--border)' }}>
            <td colSpan={3}>ยอดคงเหลือสิ้นงวด</td>
            <td className="font-mono">{fmtQty(r.inQty)}</td>
            <td className="font-mono">{fmt(r.inValue)}</td>
            <td className="font-mono">{fmtQty(r.outQty)}</td>
            <td className="font-mono">{fmt(r.outValue)}</td>
            <td className="font-mono">{fmtQty(r.closingQty)}</td>
            <td className="font-mono">{fmt(r.closingValue)}</td>
          </tr>
        </Fragment>
      )
    })
  }
  const ledgerThead = (
    <thead>
      <tr>
        <th>วันเดือนปี</th><th>รายการเคลื่อนไหว</th><th>เลขที่เอกสารอ้างอิง</th>
        <th>รับเข้า (จำนวน)</th><th>รับเข้า (มูลค่า)</th>
        <th>จำหน่ายออก (จำนวน)</th><th>จำหน่ายออก (มูลค่า)</th>
        <th>คงเหลือ (จำนวน)</th><th>คงเหลือ (มูลค่า)</th>
      </tr>
    </thead>
  )
  const activeReportMeta = TAX_REPORT_KINDS.find(k => k.key === reportKind)

  // A <thead> row repeats atop every printed page a <table> spans across
  // -- standard browser behavior for multi-page tables. Putting the
  // company/report identity INSIDE the print table's thead (not just the
  // doc-header above it, which only ever prints once on page 1) is what
  // makes it repeat -- requested via artifact comment since report 3's
  // full ledger runs to many pages. Screen-only .print-only class keeps
  // it out of the interactive on-screen table (which reuses `ledgerThead`
  // above, unchanged).
  const printRepeatRow = (cols) => (
    <tr className="print-repeat-row">
      <td colSpan={cols}>
        <span className="print-repeat-company">{tenant?.company_name}</span>
        <span className="print-repeat-sep">·</span>
        <span className="print-repeat-report">{activeReportMeta?.badge} {activeReportMeta?.label}</span>
        <span className="print-repeat-sep">·</span>
        <span className="print-repeat-period">รอบระยะเวลา {new Date(dateFrom).toLocaleDateString('th-TH')} — {new Date(dateTo).toLocaleDateString('th-TH')}</span>
      </td>
    </tr>
  )
  const printLedgerThead = (
    <thead>
      {printRepeatRow(9)}
      <tr>
        <th>วันเดือนปี</th><th>รายการเคลื่อนไหว</th><th>เลขที่เอกสารอ้างอิง</th>
        <th>รับเข้า (จำนวน)</th><th>รับเข้า (มูลค่า)</th>
        <th>จำหน่ายออก (จำนวน)</th><th>จำหน่ายออก (มูลค่า)</th>
        <th>คงเหลือ (จำนวน)</th><th>คงเหลือ (มูลค่า)</th>
      </tr>
    </thead>
  )

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {TAX_REPORT_KINDS.map(k => (
          <button key={k.key} className={`btn btn-sm ${reportKind === k.key ? 'btn-primary' : 'btn-ghost'}`} onClick={() => switchReportKind(k.key)}>{k.label}</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="label">จาก <input className="input input-sm" type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} /></label>
        <label className="label">ถึง <input className="input input-sm" type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} /></label>
        {reportKind !== 'finished_goods' && (
          <div style={{ minWidth: 220, maxWidth: 260 }}>
            <SearchableSelect value={categoryFilter} onChange={setCategoryFilter} placeholder="ทุกหมวดหมู่"
              options={(categories || []).map(c => ({ value: c.id, label: c.name, keywords: c.name }))} />
          </div>
        )}
        {referenceFilter && !(reportKind === 'all' && itemFilter) && (
          <span className="badge" style={{ background: 'var(--accent-soft, rgba(0,0,0,0.1))', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999, fontSize: 12.5 }}>
            ← กลับไปที่รายการ · กำลังดูเฉพาะใบแจ้งหนี้: {referenceFilter}
            <button className="btn-ghost" style={{ padding: 0, lineHeight: 1 }} onClick={() => setReferenceFilter(null)}>✕</button>
          </span>
        )}
        {itemFilter && (
          <span className="badge" style={{ background: 'var(--accent-soft, rgba(0,0,0,0.1))', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999, fontSize: 12.5 }}>
            ← กลับไปที่ใบแจ้งหนี้ {referenceFilter} · กำลังดูเฉพาะ: {itemFilter.code} — {itemFilter.name}
            <button className="btn-ghost" style={{ padding: 0, lineHeight: 1 }} onClick={clearItemFilter}>✕</button>
          </span>
        )}
        {!showFgList && !showRmList && (
          <button className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }} onClick={() => window.print()}>🖨️ พิมพ์ / PDF</button>
        )}
      </div>
      {showFgList ? (
        <>
          <div style={{ marginBottom: 12 }}>
            <input className="input input-sm" style={{ minWidth: 280 }} placeholder="ค้นหารหัส / รายการ / เลขที่ใบแจ้งหนี้..."
              value={fgSearch} onChange={e => setFgSearch(e.target.value)} />
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="sortable" onClick={() => fgToggleSort('date')}>วันที่ตัด{fgSi('date')}</th>
                  <th className="sortable" onClick={() => fgToggleSort('code')}>รหัส{fgSi('code')}</th>
                  <th className="sortable" onClick={() => fgToggleSort('name')}>รายการ{fgSi('name')}</th>
                  <th className="sortable" onClick={() => fgToggleSort('invoiceNumber')}>เลขที่ใบแจ้งหนี้{fgSi('invoiceNumber')}</th>
                  <th className="sortable" onClick={() => fgToggleSort('value')}>มูลค่า{fgSi('value')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sortedFgEvents.map((e, i) => (
                  <tr key={i} style={{ cursor: 'pointer' }} onClick={() => setReferenceFilter(e.invoiceNumber)}>
                    <td>{new Date(e.date).toLocaleDateString('th-TH')}</td>
                    <td>{e.code}</td>
                    <td>{e.name}</td>
                    <td>{e.invoiceNumber}</td>
                    <td className="font-mono">{fmt(e.value)}</td>
                    <td style={{ color: 'var(--accent)', whiteSpace: 'nowrap' }}>ดูรายละเอียด →</td>
                  </tr>
                ))}
                {!sortedFgEvents.length && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ไม่มีรายการตัดสต็อกสินค้าสำเร็จรูปในช่วงเวลาที่เลือก</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      ) : showRmList ? (
        <>
          <div style={{ marginBottom: 12 }}>
            <input className="input input-sm" style={{ minWidth: 280 }} placeholder="ค้นหารหัส / รายการ / เลขที่ใบแจ้งหนี้..."
              value={rmSearch} onChange={e => setRmSearch(e.target.value)} />
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="sortable" onClick={() => rmToggleSort('date')}>วันที่ตัด{rmSi('date')}</th>
                  <th className="sortable" onClick={() => rmToggleSort('code')}>รหัส{rmSi('code')}</th>
                  <th className="sortable" onClick={() => rmToggleSort('name')}>รายการ{rmSi('name')}</th>
                  <th className="sortable" onClick={() => rmToggleSort('invoiceNumber')}>เลขที่ใบแจ้งหนี้{rmSi('invoiceNumber')}</th>
                  <th className="sortable" onClick={() => rmToggleSort('value')}>มูลค่า{rmSi('value')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sortedRmEvents.map((e, i) => (
                  <tr key={i} style={{ cursor: 'pointer' }} onClick={() => setReferenceFilter(e.invoiceNumber)}>
                    <td>{new Date(e.date).toLocaleDateString('th-TH')}</td>
                    <td>{e.code}</td>
                    <td>{e.name}</td>
                    <td>{e.invoiceNumber}</td>
                    <td className="font-mono">{fmt(e.value)}</td>
                    <td style={{ color: 'var(--accent)', whiteSpace: 'nowrap' }}>ดูวัตถุดิบที่ตัด →</td>
                  </tr>
                ))}
                {!sortedRmEvents.length && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ไม่มีรายการตัดสต็อกในช่วงเวลาที่เลือก</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      ) : reportKind === 'raw_material' ? (
        <>
          <label className="label" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
            <input type="checkbox" checked={rmHideDetail} onChange={e => setRmHideDetail(e.target.checked)} />
            ซ่อนรายละเอียด (ยอดยกมา/รับเข้า/จำหน่ายออก/คงเหลือ)
          </label>
          {rmHideDetail ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>รหัส</th><th>รายการ</th><th>หน่วย</th><th>จำนวนที่ตัด</th><th>มูลค่าที่ตัด</th></tr>
                </thead>
                <tbody>
                  {rmInvoiceSummary.map(e => (
                    <tr key={e.itemId} style={{ cursor: 'pointer' }} onClick={() => jumpToItemDetail(e)}>
                      <td>{e.code}</td>
                      <td>{e.name}</td>
                      <td>{e.unit}</td>
                      <td className="font-mono">{fmtQty(e.outQty)}</td>
                      <td className="font-mono">{fmt(e.outValue)}</td>
                    </tr>
                  ))}
                  {!rmInvoiceSummary.length && <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ไม่มีรายการตัดวัตถุดิบสำหรับใบแจ้งหนี้นี้</td></tr>}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                {ledgerThead}
                <tbody>{renderLedgerRows(displayRows, { interactive: true, onItemClick: jumpToItemDetail })}</tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <div className="table-wrap">
          <table>
            {ledgerThead}
            <tbody>{renderLedgerRows(displayRows, { interactive: true })}</tbody>
          </table>
        </div>
      )}

      {/* Always-present print document -- hidden on screen (.print-only),
          shown only inside window.print(). Prints exactly what's on
          screen right now (displayRows) -- see the printTotals comment
          above. The print button itself is hidden on list views, so this
          only ever fires from a drilled-in detail view or report 3. */}
      <div className="print-only">
        <div className="printable-document tax-report-print">
          <div className="sheet-inner">
            <header className="doc-header">
              <div className="company-block">
                <div className="company-name">{tenant?.company_name}</div>
                {tenant?.tax_id && <div className="company-meta">เลขประจำตัวผู้เสียภาษีอากร {tenant.tax_id}</div>}
                {tenant?.address && <div className="company-meta">{tenant.address}</div>}
              </div>
              <div className="report-block">
                <span className="report-badge">{activeReportMeta?.badge}</span>
                <h1>{activeReportMeta?.label}</h1>
                <p className="report-subtitle">
                  {reportKind === 'raw_material'
                    ? (rmHideDetail ? 'สรุปรายการวัตถุดิบที่ตัดสำหรับใบแจ้งหนี้นี้' : 'รายละเอียดการตัดวัตถุดิบแบบเต็มสำหรับใบแจ้งหนี้นี้')
                    : activeReportMeta?.subtitle}
                </p>
                <p className="report-period">รอบระยะเวลา {new Date(dateFrom).toLocaleDateString('th-TH')} — {new Date(dateTo).toLocaleDateString('th-TH')}</p>
                {reportKind === 'raw_material' && referenceFilter && (
                  <p className="report-source">สำหรับใบแจ้งหนี้: {referenceFilter}</p>
                )}
                {reportKind === 'all' && itemFilter && (
                  <p className="report-source">กำลังดูเฉพาะ: {itemFilter.code} — {itemFilter.name}</p>
                )}
              </div>
            </header>
            {reportKind === 'raw_material' && rmHideDetail ? (
              <>
                <div className="summary-bar summary-bar-simple">
                  <div className="summary-cell"><span className="summary-label">จำนวนรายการที่ตัด</span><span className="summary-value">{rmInvoiceSummary.length.toLocaleString('th-TH')}</span></div>
                  <div className="summary-cell"><span className="summary-label">มูลค่ารวมที่ตัด</span><span className="summary-value accent">฿{fmt(rmInvoiceSummary.reduce((s, e) => s + e.outValue, 0))}</span></div>
                </div>
                <div className="table-wrap">
                  <table className="ledger">
                    <thead>
                      {printRepeatRow(5)}
                      <tr>
                        <th>รหัส</th><th>รายการ</th><th>หน่วย</th>
                        <th>จำนวนที่ตัด</th><th>มูลค่าที่ตัด (บาท)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rmInvoiceSummary.map(e => (
                        <tr key={e.itemId}>
                          <td>{e.code}</td>
                          <td>{e.name}</td>
                          <td>{e.unit}</td>
                          <td className="font-mono">{fmtQty(e.outQty)}</td>
                          <td className="font-mono">{fmt(e.outValue)}</td>
                        </tr>
                      ))}
                      {!rmInvoiceSummary.length && <tr><td colSpan={5} style={{ textAlign: 'center', padding: 24 }}>ไม่มีรายการตัดวัตถุดิบสำหรับใบแจ้งหนี้นี้</td></tr>}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <>
                <div className="summary-bar">
                  <div className="summary-cell"><span className="summary-label">จำนวนรายการสินค้า</span><span className="summary-value">{displayRows.length.toLocaleString('th-TH')}</span></div>
                  <div className="summary-cell"><span className="summary-label">ยอดยกมา</span><span className="summary-value">฿{fmt(printTotals.openingValue)}</span></div>
                  <div className="summary-cell"><span className="summary-label">รับเข้าระหว่างงวด</span><span className="summary-value">฿{fmt(printTotals.inValue)}</span></div>
                  <div className="summary-cell"><span className="summary-label">จำหน่ายออกระหว่างงวด</span><span className="summary-value">฿{fmt(printTotals.outValue)}</span></div>
                  <div className="summary-cell"><span className="summary-label">ยอดคงเหลือสิ้นงวด</span><span className="summary-value accent">฿{fmt(printTotals.closingValue)}</span></div>
                </div>
                <div className="table-wrap">
                  <table className="ledger">
                    {printLedgerThead}
                    <tbody>{renderLedgerRows(displayRows, { interactive: false })}</tbody>
                  </table>
                </div>
              </>
            )}
            <footer className="doc-footer">
              <p>จัดทำตามมาตรา 87(3) แห่งประมวลรัษฎากร และประกาศอธิบดีกรมสรรพากรเกี่ยวกับภาษีมูลค่าเพิ่ม (ฉบับที่ 89) พ.ศ. 2542 — คำนวณต้นทุนด้วยวิธีถัวเฉลี่ยเคลื่อนที่ (Weighted Average Cost)</p>
              <p>พิมพ์จากระบบ FacadeX ERP เมื่อ {new Date().toLocaleDateString('th-TH')}</p>
            </footer>
          </div>
        </div>
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
  const { data: categories, refetch: refetchCategories } = useCategories()
  // Only categories ticked "ใช้คิดต้นทุน/ตัดสต็อก" in ตั้งค่า > หมวดหมู่ count
  // toward the COGS split -- others still exist as plain item tags (`categories` above).
  const deductionCategories = useMemo(() => (categories || []).filter(c => c.use_for_cost_deduction), [categories])
  const { data: factors, refetch: refetchFactors } = useInventoryItemUnitFactors()
  const { data: balances, refetch: refetchBalances } = useStockBalances()
  const { data: profiles, refetch: refetchProfiles } = useAllAluminumProfiles()
  const [movementItemFilter, setMovementItemFilter] = useState('')
  const [movementTypeFilter, setMovementTypeFilter] = useState('')
  const [movementSiteFilter, setMovementSiteFilter] = useState('')
  const [movementDateFrom, setMovementDateFrom] = useState('')
  const [movementDateTo, setMovementDateTo] = useState('')
  const [movementRefFilter, setMovementRefFilter] = useState(null) // { type, id, label } | null
  const { data: movements, refetch: refetchMovements } = useStockMovements({
    inventoryItemId: movementItemFilter || undefined,
    movementType: movementTypeFilter || undefined,
    siteId: movementSiteFilter || undefined,
    dateFrom: movementDateFrom || undefined,
    dateTo: movementDateTo || undefined,
    referenceType: movementRefFilter?.type,
    referenceId: movementRefFilter?.id,
  })
  const { data: sites } = useSites()
  const { data: allMovements, refetch: refetchAllMovements } = useStockMovements({})
  const { data: allPos } = usePurchaseOrders({})
  const { data: invoiceNumbers } = useInvoiceNumbers()
  const { data: cogsSettings, refetch: refetchCogsSettings } = useInventoryCogsSettings()
  const { data: siteCostEstimates } = useSiteCostEstimates()
  const { data: unprocessedInvoices, refetch: refetchUnprocessedInvoices } = useUnprocessedInvoices()
  const [expandedInvoiceId, setExpandedInvoiceId] = useState(null)
  const [itemsCategoryFilter, setItemsCategoryFilter] = useState('')
  const [itemsSiteFilter, setItemsSiteFilter] = useState('')
  const [itemsSearch, setItemsSearch] = useState('')
  const [itemSortCol, setItemSortCol] = useState('name')
  const [itemSortDir, setItemSortDir] = useState('asc')
  const [movementSortCol, setMovementSortCol] = useState('created_at')
  const [movementSortDir, setMovementSortDir] = useState('desc')
  const [profileSearch, setProfileSearch] = useState('')
  const [profileSortCol, setProfileSortCol] = useState('name')
  const [profileSortDir, setProfileSortDir] = useState('asc')
  const [savingBalance, setSavingBalance] = useState(null) // the balance-row key currently saving, or null
  const [warehousePopup, setWarehousePopup] = useState(null) // { item, balances } | null -- "ดูคลัง" breakdown for a multi-site row

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
  const siteFilterOpts = (sites || []).map(s => ({ value: s.id, label: `${s.site_number} · ${s.name}`, keywords: `${s.site_number} ${s.name}` }))

  const exportMovements = () => {
    const columns = [
      { header: 'วันที่', accessor: m => new Date(m.created_at) },
      { header: 'สินค้า', accessor: m => m.inventory_items?.name || '' },
      { header: 'คลัง', accessor: m => m.sites?.name || '' },
      { header: 'ประเภท', accessor: m => MOVEMENT_TYPE_LABELS[m.movement_type] || m.movement_type },
      { header: 'อ้างอิง', accessor: m => resolveMovementReference(m, { pos: allPos || [], invoices: invoiceNumbers, sites }) },
      { header: 'จำนวน', accessor: m => m.quantity },
      { header: 'หน่วย', accessor: m => m.inventory_items?.base_unit || '' },
      { header: 'ต้นทุน/หน่วย', accessor: m => m.unit_cost ?? '' },
      { header: 'มูลค่ารวม', accessor: m => m.unit_cost != null ? m.quantity * m.unit_cost : '' },
    ]
    exportToExcel(movements || [], columns, 'ประวัติการเคลื่อนไหวสต็อก')
  }

  const itemToggleSort = (col) => {
    if (itemSortCol === col) setItemSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setItemSortCol(col); setItemSortDir('asc') }
  }
  const itemSi = (col) => itemSortCol === col ? (itemSortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕'

  const movementToggleSort = (col) => {
    if (movementSortCol === col) setMovementSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setMovementSortCol(col); setMovementSortDir('asc') }
  }
  const movementSi = (col) => movementSortCol === col ? (movementSortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕'

  const profileToggleSort = (col) => {
    if (profileSortCol === col) setProfileSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setProfileSortCol(col); setProfileSortDir('asc') }
  }
  const profileSi = (col) => profileSortCol === col ? (profileSortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕'

  const centralSite = (sites || []).find(s => s.name === 'ส่วนกลาง')

  // siteId omitted -> latest movement across ANY site for this item (used
  // by the combined multi-site row, where there's no single site to ask).
  const resolveSource = (itemId, siteId) => {
    const itemMovements = (allMovements || []).filter(m => m.inventory_item_id === itemId && (siteId == null || m.site_id === siteId))
    if (!itemMovements.length) return '—'
    const latest = itemMovements.reduce((a, b) => new Date(a.created_at) > new Date(b.created_at) ? a : b)
    return resolveMovementReference(latest, { pos: allPos || [], invoices: invoiceNumbers, sites })
  }

  const tableRows = useMemo(() => {
    const q = itemsSearch.trim().toLowerCase()
    let filteredItems = itemsCategoryFilter
      ? (items || []).filter(it => it.category_id === itemsCategoryFilter)
      : (items || [])
    if (q) filteredItems = filteredItems.filter(it => it.name?.toLowerCase().includes(q) || it.code?.toLowerCase().includes(q))
    // Sort at the item (group) level, not the flat balance-row level -- each
    // item's balance rows must stay contiguous for the merged-cell display
    // (code/name/category/status only render on isFirstForItem) to stay correct.
    filteredItems = filteredItems
      .map(it => ({ ...it, _category: it.expense_categories?.name || '' }))
      .sort((a, b) => {
        const va = a[itemSortCol] ?? ''
        const vb = b[itemSortCol] ?? ''
        if (typeof va === 'number') return itemSortDir === 'asc' ? va - vb : vb - va
        if (typeof va === 'boolean') return itemSortDir === 'asc' ? (va === vb ? 0 : va ? 1 : -1) : (va === vb ? 0 : va ? -1 : 1)
        return itemSortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va))
      })
    const rows = []
    for (const item of filteredItems) {
      let itemBalances = (balances || []).filter(b => b.inventory_item_id === item.id)
      if (itemsSiteFilter) {
        // Filtering to one คลัง -- an item never stocked there has nothing
        // to show, skip it entirely rather than falling back to the
        // "no stock anywhere" placeholder (which defaults to ส่วนกลาง and
        // would be misleading under an unrelated site filter).
        itemBalances = itemBalances.filter(b => b.site_id === itemsSiteFilter)
        if (!itemBalances.length) continue
        itemBalances.forEach((balance, i) => rows.push({ item, balance, isFirstForItem: i === 0 }))
        continue
      }
      if (!itemBalances.length) {
        // No stock anywhere yet -- still show one row (defaulting to
        // ส่วนกลาง) so the item is listed and can be adjusted manually.
        // Once real stock exists somewhere (the common case: received
        // straight to a site via PO), don't also pad in a synthetic 0.00
        // ส่วนกลาง row -- it read as a duplicate line per item for tenants
        // that never stock centrally.
        rows.push({ item, balance: null, isFirstForItem: true })
      } else if (itemBalances.length === 1) {
        rows.push({ item, balance: itemBalances[0], isFirstForItem: true })
      } else {
        // Stock at 2+ sites (e.g. two POs for the same item delivered to
        // two different job sites) -- combine into ONE row instead of one
        // row per site. Reported live: a single catalog item (one real
        // inventory_items row, confirmed live via SQL -- the code was
        // never actually duplicated) showing as separate list rows read
        // as "the system split my material into two items." The
        // breakdown by site is still available -- see the "ดูคลัง" popup.
        rows.push({ item, balance: null, isFirstForItem: true, multiSite: itemBalances })
      }
    }
    return rows
  }, [items, balances, itemsCategoryFilter, itemsSiteFilter, itemsSearch, itemSortCol, itemSortDir, centralSite])

  const exportItems = () => {
    const columns = [
      { header: 'รหัส', accessor: r => r.item.code || '' },
      { header: 'ชื่อ', accessor: r => r.item.name },
      { header: 'หมวดหมู่', accessor: r => r.item._category || '' },
      { header: 'สถานะ', accessor: r => r.item.active ? 'ใช้งานอยู่' : 'ปิดใช้งาน' },
      { header: 'คลัง', accessor: r => r.multiSite ? `${r.multiSite.length} คลัง` : (r.balance ? (r.balance.sites?.name || '') : (centralSite?.name || 'ส่วนกลาง')) },
      { header: 'ปริมาณ', accessor: r => r.multiSite ? aggregateBalances(r.multiSite).qty : (r.balance?.quantity_on_hand ?? 0) },
      { header: 'หน่วย', accessor: r => r.item.base_unit },
      { header: 'ราคา/หน่วย', accessor: r => r.multiSite ? aggregateBalances(r.multiSite).avgCost : (r.balance?.weighted_average_cost ?? 0) },
      { header: 'มูลค่ารวม', accessor: r => r.multiSite ? aggregateBalances(r.multiSite).value : (r.balance?.quantity_on_hand ?? 0) * (r.balance?.weighted_average_cost ?? 0) },
      { header: 'แหล่งที่มาล่าสุด', accessor: r => r.multiSite ? resolveSource(r.item.id) : (r.balance ? resolveSource(r.item.id, r.balance.site_id) : '') },
    ]
    exportToExcel(tableRows, columns, 'สินค้าคงคลัง')
  }

  const sortedMovements = useMemo(() => {
    const rows = (movements || []).map(m => ({
      ...m,
      _item: m.inventory_items?.name || '',
      _site: m.sites?.name || '',
      _typeLabel: MOVEMENT_TYPE_LABELS[m.movement_type] || m.movement_type,
      _total: m.unit_cost != null ? m.quantity * m.unit_cost : null,
    }))
    return [...rows].sort((a, b) => {
      const va = a[movementSortCol] ?? ''
      const vb = b[movementSortCol] ?? ''
      if (typeof va === 'number') return movementSortDir === 'asc' ? va - vb : vb - va
      return movementSortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va))
    })
  }, [movements, movementSortCol, movementSortDir])

  const sortedProfiles = useMemo(() => {
    const q = profileSearch.trim().toLowerCase()
    const rows = (profiles || []).filter(p => !q || p.name?.toLowerCase().includes(q))
    return [...rows].sort((a, b) => {
      const va = a[profileSortCol] ?? ''
      const vb = b[profileSortCol] ?? ''
      if (typeof va === 'number') return profileSortDir === 'asc' ? va - vb : vb - va
      if (typeof va === 'boolean') return profileSortDir === 'asc' ? (va === vb ? 0 : va ? 1 : -1) : (va === vb ? 0 : va ? -1 : 1)
      return profileSortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va))
    })
  }, [profiles, profileSearch, profileSortCol, profileSortDir])

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
        code: form.code || null, name: form.name, base_unit: form.base_unit, active: form.active !== false,
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
        family: form.family || null,
        series: form.series || null,
        thickness_mm: form.thickness_mm ? parseFloat(form.thickness_mm) : null,
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
        <button className={`btn btn-sm ${view === 'invoice_deduction' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('invoice_deduction')}>🧾 ตัดสต็อกจากใบแจ้งหนี้</button>
        <button className={`btn btn-sm ${view === 'profiles' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('profiles')}>📐 หน้าตัดอลูมิเนียม</button>
        <button className={`btn btn-sm ${view === 'movements' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('movements')}>📜 ประวัติการเคลื่อนไหว</button>
        <button className={`btn btn-sm ${view === 'tax_reports' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('tax_reports')}>🧾 รายงานภาษี</button>
      </div>

      {view === 'items' && (
        <>
          {canEdit && <button className="btn btn-primary" style={{ marginBottom: 14 }} onClick={() => { setEditItem(null); setShowForm(true) }}>+ เพิ่มสินค้าคงคลัง</button>}
          {canEdit && <button className="btn btn-ghost" style={{ marginBottom: 14, marginLeft: 8 }} onClick={() => setShowImportItems(v => !v)}>📥 Import Excel</button>}
          <a className="btn btn-ghost" style={{ marginBottom: 14, marginLeft: 8 }} href="/templates/TEMPLATE_รายการสินค้าคงคลัง.xlsx" download>📄 Template</a>
          <button className="btn btn-ghost" style={{ marginBottom: 14, marginLeft: 8 }} onClick={exportItems}>📤 Export Excel</button>
          {showImportItems && (
            <div style={{ marginBottom: 14 }}>
              <ExcelUpload type="inventory_item" onSuccess={() => { setShowImportItems(false); refetchItems() }} />
            </div>
          )}
          {!centralSite && (
            <div className="alert alert-error">ไม่พบไซท์งานชื่อ "ส่วนกลาง" — กรุณาสร้างไซท์งานชื่อนี้ก่อน จึงจะปรับยอดสต็อกได้</div>
          )}
          <div style={{ marginBottom: 14, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ minWidth: 220, maxWidth: 260 }}>
              <SearchableSelect value={itemsCategoryFilter} onChange={setItemsCategoryFilter} placeholder="ทุกหมวดหมู่"
                options={(categories || []).map(c => ({ value: c.id, label: c.name, keywords: c.name }))} />
            </div>
            <div style={{ minWidth: 220, maxWidth: 260 }}>
              <SearchableSelect value={itemsSiteFilter} onChange={setItemsSiteFilter} placeholder="ทุกคลัง" options={siteFilterOpts} />
            </div>
            <input className="input input-sm" style={{ width: 200 }} placeholder="ค้นหาชื่อ / รหัสสินค้า..." value={itemsSearch} onChange={e => setItemsSearch(e.target.value)} />
          </div>
          <div className="card">
            <div style={{ padding: '12px 16px', fontWeight: 700 }}>มูลค่าสต็อกรวม: <span className="font-mono" style={{ color: 'var(--accent)' }}>{fmt(totalValue)}</span> บาท</div>
            <div className="table-wrap">
              <table>
                <thead><tr>
                  <th className="sortable" onClick={() => itemToggleSort('code')}>รหัส{itemSi('code')}</th>
                  <th className="sortable" onClick={() => itemToggleSort('name')}>ชื่อ{itemSi('name')}</th>
                  <th className="sortable" onClick={() => itemToggleSort('_category')}>หมวดหมู่{itemSi('_category')}</th>
                  <th className="sortable" onClick={() => itemToggleSort('active')}>สถานะ{itemSi('active')}</th>
                  <th>คลัง</th><th>ปริมาณ</th><th>ราคา/หน่วย</th><th>มูลค่ารวม</th><th>แหล่งที่มาล่าสุด</th><th></th>
                </tr></thead>
                <tbody>
                  {tableRows.map(({ item, balance, isFirstForItem, multiSite }) => (
                    <BalanceRow
                      key={balance ? balance.id : `${item.id}-empty`}
                      item={item} balance={balance} multiSite={multiSite} isFirstForItem={isFirstForItem}
                      centralSite={centralSite} canEdit={canEdit} savingKey={savingBalance}
                      resolveSource={resolveSource}
                      onSaveBalance={handleSaveBalance}
                      onEditItem={() => { setEditItem(item); setShowForm(true) }}
                      onDeleteItem={() => setDeleteId(item.id)}
                      onViewWarehouses={multiSite ? () => setWarehousePopup({ item, balances: multiSite }) : undefined}
                    />
                  ))}
                  {!tableRows.length && <tr><td colSpan={10} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีสินค้าคงคลัง</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {view === 'invoice_deduction' && (
        <>
          {!categories?.length ? (
            <div className="card" style={{ padding: 16, marginBottom: 14, color: 'var(--text3)' }}>
              ยังไม่มีหมวดหมู่สินค้าคงคลัง — กรุณาสร้างหมวดหมู่ในแท็บ "รายการสินค้าคงคลัง" ก่อน จึงจะตั้งค่าสัดส่วนการตัดสต็อกได้
            </div>
          ) : !deductionCategories.length ? (
            <div className="card" style={{ padding: 16, marginBottom: 14, color: 'var(--text3)' }}>
              ยังไม่ได้ติ๊กหมวดหมู่ไหนไว้ใช้คิดต้นทุน/ตัดสต็อกเลย — ไปติ๊กได้ที่ ตั้งค่า → หมวดหมู่สินค้าคงคลัง
            </div>
          ) : (
            <CogsSettingsPanel settings={cogsSettings} categories={deductionCategories} onSaved={refetchCogsSettings} />
          )}
          {!centralSite && (
            <div className="alert alert-error" style={{ marginBottom: 14 }}>ไม่พบไซท์งานชื่อ "ส่วนกลาง" — การตัดสต็อกจะดึงจากไซท์งานได้อย่างเดียว ไม่มีที่มาสำรอง</div>
          )}
          {(unprocessedInvoices || []).map(inv => (
            <InvoiceDeductionRow
              key={`${inv.id}-${JSON.stringify(cogsSettings)}`} invoice={inv} categories={deductionCategories} items={items} balances={balances}
              centralSite={centralSite} defaultSettings={cogsSettings} siteCostEstimates={siteCostEstimates}
              expanded={expandedInvoiceId === inv.id}
              onToggle={() => setExpandedInvoiceId(id => id === inv.id ? null : inv.id)}
              onConfirmed={() => { setExpandedInvoiceId(null); refetchUnprocessedInvoices(); refetchBalances(); refetchItems() }}
            />
          ))}
          {!(unprocessedInvoices || []).length && (
            <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>ไม่มีใบแจ้งหนี้ที่รอตัดสต็อก</div>
          )}
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
          <div style={{ marginBottom: 14 }}>
            <input className="input input-sm" style={{ width: 200 }} placeholder="ค้นหาชื่อหน้าตัด..." value={profileSearch} onChange={e => setProfileSearch(e.target.value)} />
          </div>
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead><tr>
                  <th className="sortable" onClick={() => profileToggleSort('name')}>ชื่อหน้าตัด{profileSi('name')}</th>
                  <th className="sortable" onClick={() => profileToggleSort('family')}>กลุ่ม{profileSi('family')}</th>
                  <th className="sortable" onClick={() => profileToggleSort('series')}>รุ่น{profileSi('series')}</th>
                  <th className="sortable" onClick={() => profileToggleSort('thickness_mm')}>หนา (มม.){profileSi('thickness_mm')}</th>
                  <th className="sortable" onClick={() => profileToggleSort('linear_weight_kg_per_m')}>กก./เมตร{profileSi('linear_weight_kg_per_m')}</th>
                  <th className="sortable" onClick={() => profileToggleSort('default_length_m')}>ความยาวมาตรฐาน{profileSi('default_length_m')}</th>
                  <th className="sortable" onClick={() => profileToggleSort('active')}>สถานะ{profileSi('active')}</th>
                  <th></th>
                </tr></thead>
                <tbody>
                  {sortedProfiles.map(p => (
                    <tr key={p.id}>
                      <td style={{ fontWeight: 600 }}>{p.name}</td>
                      <td>{p.family || '—'}</td>
                      <td>{p.series || '—'}</td>
                      <td className="font-mono">{p.thickness_mm ?? '—'}</td>
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
                  {!sortedProfiles.length && <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>{profileSearch ? 'ไม่พบหน้าตัดที่ค้นหา' : 'ยังไม่มีหน้าตัด'}</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {view === 'movements' && (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
            <div style={{ minWidth: 220 }}>
              <SearchableSelect value={movementItemFilter} onChange={setMovementItemFilter} placeholder="ทุกรายการสินค้า" options={itemOpts} />
            </div>
            <div style={{ minWidth: 200 }}>
              <SearchableSelect value={movementSiteFilter} onChange={setMovementSiteFilter} placeholder="ทุกคลัง" options={siteFilterOpts} />
            </div>
            <select className="input" style={{ width: 'auto' }} value={movementTypeFilter} onChange={e => setMovementTypeFilter(e.target.value)}>
              <option value="">ทุกประเภท</option>
              {Object.entries(MOVEMENT_TYPE_LABELS).map(([type, label]) => (
                <option key={type} value={type}>{label}</option>
              ))}
            </select>
            <input type="date" className="input" style={{ width: 'auto' }} value={movementDateFrom} onChange={e => setMovementDateFrom(e.target.value)} />
            <span style={{ color: 'var(--text3)' }}>ถึง</span>
            <input type="date" className="input" style={{ width: 'auto' }} value={movementDateTo} onChange={e => setMovementDateTo(e.target.value)} />
            <button className="btn btn-sm" onClick={exportMovements} disabled={!(movements || []).length}>📊 Export Excel</button>
          </div>
          {movementRefFilter && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
              <span className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                🔎 กำลังกรองเฉพาะ: {movementRefFilter.label}
                <button className="btn btn-sm btn-ghost" style={{ padding: '2px 8px' }} onClick={() => setMovementRefFilter(null)}>✕ ล้าง</button>
              </span>
            </div>
          )}
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead><tr>
                  <th className="sortable" onClick={() => movementToggleSort('created_at')}>วันที่{movementSi('created_at')}</th>
                  <th className="sortable" onClick={() => movementToggleSort('_item')}>สินค้า{movementSi('_item')}</th>
                  <th className="sortable" onClick={() => movementToggleSort('_site')}>คลัง{movementSi('_site')}</th>
                  <th className="sortable" onClick={() => movementToggleSort('_typeLabel')}>ประเภท{movementSi('_typeLabel')}</th>
                  <th>อ้างอิง</th>
                  <th className="sortable" onClick={() => movementToggleSort('quantity')}>จำนวน{movementSi('quantity')}</th>
                  <th className="sortable" onClick={() => movementToggleSort('unit_cost')}>ต้นทุน/หน่วย{movementSi('unit_cost')}</th>
                  <th className="sortable" onClick={() => movementToggleSort('_total')}>มูลค่ารวม{movementSi('_total')}</th>
                </tr></thead>
                <tbody>
                  {sortedMovements.map(m => {
                    const refLabel = resolveMovementReference(m, { pos: allPos || [], invoices: invoiceNumbers, sites })
                    const drillable = DRILLABLE_REFERENCE_TYPES.includes(m.reference_type) && m.reference_id
                    const totalValue = m.unit_cost != null ? m.quantity * m.unit_cost : null
                    return (
                      <tr key={m.id}>
                        <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{new Date(m.created_at).toLocaleString('th-TH')}</td>
                        <td>{m.inventory_items?.name}</td>
                        <td style={{ fontSize: 12 }}>{m.sites?.name}</td>
                        <td style={{ fontSize: 12 }}>{MOVEMENT_TYPE_LABELS[m.movement_type] || m.movement_type}</td>
                        <td style={{ fontSize: 12 }}>
                          {drillable ? (
                            <button
                              className="btn-link"
                              style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}
                              onClick={() => setMovementRefFilter({ type: m.reference_type, id: m.reference_id, label: refLabel })}
                            >
                              {refLabel}
                            </button>
                          ) : refLabel}
                        </td>
                        <td className="font-mono">{fmt(m.quantity)} {m.inventory_items?.base_unit}</td>
                        <td className="font-mono">{m.unit_cost != null ? fmt(m.unit_cost) : '—'}</td>
                        <td className="font-mono">{totalValue != null ? fmt(totalValue) : '—'}</td>
                      </tr>
                    )
                  })}
                  {!sortedMovements.length && <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีประวัติ</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {view === 'tax_reports' && <TaxReportsView categories={categories} pos={allPos || []} invoiceNumbers={invoiceNumbers} sites={sites} />}

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

      {warehousePopup && (() => {
        const { qty: totalQty, value: totalValue } = aggregateBalances(warehousePopup.balances)
        return (
          <Modal title={`คลังของ ${warehousePopup.item.name}`} onClose={() => setWarehousePopup(null)} maxWidth={480}>
            <div className="modal-body">
              <div className="table-wrap">
                <table>
                  <thead><tr><th>คลัง</th><th>ปริมาณ</th><th>ราคา/หน่วย</th><th>มูลค่า</th></tr></thead>
                  <tbody>
                    {warehousePopup.balances.map(b => (
                      <tr key={b.id}>
                        <td>{b.sites?.name || '—'}</td>
                        <td className="font-mono">{fmt(b.quantity_on_hand)} {warehousePopup.item.base_unit}</td>
                        <td className="font-mono">{fmt(b.weighted_average_cost)}</td>
                        <td className="font-mono" style={{ fontWeight: 700 }}>{fmt(b.quantity_on_hand * b.weighted_average_cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ fontWeight: 700, borderTop: '1px solid var(--border)' }}>
                      <td>รวม</td>
                      <td className="font-mono">{fmt(totalQty)} {warehousePopup.item.base_unit}</td>
                      <td></td>
                      <td className="font-mono">{fmt(totalValue)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={() => setWarehousePopup(null)}>ปิด</button>
            </div>
          </Modal>
        )
      })()}

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
