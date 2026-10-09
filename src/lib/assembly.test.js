import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from './aluCatalogPricing.js'
import { jointDeductionMm, applyJoints, applyRoleThickness } from './assembly.js'

const index = buildCatalogIndex({
  series: [{ id: 's1', provider_id: 'pA' }],
  profiles: [
    { id: 'box', provider_id: 'pA', family: 'กล่องเรียบ', thickness_mm: 1.5, depth_mm: 44.45, width_mm: 101.6, primary_contact: 'width' },
    { id: 'boxn', provider_id: 'pA', family: 'กล่องแคบ', thickness_mm: 1.5, depth_mm: 44.45, width_mm: 101.6, primary_contact: 'depth' },
    { id: 'nodim', provider_id: 'pA', family: 'ไม่มีมิติ', thickness_mm: 1.5 },
  ],
  seriesProfiles: ['box', 'boxn', 'nodim'].map(profile_id => ({ series_id: 's1', profile_id })),
})
const joint = (o = {}) => ({ id: 'j1', main_family: 'กล่องเรียบ', secondary_family: 'x', deduction_mode: 'auto', cut_style: 'square', ...o })

describe('jointDeductionMm', () => {
  it('auto: a bar butting the WIDE face (101.6) is shortened by the depth (44.45); butting the narrow face by the width', () => {
    expect(jointDeductionMm(joint(), index.profiles.box)).toEqual({ mm: 44.45, source: 'auto' })
    expect(jointDeductionMm(joint(), index.profiles.boxn)).toEqual({ mm: 101.6, source: 'auto' })
  })
  it('a profile with no primary_contact set behaves as the default (wide face)', () => {
    expect(jointDeductionMm(joint(), { width_mm: 101.6, depth_mm: 44.45 }).mm).toBe(44.45)
  })
  it('manual wins and must be a number >= 0; 0 is allowed', () => {
    expect(jointDeductionMm(joint({ deduction_mode: 'manual', deduction_mm: 3 }), null)).toEqual({ mm: 3, source: 'manual' })
    expect(jointDeductionMm(joint({ deduction_mode: 'manual', deduction_mm: 0 }), null).mm).toBe(0)
    expect(jointDeductionMm(joint({ deduction_mode: 'manual', deduction_mm: '' }), null)).toEqual({ mm: null, reason: 'bad_manual_deduction' })
  })
  it('a 45 degree mitre needs no deduction; missing profile or dimension is a named reason, never 0', () => {
    expect(jointDeductionMm(joint({ cut_style: 'miter45' }), null)).toEqual({ mm: 0, source: 'miter' })
    expect(jointDeductionMm(joint(), null)).toEqual({ mm: null, reason: 'no_main_profile' })
    expect(jointDeductionMm(joint(), index.profiles.nodim)).toEqual({ mm: null, reason: 'no_dimension' })
    expect(jointDeductionMm(undefined, null)).toEqual({ mm: null, reason: 'unknown_joint' })
  })
})

describe('applyJoints', () => {
  const base = { role_name: 'เส้นนอน', profile_family: 'x', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 2 }
  const run = (c, j = joint()) => applyJoints({ components: [c], joints: [j], index, seriesId: 's1', thicknessMm: 1.5 })

  it('turns width into width_minus with deduction x 2 ends and carries the cut style', () => {
    const { components, issues } = run({ ...base, joint_id: 'j1' }, joint({ cut_style: 'notch', notch_width_mm: 40, notch_depth_mm: 20 }))
    expect(issues).toEqual([])
    expect(components[0]).toMatchObject({ length_rule_type: 'width_minus', length_deduction_mm: 88.9, cut_style: 'notch', notch_width_mm: 40, notch_depth_mm: 20 })
  })
  it('joint_ends 1 takes the deduction once; an existing width_minus deduction is kept and added to', () => {
    expect(run({ ...base, joint_id: 'j1', joint_ends: 1 }).components[0].length_deduction_mm).toBe(44.45)
    expect(run({ ...base, joint_id: 'j1', length_rule_type: 'height_minus', length_deduction_mm: 10 }).components[0]).toMatchObject({ length_rule_type: 'height_minus', length_deduction_mm: 98.9 })
  })
  it('a component without a joint is unchanged except for a default square cut', () => {
    expect(run(base).components[0]).toEqual({ ...base, cut_style: 'square' })
  })
  it('an unresolvable joint leaves the component as written and reports why', () => {
    const r = run({ ...base, joint_id: 'gone' })
    expect(r.components[0]).toMatchObject({ length_rule_type: 'width', length_deduction_mm: 0, cut_style: 'square' })
    expect(r.issues).toEqual([{ role_name: 'เส้นนอน', reason: 'unknown_joint' }])
    expect(run({ ...base, joint_id: 'j1' }, joint({ main_family: 'ไม่มีมิติ' })).issues[0].reason).toBe('no_dimension')
    expect(run({ ...base, joint_id: 'j1', length_rule_type: 'perimeter' }).issues[0].reason).toBe('rule_not_cuttable')
  })
  it('the main bar is looked up at the frame thickness, whatever thickness the secondary bar has', () => {
    expect(run({ ...base, joint_id: 'j1', thickness_mm: 2 }).issues).toEqual([])
    const other = applyJoints({ components: [{ ...base, joint_id: 'j1' }], joints: [joint()], index, seriesId: 's1', thicknessMm: 2 })
    expect(other.issues[0].reason).toBe('no_main_profile')
  })
})

describe('applyRoleThickness', () => {
  const cs = [{ role_name: 'frame' }, { role_name: 'sash', thickness_role: 'sash' }]
  it('sash-role components get the sash thickness where mixed thickness is allowed; the frame keeps the opening thickness', () => {
    expect(applyRoleThickness(cs, { allowMixed: true, sashThicknessMm: 1.5 }).map(c => c.thickness_mm)).toEqual([null, 1.5])
  })
  it('without permission, or without a sash thickness, every component uses the opening thickness', () => {
    expect(applyRoleThickness(cs, { allowMixed: false, sashThicknessMm: 1.5 }).map(c => c.thickness_mm)).toEqual([null, null])
    expect(applyRoleThickness(cs, { allowMixed: true, sashThicknessMm: null }).map(c => c.thickness_mm)).toEqual([null, null])
    expect(applyRoleThickness(cs).map(c => c.thickness_mm)).toEqual([null, null])
  })
  it('an old thickness_mm on a component never leaks through', () => {
    expect(applyRoleThickness([{ role_name: 'x', thickness_mm: 2 }], { allowMixed: true, sashThicknessMm: 1.5 })[0].thickness_mm).toBeNull()
  })
})

describe('applyJoints: main bar thickness and mitre', () => {
  const comp = (o = {}) => ({ role_name: 'r', profile_family: 'x', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1, ...o })
  const sashIndex = buildCatalogIndex({
    series: [{ id: 's1', provider_id: 'pA' }],
    profiles: [{ id: 'sbox', provider_id: 'pA', family: 'กล่องเฉพาะบาน', thickness_mm: 1.5, depth_mm: 30, width_mm: 80, primary_contact: 'width' }],
    seriesProfiles: [{ series_id: 's1', profile_id: 'sbox' }],
  })
  const j = o => joint({ main_family: 'กล่องเฉพาะบาน', ...o })
  const go = (components, jo, idx = sashIndex) => applyJoints({ components, joints: [jo], index: idx, seriesId: 's1', thicknessMm: 2 })
  it('the main bar is looked up at the thickness of its own components (sash 1.5 while the frame is 2)', () => {
    const r = go([comp({ role_name: 'main', profile_family: 'กล่องเฉพาะบาน', thickness_mm: 1.5 }), comp({ joint_id: 'j1' })], j())
    expect(r.issues).toEqual([])
    expect(r.components[1].length_deduction_mm).toBe(60)
  })
  it('with no component of the main family, the frame thickness is used', () => {
    expect(go([comp({ joint_id: 'j1' })], j()).issues[0].reason).toBe('no_main_profile')
  })
  it('a main-family component without its own thickness uses the frame thickness', () => {
    const r = go([comp({ profile_family: 'กล่องเฉพาะบาน', thickness_mm: null }), comp({ joint_id: 'j1' })], j())
    expect(r.issues[0].reason).toBe('no_main_profile')
  })
  it('a mitre joint marks the main-family bars 45 degrees as well; others stay square', () => {
    const r = go([comp({ role_name: 'main', profile_family: 'กล่องเฉพาะบาน' }), comp({ role_name: 'sec', joint_id: 'j1' }), comp({ role_name: 'other', profile_family: 'zzz' })], j({ cut_style: 'miter45' }))
    expect(r.components.map(c => c.cut_style)).toEqual(['miter45', 'miter45', 'square'])
    expect(r.components[0].length_deduction_mm).toBe(0)
    expect(r.components[1].length_deduction_mm).toBe(0)
  })
  it('a main bar keeps a non-square cut from its own joint', () => {
    const joints = [j({ cut_style: 'miter45' }), j({ id: 'j2', cut_style: 'notch', notch_width_mm: 5, notch_depth_mm: 5, secondary_family: 'q' })]
    const r = applyJoints({ components: [comp({ role_name: 'main', profile_family: 'กล่องเฉพาะบาน', joint_id: 'j2', thickness_mm: 1.5 }), comp({ joint_id: 'j1' })], joints, index: sashIndex, seriesId: 's1', thicknessMm: 2 })
    expect(r.components[0].cut_style).toBe('notch')
  })
})

describe('applyJoints: mitre only flips main bars without their own joint', () => {
  const comp = (o = {}) => ({ role_name: 'r', profile_family: 'x', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1, ...o })
  it('a main-family bar linked to a square joint stays square; one with no joint flips', () => {
    const joints = [joint({ id: 'jm', cut_style: 'miter45' }), joint({ id: 'js', cut_style: 'square' })]
    const r = applyJoints({ components: [comp({ profile_family: 'กล่องเรียบ', joint_id: 'js' }), comp({ profile_family: 'กล่องเรียบ' })], joints, index, seriesId: 's1', thicknessMm: 1.5 })
    expect(r.components.map(c => c.cut_style)).toEqual(['square', 'miter45'])
  })
  it('a component whose own joint cannot be resolved stays square', () => {
    const r = applyJoints({ components: [comp({ profile_family: 'กล่องเรียบ', joint_id: 'gone' })], joints: [joint({ cut_style: 'miter45' })], index, seriesId: 's1', thicknessMm: 1.5 })
    expect(r.components[0].cut_style).toBe('square')
  })
  it('a mitre joint with no main_family flips nothing', () => {
    const r = applyJoints({ components: [comp({ profile_family: undefined }), comp({ profile_family: '' })], joints: [joint({ cut_style: 'miter45', main_family: '' })], index, seriesId: 's1', thicknessMm: 1.5 })
    expect(r.components.map(c => c.cut_style)).toEqual(['square', 'square'])
  })
})
