// src/pages/estimation/PreviewPanel.jsx
// Live drawing of the item (mockup screen 2, right column): four styles (Ruling 11) and outside / inside view.
// inputs = itemPreviewInputs(...) of the live item; labels = partLabels(...) for the "parts" style.
// part = { model, buttOf, widthOf, widthMm, heightMm } for a layout_kind template without add-on (useItemModel): the part editor's
// drawing (partSvgString, the same one the saved snapshot and the quotation attachment use) in double-line or solid only.
import { useState, useMemo } from 'react'
import { buildFramePreview } from '../../lib/framePreview.js'
import { partSvgString } from '../../lib/partPreviewSvg.js'
import { safeSvgDataUri } from '../../lib/attachmentPages.js'
import PreviewSvg from './PreviewSvg.jsx'

const STYLES = [['double', 'เส้นคู่'], ['solid', 'สีทึบ'], ['cad', 'เส้นเดียว (CAD)'], ['parts', 'บอกความยาวชิ้นส่วน']]
const PART_STYLES = STYLES.slice(0, 2)
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

export default function PreviewPanel({ inputs, labels, availability, addonPartial, part }) {
  const [chosenStyle, setStyle] = useState('double')
  const [view, setView] = useState('out')
  const styles = part ? PART_STYLES : STYLES
  const style = styles.some(([v]) => v === chosenStyle) ? chosenStyle : 'double'
  const partSrc = useMemo(() => (part ? safeSvgDataUri(partSvgString({ ...part, view, style })) : null), [part, view, style])
  const preview = useMemo(() => {
    if (!inputs || part) return null
    return buildFramePreview({ ...inputs, view, part_labels: style === 'parts' ? labels || undefined : undefined })
  }, [inputs, part, view, style, labels])

  const a = inputs && inputs.addon
  const caption = !inputs || !(preview || partSrc) ? null
    : a ? `ชุดหลัก ${mm(inputs.width_m)} × ${mm(inputs.height_m)} มม. + ของเพิ่มเติม ${mm(a.width_m)} × ${mm(a.height_m)} มม. (${POSITION[a.position] || 'บน'})`
      : `พื้นที่ ${(inputs.width_m * inputs.height_m).toFixed(2)} ตร.ม.`

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ fontWeight: 700 }}>ภาพตัวอย่าง</div>
      <Chips items={styles} value={style} onChange={setStyle} />
      <Chips items={VIEWS} value={view} onChange={setView} />
      {partSrc
        ? <img src={partSrc} alt="ภาพตัวอย่างวงกบและบาน" style={{ width: '100%', height: 'auto', background: '#fff', borderRadius: 8 }} />
        : preview
        ? <PreviewSvg preview={preview} style={style} label="ภาพตัวอย่างวงกบและบาน" />
        : <div style={{ color: 'var(--text3)', fontSize: 13, padding: 24, textAlign: 'center', border: '1px dashed var(--border)', borderRadius: 8 }}>เลือกประเภทและกรอกขนาดเพื่อดูภาพ</div>}
      {caption && <div className="font-mono" style={{ fontSize: 12, color: 'var(--text3)', textAlign: 'center' }}>{caption}</div>}
      {style === 'parts' && preview && !labels && <div style={{ fontSize: 12, color: 'var(--text3)' }}>ยังบอกความยาวชิ้นส่วนไม่ได้ (เทมเพลตไม่มีเส้นวงกบตามกว้าง/สูง หรือยังคิดราคาไม่ได้)</div>}
      {style === 'parts' && preview && labels && <div style={{ fontSize: 12, color: 'var(--text3)' }}>ชิ้นที่ตัด 45° บอกความยาวด้านนอก</div>}
      {addonPartial && <div style={{ fontSize: 12, color: 'var(--text3)' }}>ของเพิ่มเติมยังกรอกไม่ครบ ยังไม่วาดและยังไม่คิดราคา</div>}
      {availability === 'ok' && <span style={{ color: 'var(--green)', fontSize: 12, fontWeight: 600 }}>ซีรีส์นี้ผลิตประเภทนี้ได้</span>}
      {availability === 'not_offered' && <span style={{ color: 'var(--red)', fontSize: 12, fontWeight: 600 }}>ซีรีส์นี้ไม่ผลิตประเภทนี้</span>}
    </div>
  )
}
