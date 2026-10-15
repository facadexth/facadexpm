// src/pages/bomTemplates/addon/AddonBox.jsx
// The add-on ("ช่องแสง") box under the part editor's width/height bar (mockup v12 #addonBox / renderAddons): one card
// per PREVIEW add-on (UI only, never saved: it shows what a piece set does), "เสร็จแล้ว ▲" collapses a card to its
// summary line, "แก้" opens it again, "ดูภาพขยาย / กำหนดชิ้นส่วน" opens the zoom card. Numbers go through NumInput.
import NumInput from '../NumInput.jsx'
import {
  newAddon, validateAddons, ADDON_MODES, ADDON_KINDS, ADDON_POSITIONS, ADDON_KIND_LABEL, ADDON_POSITION_LABEL,
  MAX_ADDONS, MAX_ROWS, MAX_COLS, ADDON_ALIGNS, alignLabel,
} from '../../../lib/addonModel.js'
import { addonSummary } from './addonView.js'

const MODE_TEXT = { merge: 'ร่วมวงกบ (มีผลกับ type หลัก กรอบเดียวกัน)', attach: 'แยกวงกบ (แปะเพิ่ม ชิ้นแยก ไม่แตะชิ้นหลัก)' }
const isH = (p) => p === 'top' || p === 'bottom'
const whole = (v, hi) => (v == null ? 1 : Math.min(hi, Math.max(1, Math.round(v))))

export default function AddonBox({ addons, onChange, main, sel, onSelect, error = null }) {
  const list = addons || []
  const problem = validateAddons(list.map(({ done, ...a }) => a), main)   // eslint-disable-line no-unused-vars
  const put = (i, patch) => onChange(list.map((a, j) => (j === i ? { ...a, ...patch } : a)))
  const remove = (i) => { onChange(list.filter((_, j) => j !== i)); onSelect(null) }
  const add = () => onChange([...list, newAddon({ mainWidthMm: main.widthMm, mainHeightMm: main.heightMm })])
  const viewBtn = (i, long) => (
    <button type="button" className="btn-s" aria-pressed={sel === i} onClick={() => onSelect(i)}>
      {sel === i ? 'กำลังดูภาพขยาย' : long ? 'ดูภาพขยาย / กำหนดชิ้นส่วน' : 'ดูภาพขยาย'}
    </button>
  )
  const num = (i, label, value, key, unit, opts = {}) => (
    <div className="fld">
      <label htmlFor={`ao${i}${key}`}>{label}</label>
      <NumInput id={`ao${i}${key}`} value={value} step={opts.step ?? 10} min={opts.min ?? 0} max={opts.max}
        onChange={v => put(i, { [key]: opts.whole ? whole(v, opts.max) : v })} />
      <span className="u">{unit}</span>
    </div>
  )
  return (
    <div className="aobox">
      <span className="lg">ช่องแสง (add-on) <span className="hint">อยู่ในส่วนเดียวกับช่องเปิดหลัก ใช้ทดลองดูผลกับขนาดกว้าง × สูงด้านบน ไม่ได้บันทึก</span></span>
      <p className="hint" style={{ marginTop: 0 }}>เพิ่มได้หลายอัน หลายตำแหน่ง เลือกว่าร่วมวงกบกับชิ้นหลักหรือแยกวงกบ ชนิด ตำแหน่ง และขนาด ชิ้นส่วนที่กำหนดในภาพขยายจะบันทึกกับ template นี้</p>
      {list.length === 0 && <p className="hint">ยังไม่มีช่องแสง</p>}
      {list.map((a, i) => a.done ? (
        <div key={i} className="addon done">
          <b>ช่องแสง {i + 1}</b><span>{addonSummary(a)}</span>
          <span className="aoact">
            <button type="button" className="btn-s" onClick={() => put(i, { done: false })}>แก้</button> {viewBtn(i, false)}{' '}
            <button type="button" className="btn-s" onClick={() => remove(i)}>ลบ</button>
          </span>
        </div>
      ) : (
        <div key={i} className="addon">
          <div className="addon-h">
            <b>ช่องแสง {i + 1}</b>
            <span>
              <button type="button" className="btn-s" title="ซ่อนเมื่อแก้เสร็จแล้ว" onClick={() => put(i, { done: true })}>เสร็จแล้ว ▲</button> {viewBtn(i, true)}{' '}
              <button type="button" className="btn-s" onClick={() => remove(i)}>ลบ</button>
            </span>
          </div>
          <div className="fld"><label htmlFor={`ao${i}m`}>การต่อกับชิ้นหลัก</label>
            <select id={`ao${i}m`} value={a.mode} onChange={e => put(i, { mode: e.target.value })}>
              {ADDON_MODES.map(m => <option key={m} value={m}>{MODE_TEXT[m]}</option>)}
            </select><span />
          </div>
          <div className="fld"><label htmlFor={`ao${i}k`}>ชนิดช่อง</label>
            <select id={`ao${i}k`} value={a.kind} onChange={e => put(i, { kind: e.target.value })}>
              {ADDON_KINDS.map(k => <option key={k} value={k}>ช่องแสง{ADDON_KIND_LABEL[k]} (กริด)</option>)}
            </select><span />
          </div>
          <div className="fld"><label htmlFor={`ao${i}p`}>ตำแหน่ง</label>
            <select id={`ao${i}p`} value={a.position}
              onChange={e => { const p = e.target.value; put(i, { position: p, len_mm: isH(p) ? main.widthMm : main.heightMm }) }}>
              {ADDON_POSITIONS.map(p => <option key={p} value={p}>ด้าน{ADDON_POSITION_LABEL[p]}</option>)}
            </select><span />
          </div>
          {num(i, `${isH(a.position) ? 'กว้าง' : 'สูง'} (ตามแนวขอบ)`, a.len_mm, 'len_mm', 'มม.')}
          {num(i, `${isH(a.position) ? 'สูง' : 'กว้าง'} (ความหนาของแถบ)`, a.thick_mm, 'thick_mm', 'มม.')}
          <div className="fld"><label htmlFor={`ao${i}a`}>การจัดแนว</label>
            <select id={`ao${i}a`} value={a.align === 'end' ? 'end' : 'start'} onChange={e => put(i, { align: e.target.value })}>
              {ADDON_ALIGNS.map(v => <option key={v} value={v}>{alignLabel(a)[v]}</option>)}
            </select><span />
          </div>
          {num(i, 'กี่ชั้น', a.rows, 'rows', 'ชั้น', { step: 1, min: 1, max: MAX_ROWS, whole: true })}
          {num(i, 'กี่ช่อง', a.cols, 'cols', 'ช่อง', { step: 1, min: 1, max: MAX_COLS, whole: true })}
        </div>
      ))}
      <div><button type="button" className="btn-s" disabled={list.length >= MAX_ADDONS} onClick={add}>+ เพิ่มช่องแสง</button></div>
      {problem && <div className="callout" role="alert">{problem}</div>}
      {error && <div className="callout" role="alert">{error}</div>}
    </div>
  )
}
