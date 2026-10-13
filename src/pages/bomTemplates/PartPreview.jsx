// src/pages/bomTemplates/PartPreview.jsx
// Overview + zoom drawings of the part editor (mockup drawOverview / drawZoom). Geometry is partGeometry's
// (overviewSpecs / zoomSpecs); this file only turns those numbers into SVG and wires clicks.
// sliding_2 keeps its frozen pixel overview + zoom (Sliding2Preview). Every other kind (Task 10, mockup v5) is ONE
// millimetre drawing in the geometry's own viewBox (box.x box.y box.w box.h): zoomSpecs of the chosen part tab (other
// parts at opacity 0.25), drawn with the same partSvgSymbols markup as the item / quotation drawing in the chosen D14
// style, pieces clickable (selects { key, line }), curtain-wall cells clickable (cycle glass → awning → spandrel), end
// markers on the selected position (mitred ends show 45° and do not toggle).
import { overviewSpecs, zoomSpecs } from '../../lib/partGeometry.js'
import { glassSvg, pieceSvg, symbolSvg, markSvg, dimSvg } from '../../lib/partSvgSymbols.js'

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

export default function PartPreview(props) {
  return props.model.layout_kind === 'sliding_2' ? <Sliding2Preview {...props} /> : <MmPreview {...props} />
}

const CELL_NAME = { glass: 'กระจก', awning: 'บานกระทุ้ง', spandrel: 'แผงทึบ' }

function MmPreview({ model, sel, view, widthMm, heightMm, widthOf, canEdit, onPick, onToggle, style = 'double', tab = null, onCell }) {
  const zm = zoomSpecs({ model, partKey: tab ? tab.partKey : null, partIdx: tab ? tab.partIdx : null, selected: sel, view, widthMm, heightMm, widthOf })
  const b = zm.box
  if (!b.w || !zm.pieces.length) return <div className="empty">ยังวาดภาพไม่ได้</div>
  const sw = b.sw
  const html = (s) => ({ __html: s })
  const r = sw * 5
  return (
    <>
      <h2 style={{ margin: '4px 0' }}>{zm.title}</h2>
      <svg className="mm" viewBox={`${f1(b.x)} ${f1(b.y)} ${f1(b.w)} ${f1(b.h)}`} role="img" aria-label="ภาพชิ้นส่วนของชุด (คลิกชิ้นเพื่อเลือก)">
        {zm.glass.map((g, i) => <g key={'g' + i} opacity={g.opacity} dangerouslySetInnerHTML={html(glassSvg(g, style, sw))} />)}
        {(zm.cells || []).map(c => (
          <rect key={`c${c.r},${c.c}`} className="cell" data-cell={`${c.r},${c.c}`} data-kind={c.kind} x={f1(c.x)} y={f1(c.y)} width={f1(c.w)} height={f1(c.h)}
            fill="transparent" role={canEdit ? 'button' : undefined} tabIndex={canEdit ? 0 : -1}
            aria-label={`ช่อง ${c.r + 1},${c.c + 1}: ${CELL_NAME[c.kind]}${canEdit ? ' กดเพื่อเปลี่ยน' : ''}`}
            {...(canEdit && onCell ? activate(() => onCell(c.r, c.c)) : {})} />
        ))}
        {zm.pieces.map((p, i) => {
          const live = p.opacity >= 1
          return (
            <g key={'p' + i} className={'pp' + (p.selected ? ' sel' : '') + (p.role === 'extra' ? ' ex' : '')} data-id={p.key} data-part={p.part} data-idx={p.partIdx}
              opacity={p.opacity} role={live ? 'button' : undefined} tabIndex={live ? 0 : -1} aria-label={p.label}
              {...(live ? activate(() => onPick(p.key, p.role === 'extra' ? p.line : 0)) : {})}
              dangerouslySetInnerHTML={html(pieceSvg(p, style, sw))} />
          )
        })}
        {zm.symbols.map((s, i) => <g key={'s' + i} opacity={s.opacity} pointerEvents="none" dangerouslySetInnerHTML={html(symbolSvg(s, sw))} />)}
        {zm.hardwareMarks.map((k, i) => <g key={'k' + i} opacity={k.opacity} pointerEvents="none" dangerouslySetInnerHTML={html(markSvg(k, sw))} />)}
        {zm.dims.map((d, i) => <g key={'d' + i} pointerEvents="none" dangerouslySetInnerHTML={html(dimSvg(d, sw))} />)}
        {zm.markers.map((m, i) => {
          const mitre = m.mode === 'mitre'
          const th = m.mode === 'through'
          const text = mitre ? `ปลายที่ ${m.end + 1}: เข้ามุม 45°` : `ปลายที่ ${m.end + 1}: ${th ? 'วิ่งสุด' : 'วิ่งชน'}`
          const act = canEdit && !mitre ? activate(() => onToggle(m.key, m.piece, m.end, th ? 'butt' : 'through')) : {}
          return (
            <g key={'m' + i}>
              <circle data-k={m.piece} data-e={m.end} tabIndex={canEdit && !mitre ? 0 : -1} role="button" aria-disabled={!canEdit || mitre}
                aria-label={text + (canEdit && !mitre ? ' กดเพื่อสลับ' : '')} cx={f1(m.x)} cy={f1(m.y)} r={f1(r)}
                className={'mk ' + (mitre ? 'mkM ro' : th ? 'mkT' : 'mkB') + (canEdit ? '' : ' ro')} {...act}>
                <title>{text}</title>
              </circle>
              <text className="mkt2" x={f1(m.x)} y={f1(m.y + r * 0.35)} textAnchor="middle" fontSize={f1(r * 0.95)}>{mitre ? '45°' : th ? 'สุด' : 'ชน'}</text>
            </g>
          )
        })}
      </svg>
      <p className="hint">คลิกชิ้นในภาพเพื่อเลือกตำแหน่ง (ชิ้นชื่อเดียวกันใน part เดียวกันกำหนดครั้งเดียว) · เลือกแท็บ part เพื่อให้ part อื่นจางลง · กดจุดที่ปลายเพื่อสลับ เขียว "สุด" = วิ่งสุด, ส้ม "ชน" = วิ่งชน, "45°" = เข้ามุม 45° (ตามแบบ){zm.cells?.length ? ' · คลิกช่องเพื่อวนรอบ กระจก → บานกระทุ้ง → แผงทึบ' : ''}</p>
    </>
  )
}

function Sliding2Preview({ model, sel, partKeys, view, widthMm, heightMm, widthOf, buttOf, canEdit, onPick, onToggle }) {
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
