// src/pages/bomTemplates/PartPreview.jsx
// Overview + zoom drawings of the part editor (mockup drawOverview / drawZoom). Geometry is partGeometry's
// (overviewSpecs / zoomSpecs); this file only turns those numbers into SVG and wires clicks.
import { overviewSpecs, zoomSpecs } from '../../lib/partGeometry.js'

const f1 = x => Number(x).toFixed(1)
const activate = fn => ({
  onClick: fn,
  onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn() } },
})

function Pieces({ pieces, sel, partKeys, zoom, onPick }) {
  return pieces.map((p, i) => {
    if (p.role === 'extra') {
      const xsel = sel.key === p.key && sel.line === p.line
      return <rect key={i} className={'extra' + (xsel ? ' xsel' : '')} x={f1(p.x)} y={f1(p.y)} width={f1(p.w)} height={f1(p.h)} pointerEvents="none" />
    }
    const cls = 'part' + (sel.key === p.key ? ' sel' : (partKeys.includes(p.key) ? (zoom ? ' dimp' : ' grp') : ''))
    return (
      <rect key={i} className={cls} data-id={p.key} tabIndex={0} role="button" aria-label={p.label}
        x={f1(p.x)} y={f1(p.y)} width={f1(p.w)} height={f1(p.h)} {...activate(() => onPick(p.key))}>
        <title>{p.label}</title>
      </rect>
    )
  })
}

export default function PartPreview({ model, sel, partKeys, view, widthMm, heightMm, widthOf, buttOf, canEdit, onPick, onToggle }) {
  const ov = overviewSpecs({ model, widthMm, heightMm, view, widthOf })
  const zm = zoomSpecs({ model, selected: sel, view, widthMm, heightMm, buttOf })
  const labelOf = (m) => zm.pieces.find(p => p.key === m.key && p.piece === m.piece && p.role === 'main')?.label || ''
  return (
    <>
      <svg viewBox={`0 0 ${ov.box.w} ${ov.box.h}`} role="img" aria-label="ภาพตัวอย่างวงกบและบานเลื่อน">
        <Pieces pieces={ov.pieces} sel={sel} partKeys={partKeys} zoom={false} onPick={onPick} />
        {ov.dims.map((d, i) => (
          <g key={i}>
            <line className="dim" x1={f1(d.x1)} y1={f1(d.y1)} x2={f1(d.x2)} y2={f1(d.y2)} />
            <text className="dimt" x={f1(d.tx)} y={f1(d.ty)} textAnchor={d.anchor}>{d.value}</text>
          </g>
        ))}
      </svg>
      <h2 style={{ margin: '12px 0 4px' }}>{zm.title || 'ภาพขยาย'}</h2>
      <svg className="zoom" viewBox={`0 0 ${zm.box.w} ${zm.box.h}`} role="img" aria-label="ภาพขยายของ part ที่เลือก">
        <Pieces pieces={zm.pieces} sel={sel} partKeys={partKeys} zoom onPick={onPick} />
        {zm.markers.map((m, i) => {
          const th = m.mode === 'through'
          const text = `${labelOf(m)} ปลายที่ ${m.end + 1}: ${th ? 'วิ่งสุด' : 'วิ่งชน'}`
          const act = canEdit ? activate(() => onToggle(m.key, m.piece, m.end, th ? 'butt' : 'through')) : {}
          return (
            <g key={i}>
              <circle data-k={m.piece} data-e={m.end} tabIndex={canEdit ? 0 : -1} role="button" aria-disabled={!canEdit}
                aria-label={text + (canEdit ? ' กดเพื่อสลับ' : '')} cx={f1(m.x)} cy={f1(m.y)} r="12"
                className={'mk ' + (th ? 'mkT' : 'mkB') + (canEdit ? '' : ' ro')} {...act}>
                <title>{text + (canEdit ? ' (กดเพื่อสลับ)' : '')}</title>
              </circle>
              <text className="mkt big" x={f1(m.x)} y={f1(m.y + 4)} textAnchor="middle">{th ? 'สุด' : 'ชน'}</text>
            </g>
          )
        })}
      </svg>
      <p className="hint">คลิกชิ้นในภาพ หรือคลิกแถวในตาราง · ภาพบนเป็นภาพรวม (คลิกเลือกชิ้น) ภาพล่างขยาย part ที่เลือก กดจุดที่ปลายในภาพขยายเพื่อสลับ: เขียว "สุด" = วิ่งสุด, ส้ม "ชน" = วิ่งชน ทุกปลายของทุกชิ้นตั้งแยกกัน (เฟรมข้างซ้าย/ขวา บน/ล่าง บานซ้าย/บานขวา) ชิ้นในภาพสั้นลงตามปลายที่ชน (วาดขยายให้เห็น ตัวเลขใช้มม.จริง) ชิ้นที่ซ้ำกัน (เฟรมข้างซ้าย/ขวา) ไฮไลต์พร้อมกัน เพราะเป็นแถวเดียวกันในสูตร</p>
    </>
  )
}
