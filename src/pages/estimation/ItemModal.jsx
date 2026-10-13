// src/pages/estimation/ItemModal.jsx
// Add / edit one estimation item (mockup screen 2). Two columns: left = item fields, add-on, quotation
// description; right = live preview, layout-template cards, saved-snapshot options and the cost of one set.
// Saves through buildOpeningPayload; the snapshot signature comes from the shared itemPreviewSignature helper,
// built from the SAME normalised payload. A layout template is saved only after the item saved.
import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase.js'
import { Modal } from '../../components/Modal.jsx'
import { emptyForm, formFromOpening, buildOpeningPayload } from '../../lib/openingPayload.js'
import { snapshotFor } from '../../lib/itemPreviewSignature.js'
import { bomTemplatesForType } from '../../lib/layoutTemplates.js'
import { typePath, pickInPath, cascadeLevels, typeTreeOf, templatesForType, reconcileItemForm, validateItemForm, applyCardToForm, layoutRowFromItem, layoutSaveErrorText } from './itemForm.js'
import { useItemModel } from './useItemModel.js'
import ItemFields from './ItemFields.jsx'
import AddonFields from './AddonFields.jsx'
import PreviewPanel from './PreviewPanel.jsx'
import LayoutTemplatePicker from './LayoutTemplatePicker.jsx'
import SnapshotOptions from './SnapshotOptions.jsx'
import ItemCostSummary from './ItemCostSummary.jsx'
import { cycleCell } from '../../lib/layoutCells.js'
import { PARAMS_HINT } from '../bomTemplates/partEditorView.js'

export default function ItemModal({ opening, project, ctx, templates, constraints, infillTypes, layoutTemplates, seriesTypes, currentSig, canEdit, onClose, onSaved, onLayoutSaved }) {
  const { index, templatesById } = ctx
  const [form, setForm] = useState(() => (opening ? formFromOpening(opening) : emptyForm()))
  const [path, setPath] = useState(() => typePath(index.types, (templatesById[opening && opening.template_id] || {}).type_id))
  const [own, setOwnState] = useState(() => ({ finish: !!(opening && opening.alu_finish_id), infill: !!(opening && opening.infill_type_id), hw: !!(opening && opening.hardware_set_id) }))
  const [addonTypeId, setAddonTypeId] = useState(() => (templatesById[opening && opening.addon_template_id] || {}).type_id || '')
  // an opened item keeps its description (even blank) until the owner presses "สร้างใหม่จากรูปแบบ"; a new one follows
  const [descTouched, setDescTouched] = useState(() => !!opening)
  const [layoutPick, setLayoutPick] = useState(null)
  const [layoutSave, setLayoutSave] = useState({ on: false, name: '' })
  const [snap, setSnap] = useState({ on: true, out: true, in: true })
  const [savedId, setSavedId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [layoutError, setLayoutError] = useState(null)
  const dis = !canEdit || busy
  const rowId = (opening && opening.id) || savedId

  // fills only (single thickness, blank sash on a frame change / new item); never clears an own value
  // another template drops the item's layout inputs (they belong to the old template's layout)
  const update = patch => setForm(f => {
    const p = patch.template_id !== undefined && patch.template_id !== f.template_id && patch.layout_params === undefined ? { ...patch, layout_params: {} } : patch
    return reconcileItemForm(f, { ...f, ...p }, { index, project, template: templatesById[p.template_id ?? f.template_id], isNew: !rowId })
  })
  const m = useItemModel({ form, path, addonTypeId, project, ctx, templates, constraints, infillTypes, layoutTemplates, seriesTypes })
  // curtain wall: a click on a cell of the item preview cycles it into the item's layout_params.cells (estimator input)
  const onCell = m.part && m.layoutInputs && m.layoutInputs.cells && !dis
    ? (r, c) => update({ layout_params: { ...(form.layout_params || {}), cells: cycleCell(m.part.model, r, c).params.cells } })
    : null

  // the quotation description follows the item until the owner types in it ("สร้างใหม่" brings it back)
  useEffect(() => { if (!descTouched) setForm(f => (f.item_description === m.generatedDescription ? f : { ...f, item_description: m.generatedDescription })) }, [m.generatedDescription, descTouched])

  const pickType = (level, value) => {
    const next = pickInPath(path, level, value)
    setPath(next)
    setLayoutPick(null)
    const leaf = cascadeLevels(typeTreeOf(index.types), next).leafId
    const first = leaf ? templatesForType((templates || []).filter(t => t.active !== false), leaf, null)[0] : null
    update({ template_id: first ? first.id : '' })
  }
  const pickAddonType = value => {
    setLayoutPick(null)
    if (!value) { setAddonTypeId(''); update({ has_addon: false, addon_template_id: '' }); return }
    if (value === '?') return
    setAddonTypeId(value)
    const first = bomTemplatesForType(m.addonTemplates, value)[0]
    update({ has_addon: true, addon_template_id: first ? first.id : '' })
  }
  const setOwn = (k, on) => {
    setOwnState(o => ({ ...o, [k]: on }))
    if (!on) update({ finish: { alu_finish_id: '' }, infill: { infill_type_id: '' }, hw: { hardware_set_id: '' } }[k])
  }
  const pickCard = card => {
    setLayoutPick(card.template.id)
    if (card.addonTemplate) setAddonTypeId(card.addonTemplate.type_id || '')
    update(applyCardToForm(form, card))
  }

  const storedSnapshot = opening && (opening.preview_svg_out || opening.preview_svg_in) && opening.preview_sig
  const stale = !!(storedSnapshot && currentSig && currentSig !== opening.preview_sig)

  const handleSave = async () => {
    // the template editor blocks refused layout params too (folding 0 + 0 would leave the aluminium unpriced)
    const invalid = validateItemForm(form) || (m.layoutInputs && m.layoutInputs.invalid ? PARAMS_HINT : null) || (layoutSave.on && !layoutSave.name.trim() ? 'ตั้งชื่อแม่แบบรูปแบบ' : null)
    if (invalid) { setError(invalid); return }
    setError(null); setLayoutError(null); setBusy(true)
    try {
      const plain = buildOpeningPayload(form, { projectId: project.id })
      const previews = snap.on ? snapshotFor(plain, { project, ctx, views: { out: snap.out, in: snap.in } }) : null
      const savedAt = previews ? new Date().toISOString() : null
      const payload = buildOpeningPayload(form, { projectId: project.id, previews, savedAt })
      const { data, error: e } = rowId
        ? await supabase.from('estimation_openings').update(payload).eq('id', rowId).select('id').single()
        : await supabase.from('estimation_openings').insert(payload).select('id').single()
      if (e) throw e
      setSavedId(data.id)
      if (layoutSave.on) {
        let layoutFail = null
        try {
          const tpl = templatesById[payload.template_id]
          const atpl = payload.addon_template_id ? templatesById[payload.addon_template_id] : null
          const row = tpl && tpl.type_id ? layoutRowFromItem(payload, { name: layoutSave.name, mainTypeId: tpl.type_id, addonTypeId: atpl && atpl.type_id }) : null
          const { error: le } = row ? await supabase.from('estimation_layout_templates').insert(row) : { error: { message: 'เทมเพลตนี้ยังไม่มีประเภท' } }
          layoutFail = le || null
        } catch (le) { layoutFail = le }
        if (layoutFail) { setLayoutError(`บันทึกรายการแล้ว แต่ ${layoutSaveErrorText(layoutFail)}`); onSaved({ close: false }); return }
        setLayoutSave({ on: false, name: '' })
        onLayoutSaved()
      }
      onSaved({ close: true })
    } catch (e) { setError('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setBusy(false) }
  }

  const resaveSnapshot = async () => {
    setBusy(true); setError(null)
    try {
      const previews = snapshotFor(opening, { project, ctx, views: { out: true, in: true } })
      if (!previews) throw new Error('วาดภาพจากข้อมูลที่บันทึกไว้ไม่ได้')
      const savedAt = new Date().toISOString()
      const { error: e } = await supabase.from('estimation_openings')
        .update({ preview_svg_out: previews.out, preview_svg_in: previews.in, preview_sig: previews.sig, preview_saved_at: savedAt }).eq('id', opening.id)
      if (e) throw e
      onSaved({ close: false })
    } catch (e) { setError('บันทึกภาพไม่สำเร็จ: ' + e.message) }
    finally { setBusy(false) }
  }

  return (
    <Modal title={rowId ? `แก้ไขรายการ ${form.opening_no || ''}` : 'เพิ่มรายการ'} onClose={() => (busy ? false : onClose())} maxWidth={1180}>
      <div className="modal-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 18, alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
          <ItemFields form={form} update={update} dis={dis} m={{ ...m, pickType, own, setOwn }} />
          {m.violations.map((msg, i) => <div key={i} className="alert alert-error" style={{ fontSize: 13 }}>⚠️ {msg}</div>)}
          <AddonFields form={form} update={update} dis={dis} typeId={addonTypeId} typeOptions={m.addonTypeOptions} templateOptions={m.addonTemplateOptions} onPickType={pickAddonType} violations={m.addonViolations} />
          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>คำอธิบายสำหรับใบเสนอราคา <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text3)' }}>ประกอบจากรูปแบบของโปรเจกต์ แก้ข้อความเองได้</span></div>
            <textarea className="input" rows={3} disabled={dis} value={form.item_description} onChange={e => { setDescTouched(true); setForm(f => ({ ...f, item_description: e.target.value })) }} />
            {!dis && <button type="button" className="btn btn-sm btn-ghost" style={{ justifySelf: 'start' }} onClick={() => { setDescTouched(false); setForm(f => ({ ...f, item_description: m.generatedDescription })) }}>สร้างใหม่จากรูปแบบ</button>}
          </div>
        </div>
        <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
          <PreviewPanel inputs={m.inputs} part={m.part} labels={m.labels} availability={m.availability} addonPartial={m.addonPartial}
            onCell={onCell} hint={m.layoutInputs && m.layoutInputs.invalid ? PARAMS_HINT : null} />
          <LayoutTemplatePicker cards={m.cards} selectedId={layoutPick} mainTemplate={m.template} disabled={dis} onPick={pickCard} onClear={() => setLayoutPick(null)}
            save={layoutSave} onSaveChange={setLayoutSave} saveError={layoutError} />
          <SnapshotOptions snap={snap} onChange={setSnap} stale={stale} savedAt={opening && opening.preview_saved_at} onResave={resaveSnapshot} busy={busy} dis={dis} />
          <ItemCostSummary cost={m.cost} flags={m.costFlags} index={index} addonName={m.addonTemplate && m.addonTemplate.name} />
        </div>
      </div>
      {error && <div className="alert alert-error" style={{ margin: '0 16px', fontSize: 13 }}>{error}</div>}
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>{canEdit ? 'ยกเลิก' : 'ปิด'}</button>
        {canEdit && <button type="button" className="btn btn-primary" disabled={busy} onClick={handleSave}>{busy ? '⏳ กำลังบันทึก...' : '💾 บันทึกรายการ'}</button>}
      </div>
    </Modal>
  )
}
