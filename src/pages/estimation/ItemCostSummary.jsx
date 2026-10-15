// src/pages/estimation/ItemCostSummary.jsx
// Cost of one set of the item, from costOpening(). An unresolved price reads "—" with the reason, never 0, and the
// total is withheld ("ราคายังไม่ครบ" + every unresolved entry) until everything is priced.
import { fmt } from '../../lib/supabase.js'
import { reasonText, unresolvedText } from '../../lib/reasonText.js'
import { addonCostLines } from './itemForm.js'

const Row = ({ label, value, note, bad }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13, color: bad ? 'var(--red)' : 'inherit' }}>
    <span>{label}{note && <span style={{ fontSize: 12 }}> · {note}</span>}</span>
    <span className="font-mono" style={{ whiteSpace: 'nowrap' }}>{value}</span>
  </div>
)
const money = (ok, v) => (ok ? fmt(v) : '—')

function BomRows({ bom, index, flags }) {
  const f = flags || { wasteKnown: true, infillKnown: true }
  const profile = [...bom.profileLines, ...bom.gridLines]
  return (
    <>
      {profile.map((l, i) => {
        const p = l.profile_id ? index.profiles[l.profile_id] : null
        const die = p && p.drawing_no ? ` (${p.drawing_no})` : ''
        return <Row key={`p${i}`} label={`${l.role_name}${die} ${Number(l.length_m).toFixed(3)} ม. × ${l.quantity}`} value={money(l.resolved, l.cost)} bad={!l.resolved} note={l.resolved ? null : `ไม่พบ: ${reasonText(l.reason)}`} />
      })}
      {bom.hardwareLines.map((l, i) => <Row key={`h${i}`} label={`${l.name} × ${Number(l.quantity).toFixed(2).replace(/\.00$/, '')}`} value={money(!l.unresolved, l.cost)} bad={l.unresolved} note={l.unresolved ? `ไม่พบ: ${reasonText('no_hardware_price')}` : null} />)}
      {(bom.hardwareSetLines || []).map((l, i) => <Row key={`s${i}`} label={`ชุดอุปกรณ์: ${l.name} × ${l.quantity}`} value={money(l.resolved, l.cost)} bad={!l.resolved} note={l.resolved ? null : `ไม่พบ: ${reasonText(l.reason || 'no_part_price')}`} />)}
      <Row label="เผื่อเสียเศษ" value={money(f.wasteKnown, bom.wasteCost)} note={f.wasteKnown ? null : 'รอราคาอลูมิเนียมให้ครบ'} bad={!f.wasteKnown} />
      <Row label={`วัสดุอุดช่อง (${bom.infillArea_sqm.toFixed(2)} ตร.ม.)`} value={money(f.infillKnown, bom.infillCost)} note={f.infillKnown ? null : `ไม่พบ: ${reasonText('unknown_infill')}`} bad={!f.infillKnown} />
      <Row label="ค่าแรง" value={fmt(bom.laborCost)} />
      <Row label="ซิลิโคน" value={fmt(bom.siliconeCost)} />
      <Row label="สักหลาด" value={fmt(bom.feltCost)} />
      {bom.extraLinesCost !== 0 && <Row label="รายการเพิ่มเติม" value={fmt(bom.extraLinesCost)} />}
    </>
  )
}

const Section = ({ title, children }) => (
  <div style={{ display: 'grid', gap: 2 }}>
    <div style={{ fontWeight: 700, fontSize: 13, marginTop: 4 }}>{title}</div>
    {children}
  </div>
)

// addonIndexOf (useItemModel): costed inline add-on index -> its row in the form, so lines and issues say "ช่องแสง N"
// as the estimator numbered them. Attach add-ons are one line each (their own BOM), merge glass one line; merge frame
// pieces are already lines of the main BOM, so the rows still sum to the total.
// expander names carry the costed index ("คิ้วเท (ช่องแสง 1)" / "ช่องแสง 1"): renumbered to the form's row
const issueName = (u, indexOf) => {
  if (u.addonIndex === undefined || u.addonIndex === null) return u.name || '?'
  const piece = String(u.name || '').replace(/\s*\(ช่องแสง \d+\)$/, '').replace(/^ช่องแสง \d+$/, '')
  return `ช่องแสง ${((indexOf || [])[u.addonIndex] ?? u.addonIndex) + 1}${piece ? ` ${piece}` : ''}`
}

export default function ItemCostSummary({ cost, flags, index, addonName, addonIndexOf }) {
  if (!cost) return <div className="card" style={{ padding: 12, fontSize: 13, color: 'var(--text3)' }}>เลือกประเภทและเทมเพลตเพื่อคิดราคา</div>
  const unresolved = cost.unresolved || []
  const addonLines = addonCostLines(cost, addonIndexOf)
  const notes = (cost.addonMerge && cost.addonMerge.notes) || []
  return (
    <div className="card" style={{ padding: 12, display: 'grid', gap: 6, background: 'var(--bg2)' }}>
      <div style={{ fontWeight: 700 }}>ต้นทุนต่อ 1 ชุด</div>
      <Section title="ชุดหลัก"><BomRows bom={cost.bom} index={index} flags={flags && flags.main} /></Section>
      {cost.addonBom && <Section title={`ของเพิ่มเติม${addonName ? `: ${addonName}` : ''}`}><BomRows bom={cost.addonBom} index={index} flags={flags && flags.addon} /></Section>}
      {addonLines.length > 0 && (
        <Section title="ช่องแสง">
          {addonLines.map(l => <Row key={l.key} label={l.label} value={fmt(l.value)} />)}
          {notes.map((n, i) => <div key={`n${i}`} style={{ fontSize: 12, color: 'var(--text3)' }}>หมายเหตุ ช่องแสง {((addonIndexOf || [])[n.addonIndex] ?? n.addonIndex) + 1}: {n.text}</div>)}
        </Section>
      )}
      {cost.extras.lines.length > 0 && (
        <Section title={`อุปกรณ์ติดตั้ง (${cost.extras.points} จุดยึด)`}>
          {cost.extras.lines.map(l => <Row key={l.key} label={`${l.name} × ${l.quantity}`} value={money(l.resolved, l.cost)} bad={!l.resolved} note={l.resolved ? null : `ไม่พบ: ${reasonText(l.reason)}`} />)}
        </Section>
      )}
      <div style={{ borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6 }}>
        {unresolved.length === 0 && Number.isFinite(cost.total)
          ? <Row label={<b>รวมต่อชุด</b>} value={<b>{fmt(cost.total)}</b>} />
          : (
            <div style={{ display: 'grid', gap: 2 }}>
              <Row label={<b>รวมต่อชุด</b>} value={<b>ราคายังไม่ครบ</b>} bad />
              {unresolved.map((u, i) => <div key={i} style={{ fontSize: 12, color: 'var(--red)' }}>• {issueName(u, addonIndexOf)}{u.source === 'addon' && !String(issueName(u, addonIndexOf)).startsWith('ช่องแสง') ? ' (ของเพิ่มเติม)' : ''}: {unresolvedText(u)}</div>)}
            </div>
          )}
      </div>
    </div>
  )
}
