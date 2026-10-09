// src/pages/estimation/PreviewPanel.jsx
// Live drawing of the item (mockup screen 2, right column): four styles (Ruling 11) and outside / inside view.
// inputs = itemPreviewInputs(...) of the live item; labels = partLabels(...) for the "parts" style.
import { useState, useMemo } from 'react'
import { buildFramePreview } from '../../lib/framePreview.js'
import PreviewSvg from './PreviewSvg.jsx'

const STYLES = [['double', 'เส้นคู่'], ['solid', 'สีทึบ'], ['cad', 'เส้นเดียว (CAD)'], ['parts', 'บอกความยาวชิ้นส่วน']]
const VIEWS = [['out', 'มองจากภายนอก'], ['in', 'มองจากภายใน']]
const POSITION = { top: 'บน', bottom: 'ล่าง', left: 'ซ้าย', right: 'ขวา' }
const mm = m => Math.round(m * 1000)

function Chips({ items, value, onChange }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {items.map(([v, label]) => (
        <button key={v} type="button" aria-pressed={value === v} className={`btn btn-sm ${value === v ? 'btn-primary' : 'btn-ghost'}`} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  )
}

export default function PreviewPanel({ inputs, labels, availability, addonPartial }) {
  const [style, setStyle] = useState('double')
  const [view, setView] = useState('out')
  const preview = useMemo(() => {
    if (!inputs) return null
    return buildFramePreview({ ...inputs, view, part_labels: style === 'parts' ? labels || undefined : undefined })
  }, [inputs, view, style, labels])

  const a = inputs && inputs.addon
  const caption = !inputs || !preview ? null
    : a ? `ชุดหลัก ${mm(inputs.width_m)} × ${mm(inputs.height_m)} มม. + ของเพิ่มเติม ${mm(a.width_m)} × ${mm(a.height_m)} มม. (${POSITION[a.position] || 'บน'})`
      : `พื้นที่ ${(inputs.width_m * inputs.height_m).toFixed(2)} ตร.ม.`

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ fontWeight: 700 }}>ภาพตัวอย่าง</div>
      <Chips items={STYLES} value={style} onChange={setStyle} />
      <Chips items={VIEWS} value={view} onChange={setView} />
      {preview
        ? <PreviewSvg preview={preview} style={style} label="ภาพตัวอย่างวงกบและบาน" />
        : <div style={{ color: 'var(--text3)', fontSize: 13, padding: 24, textAlign: 'center', border: '1px dashed var(--border)', borderRadius: 8 }}>เลือกประเภทและกรอกขนาดเพื่อดูภาพ</div>}
      {caption && <div className="font-mono" style={{ fontSize: 12, color: 'var(--text3)', textAlign: 'center' }}>{caption}</div>}
      {style === 'parts' && preview && !labels && <div style={{ fontSize: 12, color: 'var(--text3)' }}>ยังบอกความยาวชิ้นส่วนไม่ได้ (เทมเพลตไม่มีเส้นวงกบตามกว้าง/สูง หรือยังคิดราคาไม่ได้)</div>}
      {addonPartial && <div style={{ fontSize: 12, color: 'var(--text3)' }}>ของเพิ่มเติมยังกรอกไม่ครบ ยังไม่วาดและยังไม่คิดราคา</div>}
      {availability === 'ok' && <span style={{ color: 'var(--green)', fontSize: 12, fontWeight: 600 }}>ซีรีส์นี้ผลิตประเภทนี้ได้</span>}
      {availability === 'not_offered' && <span style={{ color: 'var(--red)', fontSize: 12, fontWeight: 600 }}>ซีรีส์นี้ไม่ผลิตประเภทนี้</span>}
    </div>
  )
}
