// src/pages/estimation/ProjectDefaultsPanel.jsx
// Project defaults (mockup screen 1): main extruder, series, colour, thicknesses, infill, hardware package,
// labour, profit, price date and the quotation description format. Blank = NULL = "choose per item".
import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../../lib/supabase.js'
import { ConfirmDialog } from '../../components/Modal.jsx'
import { thicknessesForSeries } from '../../lib/estimationCatalogViews.js'
import { itemsAffectedByDefaultSeries } from '../../lib/estimationInherit.js'
import { packagesForSeries } from '../../lib/projectHardware.js'
import { seriesLabelFull } from '../../lib/aluCatalog.js'
import { DESCRIPTION_TOKENS, buildItemDescription } from '../../lib/descriptionFormat.js'
import {
  draftFromProject, reconcileDraft, seriesChoices, finishChoices, mixedThicknessAllowed, sashDisplayValue,
  validateDraft, buildPatch,
} from './projectDefaults.js'

const Field = ({ label, hint, children }) => (
  <div>
    <label className="label">{label}</label>
    {children}
    {hint && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3 }}>{hint}</div>}
  </div>
)

export default function ProjectDefaultsPanel({ project, index, seriesTypes, infillTypes, packages, items, templatesById, canEdit, onSaved }) {
  const [draft, setDraft] = useState(() => reconcileDraft(draftFromProject(project), index, seriesTypes))
  const [saving, setSaving] = useState(false)
  const [confirm, setConfirm] = useState(null)   // { patch, affected }

  // Reset only for another project or after our own successful save, never on a plain refetch (unsaved edits stay).
  const [saveTick, setSaveTick] = useState(0)
  useEffect(() => { setDraft(reconcileDraft(draftFromProject(project), index, seriesTypes)) }, [project.id, saveTick]) // eslint-disable-line react-hooks/exhaustive-deps

  const change = (k, v) => setDraft(d => reconcileDraft({ ...d, [k]: v }, index, seriesTypes))
  const patch = useMemo(() => buildPatch(project, draft), [project, draft])
  const dirty = Object.keys(patch).length > 0
  const error = validateDraft(draft)

  const seriesOpts = seriesChoices(index, draft.primary_provider_id)
  const finishOpts = finishChoices(index, draft.default_series_id, draft.primary_provider_id)
  const thicknesses = draft.default_series_id ? thicknessesForSeries(index, draft.default_series_id) : []
  const singleThickness = thicknesses.length === 1
  const showSash = mixedThicknessAllowed(seriesTypes, draft.default_series_id)
  const pkgOpts = [...packagesForSeries(packages, draft.default_series_id)]
  const chosenPkg = draft.hardware_package_id ? (packages || []).find(p => p.id === draft.hardware_package_id) : null
  if (chosenPkg && !pkgOpts.some(p => p.id === chosenPkg.id)) pkgOpts.push(chosenPkg)

  const sampleDesc = buildItemDescription({
    item_name: 'ประตูบานเลื่อน', type_name: 'บานเลื่อน', width_m: 1.8, height_m: 2.1,
    series_label: draft.default_series_id && index.series[draft.default_series_id] ? seriesLabelFull(index.series[draft.default_series_id], index.providers[index.series[draft.default_series_id].provider_id]) : '',
    finish_name: draft.default_finish_id && index.finishes[draft.default_finish_id] ? index.finishes[draft.default_finish_id].name : 'ขาว',
    thickness_mm: draft.default_thickness_mm, infill_name: 'กระจกเขียว 6 มม.', hardware_set_name: 'ชุดมาตรฐาน',
  }, draft.description_format)

  const write = async (p) => {
    setSaving(true)
    try {
      const { error: e } = await supabase.from('estimation_projects').update(p).eq('id', project.id)
      if (e) throw e
      await onSaved()
      setSaveTick(t => t + 1)
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setSaving(false); setConfirm(null) }
  }

  const handleSave = () => {
    if (error || !dirty) return
    if ('default_series_id' in patch) {
      const affected = itemsAffectedByDefaultSeries(items, templatesById, patch.default_series_id, seriesTypes)
      if (affected.length) { setConfirm({ patch, affected }); return }
    }
    write(patch)
  }

  const tokenLabel = k => (DESCRIPTION_TOKENS.find(t => t.key === k) || {}).label || k
  const fmtList = draft.description_format
  const move = (i, d) => { const a = [...fmtList]; const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; setDraft(x => ({ ...x, description_format: a })) }
  const dis = !canEdit

  return (
    <div className="card" style={{ padding: 16, display: 'grid', gap: 12 }}>
      <div style={{ fontWeight: 700 }}>ค่าเริ่มต้นของโปรเจกต์ <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text3)' }}>(ว่าง = เลือกต่อรายการ)</span></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
        <Field label="โรงรีดหลัก">
          <select className="input" disabled={dis} value={draft.primary_provider_id} onChange={e => change('primary_provider_id', e.target.value)}>
            <option value="">ไม่กำหนด (เลือกต่อรายการ)</option>
            {Object.values(index.providers).filter(p => p.active !== false).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="ซีรีส์">
          <select className="input" disabled={dis} value={draft.default_series_id} onChange={e => change('default_series_id', e.target.value)}>
            <option value="">ไม่กำหนด (เลือกต่อรายการ)</option>
            {seriesOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        <Field label="สี" hint={!draft.default_series_id && !draft.primary_provider_id ? 'เลือกซีรีส์หรือโรงรีดก่อน' : null}>
          <select className="input" disabled={dis || !finishOpts.length} value={draft.default_finish_id} onChange={e => change('default_finish_id', e.target.value)}>
            <option value="">ไม่กำหนด (เลือกต่อรายการ)</option>
            {finishOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        <Field label="ความหนาวงกบ (มม.)" hint={singleThickness ? 'ซีรีส์นี้มีความหนาเดียว เลือกให้อัตโนมัติ' : (!draft.default_series_id ? 'เลือกซีรีส์ก่อน' : null)}>
          <select className="input" disabled={dis || singleThickness || !thicknesses.length} value={draft.default_thickness_mm} onChange={e => change('default_thickness_mm', e.target.value)}>
            <option value="">ไม่กำหนด (เลือกต่อรายการ)</option>
            {thicknesses.map(t => <option key={t} value={String(t)}>{t}</option>)}
          </select>
        </Field>
        {showSash && (
          <Field label="ความหนากรอบบาน (มม.)" hint="ซีรีส์นี้มีประเภทที่ใช้ความหนาวงกบกับกรอบบานไม่เท่ากันได้">
            <select className="input" disabled={dis} value={sashDisplayValue(draft)} onChange={e => change('default_sash_thickness_mm', e.target.value)}>
              {!sashDisplayValue(draft) && <option value="">— เลือก —</option>}
              {thicknesses.map(t => <option key={t} value={String(t)}>{t}</option>)}
            </select>
          </Field>
        )}
        <Field label="วัสดุอุดช่อง">
          <select className="input" disabled={dis} value={draft.default_infill_id} onChange={e => change('default_infill_id', e.target.value)}>
            <option value="">ไม่กำหนด (เลือกต่อรายการ)</option>
            {(infillTypes || []).filter(g => g.active !== false).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </Field>
        <Field label="ชุดอุปกรณ์ของโปรเจกต์">
          <select className="input" disabled={dis} value={draft.hardware_package_id} onChange={e => change('hardware_package_id', e.target.value)}>
            <option value="">— ไม่ใช้ —</option>
            {pkgOpts.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="ค่าแรง (฿/ตร.ม.)" hint="ว่าง = ใช้ค่าของประเภท; 0 = ไม่คิดค่าแรง">
          <input className="input" disabled={dis} type="number" min="0" step="any" value={draft.labour_per_sqm} onChange={e => change('labour_per_sqm', e.target.value)} />
        </Field>
        <Field label="กำไร (%)">
          <input className="input" disabled={dis} type="number" min="0" max="1000" step="any" value={draft.profit_pct} onChange={e => change('profit_pct', e.target.value)} />
        </Field>
        <Field label="วันที่ราคา" hint="ล็อกตั้งแต่สร้างโปรเจกต์ ใช้คิดราคาทุกรายการ">
          <div className="input" style={{ background: 'var(--bg2, #f7f7f7)' }}>{project.price_as_of || '—'}</div>
        </Field>
      </div>

      <div>
        <label className="label">รูปแบบคำอธิบายรายการ (ลำดับตามที่เลือก)</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {fmtList.map((k, i) => (
            <span key={k} className="badge" style={{ display: 'inline-flex', gap: 4, alignItems: 'center', padding: '3px 8px' }}>
              {tokenLabel(k)}
              {canEdit && <>
                <button type="button" className="btn btn-sm btn-ghost" style={{ padding: '0 4px' }} disabled={i === 0} onClick={() => move(i, -1)}>◀</button>
                <button type="button" className="btn btn-sm btn-ghost" style={{ padding: '0 4px' }} disabled={i === fmtList.length - 1} onClick={() => move(i, 1)}>▶</button>
                <button type="button" className="btn btn-sm btn-ghost" style={{ padding: '0 4px', color: 'var(--red)' }} onClick={() => setDraft(x => ({ ...x, description_format: x.description_format.filter(t => t !== k) }))}>✕</button>
              </>}
            </span>
          ))}
          {canEdit && DESCRIPTION_TOKENS.filter(t => !fmtList.includes(t.key)).map(t => (
            <button key={t.key} type="button" className="btn btn-sm btn-ghost" onClick={() => setDraft(x => ({ ...x, description_format: [...x.description_format, t.key] }))}>+ {t.label}</button>
          ))}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 6 }}>ตัวอย่าง: {sampleDesc || '—'}</div>
      </div>

      {error && <div className="alert alert-error" style={{ fontSize: 13 }}>{error}</div>}
      {canEdit && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn btn-ghost" disabled={!dirty || saving} onClick={() => setDraft(reconcileDraft(draftFromProject(project), index, seriesTypes))}>คืนค่า</button>
          <button type="button" className="btn btn-primary" disabled={!dirty || !!error || saving} onClick={handleSave}>{saving ? '⏳ กำลังบันทึก...' : '💾 บันทึกค่าเริ่มต้น'}</button>
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title="เปลี่ยนซีรีส์เริ่มต้น"
          message={<div>
            ซีรีส์ใหม่ไม่มีแบบต่อไปนี้ ({confirm.affected.length} รายการ) ยังบันทึกได้ แต่รายการเหล่านี้จะคิดราคาไม่ได้จนกว่าจะแก้:
            <ul style={{ margin: '6px 0 0 18px' }}>{confirm.affected.map(i => <li key={i.id}>{i.opening_no}{i.item_name ? ` · ${i.item_name}` : ''}</li>)}</ul>
          </div>}
          onConfirm={() => write(confirm.patch)} onCancel={() => setConfirm(null)} />
      )}
    </div>
  )
}
