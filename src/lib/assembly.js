// src/lib/assembly.js
// Joint (butt) logic for a template: which bar is the main bar, how much the secondary bar is shortened,
// how its end is cut. Pure. The engine stays as it is: callers run applyJoints / applyRoleThickness on the
// template's components BEFORE computeBomForOpening, which then sees ordinary length_deduction_mm values.
import { resolveCatalogProfile } from './aluCatalogPricing.js'

const finitePos = n => Number.isFinite(n) && n >= 0

// Deduction (mm) taken off ONE end of the secondary bar. The profile records its PRIMARY CONTACT SURFACE: the face the
// secondary bar butts against. The bar is shortened by the dimension perpendicular to that face:
//   primary_contact 'width' (default) = it butts the wide face  -> shortened by depth_mm   (e.g. 101.6 face -> 44.45)
//   primary_contact 'depth'           = it butts the narrow face -> shortened by width_mm
// A mitre needs no deduction here; manual wins.
export function jointDeductionMm(joint, mainProfile) {
  if (!joint) return { mm: null, reason: 'unknown_joint' }
  if (joint.deduction_mode === 'manual') {
    const raw = joint.deduction_mm
    const n = raw === null || raw === undefined || raw === '' ? NaN : Number(raw)
    return finitePos(n) ? { mm: n, source: 'manual' } : { mm: null, reason: 'bad_manual_deduction' }
  }
  if (joint.cut_style === 'miter45') return { mm: 0, source: 'miter' }
  if (!mainProfile) return { mm: null, reason: 'no_main_profile' }
  const dim = Number(mainProfile.primary_contact === 'depth' ? mainProfile.width_mm : mainProfile.depth_mm)
  return dim > 0 ? { mm: dim, source: 'auto' } : { mm: null, reason: 'no_dimension' }
}

const SHORTEN = { width: 'width_minus', height: 'height_minus', width_minus: 'width_minus', height_minus: 'height_minus' }

// Returns { components, issues }. A component with a joint_id gets its deduction from the joint
// (per end x joint_ends, default 2), and carries the joint's cut style / notch size for the cut optimizer.
// A joint that cannot be resolved leaves the component exactly as the template wrote it and lists an issue.
export function applyJoints({ components, joints, index, seriesId, thicknessMm }) {
  const jointsById = {}
  for (const j of joints || []) jointsById[j.id] = j
  const issues = []
  // the thickness each profile family is built at (a sash-role bar may differ from the frame); first component wins
  const familyThickness = {}
  for (const c of components || []) {
    if (c.profile_family && !(c.profile_family in familyThickness)) familyThickness[c.profile_family] = c.thickness_mm != null ? c.thickness_mm : thicknessMm
  }
  // main family -> name of the first mitre joint that mitres it (the cut sheet shows which joint cut the bar)
  const miterName = new Map()
  for (const j of joints || []) {
    if (j.cut_style === 'miter45' && j.main_family && !miterName.has(j.main_family)) miterName.set(j.main_family, j.name || null)
  }
  const out = (components || []).map(c => {
    // cut_ends = how many ends carry cut_style (0, 1 or 2); the other ends are square
    if (!c.joint_id) return { ...c, cut_style: c.cut_style || 'square', cut_ends: (c.cut_style && c.cut_style !== 'square') ? 2 : 0, joint_name: null }
    const joint = jointsById[c.joint_id]
    const rule = SHORTEN[c.length_rule_type]
    if (!rule) { issues.push({ role_name: c.role_name, reason: 'rule_not_cuttable' }); return { ...c, cut_style: 'square', cut_ends: 0, joint_name: null } }
    // the main bar is looked up at the thickness of its own components (frame by default, sash where the main bars are
    // sash-role); the secondary bar's own thickness does not move it
    const main = joint ? resolveCatalogProfile(index, seriesId, joint.main_family, familyThickness[joint.main_family] ?? thicknessMm).profile : null
    const ded = jointDeductionMm(joint, main)
    if (ded.mm === null) { issues.push({ role_name: c.role_name, reason: ded.reason }); return { ...c, cut_style: 'square', cut_ends: 0, joint_name: null } }
    const ends = Number(c.joint_ends) === 1 ? 1 : 2
    const base = c.length_rule_type === 'width' || c.length_rule_type === 'height' ? 0 : Number(c.length_deduction_mm) || 0
    return {
      ...c, length_rule_type: rule, length_deduction_mm: base + ded.mm * ends,
      cut_style: joint.cut_style || 'square', notch_width_mm: joint.notch_width_mm ?? null, notch_depth_mm: joint.notch_depth_mm ?? null,
      cut_ends: (joint.cut_style || 'square') === 'square' ? 0 : ends, joint_name: joint.name || null,
    }
  })
  // a mitre joint cuts the main bars at 45 degrees too (their lengths are unchanged); a bar with its own joint keeps what that joint gave it
  const withMitreMains = out.map(c => (!c.joint_id && miterName.has(c.profile_family) && (c.cut_style || 'square') === 'square'
    ? { ...c, cut_style: 'miter45', cut_ends: 2, joint_name: miterName.get(c.profile_family) }
    : c))
  return { components: withMitreMains, issues }
}

// Government-style specs fix the frame and the sash separately (e.g. frame 2.0 mm, sash 1.5 mm). A template component
// is tagged thickness_role 'sash' (or NULL = frame/main). Where the series+type allows mixed thickness and a sash
// thickness is set, sash-role components are priced at that thickness; every other case uses the opening thickness.
// The engine reads the resulting component.thickness_mm (NULL = the opening thickness).
export function applyRoleThickness(components, { allowMixed, sashThicknessMm } = {}) {
  const sash = Number(sashThicknessMm)
  return (components || []).map(c => ({ ...c, thickness_mm: c.thickness_role === 'sash' && allowMixed && sash > 0 ? sash : null }))
}
