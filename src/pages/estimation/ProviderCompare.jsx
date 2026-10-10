// src/pages/estimation/ProviderCompare.jsx
// Extruder comparison (mockup screen 6, lower panel). Aluminium cost only, read-only: for each extruder the owner
// picks a series and colour and the whole project is recomputed with them. Nothing changes until "ใช้โรงรีดนี้".
import { useState, useMemo } from 'react'
import { supabase, fmt } from '../../lib/supabase.js'
import { ConfirmDialog } from '../../components/Modal.jsx'
import { compareProviders } from '../../lib/providerCompare.js'
import { itemsAffectedByDefaultSeries } from '../../lib/estimationInherit.js'
import { seriesChoices, finishChoices, draftFromProject, reconcileDraft, buildPatch } from './projectDefaults.js'
import { comparisonRows, itemsWithForeignColour } from './projectBomHelpers.js'

export default function ProviderCompare({ project, items, base, index, seriesTypes, canEdit, onApplied }) {
  const providers = useMemo(() => Object.values(index.providers).filter(p => p.active !== false).sort((a, b) => String(a.name).localeCompare(String(b.name), 'th')), [index])
  const primaryId = project.primary_provider_id || null
  // picks[providerId] = { seriesId, finishId }; the main extruder row always uses the project's own defaults
  const baseMissing = !primaryId || !providers.some(p => p.id === primaryId)
  const [picks, setPicks] = useState({})
  const [confirm, setConfirm] = useState(null)
  const [busy, setBusy] = useState(false)
  const pickOf = p => (p.id === primaryId ? { seriesId: project.default_series_id || '', finishId: project.default_finish_id || '' } : (picks[p.id] || { seriesId: '', finishId: '' }))

  const rows = useMemo(() => {
    const candidates = providers.map(p => ({ providerId: p.id, ...pickOf(p) }))
    const results = compareProviders({
      project, items, templatesById: base.templatesById, componentsByTemplate: base.componentsByTemplate, jointsByTemplate: base.jointsByTemplate, partModelByTemplate: base.partModelByTemplate,
      typesById: base.typesById, infillTypesById: base.infillTypesById, index, settings: base.settings, candidates, asOf: project.price_as_of,
    })
    return comparisonRows(results, primaryId)
  }, [providers, picks, project, items, base, index, primaryId]) // eslint-disable-line react-hooks/exhaustive-deps

  const setPick = (pid, patch) => setPicks(s => ({ ...s, [pid]: { ...(s[pid] || { seriesId: '', finishId: '' }), ...patch } }))

  const startApply = row => {
    const draft = reconcileDraft({ ...draftFromProject(project), primary_provider_id: row.providerId, default_series_id: row.seriesId, default_finish_id: row.finishId }, index, seriesTypes)
    const patch = buildPatch(project, draft)
    const seen = new Set()
    const affected = [...itemsAffectedByDefaultSeries(items, base.templatesById, row.seriesId, seriesTypes), ...itemsWithForeignColour(items, index, row.providerId)]
      .filter(i => !seen.has(i.id) && seen.add(i.id))
    setConfirm({ row, patch, affected, name: index.providers[row.providerId].name, clearsThickness: 'default_thickness_mm' in patch })
  }
  const apply = async () => {
    setBusy(true)
    try {
      const { error } = await supabase.from('estimation_projects').update(confirm.patch).eq('id', project.id)
      if (error) throw error
      await onApplied()
      setConfirm(null)
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) } finally { setBusy(false) }
  }

  return (
    <div className="card" style={{ padding: 16, display: 'grid', gap: 10 }}>
      <div style={{ fontWeight: 700 }}>เทียบราคาโรงรีด <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text3)' }}>(เฉพาะอลูมิเนียม · ไม่เปลี่ยนค่าในโครงการ)</span></div>
      <div style={{ fontSize: 12, color: 'var(--text2)' }}>
        คิดต้นทุนอลูมิเนียมทั้งโครงการซ้ำ โดยบังคับทุกรายการเป็นซีรีส์และสีที่เลือก (ขนาด เทมเพลต ความหนาตามเดิม) ไม่รวมอุปกรณ์ วัสดุอุดช่อง และค่าแรง
        {!project.default_series_id || !project.default_finish_id ? ' · ตั้งซีรีส์และสีเริ่มต้นของโปรเจกต์ก่อน จึงจะเทียบกับโรงรีดหลักได้' : ''}
      </div>
      {baseMissing && <div className="alert alert-warning" style={{ fontSize: 13 }}>ไม่มีโรงรีดหลักเป็นฐานเทียบ (ยังไม่ได้เลือก หรือโรงรีดหลักถูกปิดใช้งาน) จึงไม่แสดงส่วนต่าง</div>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>โรงรีด</th><th>ซีรีส์</th><th>สี</th><th>ต้นทุนอลูมิเนียม (฿)</th><th>เทียบโรงรีดหลัก<div style={{ fontWeight: 400, fontSize: 11, color: 'var(--text3)' }}>ฐานเทียบ (บังคับซีรีส์/สีตั้งต้นของโปรเจกต์ ไม่ใช่ยอดจริงในรายการ)</div></th><th>สถานะ</th><th /></tr></thead>
          <tbody>
            {providers.map((p, i) => {
              const row = rows[i]
              const pick = pickOf(p)
              const fixed = p.id === primaryId
              return (
                <tr key={p.id}>
                  <td>{p.name}{fixed ? ' (หลัก)' : ''}</td>
                  <td>{fixed ? (index.series[pick.seriesId] ? index.series[pick.seriesId].name : '—') : (
                    <select className="input input-sm" value={pick.seriesId} onChange={e => setPick(p.id, { seriesId: e.target.value, finishId: '' })}>
                      <option value="">— เลือก —</option>
                      {seriesChoices(index, p.id).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>)}</td>
                  <td>{fixed ? (index.finishes[pick.finishId] ? index.finishes[pick.finishId].name : '—') : (
                    <select className="input input-sm" value={pick.finishId} disabled={!pick.seriesId} onChange={e => setPick(p.id, { finishId: e.target.value })}>
                      <option value="">— เลือก —</option>
                      {finishChoices(index, pick.seriesId, p.id).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>)}</td>
                  <td className="font-mono">{row.complete ? fmt(row.aluminium) : '—'}</td>
                  <td className="font-mono">{row.diff ? `${row.diff.amount > 0 ? '+' : ''}${fmt(row.diff.amount)} (${row.diff.pct > 0 ? '+' : ''}${row.diff.pct.toFixed(1)}%)` : '—'}</td>
                  <td>{row.pending ? <span style={{ color: 'var(--text3)' }}>{fixed ? 'ยังไม่ได้ตั้งซีรีส์/สีของโปรเจกต์' : 'เลือกซีรีส์และสี'}</span>
                    : row.complete ? <span style={{ color: 'var(--green)' }}>คิดครบ</span>
                      : <span style={{ color: 'var(--red)' }}>คิดไม่ได้ {row.unresolvedLines} รายการ (ไม่มีหน้าตัด/ราคา){(row.failedItems || []).length > 0 && ` · คิดราคาไม่ได้: ${row.failedItems.map(f => f.opening_no || f.id).join(', ')}`}</span>}</td>
                  <td>{canEdit && row.canApply && <button type="button" className="btn btn-sm btn-ghost" onClick={() => startApply(row)}>ใช้โรงรีดนี้</button>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {confirm && (
        <ConfirmDialog title={`ใช้โรงรีด ${confirm.name}`} confirmDisabled={busy} onCancel={() => setConfirm(null)} onConfirm={apply}
          message={<div>
            จะตั้งโรงรีดหลัก ซีรีส์ และสีเริ่มต้นของโปรเจกต์ตามแถวนี้{confirm.clearsThickness ? ' (ความหนาเริ่มต้นที่ซีรีส์ใหม่ไม่มีจะถูกล้าง ต้องเลือกใหม่)' : ''}
            <div>ความหนาวงกบ/ความหนากรอบบานที่บันทึกไว้เป็นค่าเริ่มต้น อาจถูกล้างถ้าไม่มีในซีรีส์ใหม่</div>
            {confirm.affected.length > 0 ? <> รายการเหล่านี้ที่ใช้ค่าเริ่มต้นของโปรเจกต์ ({confirm.affected.length}) ไม่มีแบบในซีรีส์ใหม่ หรือตั้งสีเองเป็นสีของโรงรีดอื่น จะคิดราคาไม่ได้จนกว่าจะแก้:
              <ul style={{ margin: '6px 0 0 18px' }}>{confirm.affected.map(i => <li key={i.id}>{i.opening_no}{i.item_name ? ` · ${i.item_name}` : ''}</li>)}</ul></> : ' ไม่มีรายการที่ได้รับผลกระทบด้านแบบ'}
            <div style={{ marginTop: 6 }}>รายการที่ตั้งซีรีส์หรือสีเองยังคงเดิม</div>
          </div>} />
      )}
    </div>
  )
}
