// src/pages/estimation/LayoutTemplatePicker.jsx
// Layout-template cards for the chosen main type (mockup screen 2): each card draws the layout on the current
// size; an unusable card is greyed with the reason. Below: "save as layout template" (saved after the item).
import { buildFramePreview } from '../../lib/framePreview.js'
import PreviewSvg from './PreviewSvg.jsx'

const FALLBACK = { grid_row_weights: [1] }

function thumbnail(card, mainTemplate) {
  const a = card.applied
  if (!a) return null
  const p = buildFramePreview({
    template: mainTemplate || FALLBACK, width_m: card.sample.w, height_m: card.sample.h, panel_count: a.main_panel_count,
    main_axis: mainTemplate && mainTemplate.main_axis,
    addon: a.addon_type_id ? { template: card.addonTemplate || FALLBACK, width_m: a.addon_width_m, height_m: a.addon_height_m, panel_count: a.addon_panel_count, position: a.addon_position, offset_m: a.addon_offset_m, main_axis: card.addonTemplate && card.addonTemplate.main_axis } : null,
  })
  return p ? { ...p, dims: [] } : null
}

const cardStyle = (pressed, usable) => ({
  display: 'grid', gap: 4, justifyItems: 'center', width: 132, padding: 6, fontSize: 12, textAlign: 'center',
  border: `1px solid ${pressed ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 8, background: pressed ? 'var(--bg3)' : 'transparent',
  opacity: usable ? 1 : 0.5, cursor: usable ? 'pointer' : 'not-allowed', color: 'var(--text)',
})

export default function LayoutTemplatePicker({ cards, selectedId, mainTemplate, onPick, onClear, disabled, save, onSaveChange, saveError }) {
  return (
    <div style={{ display: 'grid', gap: 8, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
      <div style={{ fontWeight: 700 }}>แม่แบบรูปแบบ <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text3)' }}>แสดงเฉพาะแม่แบบของประเภทชุดหลักที่เลือก</span></div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" aria-pressed={!selectedId} disabled={disabled} style={cardStyle(!selectedId, true)} onClick={onClear}>
          <span style={{ height: 48, display: 'flex', alignItems: 'center', color: 'var(--text3)' }}>ไม่ใช้</span>เริ่มจากว่าง
        </button>
        {cards.map(c => (
          <button key={c.template.id} type="button" aria-pressed={selectedId === c.template.id} disabled={disabled || !c.usable}
            title={c.reasonText || undefined} style={cardStyle(selectedId === c.template.id, c.usable)} onClick={() => onPick(c)}>
            <PreviewSvg preview={thumbnail(c, mainTemplate)} maxWidth={110} label={c.template.name} />
            <span>{c.template.name}</span>
            {c.reasonText && <span style={{ color: 'var(--red)', fontSize: 11 }}>{c.reasonText}</span>}
          </button>
        ))}
      </div>
      {!cards.length && <div style={{ fontSize: 12, color: 'var(--text3)' }}>ยังไม่มีแม่แบบรูปแบบของประเภทนี้</div>}
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
        <input type="checkbox" disabled={disabled} checked={save.on} onChange={e => onSaveChange({ ...save, on: e.target.checked })} />
        บันทึกเป็นแม่แบบรูปแบบตอนกดบันทึกรายการ
      </label>
      {save.on && (
        <div style={{ display: 'grid', gap: 4 }}>
          <label className="label">ชื่อแม่แบบ</label>
          <input className="input" disabled={disabled} value={save.name} onChange={e => onSaveChange({ ...save, name: e.target.value })} placeholder="เช่น หน้าต่าง 2 บาน + ช่องแสงบน" />
          <div style={{ fontSize: 11, color: 'var(--text3)' }}>เก็บ: ประเภทชุดหลัก ประเภทและตำแหน่งของเพิ่มเติม สัดส่วนขนาด ไม่เก็บ: ซีรีส์ สี ราคา</div>
        </div>
      )}
      {saveError && <div className="alert alert-error" style={{ fontSize: 13 }}>{saveError}</div>}
    </div>
  )
}
