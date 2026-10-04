// src/pages/Estimation.jsx
// ============================================================
// Estimation -- projects and their openings, with a live-computed BOM
// and unit cost per opening (via bomEngine.js). No AI drawing extraction
// yet (manual entry only, spec Non-goals); doesn't write into quotations
// or purchase_orders (spec Non-goals) -- this is where those future
// features will read from.
// ============================================================
import { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import {
  useEstimationProjects, useEstimationOpenings, useBomTemplates, useBomTemplateComponents,
  useBomTemplateHardware, useBomTemplateConstraints, useAluminumFinishes, useInfillTypes, useAluminumProfiles,
} from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import { fmt } from '../lib/supabase.js'
import { computeBomForOpening, combineOpeningBoms } from '../lib/bomEngine.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import SearchableSelect from '../components/SearchableSelect.jsx'

function evaluateConstraints(opening, constraints) {
  const violations = []
  for (const c of constraints) {
    if (c.rule_type === 'max_width_mm' && opening.width_m * 1000 > c.value) violations.push(c.message)
    if (c.rule_type === 'max_height_mm' && opening.height_m * 1000 > c.value) violations.push(c.message)
    if (c.rule_type === 'max_span_mm' && opening.width_m * 1000 > c.value) violations.push(c.message)
    if (c.rule_type === 'max_panel_count' && opening.panel_count > c.value) violations.push(c.message)
  }
  return violations
}

function OpeningEditor({ opening, projectId, templates, components, hardware, constraints, profiles, finishes, infillTypes, onSaved, canEdit }) {
  const isNew = !opening?.id
  const [form, setForm] = useState(() => isNew ? {
    opening_no: '', template_id: '', series: '', thickness_mm: '', finish_id: '', infill_type_id: '',
    width_m: '', height_m: '', panel_count: '1', quantity: '1', extra_lines: [],
    has_addon: false, addon_template_id: '', addon_width_m: '', addon_height_m: '', addon_panel_count: '1',
  } : {
    opening_no: opening.opening_no, template_id: opening.template_id, series: opening.series, thickness_mm: String(opening.thickness_mm),
    finish_id: opening.finish_id, infill_type_id: opening.infill_type_id || '',
    width_m: String(opening.width_m), height_m: String(opening.height_m),
    panel_count: String(opening.panel_count), quantity: String(opening.quantity), extra_lines: opening.extra_lines || [],
    has_addon: !!opening.addon_template_id,
    addon_template_id: opening.addon_template_id || '', addon_width_m: opening.addon_width_m != null ? String(opening.addon_width_m) : '',
    addon_height_m: opening.addon_height_m != null ? String(opening.addon_height_m) : '', addon_panel_count: String(opening.addon_panel_count || 1),
  })
  const [saving, setSaving] = useState(false)

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const addExtraLine = () => setForm(f => ({ ...f, extra_lines: [...f.extra_lines, { description: '', amount: 0 }] }))
  const setExtraLine = (i, k, v) => setForm(f => ({ ...f, extra_lines: f.extra_lines.map((l, idx) => idx === i ? { ...l, [k]: v } : l) }))
  const removeExtraLine = (i) => setForm(f => ({ ...f, extra_lines: f.extra_lines.filter((_, idx) => idx !== i) }))

  const template = (templates || []).find(t => t.id === form.template_id)
  const templateComponents = (components || []).filter(c => c.template_id === form.template_id)
  const templateHardware = (hardware || []).filter(h => h.template_id === form.template_id)
  const templateConstraints = (constraints || []).filter(c => c.template_id === form.template_id)
  const finish = (finishes || []).find(f => f.id === form.finish_id)
  const infillType = (infillTypes || []).find(g => g.id === form.infill_type_id)

  const addonTemplate = form.has_addon ? (templates || []).find(t => t.id === form.addon_template_id) : null
  const addonComponents = (components || []).filter(c => c.template_id === form.addon_template_id)
  const addonHardware = (hardware || []).filter(h => h.template_id === form.addon_template_id)
  const addonConstraints = (constraints || []).filter(c => c.template_id === form.addon_template_id)

  const numericOpening = useMemo(() => ({
    width_m: parseFloat(form.width_m) || 0,
    height_m: parseFloat(form.height_m) || 0,
    panel_count: parseInt(form.panel_count, 10) || 1,
    series: form.series,
    thickness_mm: parseFloat(form.thickness_mm) || 0,
    quantity: parseInt(form.quantity, 10) || 1,
    extra_lines: form.extra_lines.map(l => ({ description: l.description, amount: parseFloat(l.amount) || 0 })),
  }), [form])

  // Add-on unit shares the main opening's series/thickness_mm (spec
  // Decision 5) -- it has no selectors of its own for these, and no
  // extra_lines of its own (one adjustment-line list per opening).
  const numericAddon = useMemo(() => ({
    width_m: parseFloat(form.addon_width_m) || 0,
    height_m: parseFloat(form.addon_height_m) || 0,
    panel_count: parseInt(form.addon_panel_count, 10) || 1,
    series: form.series,
    thickness_mm: parseFloat(form.thickness_mm) || 0,
    quantity: 1,
    extra_lines: [],
  }), [form])

  const bom = useMemo(() => {
    if (!template || !finish || !numericOpening.width_m || !numericOpening.height_m || !numericOpening.series || !numericOpening.thickness_mm) return null
    return computeBomForOpening(numericOpening, template, templateComponents, templateHardware, profiles || [], finish, infillType || null)
  }, [template, finish, infillType, numericOpening, templateComponents, templateHardware, profiles])

  // Add-on aggregation happens HERE, at the call site -- computeBomForOpening
  // itself stays "one opening in, one BOM out" (spec Business logic).
  // Requires all three of template/width/height before attempting a
  // computation (spec Error handling: partially-filled add-on = "no
  // add-on yet", not an error).
  const addonBom = useMemo(() => {
    if (!form.has_addon || !addonTemplate || !finish || !numericAddon.width_m || !numericAddon.height_m) return null
    return computeBomForOpening(numericAddon, addonTemplate, addonComponents, addonHardware, profiles || [], finish, infillType || null)
  }, [form.has_addon, addonTemplate, finish, infillType, numericAddon, addonComponents, addonHardware, profiles])

  const combined = useMemo(() => combineOpeningBoms(bom, addonBom), [bom, addonBom])
  const combinedTotalCost = combined ? combined.totalCost : null

  const violations = template ? evaluateConstraints(numericOpening, templateConstraints) : []
  const addonViolations = (form.has_addon && addonTemplate) ? evaluateConstraints(numericAddon, addonConstraints) : []

  const handleSave = async () => {
    setSaving(true)
    try {
      const payload = {
        project_id: projectId, opening_no: form.opening_no, template_id: form.template_id,
        series: form.series, thickness_mm: parseFloat(form.thickness_mm) || 0,
        finish_id: form.finish_id, infill_type_id: form.infill_type_id || null,
        width_m: parseFloat(form.width_m) || 0, height_m: parseFloat(form.height_m) || 0,
        panel_count: parseInt(form.panel_count, 10) || 1, quantity: parseInt(form.quantity, 10) || 1,
        extra_lines: numericOpening.extra_lines,
        addon_template_id: form.has_addon ? (form.addon_template_id || null) : null,
        addon_width_m: form.has_addon ? (parseFloat(form.addon_width_m) || null) : null,
        addon_height_m: form.has_addon ? (parseFloat(form.addon_height_m) || null) : null,
        addon_panel_count: form.has_addon ? (parseInt(form.addon_panel_count, 10) || 1) : 1,
      }
      const { error } = isNew
        ? await supabase.from('estimation_openings').insert(payload)
        : await supabase.from('estimation_openings').update(payload).eq('id', opening.id)
      if (error) throw error
      onSaved()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setSaving(false) }
  }

  return (
    <div className="card" style={{ padding: 16, display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: 10 }}>
        <div>
          <label className="label">เลขช่อง ★</label>
          <input className="input" required disabled={!canEdit} value={form.opening_no} onChange={e => set('opening_no', e.target.value)} placeholder="เช่น D1" />
        </div>
        <div>
          <label className="label">Template ★</label>
          <SearchableSelect required disabled={!canEdit} value={form.template_id} onChange={v => set('template_id', v)}
            options={(templates || []).filter(t => t.active).map(t => ({ value: t.id, label: t.name, keywords: t.name }))} />
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        <div>
          <label className="label">รุ่น/ซีรีส์ ★</label>
          <input className="input" required disabled={!canEdit} value={form.series} onChange={e => set('series', e.target.value)} placeholder="เช่น ทั่วไป" />
        </div>
        <div>
          <label className="label">ความหนา (mm) ★</label>
          <input className="input" required disabled={!canEdit} type="number" min="0" step="0.1" value={form.thickness_mm} onChange={e => set('thickness_mm', e.target.value)} />
        </div>
        <div>
          <label className="label">สีผิว ★</label>
          <SearchableSelect required disabled={!canEdit} value={form.finish_id} onChange={v => set('finish_id', v)}
            options={(finishes || []).filter(f => f.active).map(f => ({ value: f.id, label: f.name, keywords: f.name }))} />
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr', gap: 10 }}>
        <div>
          <label className="label">กว้าง (m) ★</label>
          <input className="input" required disabled={!canEdit} type="number" min="0" step="0.01" value={form.width_m} onChange={e => set('width_m', e.target.value)} />
        </div>
        <div>
          <label className="label">สูง (m) ★</label>
          <input className="input" required disabled={!canEdit} type="number" min="0" step="0.01" value={form.height_m} onChange={e => set('height_m', e.target.value)} />
        </div>
        <div>
          <label className="label">จำนวนช่อง (panel)</label>
          <input className="input" disabled={!canEdit} type="number" min="1" value={form.panel_count} onChange={e => set('panel_count', e.target.value)} />
        </div>
        <div>
          <label className="label">จำนวน (set)</label>
          <input className="input" disabled={!canEdit} type="number" min="1" value={form.quantity} onChange={e => set('quantity', e.target.value)} />
        </div>
        <div>
          <label className="label">วัสดุอุดช่อง</label>
          <SearchableSelect disabled={!canEdit} value={form.infill_type_id} onChange={v => set('infill_type_id', v)}
            options={(infillTypes || []).filter(g => g.active).map(g => ({ value: g.id, label: g.name, keywords: g.name }))} placeholder="ไม่มีวัสดุอุดช่อง" />
        </div>
      </div>

      <div>
        <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 13 }}>รายการเพิ่มเติม (Fire Barrier, ดัดโค้ง, ฯลฯ)</div>
        <div style={{ display: 'grid', gap: 6 }}>
          {form.extra_lines.map((l, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 140px 32px', gap: 6 }}>
              <input className="input input-sm" disabled={!canEdit} placeholder="รายละเอียด" value={l.description} onChange={e => setExtraLine(i, 'description', e.target.value)} />
              <input className="input input-sm" disabled={!canEdit} type="number" placeholder="จำนวนเงิน" value={l.amount} onChange={e => setExtraLine(i, 'amount', e.target.value)} />
              {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => removeExtraLine(i)}>✕</button>}
            </div>
          ))}
          {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ justifySelf: 'start' }} onClick={addExtraLine}>+ เพิ่มรายการ</button>}
        </div>
      </div>

      <div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13, fontWeight: 700, marginBottom: form.has_addon ? 8 : 0 }}>
          <input type="checkbox" disabled={!canEdit} checked={form.has_addon} onChange={e => set('has_addon', e.target.checked)} />
          มีชุดต่อเติม (Add-on unit — เช่น ช่องแสงเหนือประตู)
        </label>
        {form.has_addon && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10 }}>
            <div style={{ gridColumn: 'span 2' }}>
              <label className="label">Template ชุดต่อเติม ★</label>
              <SearchableSelect required disabled={!canEdit} value={form.addon_template_id} onChange={v => set('addon_template_id', v)}
                options={(templates || []).filter(t => t.active).map(t => ({ value: t.id, label: t.name, keywords: t.name }))} />
            </div>
            <div>
              <label className="label">กว้าง (m) ★</label>
              <input className="input" required disabled={!canEdit} type="number" min="0" step="0.01" value={form.addon_width_m} onChange={e => set('addon_width_m', e.target.value)} />
            </div>
            <div>
              <label className="label">สูง (m) ★</label>
              <input className="input" required disabled={!canEdit} type="number" min="0" step="0.01" value={form.addon_height_m} onChange={e => set('addon_height_m', e.target.value)} />
            </div>
            <div>
              <label className="label">จำนวนช่อง (panel)</label>
              <input className="input" disabled={!canEdit} type="number" min="1" value={form.addon_panel_count} onChange={e => set('addon_panel_count', e.target.value)} />
            </div>
          </div>
        )}
        {addonViolations.map((msg, i) => (
          <div key={i} className="alert alert-error" style={{ fontSize: 13, marginTop: 6 }}>⚠️ ชุดต่อเติม: {msg}</div>
        ))}
      </div>

      {violations.map((msg, i) => (
        <div key={i} className="alert alert-error" style={{ fontSize: 13 }}>⚠️ {msg}</div>
      ))}

      {bom && (
        <div className="card" style={{ padding: 12, background: 'var(--bg2, #f7f7f7)' }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>สรุป BOM (ต่อ 1 ชุด)</div>
          {[...bom.profileLines, ...bom.gridLines].map((l, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: l.resolved ? 'inherit' : 'var(--red)' }}>
              <span>{l.role_name} {!l.resolved && '(ไม่พบหน้าตัดที่ตรงกัน)'}</span>
              <span className="font-mono">{fmt(l.cost)}</span>
            </div>
          ))}
          {bom.hardwareLines.map((l, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{l.name} x{l.quantity}</span>
              <span className="font-mono">{fmt(l.cost)}</span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>เผื่อเสียเศษ</span><span className="font-mono">{fmt(bom.wasteCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>วัสดุอุดช่อง ({bom.infillArea_sqm.toFixed(2)} ตร.ม.)</span><span className="font-mono">{fmt(bom.infillCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>ค่าแรง</span><span className="font-mono">{fmt(bom.laborCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>ซิลิโคน</span><span className="font-mono">{fmt(bom.siliconeCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>สักหลาด</span><span className="font-mono">{fmt(bom.feltCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>รายการเพิ่มเติม</span><span className="font-mono">{fmt(bom.extraLinesCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, borderTop: '1px solid var(--border, #ddd)', marginTop: 6, paddingTop: 6 }}>
            <span>รวมต่อชุด (ชุดหลัก)</span><span className="font-mono">{fmt(bom.totalCost)}</span>
          </div>
        </div>
      )}

      {addonBom && (
        <div className="card" style={{ padding: 12, background: 'var(--bg2, #f7f7f7)', border: '1px dashed var(--border, #ccc)' }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>ชุดต่อเติม: {addonTemplate?.name}</div>
          {[...addonBom.profileLines, ...addonBom.gridLines].map((l, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: l.resolved ? 'inherit' : 'var(--red)' }}>
              <span>{l.role_name} {!l.resolved && '(ไม่พบหน้าตัดที่ตรงกัน)'}</span>
              <span className="font-mono">{fmt(l.cost)}</span>
            </div>
          ))}
          {addonBom.hardwareLines.map((l, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{l.name} x{l.quantity}</span>
              <span className="font-mono">{fmt(l.cost)}</span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>เผื่อเสียเศษ</span><span className="font-mono">{fmt(addonBom.wasteCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>วัสดุอุดช่อง ({addonBom.infillArea_sqm.toFixed(2)} ตร.ม.)</span><span className="font-mono">{fmt(addonBom.infillCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>ค่าแรง</span><span className="font-mono">{fmt(addonBom.laborCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>ซิลิโคน</span><span className="font-mono">{fmt(addonBom.siliconeCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>สักหลาด</span><span className="font-mono">{fmt(addonBom.feltCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, borderTop: '1px solid var(--border, #ddd)', marginTop: 6, paddingTop: 6 }}>
            <span>รวมต่อชุด (ชุดต่อเติม)</span><span className="font-mono">{fmt(addonBom.totalCost)}</span>
          </div>
        </div>
      )}

      {combinedTotalCost != null && (
        <div className="card" style={{ padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
            <span>รวมทั้งช่องเปิด (ชุดหลัก{addonBom ? ' + ชุดต่อเติม' : ''})</span><span className="font-mono">{fmt(combinedTotalCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
            <span>รวม x{numericOpening.quantity} ชุด</span><span className="font-mono">{fmt(combinedTotalCost * numericOpening.quantity)}</span>
          </div>
        </div>
      )}

      {canEdit && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-primary" disabled={saving || !form.opening_no || !form.template_id || !form.series || !form.thickness_mm || !form.finish_id || !form.width_m || !form.height_m} onClick={handleSave}>
            {saving ? '⏳ กำลังบันทึก...' : '💾 บันทึกช่องเปิด'}
          </button>
        </div>
      )}
    </div>
  )
}

export default function Estimation(props) {
  const { isAtLeast, role } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'estimation')

  const { data: projects, refetch: refetchProjects } = useEstimationProjects()
  const { data: openings, refetch: refetchOpenings } = useEstimationOpenings()
  const { data: templates } = useBomTemplates()
  const { data: components } = useBomTemplateComponents()
  const { data: hardware } = useBomTemplateHardware()
  const { data: constraints } = useBomTemplateConstraints()
  const { data: finishes } = useAluminumFinishes()
  const { data: infillTypes } = useInfillTypes()
  const { data: profiles } = useAluminumProfiles()

  const [selectedProjectId, setSelectedProjectId] = useState(null)
  const [showProjectForm, setShowProjectForm] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [creatingOpening, setCreatingOpening] = useState(false)
  const [editingOpeningId, setEditingOpeningId] = useState(null)

  const projectOpenings = (openings || []).filter(o => o.project_id === selectedProjectId)

  const handleCreateProject = async () => {
    if (!newProjectName) return
    const { error } = await supabase.from('estimation_projects').insert({ name: newProjectName })
    if (error) { alert('สร้างไม่สำเร็จ: ' + error.message); return }
    setNewProjectName(''); setShowProjectForm(false); refetchProjects()
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 16 }}>
      <div className="card" style={{ padding: 12 }}>
        {canEdit && <button className="btn btn-primary btn-sm" style={{ marginBottom: 10, width: '100%' }} onClick={() => setShowProjectForm(true)}>+ โปรเจกต์ใหม่</button>}
        <div style={{ display: 'grid', gap: 4 }}>
          {(projects || []).map(p => (
            <button key={p.id} className={`btn btn-sm ${selectedProjectId === p.id ? 'btn-primary' : 'btn-ghost'}`} style={{ justifyContent: 'flex-start' }}
              onClick={() => { setSelectedProjectId(p.id); setCreatingOpening(false); setEditingOpeningId(null) }}>
              {p.name}
            </button>
          ))}
          {!(projects || []).length && <div style={{ fontSize: 12, color: 'var(--text3)', padding: 8 }}>ยังไม่มีโปรเจกต์</div>}
        </div>
      </div>

      <div>
        {!selectedProjectId && <div style={{ color: 'var(--text3)', padding: 20 }}>เลือกโปรเจกต์ทางซ้าย หรือสร้างใหม่</div>}
        {selectedProjectId && (
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              {canEdit && <button className="btn btn-primary btn-sm" onClick={() => { setCreatingOpening(true); setEditingOpeningId(null) }}>+ เพิ่มช่องเปิด</button>}
            </div>
            <div className="card">
              <div className="table-wrap">
                <table>
                  <thead><tr><th>เลขช่อง</th><th>Template</th><th>ขนาด</th><th>จำนวน</th><th></th></tr></thead>
                  <tbody>
                    {projectOpenings.map(o => (
                      <tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => { setEditingOpeningId(o.id); setCreatingOpening(false) }}>
                        <td style={{ fontWeight: 600 }}>{o.opening_no}</td>
                        <td>{o.bom_templates?.name}</td>
                        <td className="font-mono">{o.width_m} x {o.height_m} m</td>
                        <td className="font-mono">{o.quantity}</td>
                        <td><button className="btn btn-sm btn-ghost">แก้ไข</button></td>
                      </tr>
                    ))}
                    {!projectOpenings.length && <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีช่องเปิด</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>

            {creatingOpening && (
              <OpeningEditor key="new" opening={null} projectId={selectedProjectId} templates={templates} components={components} hardware={hardware}
                constraints={constraints} profiles={profiles} finishes={finishes} infillTypes={infillTypes} canEdit={canEdit}
                onSaved={() => { setCreatingOpening(false); refetchOpenings() }} />
            )}
            {editingOpeningId && (
              <OpeningEditor key={editingOpeningId} opening={projectOpenings.find(o => o.id === editingOpeningId)} projectId={selectedProjectId} templates={templates} components={components}
                hardware={hardware} constraints={constraints} profiles={profiles} finishes={finishes} infillTypes={infillTypes} canEdit={canEdit}
                onSaved={() => { setEditingOpeningId(null); refetchOpenings() }} />
            )}
          </div>
        )}
      </div>

      {showProjectForm && (
        <Modal title="โปรเจกต์ใหม่" onClose={() => setShowProjectForm(false)} maxWidth={420}>
          <div className="modal-body">
            <label className="label">ชื่อโปรเจกต์ ★</label>
            <input className="input" value={newProjectName} onChange={e => setNewProjectName(e.target.value)} placeholder="เช่น บ้านพี่วัฒน์" />
          </div>
          <div className="modal-footer">
            <button className="btn btn-ghost" onClick={() => setShowProjectForm(false)}>ยกเลิก</button>
            <button className="btn btn-primary" disabled={!newProjectName} onClick={handleCreateProject}>✅ สร้าง</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
