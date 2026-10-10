// src/lib/templateSave.js
// Saving a template rewrites its joints and components (delete + reinsert), so a component cannot keep the old
// joint id. In the editor a component points at a joint by its POSITION in the joint list (joint_index, or null);
// after the joints are inserted (ids returned in the same order) this turns the rows into insertable ones.
const numOrNull = v => (v === null || v === undefined || String(v).trim() === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null))

export function jointRowsForInsert(jointRows, templateId) {
  return (jointRows || []).map((j, i) => ({
    template_id: templateId, name: String(j.name || '').trim() || `จุดชน ${i + 1}`,
    main_family: String(j.main_family || '').trim(), secondary_family: String(j.secondary_family || '').trim(),
    deduction_mode: j.deduction_mode === 'manual' ? 'manual' : 'auto',
    deduction_mm: j.deduction_mode === 'manual' ? numOrNull(j.deduction_mm) : null,
    cut_style: ['square', 'notch', 'miter45'].includes(j.cut_style) ? j.cut_style : 'square',
    notch_width_mm: j.cut_style === 'notch' ? numOrNull(j.notch_width_mm) : null,
    notch_depth_mm: j.cut_style === 'notch' ? numOrNull(j.notch_depth_mm) : null,
    sort_order: i,
  }))
}

// Why the joints cannot be saved (first problem, Thai), or null.
export function validateJoints(jointRows) {
  for (const [i, j] of (jointRows || []).entries()) {
    if (!String(j.main_family || '').trim() || !String(j.secondary_family || '').trim()) return `จุดชนที่ ${i + 1}: เลือกเส้นหลักและเส้นรอง`
    // null >= 0 is true in JS, so a blank must be rejected explicitly
    if (j.deduction_mode === 'manual' && (numOrNull(j.deduction_mm) === null || numOrNull(j.deduction_mm) < 0)) return `จุดชนที่ ${i + 1}: กรอกค่าหัก (มม.)`
    if (j.cut_style === 'notch' && !(numOrNull(j.notch_width_mm) > 0 && numOrNull(j.notch_depth_mm) > 0)) return `จุดชนที่ ${i + 1}: กรอกขนาดบาก กว้างและลึก`
  }
  return null
}

export function componentRowsForInsert(rows, templateId, insertedJoints) {
  return (rows || []).map((r, i) => {
    const idx = r.joint_index === '' || r.joint_index === null || r.joint_index === undefined ? null : Number(r.joint_index)
    const joint = idx !== null && Number.isInteger(idx) ? (insertedJoints || [])[idx] : null
    // an explicit whitelist: editor-only fields (joint_index, thickness_mm, ...) must never reach PostgREST
    return {
      template_id: templateId, role_name: r.role_name, profile_family: r.profile_family, length_rule_type: r.length_rule_type,
      length_deduction_mm: parseFloat(r.length_deduction_mm) || 0,
      quantity_basis: r.quantity_basis,
      quantity_value: parseFloat(r.quantity_value) || 0,
      joint_id: joint ? joint.id : null,
      joint_ends: Number(r.joint_ends) === 1 ? 1 : 2,
      thickness_role: r.thickness_role === 'sash' ? 'sash' : null,
      sort_order: i,
    }
  })
}

// When an existing template is opened: each component's joint_id becomes a position in the (sorted) joint list.
export function jointIndexForLoad(components, joints) {
  const order = [...(joints || [])].sort((a, b) => a.sort_order - b.sort_order)
  return (components || []).map(c => ({ ...c, joint_index: c.joint_id ? String(order.findIndex(j => j.id === c.joint_id)).replace('-1', '') : '' }))
}

// The bom_templates row for the editor form. layout_kind (part-editor templates) is sent only when the form has one
// or the saved row had one (then '' clears it to null): a legacy template sends exactly the payload it always did,
// with no layout_kind key, so it also keeps saving before the 2026-10-15-01 migration is applied.
export function templatePayload(form, savedLayoutKind = null) {
  const payload = {
    name: form.name, category: form.category,
    waste_pct: parseFloat(form.waste_pct) || 0,
    infill_width_deduction_mm: parseFloat(form.infill_width_deduction_mm) || 0,
    infill_height_deduction_mm: parseFloat(form.infill_height_deduction_mm) || 0,
    labor_price_per_sqm: parseFloat(form.labor_price_per_sqm) || 0,
    silicone_price_per_m: parseFloat(form.silicone_price_per_m) || 0,
    felt_price_per_m: parseFloat(form.felt_price_per_m) || 0,
    grid_row_weights: form.grid_row_weights,
    grid_horizontal_rail_family: form.grid_horizontal_rail_family || null,
    grid_vertical_mullion_family: form.grid_vertical_mullion_family || null,
    type_id: form.type_id || null,
    preview_kind: form.preview_kind, main_axis: form.main_axis,
    active: form.active !== false,
  }
  if (form.layout_kind || savedLayoutKind) payload.layout_kind = form.layout_kind || null
  return payload
}
