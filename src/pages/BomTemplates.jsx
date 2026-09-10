// src/pages/BomTemplates.jsx
// ============================================================
// BOM Templates -- admin screen for the estimation module's guided
// template editor plus its two small reference catalogs (finishes,
// glass types). Gated on has_module_access('estimation').
// See docs/superpowers/specs/2026-09-10-bom-template-engine-design.md.
// ============================================================
import { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { useBomTemplates, useAluminumFinishes, useBomGlassTypes } from '../hooks/useSupabase.js'
import { useBomTemplateComponents, useBomTemplateHardware, useBomTemplateConstraints, useAluminumProfiles } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import { fmt } from '../lib/supabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import { useDraftForm } from '../hooks/useDraftForm.js'

function FinishForm({ initial, onSave, onCancel, loading }) {
  const [form, setForm, clearDraft] = useDraftForm('aluminum-finish-form', { name: '', price_per_kg: '', active: true, ...initial }, !initial?.id)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <form onSubmit={e => { e.preventDefault(); clearDraft(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div>
          <label className="label">ชื่อสีผิว ★</label>
          <input className="input" required value={form.name} onChange={e => set('name', e.target.value)} placeholder="เช่น POWDER COATING SAHARA" />
        </div>
        <div>
          <label className="label">ราคา/กก. ★</label>
          <input className="input" required type="number" min="0" step="0.01" value={form.price_per_kg} onChange={e => set('price_per_kg', e.target.value)} />
        </div>
        {initial?.id && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
            <input type="checkbox" checked={form.active} onChange={e => set('active', e.target.checked)} />
            ใช้งานอยู่
          </label>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={() => { clearDraft(); onCancel() }}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}</button>
      </div>
    </form>
  )
}

function GlassTypeForm({ initial, onSave, onCancel, loading }) {
  const [form, setForm, clearDraft] = useDraftForm('bom-glass-type-form', { name: '', price_per_sqm: '', active: true, ...initial }, !initial?.id)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <form onSubmit={e => { e.preventDefault(); clearDraft(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div>
          <label className="label">ชื่อกระจก ★</label>
          <input className="input" required value={form.name} onChange={e => set('name', e.target.value)} placeholder="เช่น กระจกใส 10มม." />
        </div>
        <div>
          <label className="label">ราคา/ตร.ม. ★</label>
          <input className="input" required type="number" min="0" step="0.01" value={form.price_per_sqm} onChange={e => set('price_per_sqm', e.target.value)} />
        </div>
        {initial?.id && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
            <input type="checkbox" checked={form.active} onChange={e => set('active', e.target.checked)} />
            ใช้งานอยู่
          </label>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={() => { clearDraft(); onCancel() }}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}</button>
      </div>
    </form>
  )
}

const LENGTH_RULE_LABELS = {
  width: '= กว้าง (width)',
  height: '= สูง (height)',
  width_minus: '= กว้าง − ระยะหัก (mm)',
  height_minus: '= สูง − ระยะหัก (mm)',
  perimeter: '= เส้นรอบรูป',
}
const QUANTITY_BASIS_LABELS = { fixed: 'จำนวนคงที่', per_cell: 'ต่อช่อง (cell)' }
const HARDWARE_BASIS_LABELS = { fixed: 'จำนวนคงที่', per_cell: 'ต่อช่อง (cell)', per_perimeter_m: 'ต่อเมตรเส้นรอบรูป' }
const CONSTRAINT_TYPE_LABELS = { max_width_mm: 'กว้างสูงสุด (mm)', max_height_mm: 'สูงสุงสุด (mm)', max_span_mm: 'ช่วงกว้างสูงสุด (mm)', max_panel_count: 'จำนวนช่องสูงสุด' }

const EMPTY_TEMPLATE_FORM = {
  name: '', category: 'window', waste_pct: '10',
  glass_width_deduction_mm: '0', glass_height_deduction_mm: '0',
  grid_row_weights: [1],
  grid_horizontal_rail_family: '', grid_vertical_mullion_family: '',
  active: true,
}

function TemplateEditor({ template, allProfiles, components, hardware, constraints, onSaved, onDeleted, canEdit }) {
  const isNew = !template?.id
  const [form, setForm] = useState(() => isNew ? EMPTY_TEMPLATE_FORM : {
    name: template.name, category: template.category, waste_pct: String(template.waste_pct),
    glass_width_deduction_mm: String(template.glass_width_deduction_mm), glass_height_deduction_mm: String(template.glass_height_deduction_mm),
    grid_row_weights: template.grid_row_weights, grid_horizontal_rail_family: template.grid_horizontal_rail_family || '',
    grid_vertical_mullion_family: template.grid_vertical_mullion_family || '', active: template.active,
  })
  const [rows, setRows] = useState(() => isNew ? [] : components.filter(c => c.template_id === template.id).sort((a, b) => a.sort_order - b.sort_order))
  const [hwRows, setHwRows] = useState(() => isNew ? [] : hardware.filter(h => h.template_id === template.id).sort((a, b) => a.sort_order - b.sort_order))
  const [constraintRows, setConstraintRows] = useState(() => isNew ? [] : constraints.filter(c => c.template_id === template.id))
  const [saving, setSaving] = useState(false)

  const familyOptions = [...new Set(allProfiles.map(p => p.family).filter(Boolean))]

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const setRowWeight = (i, v) => setForm(f => ({ ...f, grid_row_weights: f.grid_row_weights.map((w, idx) => idx === i ? parseFloat(v) || 0 : w) }))
  const addRow = () => setForm(f => ({ ...f, grid_row_weights: [...f.grid_row_weights, 1] }))
  const removeRow = (i) => setForm(f => ({ ...f, grid_row_weights: f.grid_row_weights.filter((_, idx) => idx !== i) }))

  const addComponent = () => setRows(r => [...r, { role_name: '', profile_family: '', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1, sort_order: r.length }])
  const setComponent = (i, k, v) => setRows(r => r.map((row, idx) => idx === i ? { ...row, [k]: v } : row))
  const removeComponent = (i) => setRows(r => r.filter((_, idx) => idx !== i))

  const addHardware = () => setHwRows(r => [...r, { name: '', reference_unit_price: 0, quantity_basis: 'fixed', quantity_value: 1, sort_order: r.length }])
  const setHardware = (i, k, v) => setHwRows(r => r.map((row, idx) => idx === i ? { ...row, [k]: v } : row))
  const removeHardware = (i) => setHwRows(r => r.filter((_, idx) => idx !== i))

  const addConstraint = () => setConstraintRows(r => [...r, { rule_type: 'max_width_mm', value: 0, message: '' }])
  const setConstraint = (i, k, v) => setConstraintRows(r => r.map((row, idx) => idx === i ? { ...row, [k]: v } : row))
  const removeConstraint = (i) => setConstraintRows(r => r.filter((_, idx) => idx !== i))

  // One template, its components, its hardware, and its constraints save
  // together as one unit -- simplest correct approach for a form editor:
  // upsert the template row, then delete-and-reinsert every child table's
  // rows for it. The template row is written first, and children are only
  // touched after it succeeds -- but each child table's own delete+reinsert
  // pair is two separate network requests and is not itself atomic (same
  // accepted tradeoff used elsewhere in this codebase, e.g.
  // Quotations.jsx/PurchaseOrders.jsx).
  const handleSave = async () => {
    setSaving(true)
    try {
      const payload = {
        name: form.name, category: form.category,
        waste_pct: parseFloat(form.waste_pct) || 0,
        glass_width_deduction_mm: parseFloat(form.glass_width_deduction_mm) || 0,
        glass_height_deduction_mm: parseFloat(form.glass_height_deduction_mm) || 0,
        grid_row_weights: form.grid_row_weights,
        grid_horizontal_rail_family: form.grid_horizontal_rail_family || null,
        grid_vertical_mullion_family: form.grid_vertical_mullion_family || null,
        active: form.active !== false,
      }
      let templateId = template?.id
      if (isNew) {
        const { data, error } = await supabase.from('bom_templates').insert(payload).select('id').single()
        if (error) throw error
        templateId = data.id
      } else {
        const { error } = await supabase.from('bom_templates').update(payload).eq('id', templateId)
        if (error) throw error
      }

      {
        const { error } = await supabase.from('bom_template_components').delete().eq('template_id', templateId)
        if (error) throw error
      }
      if (rows.length) {
        const { error } = await supabase.from('bom_template_components').insert(
          rows.map((r, i) => ({ ...r, template_id: templateId, length_deduction_mm: parseFloat(r.length_deduction_mm) || 0, quantity_value: parseFloat(r.quantity_value) || 0, sort_order: i }))
        )
        if (error) throw error
      }

      {
        const { error } = await supabase.from('bom_template_hardware').delete().eq('template_id', templateId)
        if (error) throw error
      }
      if (hwRows.length) {
        const { error } = await supabase.from('bom_template_hardware').insert(
          hwRows.map((h, i) => ({ ...h, template_id: templateId, reference_unit_price: parseFloat(h.reference_unit_price) || 0, quantity_value: parseFloat(h.quantity_value) || 0, sort_order: i }))
        )
        if (error) throw error
      }

      {
        const { error } = await supabase.from('bom_template_constraints').delete().eq('template_id', templateId)
        if (error) throw error
      }
      if (constraintRows.length) {
        const { error } = await supabase.from('bom_template_constraints').insert(
          constraintRows.map(c => ({ ...c, template_id: templateId, value: parseFloat(c.value) || 0 }))
        )
        if (error) throw error
      }

      onSaved()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setSaving(false) }
  }

  return (
    <div className="card" style={{ padding: 16, display: 'grid', gap: 16 }}>
      <datalist id="profile-family-options">
        {familyOptions.map(f => <option key={f} value={f} />)}
      </datalist>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: 10 }}>
        <div>
          <label className="label">ชื่อ Template ★</label>
          <input className="input" required disabled={!canEdit} value={form.name} onChange={e => set('name', e.target.value)} placeholder="เช่น Swing Door 2 Leaf General" />
        </div>
        <div>
          <label className="label">ประเภท</label>
          <select className="input" disabled={!canEdit} value={form.category} onChange={e => set('category', e.target.value)}>
            <option value="door">ประตู</option>
            <option value="window">หน้าต่าง</option>
          </select>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        <div>
          <label className="label">เผื่อเสียเศษ (%)</label>
          <input className="input" disabled={!canEdit} type="number" min="0" step="0.1" value={form.waste_pct} onChange={e => set('waste_pct', e.target.value)} />
        </div>
        <div>
          <label className="label">หักระยะกระจก กว้าง (mm)</label>
          <input className="input" disabled={!canEdit} type="number" min="0" value={form.glass_width_deduction_mm} onChange={e => set('glass_width_deduction_mm', e.target.value)} />
        </div>
        <div>
          <label className="label">หักระยะกระจก สูง (mm)</label>
          <input className="input" disabled={!canEdit} type="number" min="0" value={form.glass_height_deduction_mm} onChange={e => set('glass_height_deduction_mm', e.target.value)} />
        </div>
      </div>

      <div>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>โครงสร้างภายใน (Grid)</div>
        <div style={{ display: 'grid', gap: 6 }}>
          {form.grid_row_weights.map((w, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: 'var(--text3)', width: 60 }}>แถว {i + 1}</span>
              <input className="input input-sm" style={{ width: 100 }} disabled={!canEdit} type="number" min="0" step="0.05" value={w} onChange={e => setRowWeight(i, e.target.value)} />
              {canEdit && form.grid_row_weights.length > 1 && <button type="button" className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => removeRow(i)}>✕</button>}
            </div>
          ))}
          {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ justifySelf: 'start' }} onClick={addRow}>+ เพิ่มแถว</button>}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
          <div>
            <label className="label">โปรไฟล์คานแนวนอน (ถ้ามีมากกว่า 1 แถว)</label>
            <input className="input" disabled={!canEdit} list="profile-family-options" value={form.grid_horizontal_rail_family} onChange={e => set('grid_horizontal_rail_family', e.target.value)} placeholder="เช่น กล่องร่อง" />
          </div>
          <div>
            <label className="label">โปรไฟล์เสากลาง (ถ้าจำนวนช่อง &gt; 1)</label>
            <input className="input" disabled={!canEdit} list="profile-family-options" value={form.grid_vertical_mullion_family} onChange={e => set('grid_vertical_mullion_family', e.target.value)} placeholder="เช่น กล่องร่อง" />
          </div>
        </div>
      </div>

      <div>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>ชิ้นส่วนอลูมิเนียม (Components)</div>
        <div style={{ display: 'grid', gap: 6 }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 80px 1fr 80px 32px', gap: 6, alignItems: 'center' }}>
              <input className="input input-sm" disabled={!canEdit} placeholder="ชื่อชิ้นส่วน" value={r.role_name} onChange={e => setComponent(i, 'role_name', e.target.value)} />
              <input className="input input-sm" disabled={!canEdit} list="profile-family-options" placeholder="กลุ่มหน้าตัด" value={r.profile_family} onChange={e => setComponent(i, 'profile_family', e.target.value)} />
              <select className="input input-sm" disabled={!canEdit} value={r.length_rule_type} onChange={e => setComponent(i, 'length_rule_type', e.target.value)}>
                {Object.entries(LENGTH_RULE_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              <input className="input input-sm" disabled={!canEdit} type="number" min="0" placeholder="ระยะหัก mm" value={r.length_deduction_mm} onChange={e => setComponent(i, 'length_deduction_mm', e.target.value)} />
              <select className="input input-sm" disabled={!canEdit} value={r.quantity_basis} onChange={e => setComponent(i, 'quantity_basis', e.target.value)}>
                {Object.entries(QUANTITY_BASIS_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              <input className="input input-sm" disabled={!canEdit} type="number" min="0" placeholder="จำนวน" value={r.quantity_value} onChange={e => setComponent(i, 'quantity_value', e.target.value)} />
              {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => removeComponent(i)}>✕</button>}
            </div>
          ))}
          {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ justifySelf: 'start' }} onClick={addComponent}>+ เพิ่มชิ้นส่วน</button>}
        </div>
      </div>

      <div>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>อุปกรณ์ (Hardware)</div>
        <div style={{ display: 'grid', gap: 6 }}>
          {hwRows.map((h, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 120px 1fr 80px 32px', gap: 6, alignItems: 'center' }}>
              <input className="input input-sm" disabled={!canEdit} placeholder="ชื่ออุปกรณ์" value={h.name} onChange={e => setHardware(i, 'name', e.target.value)} />
              <input className="input input-sm" disabled={!canEdit} type="number" min="0" placeholder="ราคา/ชิ้น" value={h.reference_unit_price} onChange={e => setHardware(i, 'reference_unit_price', e.target.value)} />
              <select className="input input-sm" disabled={!canEdit} value={h.quantity_basis} onChange={e => setHardware(i, 'quantity_basis', e.target.value)}>
                {Object.entries(HARDWARE_BASIS_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              <input className="input input-sm" disabled={!canEdit} type="number" min="0" placeholder="จำนวน" value={h.quantity_value} onChange={e => setHardware(i, 'quantity_value', e.target.value)} />
              {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => removeHardware(i)}>✕</button>}
            </div>
          ))}
          {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ justifySelf: 'start' }} onClick={addHardware}>+ เพิ่มอุปกรณ์</button>}
        </div>
      </div>

      <div>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>ข้อจำกัด (แจ้งเตือนเท่านั้น ไม่บล็อกการบันทึก)</div>
        <div style={{ display: 'grid', gap: 6 }}>
          {constraintRows.map((c, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 120px 2fr 32px', gap: 6, alignItems: 'center' }}>
              <select className="input input-sm" disabled={!canEdit} value={c.rule_type} onChange={e => setConstraint(i, 'rule_type', e.target.value)}>
                {Object.entries(CONSTRAINT_TYPE_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              <input className="input input-sm" disabled={!canEdit} type="number" min="0" placeholder="ค่า" value={c.value} onChange={e => setConstraint(i, 'value', e.target.value)} />
              <input className="input input-sm" disabled={!canEdit} placeholder="ข้อความแจ้งเตือน" value={c.message} onChange={e => setConstraint(i, 'message', e.target.value)} />
              {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => removeConstraint(i)}>✕</button>}
            </div>
          ))}
          {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ justifySelf: 'start' }} onClick={addConstraint}>+ เพิ่มข้อจำกัด</button>}
        </div>
      </div>

      {!isNew && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
          <input type="checkbox" disabled={!canEdit} checked={form.active} onChange={e => set('active', e.target.checked)} />
          ใช้งานอยู่
        </label>
      )}

      {canEdit && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {!isNew && <button type="button" className="btn btn-ghost" style={{ color: 'var(--red)' }} onClick={() => onDeleted(template.id)}>🗑️ ลบ Template</button>}
          <button type="button" className="btn btn-primary" disabled={saving || !form.name} onClick={handleSave}>{saving ? '⏳ กำลังบันทึก...' : '💾 บันทึก'}</button>
        </div>
      )}
    </div>
  )
}

function TemplatesView({ canEdit }) {
  const { data: templates, refetch: refetchTemplates } = useBomTemplates()
  const { data: components, refetch: refetchComponents } = useBomTemplateComponents()
  const { data: hardware, refetch: refetchHardware } = useBomTemplateHardware()
  const { data: constraints, refetch: refetchConstraints } = useBomTemplateConstraints()
  const { data: allProfiles } = useAluminumProfiles()
  const [selectedId, setSelectedId] = useState(null)
  const [creating, setCreating] = useState(false)
  const [deleteId, setDeleteId] = useState(null)

  const selected = (templates || []).find(t => t.id === selectedId)

  const handleDelete = async () => {
    if (!deleteId) return
    const { error } = await supabase.from('bom_templates').delete().eq('id', deleteId)
    if (!error) { setDeleteId(null); setSelectedId(null); refetchTemplates() }
    else alert('ลบไม่สำเร็จ (อาจมี opening ที่ใช้ template นี้อยู่): ' + error.message)
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 16 }}>
      <div className="card" style={{ padding: 12 }}>
        {canEdit && <button className="btn btn-primary btn-sm" style={{ marginBottom: 10, width: '100%' }} onClick={() => { setCreating(true); setSelectedId(null) }}>+ Template ใหม่</button>}
        <div style={{ display: 'grid', gap: 4 }}>
          {(templates || []).map(t => (
            <button key={t.id} className={`btn btn-sm ${selectedId === t.id ? 'btn-primary' : 'btn-ghost'}`} style={{ justifyContent: 'flex-start' }}
              onClick={() => { setSelectedId(t.id); setCreating(false) }}>
              {t.active ? '' : '🚫 '}{t.name}
            </button>
          ))}
          {!(templates || []).length && <div style={{ fontSize: 12, color: 'var(--text3)', padding: 8 }}>ยังไม่มี Template</div>}
        </div>
      </div>
      <div>
        {creating && (
          <TemplateEditor key="new" template={null} allProfiles={allProfiles || []} components={[]} hardware={[]} constraints={[]} canEdit={canEdit}
            onSaved={() => { setCreating(false); refetchTemplates(); refetchComponents(); refetchHardware(); refetchConstraints() }} onDeleted={() => {}} />
        )}
        {selected && !creating && (
          <TemplateEditor key={selected.id} template={selected} allProfiles={allProfiles || []} components={components || []} hardware={hardware || []} constraints={constraints || []} canEdit={canEdit}
            onSaved={() => { refetchTemplates(); refetchComponents(); refetchHardware(); refetchConstraints() }} onDeleted={(id) => setDeleteId(id)} />
        )}
        {!creating && !selected && <div style={{ color: 'var(--text3)', padding: 20 }}>เลือก Template ทางซ้าย หรือสร้างใหม่</div>}
      </div>
      {deleteId && <ConfirmDialog title="ลบ Template" message="ยืนยันการลบ? (ถ้ามี opening ผูกอยู่ การลบจะไม่สำเร็จ)" onConfirm={handleDelete} onCancel={() => setDeleteId(null)} />}
    </div>
  )
}

export default function BomTemplates(props) {
  const { isAtLeast, role } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'bom_templates')

  const [view, setView] = useState('templates')

  const { data: templates, refetch: refetchTemplates } = useBomTemplates()
  const { data: finishes, refetch: refetchFinishes } = useAluminumFinishes()
  const { data: glassTypes, refetch: refetchGlassTypes } = useBomGlassTypes()

  const [showFinishForm, setShowFinishForm] = useState(false)
  const [editFinish, setEditFinish] = useState(null)
  const [savingFinish, setSavingFinish] = useState(false)
  const [deleteFinishId, setDeleteFinishId] = useState(null)

  const [showGlassForm, setShowGlassForm] = useState(false)
  const [editGlass, setEditGlass] = useState(null)
  const [savingGlass, setSavingGlass] = useState(false)
  const [deleteGlassId, setDeleteGlassId] = useState(null)

  const handleSaveFinish = async (form) => {
    setSavingFinish(true)
    try {
      const payload = { name: form.name, price_per_kg: parseFloat(form.price_per_kg) || 0, active: form.active !== false }
      const { error } = editFinish
        ? await supabase.from('aluminum_finishes').update(payload).eq('id', editFinish.id)
        : await supabase.from('aluminum_finishes').insert(payload)
      if (error) throw error
      setShowFinishForm(false); setEditFinish(null); refetchFinishes()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setSavingFinish(false) }
  }

  const handleDeleteFinish = async () => {
    if (!deleteFinishId) return
    const { error } = await supabase.from('aluminum_finishes').delete().eq('id', deleteFinishId)
    if (!error) { setDeleteFinishId(null); refetchFinishes() }
    else alert('ลบไม่สำเร็จ (อาจมีการใช้งานผูกอยู่): ' + error.message)
  }

  const handleSaveGlass = async (form) => {
    setSavingGlass(true)
    try {
      const payload = { name: form.name, price_per_sqm: parseFloat(form.price_per_sqm) || 0, active: form.active !== false }
      const { error } = editGlass
        ? await supabase.from('bom_glass_types').update(payload).eq('id', editGlass.id)
        : await supabase.from('bom_glass_types').insert(payload)
      if (error) throw error
      setShowGlassForm(false); setEditGlass(null); refetchGlassTypes()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setSavingGlass(false) }
  }

  const handleDeleteGlass = async () => {
    if (!deleteGlassId) return
    const { error } = await supabase.from('bom_glass_types').delete().eq('id', deleteGlassId)
    if (!error) { setDeleteGlassId(null); refetchGlassTypes() }
    else alert('ลบไม่สำเร็จ (อาจมีการใช้งานผูกอยู่): ' + error.message)
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className={`btn btn-sm ${view === 'templates' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('templates')}>🧩 BOM Templates</button>
        <button className={`btn btn-sm ${view === 'finishes' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('finishes')}>🎨 สีผิวอลูมิเนียม</button>
        <button className={`btn btn-sm ${view === 'glass_types' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('glass_types')}>🪟 ชนิดกระจก</button>
      </div>

      {view === 'templates' && (
        <TemplatesView canEdit={canEdit} />
      )}

      {view === 'finishes' && (
        <>
          {canEdit && <button className="btn btn-primary" style={{ marginBottom: 14 }} onClick={() => { setEditFinish(null); setShowFinishForm(true) }}>+ เพิ่มสีผิว</button>}
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead><tr><th>ชื่อสีผิว</th><th>ราคา/กก.</th><th>สถานะ</th><th></th></tr></thead>
                <tbody>
                  {(finishes || []).map(f => (
                    <tr key={f.id}>
                      <td style={{ fontWeight: 600 }}>{f.name}</td>
                      <td className="font-mono">{fmt(f.price_per_kg)}</td>
                      <td>{f.active ? <span className="badge badge-paid">ใช้งานอยู่</span> : <span className="badge badge-finished">ปิดใช้งาน</span>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {canEdit && (
                          <>
                            <button className="btn btn-sm btn-ghost" onClick={() => { setEditFinish(f); setShowFinishForm(true) }}>แก้ไข</button>
                            <button className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => setDeleteFinishId(f.id)}>ลบ</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!(finishes || []).length && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีสีผิว</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {view === 'glass_types' && (
        <>
          {canEdit && <button className="btn btn-primary" style={{ marginBottom: 14 }} onClick={() => { setEditGlass(null); setShowGlassForm(true) }}>+ เพิ่มชนิดกระจก</button>}
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead><tr><th>ชื่อกระจก</th><th>ราคา/ตร.ม.</th><th>สถานะ</th><th></th></tr></thead>
                <tbody>
                  {(glassTypes || []).map(g => (
                    <tr key={g.id}>
                      <td style={{ fontWeight: 600 }}>{g.name}</td>
                      <td className="font-mono">{fmt(g.price_per_sqm)}</td>
                      <td>{g.active ? <span className="badge badge-paid">ใช้งานอยู่</span> : <span className="badge badge-finished">ปิดใช้งาน</span>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {canEdit && (
                          <>
                            <button className="btn btn-sm btn-ghost" onClick={() => { setEditGlass(g); setShowGlassForm(true) }}>แก้ไข</button>
                            <button className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => setDeleteGlassId(g.id)}>ลบ</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!(glassTypes || []).length && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีชนิดกระจก</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {showFinishForm && (
        <Modal title={editFinish ? `แก้ไข ${editFinish.name}` : 'เพิ่มสีผิวใหม่'} onClose={() => { setShowFinishForm(false); setEditFinish(null) }} maxWidth={420}>
          <FinishForm initial={editFinish || {}} onSave={handleSaveFinish} onCancel={() => { setShowFinishForm(false); setEditFinish(null) }} loading={savingFinish} />
        </Modal>
      )}
      {deleteFinishId && <ConfirmDialog title="ลบสีผิว" message="ยืนยันการลบ?" onConfirm={handleDeleteFinish} onCancel={() => setDeleteFinishId(null)} />}

      {showGlassForm && (
        <Modal title={editGlass ? `แก้ไข ${editGlass.name}` : 'เพิ่มชนิดกระจกใหม่'} onClose={() => { setShowGlassForm(false); setEditGlass(null) }} maxWidth={420}>
          <GlassTypeForm initial={editGlass || {}} onSave={handleSaveGlass} onCancel={() => { setShowGlassForm(false); setEditGlass(null) }} loading={savingGlass} />
        </Modal>
      )}
      {deleteGlassId && <ConfirmDialog title="ลบชนิดกระจก" message="ยืนยันการลบ?" onConfirm={handleDeleteGlass} onCancel={() => setDeleteGlassId(null)} />}
    </div>
  )
}
