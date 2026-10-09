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
    const { joint_index, id, tenant_id, created_at, ...rest } = r
    void joint_index; void id; void tenant_id; void created_at
    return {
      ...rest, template_id: templateId,
      length_deduction_mm: parseFloat(r.length_deduction_mm) || 0,
      quantity_value: parseFloat(r.quantity_value) || 0,
      thickness_mm: numOrNull(r.thickness_mm),
      joint_id: joint ? joint.id : null,
      joint_ends: Number(r.joint_ends) === 1 ? 1 : 2,
      sort_order: i,
    }
  })
}

// When an existing template is opened: each component's joint_id becomes a position in the (sorted) joint list.
export function jointIndexForLoad(components, joints) {
  const order = [...(joints || [])].sort((a, b) => a.sort_order - b.sort_order)
  return (components || []).map(c => ({ ...c, joint_index: c.joint_id ? String(order.findIndex(j => j.id === c.joint_id)).replace('-1', '') : '' }))
}
