// src/pages/bomTemplates/addon/AddonEffects.jsx
// "ผลต่อชิ้นงาน" (mockup v12 #effects): what the preview add-ons do to the main unit and what they add, straight from
// expandAddons over every piece set (addonView.addonEffects): main-frame overrides (position name → new length /
// family), notes, added bars, glass and the unresolved Thai text.
import { fmt, fmtCount } from '../partEditorView.js'
import { addonEffects } from './addonView.js'

export default function AddonEffects({ addons, addonSets, main, buttOf, layoutKind, model }) {
  if (!addons || !addons.length) return <p className="hint">ยังไม่มีช่องแสง ไม่มีผลต่อชิ้นงาน</p>
  const e = addonEffects({ addons, addonSets, main, buttOf, layoutKind, model })
  return (
    <>
      <div className="tw">
        <table>
          <thead><tr><th>ชิ้นงานที่ได้รับผล</th><th>ผล</th><th>มม.</th></tr></thead>
          <tbody>
            {e.overrides.map(o => (
              <tr key={'o' + o.key}>
                <td>ชิ้นหลัก: {o.name}</td>
                <td>{[o.lengthMm != null ? 'ยาวขึ้นถึงขอบช่องแสง' : null, o.family ? `เปลี่ยนโปรไฟล์เป็น ${o.family}` : null].filter(Boolean).join(' · ')}</td>
                <td className="n">{o.lengthMm != null ? fmt(o.lengthMm) : '—'}</td>
              </tr>
            ))}
            {e.notes.map((n, i) => (
              <tr key={'n' + i}><td>ชิ้นหลัก ด้านที่ติดช่องแสง {n.addonIndex + 1}</td><td>หมายเหตุ: {n.text}</td><td className="n">—</td></tr>
            ))}
            {e.components.map((c, i) => (
              <tr key={'c' + i}>
                <td>{c.name}</td>
                <td>เพิ่มใหม่ · {c.family}{c.factor != null && c.factor !== 1 ? ` · × ${c.factor}` : ''}</td>
                <td className="n">{fmt(c.length)} × {fmtCount(c.qty)}</td>
              </tr>
            ))}
            {e.glass.map((g, i) => (
              <tr key={'g' + i}><td>กระจก / บาน (ช่องแสง {g.addonIndex + 1})</td><td>เพิ่มใหม่ ช่องละ ≈</td><td className="n">{fmt(g.widthMm)} × {fmt(g.heightMm)} × {fmtCount(g.count)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      {e.issues.length > 0 && (
        <div className="res tot" style={{ marginTop: 8 }}>
          {e.issues.map((x, i) => <span key={i} className="warnline">{x.name}: {x.text}</span>)}
        </div>
      )}
    </>
  )
}
