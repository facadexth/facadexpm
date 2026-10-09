// src/pages/bomTemplates/HardwarePackagesTab.jsx
// "ชุดอุปกรณ์โครงการ": edits alu_hardware_packages / alu_hardware_package_items. Independent of the template being edited.
import { useState, useMemo } from 'react'
import { useHardwarePackages } from '../../hooks/useEstimation2b.js'
import {
  flatTypeRows, editorRowsFromItems, itemRowsForSave, hardwareSetChoices, SET_UNASSIGNED, SET_NONE,
} from './helpers.js'

export default function HardwarePackagesTab({ types, typesById, index, canEdit }) {
  const { packages, items, loading, savePackage, saveItems } = useHardwarePackages()
  const [pkgId, setPkgId] = useState('')            // '' = nothing chosen; 'new' = unsaved draft
  const [name, setName] = useState('')
  const [seriesId, setSeriesId] = useState('')
  const [rows, setRows] = useState([])
  const [saving, setSaving] = useState(false)
  const typeRows = useMemo(() => flatTypeRows(types, typesById), [types, typesById])
  const seriesList = Object.values(index?.series || {}).filter(s => s.active !== false)

  const pick = (id) => {
    setPkgId(id)
    if (id === 'new' || !id) { setName(''); setSeriesId(''); setRows([]); return }
    const p = packages.find(x => x.id === id)
    setName(p ? p.name : ''); setSeriesId(p?.series_id || ''); setRows(editorRowsFromItems(items, id))
  }
  const setRow = (i, patch) => setRows(r => r.map((x, k) => k === i ? { ...x, ...patch } : x))
  const used = new Set(rows.map(r => r.type_id))

  const save = async () => {
    if (!name.trim()) { alert('กรอกชื่อชุดอุปกรณ์โครงการ'); return }
    setSaving(true)
    try {
      const saved = await savePackage({ id: pkgId === 'new' ? undefined : pkgId, name: name.trim(), series_id: seriesId || null })
      await saveItems(saved.id, itemRowsForSave(rows))
      setPkgId(saved.id)
      setRows(r => r.filter(x => x.choice !== SET_UNASSIGNED))
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setSaving(false) }
  }

  if (loading) return <div style={{ color: 'var(--text3)' }}>กำลังโหลด...</div>
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ fontSize: 12, color: 'var(--text3)' }}>ชุดอุปกรณ์โครงการคือชุดที่กำหนด hardware set ของแต่ละประเภทบาน สร้างครั้งเดียวแล้วเลือกใช้ที่หน้าโปรเจกต์ (ไม่เกี่ยวกับเทมเพลตที่เปิดอยู่) บันทึกแยกจากปุ่มบันทึกเทมเพลต</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 10, alignItems: 'end' }}>
        <div>
          <label className="label">ชุดอุปกรณ์โครงการ</label>
          <select className="input" value={pkgId} onChange={e => pick(e.target.value)}>
            <option value="">— เลือก —</option>
            {pkgId === 'new' && <option value="new">(ชุดใหม่ ยังไม่บันทึก)</option>}
            {packages.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div><label className="label">ชื่อ</label><input className="input" disabled={!canEdit || !pkgId} value={name} onChange={e => setName(e.target.value)} /></div>
        <div>
          <label className="label">ใช้กับซีรีส์</label>
          <select className="input" disabled={!canEdit || !pkgId} value={seriesId} onChange={e => setSeriesId(e.target.value)}>
            <option value="">ทุกซีรีส์</option>
            {seriesList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        {canEdit && <button type="button" className="btn btn-sm btn-ghost" onClick={() => pick('new')}>+ ชุดอุปกรณ์โครงการใหม่</button>}
      </div>
      {pkgId && (
        <>
          <div className="table-wrap"><table>
            <thead><tr><th>ประเภท</th><th>ชุดอุปกรณ์ (hardware set)</th><th></th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    <select className="input input-sm" disabled={!canEdit} value={r.type_id} onChange={e => setRow(i, { type_id: e.target.value, choice: SET_UNASSIGNED })}>
                      <option value="">— เลือกประเภท —</option>
                      {typeRows.filter(t => t.id === r.type_id || !used.has(t.id)).map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                    </select>
                  </td>
                  <td>
                    <select className="input input-sm" disabled={!canEdit || !r.type_id} value={r.choice} onChange={e => setRow(i, { choice: e.target.value })}>
                      <option value={SET_UNASSIGNED}>— ยังไม่กำหนด —</option>
                      <option value={SET_NONE}>— ไม่ใช้ชุดอุปกรณ์ —</option>
                      {hardwareSetChoices(index, seriesId, r.type_id, r.choice).map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                  </td>
                  <td style={{ fontSize: 12, color: r.choice === SET_UNASSIGNED ? 'var(--yellow)' : 'var(--text3)' }}>
                    {r.choice === SET_UNASSIGNED ? 'ยังไม่กำหนด ไม่บันทึกแถวนี้ รายการประเภทนี้คิดราคาโดยไม่มีชุดอุปกรณ์' : ''}
                    {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => setRows(x => x.filter((_, k) => k !== i))}>✕</button>}
                  </td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--text3)', padding: 16 }}>ยังไม่มีประเภท</td></tr>}
            </tbody>
          </table></div>
          {canEdit && (
            <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRows(r => [...r, { type_id: '', choice: SET_UNASSIGNED }])}>+ เพิ่มประเภท</button>
              <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={save}>{saving ? '⏳ กำลังบันทึก...' : '💾 บันทึกชุดอุปกรณ์โครงการ'}</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
