// src/pages/aluCatalog/StockItemPicker.jsx
// "+ เพิ่ม" of a hardware-set section: search the stock items of the section's categories (on hand + latest purchase
// price), pick one, or create a part that is not in stock (name, unit, optional price). Never writes by itself:
// onPick(item) / onCreate({ name, unit, price }) belong to the page.
import { useState, useMemo } from 'react'
import { supabase } from '../../lib/supabase.js'
import { useQuery } from '../../hooks/useSupabase.js'
import { fetchAllRows } from '../../lib/fetchAllRows.js'
import { stockMatches, onHandByItem, stockLineText } from '../../lib/hardwareSetView.js'
import { latestPurchasePrice } from '../../lib/latestPurchasePrice.js'

export function StockResults({ matches, onHand, prices, priceError = false, busy, onPick }) {
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {matches.map(i => (
        <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div><span className="font-mono" style={{ color: 'var(--text3)' }}>{i.code}</span> {i.name}</div>
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>{stockLineText({ onHand: (onHand || {})[i.id], unit: i.base_unit, price: latestPurchasePrice(prices, i.id), priceFailed: priceError })}</div>
          </div>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => onPick(i)}>เลือก</button>
        </div>
      ))}
    </div>
  )
}

export default function StockItemPicker({ section, busy, onPick, onCreate, onClose }) {
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState({ name: '', unit: '', price: '' })
  const [formError, setFormError] = useState(null)
  const stock = useQuery(async () => {
    const [items, balances] = await Promise.all([
      fetchAllRows(() => supabase.from('inventory_items').select('id, code, name, base_unit, active, category_id, expense_categories(name)').eq('active', true).order('name').order('id')),
      fetchAllRows(() => supabase.from('inventory_stock_balances').select('id, inventory_item_id, quantity_on_hand').order('id')),
    ])
    return { items, onHand: onHandByItem(balances) }
  }, [])
  const matches = useMemo(() => stockMatches({ items: stock.data && stock.data.items, categoryNames: section.categories, query }), [stock.data, section, query])
  const ids = matches.map(m => m.id)
  const prices = useQuery(async () => {
    if (!ids.length) return []
    const { data, error } = await supabase.rpc('stock_item_purchase_prices', { p_item_ids: ids })
    if (error) throw error
    return data || []
  }, [ids.join(',')])

  const create = () => {
    const price = String(draft.price).trim()
    if (!draft.name.trim() || !draft.unit.trim()) { setFormError('กรอกชื่อและหน่วย'); return }
    if (price !== '' && !(Number(price) >= 0)) { setFormError('ราคาต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป'); return }
    setFormError(null)
    onCreate({ name: draft.name.trim(), unit: draft.unit.trim(), price: price === '' ? null : Number(price) })
  }

  return (
    <div className="card" style={{ padding: 12, display: 'grid', gap: 8, background: 'var(--bg3)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>จากสต๊อก (คลังสินค้า หมวด{section.categories.join(' / ')})</div>
        <button type="button" className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }} onClick={onClose}>ปิด</button>
      </div>
      <input className="input" autoFocus placeholder="พิมพ์ชื่อหรือรหัสสินค้า" value={query} onChange={e => setQuery(e.target.value)} />
      {stock.error && <div style={{ color: 'var(--red)', fontSize: 13 }}>โหลดสต๊อกไม่สำเร็จ: {stock.error}</div>}
      {!stock.data && !stock.error && <div style={{ fontSize: 13, color: 'var(--text3)' }}>กำลังโหลดสต๊อก...</div>}
      {stock.data && prices.error && <div style={{ color: 'var(--red)', fontSize: 13 }}>โหลดราคาซื้อไม่สำเร็จ</div>}
      {stock.data && <StockResults matches={matches} onHand={stock.data.onHand} prices={prices.data || []} priceError={!!prices.error} busy={busy} onPick={onPick} />}
      {stock.data && !matches.length && <div style={{ fontSize: 13, color: 'var(--text3)' }}>ไม่พบในสต๊อก</div>}
      {!creating
        ? <button type="button" className="btn btn-sm btn-ghost" style={{ justifySelf: 'start' }} onClick={() => { setCreating(true); setDraft(d => ({ ...d, name: d.name || query.trim() })) }}>+ สร้างรายการใหม่ (ยังไม่มีในสต๊อก)</button>
        : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, alignItems: 'end' }}>
            <div><label className="label">ชื่อ</label><input className="input" value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} /></div>
            <div><label className="label">หน่วย</label><input className="input" value={draft.unit} placeholder="เช่น ชิ้น" onChange={e => setDraft(d => ({ ...d, unit: e.target.value }))} /></div>
            <div><label className="label">ราคา/หน่วย (ไม่บังคับ)</label><input className="input" type="number" min="0" step="any" value={draft.price} onChange={e => setDraft(d => ({ ...d, price: e.target.value }))} /></div>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={create}>สร้างและเพิ่มเข้าชุด</button>
            {formError && <div style={{ gridColumn: '1 / -1', color: 'var(--red)', fontSize: 13 }}>{formError}</div>}
          </div>
        )}
    </div>
  )
}
