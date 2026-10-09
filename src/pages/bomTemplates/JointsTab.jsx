// src/pages/bomTemplates/JointsTab.jsx
// The two joint tabs of the template editor: "รายละเอียดการประกอบ (จุดชน)" (view="joints") and
// "รายละเอียดการบาก" (view="notch"). State lives in the editor; this only edits the joint rows it is given.
import { useState } from 'react'
import { jointDeductionPreview, mainBarDepthMm, notchGeometry } from './helpers.js'

const CUT_LABELS = { square: 'ตัดตรง 90° ชนหน้า', notch: 'บากมน (notch)', miter45: 'ตัด 45°' }
const MODE_LABELS = { auto: 'อัตโนมัติ: พื้นผิวสัมผัสหลักของเส้นหลัก', manual: 'กำหนดเอง (มม.)' }
const NEW_JOINT = { name: '', main_family: '', secondary_family: '', deduction_mode: 'auto', deduction_mm: '', cut_style: 'square', notch_width_mm: '', notch_depth_mm: '' }

export const emptyJoint = () => ({ ...NEW_JOINT })

function FamilySelect({ value, families, disabled, onChange }) {
  const list = value && !families.includes(value) ? [...families, value] : families
  return (
    <select className="input input-sm" disabled={disabled} value={value || ''} onChange={e => onChange(e.target.value)}>
      <option value="">— เลือก —</option>
      {list.map(f => <option key={f} value={f}>{f}</option>)}
    </select>
  )
}

export function NotchSketch({ style, widthMm, depthMm, mainDepthMm }) {
  const g = notchGeometry({ style, widthMm, depthMm, mainDepthMm })
  return (
    <svg viewBox="0 0 260 150" width="100%" style={{ maxWidth: 340 }} role="img" aria-label="ภาพการบากชน">
      <rect x={g.main.x} y={g.main.y} width={g.main.width} height={g.main.height} fill="var(--bg3)" stroke="var(--text2)" />
      <text x={g.main.x + 70} y={g.main.y + g.main.height / 2 + 4} fontSize="10" fill="var(--text3)" textAnchor="middle">เส้นหลัก ({g.mainDepth} มม.)</text>
      <polygon points={g.points} fill="var(--bg3)" stroke="var(--text2)" strokeWidth="1.4" />
      <text x={g.labelX} y={g.labelY} fontSize="10" fill="var(--text3)" textAnchor="middle">เส้นรอง</text>
    </svg>
  )
}

export default function JointsTab({ view, joints, onChange, onRemove, families, index, typeId, canEdit }) {
  const [sel, setSel] = useState(0)
  const set = (i, patch) => onChange(joints.map((j, idx) => idx === i ? { ...j, ...patch } : j))
  const add = () => { onChange([...joints, emptyJoint()]) }
  const remove = (i) => onRemove(i)   // the editor re-links components, then drops the row

  if (view === 'notch') {
    const i = Math.min(sel, Math.max(joints.length - 1, 0))
    const j = joints[i]
    if (!j) return <div style={{ color: 'var(--text3)', fontSize: 13 }}>ยังไม่มีจุดชน เพิ่มที่แท็บ "รายละเอียดการประกอบ (จุดชน)" ก่อน</div>
    const mainDepth = mainBarDepthMm(index, j.main_family)
    return (
      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ fontSize: 12, color: 'var(--text3)' }}>กำหนดแบบการบากชนของแต่ละจุดชน ภาพวาดด้วยโค้ดตามค่ากว้าง/ลึกที่กรอก (ด้านข้างของเส้นรองที่มาชนเส้นหลัก)</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          <div>
            <label className="label">จุดชน</label>
            <select className="input" value={i} onChange={e => setSel(Number(e.target.value))}>
              {joints.map((x, k) => <option key={k} value={k}>{x.name || `จุดชน ${k + 1}`}</option>)}
            </select>
          </div>
          <div>
            <label className="label">แบบการบาก</label>
            <select className="input" disabled={!canEdit} value={j.cut_style} onChange={e => set(i, { cut_style: e.target.value })}>
              {Object.entries(CUT_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className="label">กว้าง (มม.)</label>
            <input className="input" type="number" min="0" step="any" disabled={!canEdit || j.cut_style !== 'notch'} value={j.notch_width_mm ?? ''} onChange={e => set(i, { notch_width_mm: e.target.value })} />
          </div>
          <div>
            <label className="label">ลึก (มม.)</label>
            <input className="input" type="number" min="0" step="any" disabled={!canEdit || j.cut_style !== 'notch'} value={j.notch_depth_mm ?? ''} onChange={e => set(i, { notch_depth_mm: e.target.value })} />
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text3)' }}>ความลึกเส้นหลัก (อ่านจากแคตตาล็อก): {mainDepth ? `${mainDepth} มม.` : 'ไม่พบ ใช้ 40 มม. วาดภาพ'}</div>
        <NotchSketch style={j.cut_style} widthMm={j.notch_width_mm} depthMm={j.notch_depth_mm} mainDepthMm={mainDepth} />
        {j.cut_style === 'miter45' && <div style={{ fontSize: 12, color: 'var(--yellow)' }}>ความยาวชิ้นตัด 45° ใช้ความยาวด้านนอกเสมอ</div>}
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ fontSize: 12, color: 'var(--text3)' }}>เส้นหลัก = วิ่งต่อเนื่อง, เส้นรอง = มาชนเส้นหลัก ความยาวเส้นรองถูกหักตามที่ตั้งไว้ที่นี่ ส่วนประกอบที่ผูกจุดชนต้องเป็นหน้าตัดเดียวกับเส้นรอง</div>
      {joints.map((j, i) => {
        const prev = jointDeductionPreview(index, j, typeId)
        return (
          <div key={i} className="card" style={{ padding: 10, display: 'grid', gap: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr 32px', gap: 8, alignItems: 'end' }}>
              <div><label className="label">ชื่อจุดชน</label><input className="input input-sm" disabled={!canEdit} value={j.name} placeholder={`จุดชน ${i + 1}`} onChange={e => set(i, { name: e.target.value })} /></div>
              <div><label className="label">เส้นหลัก (วิ่งต่อ)</label><FamilySelect value={j.main_family} families={families} disabled={!canEdit} onChange={v => set(i, { main_family: v })} /></div>
              <div><label className="label">เส้นรอง (มาชน)</label><FamilySelect value={j.secondary_family} families={families} disabled={!canEdit} onChange={v => set(i, { secondary_family: v })} /></div>
              {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => remove(i)}>✕</button>}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1.4fr', gap: 8, alignItems: 'end' }}>
              <div>
                <label className="label">หักความยาวเส้นรอง</label>
                <select className="input input-sm" disabled={!canEdit} value={j.deduction_mode} onChange={e => set(i, { deduction_mode: e.target.value })}>
                  {Object.entries(MODE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
              <div>
                <label className="label">ค่าหัก (มม.)</label>
                <input className="input input-sm" type="number" min="0" step="any" disabled={!canEdit || j.deduction_mode !== 'manual'} value={j.deduction_mm ?? ''} onChange={e => set(i, { deduction_mm: e.target.value })} />
              </div>
              <div>
                <label className="label">แบบการบาก</label>
                <select className="input input-sm" disabled={!canEdit} value={j.cut_style} onChange={e => set(i, { cut_style: e.target.value })}>
                  {Object.entries(CUT_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>
              หักต่อด้าน: {prev.length
                ? prev.map((p, k) => <span key={k}>{k ? ' / ' : ''}{p.mm === null ? 'คำนวณไม่ได้' : `${p.mm} มม.`} ({p.profile})</span>)
                : 'เลือกเส้นหลักเพื่อดูค่าหักจากแคตตาล็อก'}
            </div>
            {j.cut_style === 'miter45' && <div style={{ fontSize: 12, color: 'var(--yellow)' }}>ความยาวชิ้นตัด 45° ใช้ความยาวด้านนอกเสมอ</div>}
            {j.cut_style === 'notch' && <div style={{ fontSize: 12, color: 'var(--text3)' }}>กรอกขนาดบาก (กว้าง/ลึก) ที่แท็บ "รายละเอียดการบาก"</div>}
          </div>
        )
      })}
      {!joints.length && <div style={{ color: 'var(--text3)', fontSize: 13 }}>ยังไม่มีจุดชน</div>}
      {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ justifySelf: 'start' }} onClick={add}>+ เพิ่มจุดชน</button>}
    </div>
  )
}
