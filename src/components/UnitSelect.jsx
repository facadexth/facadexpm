// ============================================================
// UnitSelect — a SearchableSelect over the tenant's known หน่วยนับ
// (units table) with a "+ เพิ่มหน่วย" inline add, same UX as
// QuickAddSelect but operating on the unit's NAME directly as the
// value (not an id) -- catalog_items.unit/quotation_items.unit/
// purchase_order_items.unit all stay plain TEXT, this component only
// supplies known values to pick from or extend, exactly like typing
// always did. Shared across sell-side (CatalogItems, Quotations) and
// buy-side (PurchaseOrders) unit fields.
// ============================================================
import { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import SearchableSelect from './SearchableSelect.jsx'

export default function UnitSelect({ value, onChange, units, onUnitAdded, placeholder = 'หน่วย' }) {
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  const options = (units || []).map(u => ({ value: u.name, label: u.name, keywords: u.name }))

  const handleCreate = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setSaving(true)
    try {
      const { data, error } = await supabase.from('units').insert({ name: trimmed })
        .select().single()
      if (error) throw error
      onChange(data.name)
      setShowCreate(false)
      setName('')
      onUnitAdded?.(data)
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSaving(false) }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 4 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <SearchableSelect value={value || null} onChange={v => onChange(v || '')} options={options} placeholder={placeholder} />
        </div>
        <button type="button" className="btn btn-ghost btn-sm" style={{ flexShrink: 0, padding: '0 8px' }} title="เพิ่มหน่วยใหม่" onClick={() => setShowCreate(s => !s)}>+</button>
      </div>
      {showCreate && (
        <div className="card" style={{ padding: 8, marginTop: 6, display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            className="input input-sm" style={{ flex: 1 }} autoFocus
            value={name} onChange={e => setName(e.target.value)} placeholder="ชื่อหน่วยใหม่ เช่น ตร.ม."
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleCreate() } }}
          />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setShowCreate(false); setName('') }}>ยกเลิก</button>
          <button type="button" className="btn btn-primary btn-sm" disabled={saving || !name.trim()} onClick={handleCreate}>
            {saving ? '⏳' : '✅'}
          </button>
        </div>
      )}
    </div>
  )
}
