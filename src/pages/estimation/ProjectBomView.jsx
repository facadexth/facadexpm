// src/pages/estimation/ProjectBomView.jsx
// "BOM ทั้งโครงการ" (mockup screen 6): every item's BOM x its quantity rolled up. Uses the costs the project page
// already computed (costOpening with the project's hardware package), never a second calculation.
import { useMemo, useState } from 'react'
import { fmt } from '../../lib/supabase.js'
import { buildProjectBom, stockForProject } from '../../lib/projectBom.js'
import { reasonText } from '../../lib/reasonText.js'
import { buildCutPlan, rangeLengths } from '../../lib/cutPlan.js'
import { useProjectStock, useOffcuts, offcutsByGroup } from '../../hooks/useEstimation2b.js'
import {
  buildEntries, entriesPieceCount, seriesByGroup, MAX_PIECES, cutGroupInfo, cutGroupKgPerM, cutGroupOverrides, cutGroupPricePerKg,
  lengthCompare, bestLengthsByProfile, bomStockBasis,
} from './projectBomHelpers.js'
import { saveProfileStock } from './projectStockSave.js'
import BomProfilesTable from './BomProfilesTable.jsx'
import CutOptimizerPanel from './CutOptimizerPanel.jsx'
import CutModeField from './CutModeField.jsx'
import CustomLengthSummary from './CustomLengthSummary.jsx'
import ProviderCompare from './ProviderCompare.jsx'

const PartsTable = ({ rows }) => (
  <div className="table-wrap"><table>
    <thead><tr><th>รหัส</th><th>ชื่อ</th><th>จำนวนรวม</th><th>ต้นทุน (฿)</th></tr></thead>
    <tbody>{rows.map(p => (
      <tr key={p.key}><td>{p.code || '—'}</td><td>{p.name}</td><td className="font-mono">{Number(p.quantity).toFixed(2).replace(/\.00$/, '')}</td>
        <td className="font-mono">{p.resolved ? fmt(p.cost) : <span style={{ color: 'var(--red)' }}>— ราคายังไม่ครบ</span>}</td></tr>
    ))}</tbody>
  </table></div>
)

const Section = ({ title, children }) => (
  <div className="card" style={{ padding: 16, display: 'grid', gap: 8 }}>
    <div style={{ fontWeight: 700 }}>{title}</div>
    {children}
  </div>
)

export default function ProjectBomView({ project, items, costs, base, index, seriesTypes, settings, canEdit, onProjectSaved }) {
  const stockQ = useProjectStock()
  const stockRows = stockQ.data
  const offcutsQ = useOffcuts()
  const [offcutsFirst, setOffcutsFirst] = useState(true)
  // 'stock' = normal job (market bar only), 'custom' = project job (custom lengths). No column yet = 'stock'.
  const cutMode = project.cut_mode === 'custom' ? 'custom' : 'stock'
  const isCustom = cutMode === 'custom'

  const { entries, skipped } = useMemo(() => buildEntries(items, costs), [items, costs])
  const pieces = useMemo(() => entriesPieceCount(entries), [entries])
  const tooMany = pieces > MAX_PIECES
  const projectStock = useMemo(() => stockForProject(stockRows, project.id, project), [stockRows, project])
  // Same stock basis as the cut plan (market bar; per-profile lengths only in a project job), so section 1 and the
  // summary never disagree.
  const stock = useMemo(() => bomStockBasis(cutMode, projectStock), [cutMode, projectStock])
  const bom = useMemo(() => (tooMany || !stockRows ? null : buildProjectBom({ entries, settings, stock, profilesById: index.profiles, finishesById: index.finishes, partsById: index.parts })),
    [entries, settings, stock, index, tooMany, stockRows])
  const seriesMap = useMemo(() => Object.fromEntries(Object.entries(seriesByGroup(entries)).map(([k, s]) => [k, [...s]])), [entries])

  // The ONE cut plan of this tab (summary, cut sheet, stickers and offcut stock all read it).
  const groupInfo = useMemo(() => cutGroupInfo(entries, index), [entries, index])
  const kgPerM = useMemo(() => cutGroupKgPerM(groupInfo, index), [groupInfo, index])
  const offcuts = useMemo(() => (offcutsFirst ? offcutsByGroup(offcutsQ.data) : {}), [offcutsFirst, offcutsQ.data])
  const overrides = useMemo(() => (isCustom ? cutGroupOverrides(groupInfo, projectStock.byProfile) : {}), [isCustom, groupInfo, projectStock])
  // Never plan while the offcut stock is still loading (an issued plan must not silently skip offcuts); a load error
  // plans without offcuts and says so.
  const offcutsReady = !offcutsFirst || !!offcutsQ.data || !!offcutsQ.error
  const plan = useMemo(() => (tooMany || !stockRows || !offcutsReady ? null : buildCutPlan({ entries, mode: cutMode, settings, kgPerM, offcutsByGroup: offcuts, overrides, groupInfo })),
    [tooMany, stockRows, offcutsReady, entries, cutMode, settings, kgPerM, offcuts, overrides, groupInfo])
  // Independent of the per-profile overrides: saving a length does not recompute the whole length search.
  const compare = useMemo(() => (isCustom && !tooMany && offcutsReady ? lengthCompare({ entries, settings, kgPerM, offcutsByGroup: offcuts }) : null),
    [isCustom, tooMany, offcutsReady, entries, settings, kgPerM, offcuts])
  const prices = useMemo(() => cutGroupPricePerKg({ groupInfo, index, seriesMap, asOf: project.price_as_of, kgPerM }), [groupInfo, index, seriesMap, project.price_as_of, kgPerM])
  const rangeM = useMemo(() => (isCustom ? rangeLengths(settings) : null), [isCustom, settings])

  const saveProfile = async (profileId, value) => { await saveProfileStock(project.id, profileId, value); await stockQ.refetch() }
  // Sequential: one profile's write failing stops the rest, and the list is reloaded either way.
  const applyAllBest = async () => {
    try { for (const t of bestLengthsByProfile(plan, compare)) await saveProfileStock(project.id, t.profile_id, t.length_m) }
    finally { await stockQ.refetch() }
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
  const notLinked = ['shim_part_id', 'screw_part_id', 'plug_part_id'].some(k => !settings[k])

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {problems.length > 0 && (
        <div className="alert alert-warning" style={{ fontSize: 13 }}>
          <b>คิดไม่ครบ {problems.length} จุด — ยอดด้านล่างอาจไม่ครบ</b>
          <ul style={{ margin: '4px 0 0 18px' }}>{problems.map((p, i) => <li key={i}>{p.opening_no} · {p.name || '?'}: {p.text}</li>)}</ul>
        </div>
      )}

      <Section title="ประเภทงาน">
        <CutModeField project={project} settings={settings} canEdit={canEdit} onProjectSaved={onProjectSaved} />
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={offcutsFirst} onChange={e => setOffcutsFirst(e.target.checked)} />
          ใช้เศษในสต็อกก่อนตัดเส้นใหม่
        </label>
        {offcutsFirst && offcutsQ.error && <div style={{ fontSize: 12, color: 'var(--red)' }}>โหลดเศษในสต็อกไม่สำเร็จ — คิดโดยไม่ใช้เศษ: {String(offcutsQ.error.message || offcutsQ.error)}</div>}
        <div style={{ fontSize: 12, color: 'var(--text3)' }}>
          {isCustom
            ? `สั่งได้ ${Number(settings.custom_len_min_m).toFixed(2)}–${Number(settings.custom_len_max_m).toFixed(2)} ม. ทีละ ${settings.custom_len_step_m} ม. · ขั้นต่ำสั่งพิเศษ ${Number(settings.custom_moq_kg).toLocaleString('en-US')} กก. ทั้งโครงการ (แก้ที่ตั้งค่า)`
            : `งานทั่วไปใช้เส้นมาตรฐาน ${Number(settings.stock_length_m).toFixed(2)} ม. เท่านั้น`}
        </div>
      </Section>

      {isCustom && plan && compare && (
        <CustomLengthSummary plan={plan} compare={compare} prices={prices} kgPerM={kgPerM} settings={settings} canEdit={canEdit} onUse={saveProfile} onUseAll={applyAllBest} />
      )}

      <Section title="1. อลูมิเนียมโปรไฟล์ (แยกตามหน้าตัดและสี)">
        <BomProfilesTable profiles={bom.profiles} overrides={stock.byProfile} canEdit={canEdit && isCustom} onSaveStock={saveProfile} />
      </Section>

      {isCustom && <CutOptimizerPanel profiles={bom.profiles} seriesMap={seriesMap} index={index} settings={settings} asOf={project.price_as_of} rangeM={rangeM} canEdit={canEdit} onUseLength={saveProfile} />}

      <Section title="2. อุปกรณ์และชิ้นส่วน">
        {hardware.length > 0 && <><div style={{ fontSize: 12, color: 'var(--text3)' }}>อุปกรณ์ (hardware)</div><PartsTable rows={hardware} /></>}
        {accessories.length > 0 && <><div style={{ fontSize: 12, color: 'var(--text3)' }}>อุปกรณ์เสริม (accessory)</div><PartsTable rows={accessories} /></>}
        {!bom.parts.length && <div style={{ color: 'var(--text3)', fontSize: 13 }}>ไม่มีอุปกรณ์</div>}
        {notLinked && <div style={{ fontSize: 12, color: 'var(--text3)' }}>shim / สกรู / พุกพลาสติก ยังปิดอยู่ จนกว่าจะผูกชิ้นส่วนในตั้งค่าการประเมินราคา</div>}
      </Section>

      <Section title="3. ซีลแลนท์">
        <div className="table-wrap"><table>
          <thead><tr><th>ความยาวแนวที่ต้องอุดรวม (ม.)</th><th>ม./หลอด (หลอดละ 300 มล.)</th><th>จำนวนหลอด</th></tr></thead>
          <tbody><tr><td className="font-mono">{bom.sealant.length_m.toFixed(1)}</td><td className="font-mono">{bom.sealant.m_per_tube}</td><td className="font-mono"><b>{bom.sealant.tubes}</b></td></tr></tbody>
        </table></div>
        <div style={{ fontSize: 12, color: 'var(--text3)' }}>ปัดขึ้นเป็นหลอดครั้งเดียวทั้งโครงการ · ต้นทุนซีลแลนท์ยังคิดจากค่าซิลิโคนต่อเมตรในเทมเพลต ไม่ได้คิดจากจำนวนหลอด</div>
      </Section>

      <ProviderCompare project={project} items={items} base={base} index={index} seriesTypes={seriesTypes} canEdit={canEdit} onApplied={onProjectSaved} />
    </div>
  )
}
