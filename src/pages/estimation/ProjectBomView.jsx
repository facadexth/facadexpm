// src/pages/estimation/ProjectBomView.jsx
// "BOM ทั้งโครงการ" (mockup screen 6): every item's BOM x its quantity rolled up. Uses the costs the project page
// already computed (costOpening with the project's hardware package), never a second calculation.
import { useMemo, useState } from 'react'
import { fmt } from '../../lib/supabase.js'
import { buildProjectBom, stockForProject } from '../../lib/projectBom.js'
import { reasonText } from '../../lib/reasonText.js'
import { useProjectStock } from '../../hooks/useEstimation2b.js'
import { buildEntries, entriesPieceCount, seriesByGroup, parseStockLength, MAX_PIECES } from './projectBomHelpers.js'
import { saveProfileStock, saveProjectStockLength } from './projectStockSave.js'
import BomProfilesTable from './BomProfilesTable.jsx'
import CutOptimizerPanel from './CutOptimizerPanel.jsx'
import ProviderCompare from './ProviderCompare.jsx'

const Section = ({ title, children }) => (
  <div className="card" style={{ padding: 16, display: 'grid', gap: 8 }}>
    <div style={{ fontWeight: 700 }}>{title}</div>
    {children}
  </div>
)

export default function ProjectBomView({ project, items, costs, base, index, seriesTypes, settings, canEdit, onProjectSaved }) {
  const stockQ = useProjectStock()
  const stockRows = stockQ.data
  const [stockText, setStockText] = useState(project.stock_length_m ? String(project.stock_length_m) : '')

  const { entries, skipped } = useMemo(() => buildEntries(items, costs), [items, costs])
  const pieces = useMemo(() => entriesPieceCount(entries), [entries])
  const tooMany = pieces > MAX_PIECES
  const stock = useMemo(() => stockForProject(stockRows, project.id, project), [stockRows, project])
  const bom = useMemo(() => (tooMany || stockQ.loading ? null : buildProjectBom({ entries, settings, stock, profilesById: index.profiles, finishesById: index.finishes, partsById: index.parts })),
    [entries, settings, stock, index, tooMany, stockQ.loading])
  const seriesMap = useMemo(() => Object.fromEntries(Object.entries(seriesByGroup(entries)).map(([k, s]) => [k, [...s]])), [entries])

  const saveProfile = async (profileId, value) => { await saveProfileStock(project.id, profileId, value); await stockQ.refetch() }
  const commitProjectStock = async () => {
    const v = parseStockLength(stockText)
    const was = project.stock_length_m ? Number(project.stock_length_m) : null
    if (Number.isNaN(v)) { alert('ความยาวเส้นต้องเป็นตัวเลขมากกว่า 0 และไม่เกิน 20 ม.'); setStockText(was ? String(was) : ''); return }
    if (v === was) return
    try { await saveProjectStockLength(project.id, v); await onProjectSaved() } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
  }

  if (stockQ.error) return <div className="alert alert-error">โหลดความยาวเส้นไม่สำเร็จ: {String(stockQ.error)}</div>
  if (!items.length) return <div style={{ color: 'var(--text3)', padding: 20 }}>ยังไม่มีรายการในโปรเจกต์</div>
  if (tooMany) return <div className="alert alert-error">จำนวนชิ้นที่ต้องตัดมีมากเกินไป ({pieces.toLocaleString('en-US')} ชิ้น) ตรวจจำนวนชุดของแต่ละรายการ (เกิน {MAX_PIECES.toLocaleString('en-US')} ชิ้นจะไม่คำนวณ)</div>
  if (!bom) return <div style={{ color: 'var(--text3)', padding: 20 }}>กำลังโหลด...</div>

  const problems = [
    ...skipped.map(s => ({ opening_no: s.opening_no, name: s.name || 'ทั้งรายการ', text: 'ไม่พบเทมเพลต' })),
    ...bom.unresolved.map(u => ({ opening_no: u.opening_no, name: u.name, text: reasonText(u.reason) })),
  ]
  const accessories = bom.parts.filter(p => p.kind === 'accessory')
  const hardware = bom.parts.filter(p => p.kind !== 'accessory')
  const PartsTable = ({ rows }) => (
    <div className="table-wrap"><table>
      <thead><tr><th>รหัส</th><th>ชื่อ</th><th>จำนวนรวม</th><th>ต้นทุน (฿)</th></tr></thead>
      <tbody>{rows.map(p => (
        <tr key={p.key}><td>{p.code || '—'}</td><td>{p.name}</td><td className="font-mono">{Number(p.quantity).toFixed(2).replace(/\.00$/, '')}</td>
          <td className="font-mono">{p.resolved ? fmt(p.cost) : <span style={{ color: 'var(--red)' }}>— ราคายังไม่ครบ</span>}</td></tr>
      ))}</tbody>
    </table></div>
  )
  const notLinked = ['shim_part_id', 'screw_part_id', 'plug_part_id'].some(k => !settings[k])

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {problems.length > 0 && (
        <div className="alert alert-warning" style={{ fontSize: 13 }}>
          <b>คิดไม่ครบ {problems.length} จุด — ยอดด้านล่างอาจไม่ครบ</b>
          <ul style={{ margin: '4px 0 0 18px' }}>{problems.map((p, i) => <li key={i}>{p.opening_no} · {p.name || '?'}: {p.text}</li>)}</ul>
        </div>
      )}

      <Section title="ความยาวเส้นมาตรฐาน">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="label" style={{ margin: 0 }}>ความยาวเส้นของโปรเจกต์ (ม.)</label>
          <input className="input" style={{ width: 100 }} inputMode="decimal" disabled={!canEdit} value={stockText} placeholder={String(settings.stock_length_m)}
            onChange={e => setStockText(e.target.value)} onBlur={commitProjectStock} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
          <span style={{ fontSize: 12, color: 'var(--text3)' }}>ว่าง = ค่ามาตรฐานของบริษัท {settings.stock_length_m} ม. · ลำดับ: ตั้งเองต่อหน้าตัด &gt; ของโปรเจกต์ &gt; มาตรฐาน</span>
        </div>
      </Section>

      <Section title="1. อลูมิเนียมโปรไฟล์ (แยกตามหน้าตัดและสี)">
        <BomProfilesTable profiles={bom.profiles} overrides={stock.byProfile} canEdit={canEdit} onSaveStock={saveProfile} />
      </Section>

      <CutOptimizerPanel profiles={bom.profiles} seriesMap={seriesMap} index={index} settings={settings} asOf={project.price_as_of} canEdit={canEdit} onUseLength={saveProfile} />

      <Section title="2. อุปกรณ์และชิ้นส่วน">
        {hardware.length > 0 && <><div style={{ fontSize: 12, color: 'var(--text3)' }}>อุปกรณ์ (hardware)</div><PartsTable rows={hardware} /></>}
        {accessories.length > 0 && <><div style={{ fontSize: 12, color: 'var(--text3)' }}>อุปกรณ์เสริม (accessory)</div><PartsTable rows={accessories} /></>}
        {!bom.parts.length && <div style={{ color: 'var(--text3)', fontSize: 13 }}>ไม่มีอุปกรณ์</div>}
        {notLinked && <div style={{ fontSize: 12, color: 'var(--text3)' }}>shim / สกรู / พุกพลาสติก ยังปิดอยู่ จนกว่าจะผูกชิ้นส่วนในตั้งค่าการประเมินราคา</div>}
      </Section>

      <Section title="3. ซีลแลนท์">
        <div className="table-wrap"><table>
          <thead><tr><th>ความยาวแนวที่ต้องอุดรวม (ม.)</th><th>ม./หลอด (300 มล.)</th><th>จำนวนหลอด</th></tr></thead>
          <tbody><tr><td className="font-mono">{bom.sealant.length_m.toFixed(1)}</td><td className="font-mono">{bom.sealant.m_per_tube}</td><td className="font-mono"><b>{bom.sealant.tubes}</b></td></tr></tbody>
        </table></div>
        <div style={{ fontSize: 12, color: 'var(--text3)' }}>ปัดขึ้นเป็นหลอดครั้งเดียวทั้งโครงการ · ต้นทุนซีลแลนท์ยังคิดจากค่าซิลิโคนต่อเมตรในเทมเพลต ไม่ได้คิดจากจำนวนหลอด</div>
      </Section>

      <ProviderCompare project={project} items={items} base={base} index={index} seriesTypes={seriesTypes} canEdit={canEdit} onApplied={onProjectSaved} />
    </div>
  )
}
