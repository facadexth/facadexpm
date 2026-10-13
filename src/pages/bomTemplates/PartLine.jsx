// src/pages/bomTemplates/PartLine.jsx
// One profile line of the selected position (mockup lineHtml + endsHtml + resHtml): family, read-only profile numbers
// (Ruling PE-3: edited in the catalogue), length rule, deduction (auto/manual + ↺), length factor, pieces per drawn piece,
// thickness role, per-piece per-end controls and the "ที่มา" / result lines. Numbers come from the view (partEditorView).
import { setEndMode, updateLine, updateEnd, LAYOUTS } from '../../lib/partModel.js'
import NumInput from './NumInput.jsx'
import { RULE_LABELS, DEDUCTING, ISSUE_TEXT, STOCK_M, fmt, fmtCount, pieceLabel, refName, endLabels } from './partEditorView.js'

function Explain({ text }) {
  const at = text.lastIndexOf(' = ')
  if (at < 0) return text
  const tail = text.slice(at + 3).replace(/ มม\.$/, '')
  return <>{text.slice(0, at)} = <b>{tail}</b> มม.</>
}

function EndRows({ model, view, posKey, line, i, families, canEdit, onChange, onSelLine }) {
  const lab = endLabels(model, posKey)
  const refs = LAYOUTS[model.layout_kind].order.flatMap(k => (model.lines[k] || []).map((_, li) => ({ key: k, line: li })))
  return (line.ends || []).map((pair, k) => (
    <div className="endrow" key={k}>
      <b>{pieceLabel(model, posKey, k) || 'ชิ้น'}</b>
      {[0, 1].map(e => {
        const p = pair[e]
        if (p.mode === 'mitre') return <span className="endc" key={e}>ปลาย{lab[e]}: <b>เข้ามุม 45°</b> (ตามแบบ)</span>
        const butt = p.mode === 'butt'
        const toVal = p.to ? `${p.to.key}:${p.to.line}` : ''
        return (
          <span className="endc" key={e}>
            <label>ปลาย{lab[e]}{' '}
              <select disabled={!canEdit} value={butt ? 'butt' : 'through'} onChange={ev => { onSelLine(i); onChange(setEndMode(model, posKey, i, k, e, ev.target.value)) }}>
                <option value="through">วิ่งสุด</option>
                <option value="butt">วิ่งชน</option>
              </select>
            </label>
            {butt && <>
              <select disabled={!canEdit} aria-label="ชนกับ (ใช้เติมค่าหักเริ่มต้น)" value={toVal}
                onChange={ev => { const [tk, tl] = ev.target.value.split(':'); onSelLine(i); onChange(updateEnd(model, posKey, i, k, e, { to: tk ? { key: tk, line: Number(tl) } : null })) }}>
                {!p.to && <option value="">— เลือกชิ้นที่ชน —</option>}
                {refs.map(r => {
                  const b = view.buttOfLine(r)
                  return <option key={`${r.key}:${r.line}`} value={`${r.key}:${r.line}`}>ชน {refName(model, r)} ({b == null ? 'ยังไม่มีระยะชน' : fmt(b) + ' มม.'})</option>
                })}
              </select>
              <label>หัก <NumInput className="dedin" disabled={!canEdit} value={view.endDed(p).mm}
                onChange={v => { onSelLine(i); onChange(updateEnd(model, posKey, i, k, e, { deduction_mm: v })) }} /> มม.{p.deduction_mm != null ? ' (แก้เอง)' : ''}</label>
            </>}
          </span>
        )
      })}
    </div>
  ))
}

export default function PartLine({ model, view, posKey, line, i, n, selLine, families, canEdit, onChange, onSelLine, onRemove }) {
  const r = view.lines[posKey]?.[i] || { groups: [], totalM: 0, kg: null, bars: 0 }
  const dedOn = DEDUCTING.has(line.length_rule_type)
  const d = view.deductions(posKey, i)
  const set = patch => onChange(updateLine(model, posKey, i, patch))
  const fam = String(line.profile_family ?? '').trim()
  const famOpts = fam && !families.includes(fam) ? [fam, ...families] : families
  // a blank family that follows another position (layout rule.familyFrom: sliding_n middle / right sashes)
  const inherited = !fam && r.family ? r.family : ''
  const eff = fam || inherited
  const w = eff ? view.widthOf(eff) : null
  const b = eff ? view.buttOf(eff) : null
  return (
    <fieldset className={'ln' + (i === selLine ? ' on' : '')} onFocus={() => { if (i !== selLine) onSelLine(i) }}>
      <legend>โปรไฟล์ที่ {i + 1}{i === selLine ? ' · ปลายที่เห็นในภาพ' : ''}
        {n > 1 && canEdit && <button type="button" className="x" aria-label={`ลบโปรไฟล์ที่ ${i + 1}`} onClick={() => onRemove(i)}>✕</button>}
      </legend>
      <div className="f">
        <span>อลูมิเนียม (ตระกูลโปรไฟล์){i > 0 ? ' · เริ่มต้นเหมือนโปรไฟล์ที่ 1' : ''}</span>
        <select disabled={!canEdit} value={fam} onChange={e => set({ profile_family: e.target.value })}>
          <option value="">{inherited ? `ตามบานแรก (${inherited})` : '— เลือกอลูมิเนียม —'}</option>
          {famOpts.map(f => <option key={f} value={f}>{f}</option>)}
        </select>
      </div>
      <div className="row2 pinfo">
        <div className="f"><span>ความกว้างเต็มของโปรไฟล์ (มม.)</span><input readOnly disabled value={w == null ? '—' : fmt(w)} /></div>
        <div className="f"><span>ระยะชน เมื่อถูกชน หลัง notch (มม.)</span><input readOnly disabled value={b == null ? '—' : fmt(b)} /></div>
        <small className="h" style={{ gridColumn: '1 / -1', color: 'var(--pe-muted)', fontSize: 11 }}>ค่าของโปรไฟล์ที่ซีรีส์/ความหนาที่ใช้ทดสอบ · แก้ที่แคตตาล็อก (ประเมินราคา → 🏭 แคตตาล็อกอลูมิเนียม)</small>
      </div>
      <div className="row2">
        <div className="f"><span>วิธีคิดความยาว</span>
          <select disabled={!canEdit} value={line.length_rule_type} onChange={e => set({ length_rule_type: e.target.value })}>
            {Object.entries(RULE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
        <div className="f">
          <span>ระยะหัก (มม.){dedOn && d.hasAuto && (line.deduction_auto
            ? <> · <span className="tag">อัตโนมัติจากวงกบ</span></>
            : <> · แก้เอง {canEdit && <button type="button" className="x" title="กลับไปใช้ค่าอัตโนมัติจากวงกบ" onClick={() => set({ deduction_auto: true })}>↺</button>}</>)}</span>
          <NumInput disabled={!canEdit || !dedOn} value={dedOn ? d.pre : line.length_deduction_mm}
            onChange={v => set({ length_deduction_mm: v, deduction_auto: false })} />
        </div>
      </div>
      <div className="f"><span>สัดส่วนของความยาวที่ใช้</span>
        <NumInput disabled={!canEdit} value={line.length_factor} onChange={v => set({ length_factor: v })} />
        <small className="h">ปกติ 1 = ยาวเต็ม · 0.5 = ครึ่งหนึ่ง (เช่น รางบานเลื่อนแต่ละบานยาวครึ่งของความกว้างที่เหลือ)</small>
      </div>
      <div className="row2">
        <div className="f"><span>จำนวนท่อนต่อ 1 ชิ้นในภาพ</span>
          <NumInput disabled={!canEdit} value={line.quantity_value} onChange={v => set({ quantity_value: v })} />
          <small className="h">ปกติ 1 · ใส่ 2 ถ้าตำแหน่งนี้ใช้ 2 ท่อนซ้อนกัน จำนวนบานหรือวงกบตั้งที่ Part ด้านบน</small>
        </div>
        <div className="f"><span>ความหนา</span>
          <select disabled={!canEdit} value={line.thickness_role === 'sash' ? 'sash' : ''} onChange={e => set({ thickness_role: e.target.value === 'sash' ? 'sash' : null })}>
            <option value="">ตามกรอบ</option>
            <option value="sash">ตามบาน (sash)</option>
          </select>
        </div>
      </div>
      <div className="f"><span>การชนที่ปลาย: เมื่อวิ่งชน กำหนดค่าหักเองได้ (เติมจากความกว้างโปรไฟล์ที่ชนให้ก่อน) · กดจุดในภาพเพื่อสลับสุด/ชน เมื่อโปรไฟล์นี้เป็นตัวที่เห็นในภาพ</span>
        <EndRows model={model} view={view} posKey={posKey} line={line} i={i} families={families} canEdit={canEdit} onChange={onChange} onSelLine={onSelLine} />
      </div>
      <div className="res">
        {r.unresolved
          ? <span className="warnline">{ISSUE_TEXT[r.unresolved]}</span>
          : <>
            <span className="calc">ที่มา ({pieceLabel(model, posKey, 0) || 'ชิ้นแรก'}): <Explain text={view.explain(posKey, i, 0)} /></span>
            <span><b>ความยาวต่อชิ้น × ปริมาณ (มม.)</b> {r.groups.map(g => fmt(g.len) + ' × ' + fmtCount(g.n)).join(' + ') || '—'}</span>
            <span><b>รวม</b> {fmt(r.totalM, 2)} ม. · <b>น้ำหนัก</b> {r.kg == null ? '—' : fmt(r.kg, 2)} กก. · <b>เส้น {fmt(STOCK_M)} ม.</b> {r.bars}</span>
          </>}
      </div>
    </fieldset>
  )
}
