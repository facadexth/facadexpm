// src/pages/aluCatalog/SeriesLinkPicker.jsx
// "+ เพิ่มซีรีส์" of a hardware set: extruder → ซีรีส์หลัก → tick its series, optional type → onAdd(seriesIds, typeId).
// Same alu_series_parts rows as the series side ("ชุดอุปกรณ์ที่ซีรีส์นี้ใช้"); the page does the insert.
import { useState } from 'react'
import { familyChoices, familySeries } from '../../lib/seriesFamily.js'

const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'th')

export default function SeriesLinkPicker({ index, typeOptions, busy, onAdd, onClose }) {
  const [providerId, setProviderId] = useState('')
  const [key, setKey] = useState('')
  const [picked, setPicked] = useState([])
  const [typeId, setTypeId] = useState('')
  const providers = Object.values(index.providers).filter(p => p.active !== false).sort(byName)
  const list = key ? familySeries(index, providerId, key) : []
  const toggle = id => setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]))
  return (
    <div className="card" style={{ padding: 12, display: 'grid', gap: 8, background: 'var(--bg3)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
        <select className="input" value={providerId} onChange={e => { setProviderId(e.target.value); setKey(''); setPicked([]) }}>
          <option value="">— โรงรีด —</option>
          {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select className="input" disabled={!providerId} value={key} onChange={e => { setKey(e.target.value); setPicked([]) }}>
          <option value="">— ซีรีส์หลัก —</option>
          {(providerId ? familyChoices(index, providerId) : []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select className="input" value={typeId} onChange={e => setTypeId(e.target.value)}>
          <option value="">ประเภท: ทุกประเภท (ไม่บังคับ)</option>
          {(typeOptions || []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      {list.map(s => (
        <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={picked.includes(s.id)} onChange={() => toggle(s.id)} /> {s.name}
        </label>
      ))}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>ยกเลิก</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy || !picked.length} onClick={() => onAdd(picked, typeId || null)}>เพิ่ม {picked.length} ชุด</button>
      </div>
    </div>
  )
}
