// src/pages/BomTemplates.jsx
// ============================================================
// BOM Templates -- admin screen for the estimation module's guided
// template editor plus its two small reference catalogs (finishes,
// glass types). Gated on has_module_access('estimation').
// See docs/superpowers/specs/2026-09-10-bom-template-engine-design.md.
// ============================================================
import AluminumProfiles from './AluminumProfiles.jsx'
import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { useBomTemplates, useInfillTypes } from '../hooks/useSupabase.js'
import { useBomTemplateComponents, useBomTemplateHardware, useBomTemplateConstraints } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import { fmt } from '../lib/supabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import { useDraftForm } from '../hooks/useDraftForm.js'
import { useCatalogTable, useEstimationCatalog } from '../hooks/useAluCatalog.js'
import { useTemplateJoints } from '../hooks/useEstimation2b.js'
import { jointRowsForInsert, validateJoints, componentRowsForInsert, jointIndexForLoad, templatePayload } from '../lib/templateSave.js'
import { loadModel, validateModel, saveModel, templateParamsPayload } from '../lib/partSave.js'
import { reasonText } from '../lib/reasonText.js'
import { startModel, LAYOUTS } from '../lib/partModel.js'
import { hardwareDefaultsPlan, hardwareDefaultRows } from '../lib/hardwareDefaults.js'
import { defaultParams, fixedKeysOf, layoutLabels } from '../lib/layoutRegistry.js'
import { PARAMS_HINT } from './bomTemplates/partEditorView.js'
import PartEditor from './bomTemplates/PartEditor.jsx'
import { defaultTestPick } from './bomTemplates/partEditorView.js'
import JointsTab from './bomTemplates/JointsTab.jsx'
import { useAddonTemplateState } from './bomTemplates/addon/addonTemplateGlue.js'
import HardwarePackagesTab from './bomTemplates/HardwarePackagesTab.jsx'
import CardTable from '../components/CardTable.jsx'
import TemplateCardGrid from './estimation/TemplateCardGrid.jsx'
import { useBomPartModel } from '../hooks/useBomPartModel.js'
import {
  catalogFamilies, templateTypeOptions, typeAllowsMixed, hardwarePartOptions, relinkAfterJointRemoved, validateComponentRows, orderJointIds,
  layoutLoadText,
} from './bomTemplates/helpers.js'

const MATERIAL_KIND_LABELS = { glass: 'กระจก', mesh: 'ตาข่าย', solid_panel: 'แผ่นทึบ', acp: 'อลูมิเนียมคอมโพสิต (ACP)' }

function InfillTypeForm({ initial, onSave, onCancel, loading }) {
  const [form, setForm, clearDraft] = useDraftForm('infill-type-form', { name: '', price_per_sqm: '', material_kind: 'glass', active: true, ...initial }, !initial?.id)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <form onSubmit={e => { e.preventDefault(); clearDraft(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div>
          <label className="label">ชื่อวัสดุอุดช่อง ★</label>
          <input className="input" required value={form.name} onChange={e => set('name', e.target.value)} placeholder="เช่น กระจกใส 10มม." />
        </div>
        <div>
          <label className="label">ประเภทวัสดุ ★</label>
          <select className="input" required value={form.material_kind} onChange={e => set('material_kind', e.target.value)}>
            {Object.entries(MATERIAL_KIND_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
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
const PREVIEW_KIND_LABELS = { fixed: 'บานติดตาย', slide: 'บานเลื่อน', swing: 'บานสวิง' }
const MAIN_AXIS_LABELS = { vertical: 'เส้นตั้ง ซ้าย/ขวา', horizontal: 'เส้นนอน บน/ล่าง' }
const EDITOR_TABS = ['ส่วนประกอบและอุปกรณ์', 'รายละเอียดการประกอบ (จุดชน)', 'รายละเอียดการบาก', 'ชุดอุปกรณ์โครงการ']
const CONSTRAINT_TYPE_LABELS = { max_width_mm: 'กว้างสูงสุด (mm)', max_height_mm: 'สูงสุงสุด (mm)', max_span_mm: 'ช่วงกว้างสูงสุด (mm)', max_panel_count: 'จำนวนช่องสูงสุด' }

const EMPTY_TEMPLATE_FORM = {
  name: '', category: 'window', waste_pct: '10',
  infill_width_deduction_mm: '0', infill_height_deduction_mm: '0',
  labor_price_per_sqm: '0', silicone_price_per_m: '0', felt_price_per_m: '0',
  grid_row_weights: [1],
  grid_horizontal_rail_family: '', grid_vertical_mullion_family: '',
  type_id: '', preview_kind: 'fixed', main_axis: 'vertical',
  layout_kind: '',   // '' = legacy template (flat components); a LAYOUTS key = part-editor template (partModel.js)
  active: true,
}

export function TemplateEditor({ template, joints, catalog, types, components, hardware, constraints, onSaved, onDeleted, canEdit }) {
  // A template inserted by a save that failed later is switched to its saved id, so a retry updates instead of inserting again.
  const [createdId, setCreatedId] = useState(null)
  const rowId = template?.id || createdId
  const isNew = !rowId
  const [form, setForm] = useState(() => isNew ? EMPTY_TEMPLATE_FORM : {
    name: template.name, category: template.category, waste_pct: String(template.waste_pct),
    infill_width_deduction_mm: String(template.infill_width_deduction_mm), infill_height_deduction_mm: String(template.infill_height_deduction_mm),
    labor_price_per_sqm: String(template.labor_price_per_sqm), silicone_price_per_m: String(template.silicone_price_per_m), felt_price_per_m: String(template.felt_price_per_m),
    grid_row_weights: template.grid_row_weights, grid_horizontal_rail_family: template.grid_horizontal_rail_family || '',
    grid_vertical_mullion_family: template.grid_vertical_mullion_family || '', active: template.active,
    type_id: template.type_id || '', preview_kind: template.preview_kind || 'fixed', main_axis: template.main_axis || 'vertical',
    layout_kind: template.layout_kind || '',
  })
  const [jointRows, setJointRows] = useState(() => isNew ? [] : joints.filter(j => j.template_id === template.id).sort((a, b) => a.sort_order - b.sort_order))
  const [rows, setRows] = useState(() => isNew ? [] : jointIndexForLoad(
    components.filter(c => c.template_id === template.id).sort((a, b) => a.sort_order - b.sort_order),
    joints.filter(j => j.template_id === template.id)))
  const [tab, setTab] = useState(0)
  const [hwRows, setHwRows] = useState(() => isNew ? [] : hardware.filter(h => h.template_id === template.id).sort((a, b) => a.sort_order - b.sort_order))
  const [constraintRows, setConstraintRows] = useState(() => isNew ? [] : constraints.filter(c => c.template_id === template.id))
  const [saving, setSaving] = useState(false)
  // Part model (templates with layout_kind): read straight from this template's part rows, never through the
  // tenant-wide useBomPartModel hook (that hook belongs to the Estimation page; its refetch blanks costs there).
  // null until loaded; a failed load blocks saving, so it can never be mistaken for "no rows" and saved over.
  const [model, setModel] = useState(null)
  const [modelError, setModelError] = useState(null)
  // a load refusal a reload cannot fix (layout_mismatch / unknown_layout, R-F5): shown as is, blocks saving
  const [layoutProblem, setLayoutProblem] = useState(null)
  const addon = useAddonTemplateState(template)   // add-on ช่องแสง piece sets (saved) + preview add-ons (UI only)
  useEffect(() => {
    if (!template?.layout_kind) return
    let live = true
    // with its type: a template whose type names another layout_kind is refused (never re-mapped), and a template saved
    // before layout_params takes the type's fixed values (TemplatesView opens the editor only once types are loaded)
    const type = (template.type_id && (types || []).find(t => t.id === template.type_id)) || null
    addon.load(template.id)   // piece sets alongside the model; a failed load blocks writing them
    loadModel({ supabase, template, type })
      .then(m => {
        if (!live) return
        if (m && m.error) {
          const text = layoutLoadText(m.error, template.layout_kind, type && type.layout_kind, layoutLabels)
          if (text) setLayoutProblem(text); else setModelError(reasonText(m.error))
        } else setModel(m)
      })
      .catch(e => { if (live) setModelError(e.message) })
    return () => { live = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- once per opened template (the editor is keyed by id)

  const index = catalog.index
  // Part editor test series / thickness (Ruling PE-3): UI-only, never saved.
  const [testPick, setTestPick] = useState(() => defaultTestPick(catalog.index, template?.type_id || ''))
  // "สร้างจากแบบบานเลื่อน 2 บาน": a new or legacy-empty template becomes a part-editor template with the layout's
  // default model right away (so Save never waits on a load that will not happen).
  // A type with a layout_kind starts its own layout with the type's fixed values (defaultParams); a layout the type's
  // params refuse (folding 0 + 0) is not started: the hint says what to fix on the type.
  const [startError, setStartError] = useState(null)
  const [paramsInvalid, setParamsInvalid] = useState(false)   // the editor holds params its layout refused (not saved)
  const startFromLayout = (kind, type = null) => {
    let m
    try {
      m = startModel(kind, defaultParams(kind, type && type.layout_params))
      const fixedKeys = fixedKeysOf(kind, type && type.layout_params)   // the inputs the type pins (R-F2), read-only in the editor
      if (fixedKeys.length) m = { ...m, fixedKeys }
    } catch (e) {
      if (e && e.message === 'layout_params_invalid') { setStartError(`${PARAMS_HINT} ที่ประเภท (แคตตาล็อก)`); return }
      throw e
    }
    setStartError(null)
    set('layout_kind', kind)
    setModel(m)
    setModelError(null)
    setLayoutProblem(null)
  }
  const familyOptions = catalogFamilies(index)
  const typesById = Object.fromEntries((types || []).map(t => [t.id, t]))
  const formTypeRow = typesById[form.type_id] || null
  const typeKind = formTypeRow && formTypeRow.layout_kind && LAYOUTS[formTypeRow.layout_kind] ? formTypeRow.layout_kind : null
  const typeOpts = templateTypeOptions(types || [], typesById, template?.type_id || '')
  const showThickness = typeAllowsMixed(index, form.type_id)
  const partOpts = hardwarePartOptions(index?.parts)

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const setRowWeight = (i, v) => setForm(f => ({ ...f, grid_row_weights: f.grid_row_weights.map((w, idx) => idx === i ? parseFloat(v) || 0 : w) }))
  const addRow = () => setForm(f => ({ ...f, grid_row_weights: [...f.grid_row_weights, 1] }))
  const removeRow = (i) => setForm(f => ({ ...f, grid_row_weights: f.grid_row_weights.filter((_, idx) => idx !== i) }))

  const addComponent = () => setRows(r => [...r, { role_name: '', profile_family: '', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1, joint_index: '', joint_ends: 2, thickness_role: null, sort_order: r.length }])
  const setComponent = (i, k, v) => setRows(r => r.map((row, idx) => idx === i ? { ...row, [k]: v } : row))
  const removeComponent = (i) => setRows(r => r.filter((_, idx) => idx !== i))

  const addHardware = () => setHwRows(r => [...r, { name: '', part_id: null, reference_unit_price: 0, quantity_basis: 'fixed', quantity_value: 1, sort_order: r.length }])
  const setHardware = (i, k, v) => setHwRows(r => r.map((row, idx) => idx === i ? { ...row, [k]: v } : row))
  const removeHardware = (i) => setHwRows(r => r.filter((_, idx) => idx !== i))

  const addConstraint = () => setConstraintRows(r => [...r, { rule_type: 'max_width_mm', value: 0, message: '' }])
  const setConstraint = (i, k, v) => setConstraintRows(r => r.map((row, idx) => idx === i ? { ...row, [k]: v } : row))
  const removeJoint = (i) => {
    setRows(r => relinkAfterJointRemoved(r, i))
    setJointRows(js => js.filter((_, k) => k !== i))
  }
  const removeConstraint = (i) => setConstraintRows(r => r.filter((_, idx) => idx !== i))

  // One template, its components, its hardware, and its constraints save
  // together as one unit -- simplest correct approach for a form editor:
  // upsert the template row, then delete-and-reinsert every child table's
  // rows for it. The template row is written first, and children are only
  // touched after it succeeds -- but each child table's own delete+reinsert
  // pair is two separate network requests and is not itself atomic (same
  // accepted tradeoff used elsewhere in this codebase, e.g.
  // Quotations.jsx/PurchaseOrders.jsx).
  // A part-editor template (form.layout_kind set) writes its part model (partSave.saveModel) INSTEAD of flat
  // components/joints (those rows are left untouched and costing ignores them); hardware and constraints save as before.
  // saveModel is not atomic either (delete the template's parts, then insert parts -> positions -> lines -> ends):
  // if it fails midway the template has no / partial part rows. The error is alerted, onSaved is NOT called (so the
  // page does not look saved) and the unsaved model stays in the editor, so pressing save again rewrites it whole.
  const handleSave = async () => {
    setSaving(true)
    try {
      const payload = templatePayload(form, template?.layout_kind)
      const partMode = !!form.layout_kind
      // nothing is written until everything checks out
      const formType = typesById[form.type_id]
      const problem = partMode && formType && formType.layout_kind && formType.layout_kind !== form.layout_kind
        ? layoutLoadText('layout_mismatch', form.layout_kind, formType.layout_kind, layoutLabels)
        : partMode
        ? (paramsInvalid ? PARAMS_HINT : model ? validateModel(model) : layoutProblem ? layoutProblem : (modelError ? 'โหลดข้อมูลชิ้นส่วนของเทมเพลตไม่สำเร็จ จึงยังไม่ได้บันทึกอะไร กรุณารีโหลดหน้านี้: ' + modelError : 'กำลังโหลดข้อมูลชิ้นส่วนของเทมเพลต กรุณารอสักครู่แล้วกดบันทึกอีกครั้ง'))
        : (validateJoints(jointRows) || validateComponentRows(rows, jointRows))
      const aoProblem = partMode && !problem ? addon.problem() : null
      if (problem || aoProblem) { alert(problem || aoProblem); return }
      let templateId = rowId
      // Remember the old rows BEFORE writing anything: if either read fails, stop here (otherwise the old rows
      // would never be deleted and the BOM would be silently doubled).
      let oldComp = []
      let oldJoints = []
      if (!isNew && !partMode) {
        const rc = await supabase.from('bom_template_components').select('id').eq('template_id', templateId)
        const rj = await supabase.from('bom_template_joints').select('id').eq('template_id', templateId)
        if (rc.error || rj.error) {
          alert('อ่านข้อมูลเดิมของเทมเพลตไม่สำเร็จ จึงยังไม่ได้บันทึกอะไร กรุณาลองใหม่: ' + (rc.error || rj.error).message)
          return
        }
        oldComp = (rc.data || []).map(r => r.id)
        oldJoints = (rj.data || []).map(r => r.id)
      }
      if (isNew) {
        const { data, error } = await supabase.from('bom_templates').insert(payload).select('id').single()
        if (error) throw error
        templateId = data.id
        setCreatedId(data.id)
      } else {
        const { error } = await supabase.from('bom_templates').update(payload).eq('id', templateId)
        if (error) throw error
      }

      if (partMode) {
        try {
          await saveModel({ supabase, templateId, model })
          await addon.save(templateId)   // only when a piece set was edited (addonTemplateGlue)
        } catch (e) {
          throw new Error(e.message + ' (ข้อมูลชิ้นส่วนของเทมเพลตนี้อาจไม่ครบ กรุณากดบันทึกอีกครั้ง)')
        }
      } else {
        // Never leave the template empty: write the new rows first, delete the old ones last.
        const newJointIds = []
        const newCompIds = []
        const rollback = async () => {
          if (newCompIds.length) await supabase.from('bom_template_components').delete().in('id', newCompIds)
          if (newJointIds.length) await supabase.from('bom_template_joints').delete().in('id', newJointIds)
        }
        try {
          let jointIds = []
          if (jointRows.length) {
            const { data, error } = await supabase.from('bom_template_joints').insert(jointRowsForInsert(jointRows, templateId)).select('id, sort_order')
            if (error) throw error
            newJointIds.push(...(data || []).map(r => r.id))
            jointIds = orderJointIds(data, jointRows.length)
          }
          if (rows.length) {
            const { data, error } = await supabase.from('bom_template_components').insert(
              componentRowsForInsert(rows, templateId, jointIds.map(id => ({ id })))
            ).select('id')
            if (error) throw error
            newCompIds.push(...(data || []).map(r => r.id))
          }
        } catch (e) {
          await rollback()
          throw new Error(e.message + ' (ข้อมูลเดิมยังอยู่)')
        }
        try {
          if (oldComp.length) {
            const { error } = await supabase.from('bom_template_components').delete().in('id', oldComp)
            if (error) throw error
          }
          if (oldJoints.length) {
            const { error } = await supabase.from('bom_template_joints').delete().in('id', oldJoints)
            if (error) throw error
          }
        } catch (e) {
          throw new Error(e.message + ' (บันทึกชุดใหม่แล้ว แต่ลบชุดเก่าไม่สำเร็จ อาจมีข้อมูลซ้ำ กรุณารีโหลดหน้านี้และตรวจสอบ)')
        }
      }

      {
        const { error } = await supabase.from('bom_template_hardware').delete().eq('template_id', templateId)
        if (error) throw error
      }
      // A NEW part-editor template starts with the hardware its layout declares (editable lines afterwards, no part picked yet).
      // Create only: an existing template's hardware is exactly what the owner left in the tab.
      const hwDefaults = isNew && partMode && model ? hardwareDefaultRows(form.layout_kind, model.params, hwRows.length) : []
      if (isNew && partMode && model) {
        const { skipped } = hardwareDefaultsPlan(form.layout_kind, model.params)
        if (skipped.length) console.warn('hardware defaults skipped', skipped)
      }
      if (hwRows.length || hwDefaults.length) {
        const { error } = await supabase.from('bom_template_hardware').insert([
          ...hwRows.map((h, i) => ({ ...h, part_id: h.part_id || null, template_id: templateId, reference_unit_price: parseFloat(h.reference_unit_price) || 0, quantity_value: parseFloat(h.quantity_value) || 0, sort_order: i })),
          ...hwDefaults.map(h => ({ ...h, template_id: templateId })),
        ])
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

      if (partMode) {
        // Show what is now in the tables (this template only; no tenant-wide refetch). The save itself succeeded,
        // so a failed re-read keeps the in-memory model, which is exactly what was just written.
        try {
          const m = await loadModel({ supabase, template: { id: templateId, layout_kind: form.layout_kind, layout_params: templateParamsPayload(model).layout_params || {} }, type: typesById[form.type_id] || null })
          if (m && !m.error) setModel(m)
          await addon.load(templateId)
        }
        catch (e) { console.warn('reload part model failed', e) }
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

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {EDITOR_TABS.map((label, k) => (
          <button key={k} type="button" className={`btn btn-sm ${tab === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {tab === 1 && <JointsTab view="joints" joints={jointRows} onChange={setJointRows} onRemove={removeJoint} families={familyOptions} index={index} typeId={form.type_id} canEdit={canEdit} />}
      {tab === 2 && <JointsTab view="notch" joints={jointRows} onChange={setJointRows} onRemove={removeJoint} families={familyOptions} index={index} typeId={form.type_id} canEdit={canEdit} />}
      {tab === 3 && <HardwarePackagesTab types={types} typesById={typesById} index={index} canEdit={canEdit} />}

      {tab === 0 && <>
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
          <label className="label">ประเภท (จากแคตตาล็อก)</label>
          <select className="input" disabled={!canEdit} value={form.type_id} onChange={e => set('type_id', e.target.value)}>
            <option value="">— ไม่ระบุ —</option>
            {typeOpts.options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          {typeOpts.savedNotSelectable && form.type_id === template?.type_id && <span className="pill" style={{ color: 'var(--yellow)', fontSize: 11 }}>ประเภทนี้มีประเภทย่อย เลือกประเภทย่อย</span>}
        </div>
        <div>
          <label className="label">รูปแบบภาพตัวอย่าง</label>
          <select className="input" disabled={!canEdit} value={form.preview_kind} onChange={e => set('preview_kind', e.target.value)}>
            {Object.entries(PREVIEW_KIND_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
        <div>
          <label className="label">เส้นหลักของกรอบ (วิ่งเต็ม)</label>
          <select className="input" disabled={!canEdit} value={form.main_axis} onChange={e => set('main_axis', e.target.value)}>
            {Object.entries(MAIN_AXIS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        <div>
          <label className="label">เผื่อเสียเศษ (%)</label>
          <input className="input" disabled={!canEdit} type="number" min="0" step="0.1" value={form.waste_pct} onChange={e => set('waste_pct', e.target.value)} />
        </div>
        <div>
          <label className="label">หักระยะวัสดุอุดช่อง กว้าง (mm)</label>
          <input className="input" disabled={!canEdit} type="number" min="0" value={form.infill_width_deduction_mm} onChange={e => set('infill_width_deduction_mm', e.target.value)} />
        </div>
        <div>
          <label className="label">หักระยะวัสดุอุดช่อง สูง (mm)</label>
          <input className="input" disabled={!canEdit} type="number" min="0" value={form.infill_height_deduction_mm} onChange={e => set('infill_height_deduction_mm', e.target.value)} />
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        <div>
          <label className="label">ค่าแรง (฿/ตร.ม.)</label>
          <input className="input" disabled={!canEdit} type="number" min="0" step="0.01" value={form.labor_price_per_sqm} onChange={e => set('labor_price_per_sqm', e.target.value)} />
        </div>
        <div>
          <label className="label">ซิลิโคน (฿/ม.)</label>
          <input className="input" disabled={!canEdit} type="number" min="0" step="0.01" value={form.silicone_price_per_m} onChange={e => set('silicone_price_per_m', e.target.value)} />
        </div>
        <div>
          <label className="label">สักหลาด (฿/ม.)</label>
          <input className="input" disabled={!canEdit} type="number" min="0" step="0.01" value={form.felt_price_per_m} onChange={e => set('felt_price_per_m', e.target.value)} />
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

      {form.layout_kind ? (
        model
          ? <PartEditor model={model} onChange={setModel} index={index} canEdit={canEdit} templateName={form.name} onParamsInvalid={setParamsInvalid} {...addon.editorProps}
              testSeriesId={testPick.seriesId} testThicknessMm={testPick.thicknessMm} onTestChange={setTestPick} />
          : <div role={layoutProblem || modelError ? 'alert' : undefined} style={{ color: layoutProblem || modelError ? 'var(--red)' : 'var(--text3)', padding: 12 }}>
              {layoutProblem || (modelError ? 'โหลดข้อมูลชิ้นส่วนของเทมเพลตไม่สำเร็จ กรุณารีโหลดหน้านี้: ' + modelError : 'กำลังโหลดข้อมูลชิ้นส่วนของเทมเพลต...')}
            </div>
      ) : (
      <div>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>ชิ้นส่วนอลูมิเนียม (Components)</div>
        {canEdit && !rows.length && (typeKind && typeKind !== 'sliding_2'
          ? (
            <button type="button" className="btn btn-sm btn-ghost" style={{ marginBottom: 8, border: '1px dashed var(--accent)' }} onClick={() => startFromLayout(typeKind, formTypeRow)}>
              สร้างจากแบบ{layoutLabels[typeKind]} (ตามประเภทที่เลือก)
            </button>
          ) : (
            <button type="button" className="btn btn-sm btn-ghost" style={{ marginBottom: 8, border: '1px dashed var(--accent)' }} onClick={() => startFromLayout('sliding_2', formTypeRow)}>
              สร้างจากแบบบานเลื่อน 2 บาน (เพิ่มช่องแสงได้ในกล่องช่องแสง)
            </button>
          ))}
        {startError && <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 8 }}>{startError}</div>}
        <div style={{ display: 'grid', gap: 6 }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: 'grid', gap: 4 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 80px 1fr 80px 32px', gap: 6, alignItems: 'center' }}>
              <input className="input input-sm" disabled={!canEdit} placeholder="ชื่อชิ้นส่วน" value={r.role_name} onChange={e => setComponent(i, 'role_name', e.target.value)} />
              <input className="input input-sm" disabled={!canEdit} list="profile-family-options" placeholder="กลุ่มหน้าตัด" value={r.profile_family} onChange={e => setComponent(i, 'profile_family', e.target.value)} />
              <select className="input input-sm" disabled={!canEdit} value={r.length_rule_type} onChange={e => setComponent(i, 'length_rule_type', e.target.value)}>
                {Object.entries(LENGTH_RULE_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              <input className="input input-sm" disabled={!canEdit} type="number" min="0" placeholder="ระยะหัก mm" value={r.length_deduction_mm} onChange={e => setComponent(i, 'length_deduction_mm', e.target.value)} />
              <select className="input input-sm" disabled={!canEdit} value={r.quantity_basis} onChange={e => setComponent(i, 'quantity_basis', e.target.value)}>
                {Object.entries(QUANTITY_BASIS_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              <input className="input input-sm num-spin" disabled={!canEdit} type="number" step="any" min="0" placeholder="จำนวน" value={r.quantity_value} onChange={e => setComponent(i, 'quantity_value', e.target.value)} />
              {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => removeComponent(i)}>✕</button>}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', paddingLeft: 8 }}>
              <select className="input input-sm" style={{ width: 200 }} disabled={!canEdit} value={r.joint_index ?? ''} onChange={e => setComponent(i, 'joint_index', e.target.value)}>
                <option value="">ไม่มีจุดชน</option>
                {jointRows.map((j, k) => <option key={k} value={String(k)}>{j.name || `จุดชน ${k + 1}`}</option>)}
              </select>
              {(r.joint_index ?? '') !== '' && (
                <select className="input input-sm" style={{ width: 120 }} disabled={!canEdit} value={Number(r.joint_ends) === 1 ? '1' : '2'} onChange={e => setComponent(i, 'joint_ends', Number(e.target.value))}>
                  <option value="2">ชน 2 ปลาย</option>
                  <option value="1">ชน 1 ปลาย</option>
                </select>
              )}
              {showThickness && (
                <select className="input input-sm" style={{ width: 170 }} disabled={!canEdit} value={r.thickness_role === 'sash' ? 'sash' : ''} onChange={e => setComponent(i, 'thickness_role', e.target.value === 'sash' ? 'sash' : null)}>
                  <option value="">ความหนา: ตามวงกบ</option>
                  <option value="sash">ความหนา: ตามบาน</option>
                </select>
              )}
            </div>
            </div>
          ))}
          {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ justifySelf: 'start' }} onClick={addComponent}>+ เพิ่มชิ้นส่วน</button>}
        </div>
      </div>
      )}

      <div>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>อุปกรณ์ (Hardware)</div>
        <div style={{ display: 'grid', gap: 6 }}>
          {hwRows.map((h, i) => (
            <div key={i} style={{ display: 'grid', gap: 4 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px 1fr 80px 32px', gap: 6, alignItems: 'center' }}>
              <input className="input input-sm" disabled={!canEdit} placeholder="ชื่ออุปกรณ์" value={h.name} onChange={e => setHardware(i, 'name', e.target.value)} />
              <input className="input input-sm" disabled={!canEdit} type="number" min="0" placeholder="ราคา/ชิ้น" value={h.reference_unit_price} onChange={e => setHardware(i, 'reference_unit_price', e.target.value)} />
              <select className="input input-sm" disabled={!canEdit} value={h.quantity_basis} onChange={e => setHardware(i, 'quantity_basis', e.target.value)}>
                {Object.entries(HARDWARE_BASIS_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              <input className="input input-sm num-spin" disabled={!canEdit} type="number" step="any" min="0" placeholder="จำนวน" value={h.quantity_value} onChange={e => setHardware(i, 'quantity_value', e.target.value)} />
              {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => removeHardware(i)}>✕</button>}
            </div>
            <select className="input input-sm" style={{ marginLeft: 8, maxWidth: 360 }} disabled={!canEdit} value={h.part_id || ''} onChange={e => setHardware(i, 'part_id', e.target.value || null)}>
              <option value="">— ไม่ผูก (ใช้ราคาอ้างอิง) —</option>
              {partOpts.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
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

      </>}

      {canEdit && tab !== 3 && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {!isNew && <button type="button" className="btn btn-ghost" style={{ color: 'var(--red)' }} onClick={() => onDeleted(rowId)}>🗑️ ลบ Template</button>}
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
  const { data: joints, refetch: refetchJoints } = useTemplateJoints()
  const { data: types } = useCatalogTable('door_window_types', 'name')
  const catalog = useEstimationCatalog()
  // The editor copies joints/types/catalog on mount, so it must not open before they arrive (a save would wipe joints).
  const ready = !!(joints && types && catalog.index)
  const [selectedId, setSelectedId] = useState(null)
  const [creating, setCreating] = useState(false)
  const [deleteId, setDeleteId] = useState(null)
  // the card pictures: part-editor templates are drawn from their part rows (read-only here, the editor still loads its own)
  const typesById = useMemo(() => Object.fromEntries((types || []).map(t => [t.id, t])), [types])
  const partModels = useBomPartModel(templates, types ? typesById : null)

  const selected = (templates || []).find(t => t.id === selectedId)

  const handleDelete = async () => {
    if (!deleteId) return
    const { error } = await supabase.from('bom_templates').delete().eq('id', deleteId)
    if (!error) { setDeleteId(null); setSelectedId(null); refetchTemplates() }
    else alert('ลบไม่สำเร็จ (อาจมี opening ที่ใช้ template นี้อยู่): ' + error.message)
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
      <div className="card" style={{ padding: 12, flex: '1 1 340px', maxWidth: '100%', minWidth: 0 }}>
        {canEdit && <button className="btn btn-primary btn-sm" style={{ marginBottom: 10, width: '100%', minHeight: 44 }} onClick={() => { setCreating(true); setSelectedId(null) }}>+ Template ใหม่</button>}
        <TemplateCardGrid templates={templates || []} typesById={typesById} partModelByTemplate={partModels.partModelByTemplate} selectedId={selectedId}
          onPick={t => { setSelectedId(t.id); setCreating(false) }} maxHeight="75vh" emptyText="ยังไม่มี Template" />
      </div>
      <div style={{ flex: '999 1 520px', minWidth: 0 }}>
        {(creating || selected) && !ready && <div style={{ color: 'var(--text3)', padding: 20 }}>กำลังโหลดแคตตาล็อก...</div>}
        {ready && creating && (
          <TemplateEditor key="new" template={null} joints={[]} catalog={catalog} types={types || []} components={[]} hardware={[]} constraints={[]} canEdit={canEdit}
            onSaved={() => { setCreating(false); refetchTemplates(); refetchComponents(); refetchHardware(); refetchConstraints(); refetchJoints(); partModels.refetch() }} onDeleted={() => {}} />
        )}
        {ready && selected && !creating && (
          <TemplateEditor key={selected.id} template={selected} joints={joints || []} catalog={catalog} types={types || []} components={components || []} hardware={hardware || []} constraints={constraints || []} canEdit={canEdit}
            onSaved={() => { refetchTemplates(); refetchComponents(); refetchHardware(); refetchConstraints(); refetchJoints(); partModels.refetch() }} onDeleted={(id) => setDeleteId(id)} />
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
  const { data: infillTypes, refetch: refetchInfillTypes } = useInfillTypes()

  const [showInfillForm, setShowInfillForm] = useState(false)
  const [editInfill, setEditInfill] = useState(null)
  const [savingInfill, setSavingInfill] = useState(false)
  const [deleteInfillId, setDeleteInfillId] = useState(null)

  const handleSaveInfill = async (form) => {
    setSavingInfill(true)
    try {
      const payload = { name: form.name, price_per_sqm: parseFloat(form.price_per_sqm) || 0, material_kind: form.material_kind, active: form.active !== false }
      const { error } = editInfill
        ? await supabase.from('infill_types').update(payload).eq('id', editInfill.id)
        : await supabase.from('infill_types').insert(payload)
      if (error) throw error
      setShowInfillForm(false); setEditInfill(null); refetchInfillTypes()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setSavingInfill(false) }
  }

  const handleDeleteInfill = async () => {
    if (!deleteInfillId) return
    const { error } = await supabase.from('infill_types').delete().eq('id', deleteInfillId)
    if (!error) { setDeleteInfillId(null); refetchInfillTypes() }
    else alert('ลบไม่สำเร็จ (อาจมีการใช้งานผูกอยู่): ' + error.message)
  }

  return (
    <div>
      <div data-phone="chips" style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className={`btn btn-sm ${view === 'templates' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('templates')}>🧩 BOM Templates</button>
        {/* Legacy profile / colour lists are hidden so there is one list only (the catalog's).
            Restore these two buttons to bring them back; Phase 2 deletes them for good. */}
        <span style={{ alignSelf: 'center', fontSize: 12, color: 'var(--text3)' }}>หน้าตัดและสีอลูมิเนียมอยู่ที่ ประเมินราคา → 🏭 แคตตาล็อกอลูมิเนียม</span>
        <button className={`btn btn-sm ${view === 'infill_types' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('infill_types')}>🪟 วัสดุอุดช่อง</button>
      </div>

      {view === 'templates' && (
        <TemplatesView canEdit={canEdit} />
      )}

      {view === 'profiles' && <AluminumProfiles />}

      {view === 'infill_types' && (
        <>
          {canEdit && <button className="btn btn-primary" style={{ marginBottom: 14 }} onClick={() => { setEditInfill(null); setShowInfillForm(true) }}>+ เพิ่มวัสดุอุดช่อง</button>}
          <div className="card">
            <CardTable>
              <table>
                <thead><tr><th>ชื่อวัสดุ</th><th>ประเภท</th><th>ราคา/ตร.ม.</th><th>สถานะ</th><th></th></tr></thead>
                <tbody>
                  {(infillTypes || []).map(g => (
                    <tr key={g.id}>
                      <td style={{ fontWeight: 600 }}>{g.name}</td>
                      <td>{MATERIAL_KIND_LABELS[g.material_kind] || g.material_kind}</td>
                      <td className="font-mono">{fmt(g.price_per_sqm)}</td>
                      <td>{g.active ? <span className="badge badge-paid">ใช้งานอยู่</span> : <span className="badge badge-finished">ปิดใช้งาน</span>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {canEdit && (
                          <>
                            <button className="btn btn-sm btn-ghost" onClick={() => { setEditInfill(g); setShowInfillForm(true) }}>แก้ไข</button>
                            <button className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => setDeleteInfillId(g.id)}>ลบ</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!(infillTypes || []).length && <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีวัสดุอุดช่อง</td></tr>}
                </tbody>
              </table>
            </CardTable>
          </div>
        </>
      )}

      {showInfillForm && (
        <Modal title={editInfill ? `แก้ไข ${editInfill.name}` : 'เพิ่มวัสดุอุดช่องใหม่'} onClose={() => { setShowInfillForm(false); setEditInfill(null) }} maxWidth={420}>
          <InfillTypeForm initial={editInfill || {}} onSave={handleSaveInfill} onCancel={() => { setShowInfillForm(false); setEditInfill(null) }} loading={savingInfill} />
        </Modal>
      )}
      {deleteInfillId && <ConfirmDialog title="ลบวัสดุอุดช่อง" message="ยืนยันการลบ?" onConfirm={handleDeleteInfill} onCancel={() => setDeleteInfillId(null)} />}
    </div>
  )
}
