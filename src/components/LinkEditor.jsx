// src/components/LinkEditor.jsx
// ============================================================
// Many-to-many editor: one checkbox per candidate child for a chosen
// parent, backed by a link table. An optional "extra" column on the link
// row (a role name, a quantity, a type) is edited inline once linked.
// ============================================================
import { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { friendlyDbError } from '../lib/catalogForm.js'

function ExtraInput({ extra, link, canEdit, onSaved }) {
  const [value, setValue] = useState(link[extra.key] ?? '')
  const save = async (next) => {
    const parsed = extra.type === 'number'
      ? (next === '' ? null : parseFloat(next))
      : (next === '' ? null : next)
    if (parsed === (link[extra.key] ?? null)) return
    const { error } = await supabase.from(extra.table).update({ [extra.key]: parsed }).eq('id', link.id)
    if (error) { alert('บันทึกไม่สำเร็จ: ' + friendlyDbError(error)); setValue(link[extra.key] ?? ''); return }
    onSaved()
  }
  if (extra.type === 'select') {
    return (
      <select className="input input-sm" style={{ width: 160 }} disabled={!canEdit} value={value}
        onChange={e => { setValue(e.target.value); save(e.target.value) }}>
        <option value="">{extra.emptyLabel || '—'}</option>
        {(extra.options || []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    )
  }
  return (
    <input className="input input-sm" style={{ width: 140 }} disabled={!canEdit}
      type={extra.type === 'number' ? 'number' : 'text'} step={extra.type === 'number' ? 'any' : undefined}
      placeholder={extra.label} value={value}
      onChange={e => setValue(e.target.value)} onBlur={e => save(e.target.value)} />
  )
}

export default function LinkEditor({ title, hint, linkTable, parentKey, parentId, childKey, childOptions, links, onChanged, canEdit, extra = null }) {
  const mine = (links || []).filter(l => l[parentKey] === parentId)
  const linkFor = (childId) => mine.find(l => l[childKey] === childId)
  const extraWithTable = extra ? { ...extra, table: linkTable } : null

  const toggle = async (child) => {
    const existing = linkFor(child.id)
    if (existing) {
      const { error } = await supabase.from(linkTable).delete().eq('id', existing.id)
      if (error) { alert('ลบไม่สำเร็จ: ' + friendlyDbError(error)); return }
    } else {
      const row = { [parentKey]: parentId, [childKey]: child.id }
      if (extra && extra.defaultFor) row[extra.key] = extra.defaultFor(child)
      const { error } = await supabase.from(linkTable).insert(row)
      if (error) { alert('บันทึกไม่สำเร็จ: ' + friendlyDbError(error)); return }
    }
    onChanged()
  }

  return (
    <div className="card" style={{ padding: 14, marginBottom: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
      {hint && <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>{hint}</div>}
      {!(childOptions || []).length && <div style={{ color: 'var(--text3)' }}>ยังไม่มีรายการให้เลือก</div>}
      <div style={{ display: 'grid', gap: 6 }}>
        {(childOptions || []).map(child => {
          const link = linkFor(child.id)
          return (
            <div key={child.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: canEdit ? 'pointer' : 'default', minWidth: 220 }}>
                <input type="checkbox" disabled={!canEdit} checked={!!link} onChange={() => toggle(child)} />
                {child.label}
              </label>
              {link && extraWithTable && <ExtraInput key={link.id + String(link[extra.key])} extra={extraWithTable} link={link} canEdit={canEdit} onSaved={onChanged} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}
