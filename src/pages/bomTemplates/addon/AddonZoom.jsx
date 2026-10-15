// src/pages/bomTemplates/addon/AddonZoom.jsx
// Zoom card of one preview add-on (mockup v12 #azoomCard / renderAZoom): the add-on alone with the main unit faded,
// pieces clickable (addonView.zoomPieces), the side panel of the selected piece row (family, reference input, factor,
// deduction, quantity rule + fixed quantity, thickness, note) and the piece table. The set shown is the template's
// saved / edited set, else its defaults (chip "ค่าเริ่มต้น ยังไม่บันทึก"); the first edit copies the defaults.
import NumInput from '../NumInput.jsx'
import { addonDims, REF_INPUTS, QTY_RULES, PIECE_LABEL, ADDON_MODE_LABEL, ADDON_KIND_LABEL, ADDON_POSITION_LABEL } from '../../../lib/addonModel.js'
import { fmt } from '../partEditorView.js'
import { zoomPieces, pieceTableRows, refOptions, glassInfo, tableTotalM, QTY_LABEL, THICK_LABEL } from './addonView.js'
import AddonPieceTable, { lengthCell } from './AddonPieceTable.jsx'

const f1 = x => Number(x).toFixed(1)
const GHOST = 36   // px of the faded main unit drawn on the add-on's main side
const NOTE = {
  merge: 'ช่องแสงแบบร่วมวงกบ อยู่ในกรอบเดียวกับชิ้นหลัก ที่นี่เห็นชิ้นที่ยืด/เพิ่ม: เฟรมของชิ้นหลักที่ยืดมาข้างช่องแสง คานกั้น คิ้ว ซอยกลาง (ชิ้นหลักเป็นภาพจาง) คลิกชิ้นส่วนเพื่อกำหนดโปรไฟล์ อ้างอิงขนาดจาก input ตัวไหน และกี่ท่อน',
  attach: 'ช่องแสงแบบแยกวงกบ ไม่แตะชิ้นหลัก ที่นี่เห็นเฉพาะช่องแสง (ชิ้นหลักเป็นภาพจาง) คลิกชิ้นส่วนแต่ละชิ้นเพื่อกำหนดโปรไฟล์ อ้างอิงขนาดจาก input ตัวไหน และกี่ท่อน',
}

function ZoomSvg({ addon, rows, selKey, onPick }) {   // selKey 'glass' = the panes
  const d = addonDims(addon)
  const w = Number(d.w) || 0, h = Number(d.h) || 0
  if (!(w > 0 && h > 0)) return <div className="empty">ยังวาดภาพไม่ได้ (ขนาดช่องแสงต้องมากกว่า 0)</div>
  const sc = Math.min(440 / w, 250 / h)
  const W = w * sc, H = h * sc
  const pieces = zoomPieces({ addon, rows, scale: sc })
  const p = addon.position
  const ghost = p === 'top' ? { x: 0, y: H, w: W, h: GHOST } : p === 'bottom' ? { x: 0, y: -GHOST, w: W, h: GHOST }
    : p === 'left' ? { x: W, y: 0, w: GHOST, h: H } : { x: -GHOST, y: 0, w: GHOST, h: H }
  const m = GHOST + 8
  const idxOf = (key) => rows.findIndex(r => r.piece_key === key)
  return (
    <svg className="zoom" viewBox={`${-m} ${-m} ${f1(W + 2 * m)} ${f1(H + 2 * m)}`} role="img" aria-label="ภาพขยายช่องแสง (คลิกชิ้นเพื่อเลือก)">
      <rect className="pc ghost" x={f1(ghost.x)} y={f1(ghost.y)} width={f1(ghost.w)} height={f1(ghost.h)} opacity="0.3"><title>ชิ้นหลัก (จาง)</title></rect>
      <rect className={'pc glass' + (selKey === 'glass' ? ' sel' : '')} data-pc="glass" tabIndex={0} role="button" aria-label="กระจก / บาน"
        x="0" y="0" width={f1(W)} height={f1(H)}
        onClick={() => onPick('glass')} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick('glass') } }}>
        <title>กระจก / บาน</title>
      </rect>
      {pieces.map((q, i) => (
        <rect key={i} className={'pc' + (q.key === selKey ? ' sel' : '') + (q.role === 'main' ? ' mainp' : '')} data-pc={q.key} tabIndex={0} role="button"
          aria-label={PIECE_LABEL[q.key] || q.key} x={f1(q.x)} y={f1(q.y)} width={f1(q.w)} height={f1(q.h)}
          onClick={() => onPick(idxOf(q.key))} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(idxOf(q.key)) } }}>
          <title>{PIECE_LABEL[q.key] || q.key}</title>
        </rect>
      ))}
    </svg>
  )
}

function PiecePanel({ addon, row, line, families, canEdit, onEdit, main }) {
  const fams = row.profile_family && !families.includes(row.profile_family) ? [row.profile_family, ...families] : families
  const put = (patch) => { if (canEdit) onEdit(patch) }
  const cell = lengthCell(line)
  return (
    <>
      <h3 className="aoh3">ชิ้นที่เลือก: {PIECE_LABEL[row.piece_key] || row.piece_key}</h3>
      <div className="fld"><label htmlFor="aoFam">โปรไฟล์อะไร</label>
        <select id="aoFam" disabled={!canEdit} value={row.profile_family || ''} onChange={e => put({ profile_family: e.target.value || null })}>
          <option value="">— ไม่ระบุ —</option>
          {fams.map(f => <option key={f} value={f}>{f}</option>)}
        </select><span />
      </div>
      <div className="fld"><label htmlFor="aoRef">อ้างอิงขนาดจาก</label>
        <select id="aoRef" disabled={!canEdit} value={row.ref_input} onChange={e => put({ ref_input: e.target.value })}>
          {refOptions(addon, REF_INPUTS[addon.mode] || [], main).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select><span />
      </div>
      <div className="fld"><label htmlFor="aoMul">ตัวคูณความยาว</label>
        <NumInput id="aoMul" disabled={!canEdit} value={row.length_factor} onChange={v => put({ length_factor: v })} /><span />
      </div>
      <div className="fld"><label htmlFor="aoDed">หัก (มม.)</label>
        <NumInput id="aoDed" disabled={!canEdit} value={row.deduction_mm} onChange={v => put({ deduction_mm: v })} /><span className="u">มม.</span>
      </div>
      <div className="fld"><label htmlFor="aoQ">ปริมาณกี่ท่อน</label>
        <select id="aoQ" disabled={!canEdit} value={row.qty_rule} onChange={e => put({ qty_rule: e.target.value })}>
          {QTY_RULES.map(q => <option key={q} value={q}>{QTY_LABEL[q]}</option>)}
        </select><span />
      </div>
      {row.qty_rule === 'fixed' && (
        <div className="fld"><label htmlFor="aoN">จำนวนท่อน (คงที่)</label>
          <NumInput id="aoN" disabled={!canEdit} step={1} value={row.qty_fixed} onChange={v => put({ qty_fixed: v == null ? 0 : Math.max(0, Math.round(v)) })} /><span className="u">ท่อน</span>
        </div>
      )}
      <div className="fld"><label htmlFor="aoTh">ความหนา</label>
        <select id="aoTh" disabled={!canEdit} value={row.thickness_role || ''} onChange={e => put({ thickness_role: e.target.value || null })}>
          {Object.entries(THICK_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select><span />
      </div>
      <div className="fld"><label htmlFor="aoNote">หมายเหตุ</label>
        <input id="aoNote" type="text" maxLength={120} disabled={!canEdit} value={row.note || ''} onChange={e => put({ note: e.target.value.slice(0, 120) || null })} /><span />
      </div>
      <div className="res tot">
        {line.explain && <span className="calc">ที่มา: {line.explain}</span>}
        <span><b>ความยาว × ท่อน (มม.)</b> {cell ?? '—'}{line.totalM != null ? ` · รวม ${fmt(line.totalM, 2)} ม.` : ''}</span>
        {line.unresolved && <span className="warnline">{line.unresolved}</span>}
      </div>
    </>
  )
}

// Panes are not a piece row (spec 4.2: the infill follows the item): read-only readout from expandAddons(...).glass.
function GlassPanel({ glass }) {
  return (
    <>
      <h3 className="aoh3">ชิ้นที่เลือก: กระจก / บาน</h3>
      {glass
        ? <p className="hint" style={{ marginTop: 0 }}>วัสดุอุดช่อง ไม่ใช่อลูมิเนียม จำนวน = ชั้น × ช่อง = {glass.rows} × {glass.cols} = <b>{glass.count}</b> ช่อง · ขนาดช่องละ ≈ <b>{fmt(glass.widthMm)} × {fmt(glass.heightMm)}</b> มม. (หักระยะชนของเฟรมข้างช่องแสง) · ชนิดกระจกใช้ค่าของรายการ</p>
        : <p className="hint">ยังคิดขนาดกระจกไม่ได้</p>}
    </>
  )
}

export default function AddonZoom({ addon, ai, rows, isDefault, dirty, families, canEdit, pieceIdx, onPick, onEditRow, main, buttOf, layoutKind, model, error = null }) {
  const d = addonDims(addon)
  const isGlass = pieceIdx === 'glass'
  const idx = isGlass ? -1 : Math.min(Math.max(0, pieceIdx || 0), Math.max(0, rows.length - 1))
  const lines = pieceTableRows({ addon, rows, main, buttOf, layoutKind, model })
  const glass = glassInfo({ addon, rows, main, buttOf, layoutKind })
  const row = isGlass ? null : rows[idx]
  return (
    <section className="card2" aria-label="ภาพขยายช่องแสง">
      <h2>
        ภาพขยาย ช่องแสง {ai + 1} ({ADDON_MODE_LABEL[addon.mode]}) · {ADDON_KIND_LABEL[addon.kind]} · ด้าน{ADDON_POSITION_LABEL[addon.position]} · {fmt(d.w)} × {fmt(d.h)} มม.{' '}
        {isDefault ? <span className="tag">ค่าเริ่มต้น ยังไม่บันทึก</span> : dirty ? <span className="tag">แก้แล้ว</span> : null}
      </h2>
      <p className="hint" style={{ marginTop: -4 }}>{NOTE[addon.mode]}</p>
      {error && <div className="callout" role="alert">{error}</div>}
      <div className="top">
        <div>
          <ZoomSvg addon={addon} rows={rows} selKey={isGlass ? 'glass' : row?.piece_key} onPick={i => { if (i === 'glass' || i >= 0) onPick(i) }} />
          <p className="hint">ชิ้นที่ซ้ำกัน (เช่น เฟรมข้าง 2 ข้าง ซอยกลางทุกเส้น) ไฮไลต์พร้อมกัน เพราะเป็นแถวเดียวกันในสูตร · ชิ้นที่จำนวนเป็น 0 ไม่วาด เลือกจากตารางได้ · ตัวเลขใช้ขนาดกว้าง × สูงและซีรีส์ที่ใช้ทดสอบด้านบน</p>
        </div>
        <div>{isGlass ? <GlassPanel glass={glass} /> : row && <PiecePanel addon={addon} row={row} line={lines[idx]} families={families} canEdit={canEdit} main={main} onEdit={patch => onEditRow(idx, patch)} />}</div>
      </div>
      <AddonPieceTable rows={lines} selIdx={isGlass ? 'glass' : idx} onPick={onPick} glass={glass} totalM={tableTotalM(lines)} />
    </section>
  )
}
