// src/pages/estimation/ItemAddons.jsx
// "ช่องแสง" box of the item popup (owner-approved mockup v2, 2026-10-15): one row per inline add-on (form.addons, mm)
// with โหมด / ชนิด / ตำแหน่ง / ยาวตามขอบ / สูง|กว้างของช่องแสง / วางเสมอ / ชั้น / ช่อง, a one-line summary, "เสร็จแล้ว ▲ / แก้"
// to collapse, "ลบ", "+ เพิ่มช่องแสง" (max 6) and a range warning per row. A legacy item (has_addon) shows the yellow
// box with "แปลงเป็นช่องแสงแบบใหม่" instead of the list. Mounted only for a template with layout_kind.
import { useState } from 'react'
import {
  newAddon, alignLabel, ADDON_MODES, ADDON_KINDS, ADDON_POSITIONS, ADDON_MODE_LABEL, ADDON_KIND_LABEL, ADDON_POSITION_LABEL, MAX_ADDONS, MAX_ROWS, MAX_COLS,
} from '../../lib/addonModel.js'
import { addonRangeWarnings, addonSize } from './itemForm.js'
import { Field } from './ItemFields.jsx'

const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }
const box = { display: 'grid', gap: 8, border: '1px solid var(--border)', borderRadius: 8, padding: 10 }
const numIn = v => (String(v).trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const shown = v => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '' : v)
const isH = p => p === 'top' || p === 'bottom'

export const addonSummary = a => [
  ADDON_MODE_LABEL[a.mode] || '?', ADDON_KIND_LABEL[a.kind] || '?', ADDON_POSITION_LABEL[a.position] || '?', `${addonSize(a)} มม.`,
  `${shown(a.rows) === '' ? '?' : a.rows} × ${shown(a.cols) === '' ? '?' : a.cols} ช่อง`, alignLabel(a)[a.align === 'end' ? 'end' : 'start'],
  // a converted legacy add-on keeps its offset (no field for it any more): shown so it is not hidden
  ...(Number(a.offset_mm) ? [`เยื้อง ${Number(a.offset_mm)}`] : []),
].join(' · ')

function AddonRow({ a, i, done, warn, dis, onPatch, onToggle, onRemove }) {
  const al = alignLabel(a)
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', display: 'grid', gap: 8, background: 'var(--bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, color: 'var(--accent)' }}>ช่องแสง {i + 1}</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--text3)' }}>{addonSummary(a)}</span>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onToggle}>{done ? 'แก้' : 'เสร็จแล้ว ▲'}</button>
        {!dis && <button type="button" className="btn btn-sm btn-ghost" onClick={onRemove}>ลบ</button>}
      </div>
      {!done && (
        <div style={grid}>
          <Field label="โหมด">
            <select className="input" disabled={dis} value={a.mode} onChange={e => onPatch({ mode: e.target.value })}>
              {ADDON_MODES.map(v => <option key={v} value={v}>{ADDON_MODE_LABEL[v]}</option>)}
            </select>
          </Field>
          <Field label="ชนิด">
            <select className="input" disabled={dis} value={a.kind} onChange={e => onPatch({ kind: e.target.value })}>
              {ADDON_KINDS.map(v => <option key={v} value={v}>{ADDON_KIND_LABEL[v]}</option>)}
            </select>
          </Field>
          <Field label="ตำแหน่ง">
            <select className="input" disabled={dis} value={a.position} onChange={e => onPatch({ position: e.target.value })}>
              {ADDON_POSITIONS.map(v => <option key={v} value={v}>{ADDON_POSITION_LABEL[v]}</option>)}
            </select>
          </Field>
          <Field label="ยาวตามขอบ (มม.)"><input className="input" type="number" min="0" step="1" disabled={dis} value={shown(a.len_mm)} onChange={e => onPatch({ len_mm: numIn(e.target.value) })} /></Field>
          <Field label={`${isH(a.position) ? 'สูง' : 'กว้าง'}ของช่องแสง (มม.)`}><input className="input" type="number" min="0" step="1" disabled={dis} value={shown(a.thick_mm)} onChange={e => onPatch({ thick_mm: numIn(e.target.value) })} /></Field>
          <Field label="วางเสมอ">
            <select className="input" disabled={dis} value={a.align === 'end' ? 'end' : 'start'} onChange={e => onPatch({ align: e.target.value })}>
              <option value="start">{al.start}</option>
              <option value="end">{al.end}</option>
            </select>
          </Field>
          <Field label="ชั้น (rows)"><input className="input" type="number" min="1" max={MAX_ROWS} step="1" disabled={dis} value={shown(a.rows)} onChange={e => onPatch({ rows: numIn(e.target.value) })} /></Field>
          <Field label="ช่อง (cols)"><input className="input" type="number" min="1" max={MAX_COLS} step="1" disabled={dis} value={shown(a.cols)} onChange={e => onPatch({ cols: numIn(e.target.value) })} /></Field>
        </div>
      )}
      {warn && <div style={{ fontSize: 12, color: 'var(--yellow)' }}>⚠ {warn}</div>}
    </div>
  )
}

// addons: form.addons (mm); main: { widthMm, heightMm } of the main window; onChange(nextAddons); legacy: the item has
// the old single add-on (form.has_addon) → onConvert(); loading / error: the item's saved add-ons are not loaded yet.
export default function ItemAddons({ addons, main, onChange, onConvert, legacy = false, loading = false, error = null, dis = false }) {
  const [done, setDone] = useState(() => new Set())
  const list = addons || []
  const warnings = addonRangeWarnings(list, main)
  const title = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ fontWeight: 700, fontSize: 13 }}>ช่องแสง <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text3)' }}>ชิ้นส่วนและ profile มาจาก template</span></span>
      {!legacy && !loading && !error && !dis && (
        <button type="button" className="btn btn-sm btn-ghost" disabled={list.length >= MAX_ADDONS}
          onClick={() => onChange([...list, newAddon({ mainWidthMm: main && main.widthMm, mainHeightMm: main && main.heightMm })])}>+ เพิ่มช่องแสง</button>
      )}
    </div>
  )
  if (error) return <div style={box}>{title}<div className="alert alert-error" style={{ fontSize: 13 }}>โหลดช่องแสงไม่สำเร็จ แก้ช่องแสงของรายการนี้ไม่ได้จนกว่าจะโหลดได้ ({String(error)})</div></div>
  if (loading) return <div style={box}>{title}<div style={{ fontSize: 13, color: 'var(--text3)' }}>กำลังโหลดช่องแสง...</div></div>
  if (legacy) {
    return (
      <div style={box}>
        {title}
        <div className="alert alert-warning" style={{ fontSize: 13, display: 'grid', gap: 6 }}>
          <div>รายการนี้มี &quot;ชุดต่อเติม&quot; แบบเดิมอยู่ (template ช่องแสง + กว้าง/สูง) ใช้ร่วมกับช่องแสงแบบใหม่ไม่ได้</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {!dis && <button type="button" className="btn btn-sm btn-ghost" onClick={onConvert}>แปลงเป็นช่องแสงแบบใหม่</button>}
            <span style={{ fontSize: 12 }}>สร้างช่องแสงแยกวงกบ 1 ชิ้น ขนาดและตำแหน่งเดิม แล้วล้างค่าชุดต่อเติมเดิม</span>
          </div>
        </div>
      </div>
    )
  }
  const patch = (i, p) => onChange(list.map((a, k) => (k === i ? { ...a, ...p } : a)))
  const toggle = i => setDone(s => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n })
  // indices above the removed row shift down by one
  const remove = i => {
    setDone(s => new Set([...s].filter(k => k !== i).map(k => (k > i ? k - 1 : k))))
    onChange(list.filter((_, k) => k !== i))
  }
  return (
    <div style={box}>
      {title}
      {list.map((a, i) => (
        <AddonRow key={i} a={a} i={i} done={done.has(i)} warn={warnings[i]} dis={dis}
          onPatch={p => patch(i, p)} onToggle={() => toggle(i)} onRemove={() => remove(i)} />
      ))}
      <div style={{ fontSize: 12, color: 'var(--text3)' }}>
        {list.length
          ? `${list.length} ชิ้น (สูงสุด ${MAX_ADDONS}) · ชนิดกระทุ้งตอนนี้คิดเหมือนติดตาย (ยังไม่มีชิ้นบานกระทุ้ง)`
          : 'ยังไม่มีช่องแสง กด + เพิ่มช่องแสง'}
      </div>
    </div>
  )
}
