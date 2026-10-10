import { describe, it, expect } from 'vitest'
import { startModel, setEndMode, setPartCount, addLine, validateCorners } from './partModel.js'
import { modelFromRows, partModelsByTemplate } from './partSave.js'

// Hand-built DB rows for a model (what Task 7's save writes). Numerics come back as strings from PostgREST.
function rowsOf(model, templateId = 't1') {
  const parts = []; const positions = []; const lines = []; const ends = []
  const lineId = (key, li) => `${templateId}-${key}-${li}`
  model.parts.forEach((p, pi) => {
    const partId = `${templateId}-part-${p.key}`
    parts.push({ id: partId, template_id: templateId, part_key: p.key, name: p.name, count: String(p.count), overlap_mode: p.overlap_mode, overlap_mm: p.overlap_mm == null ? null : String(p.overlap_mm), sort_order: pi })
    Object.keys(model.lines).forEach((key, ki) => {
      const PART = { frame_top: 'frame', frame_bottom: 'frame', frame_side: 'frame' }[key] || 'sash'
      if (PART !== p.key) return
      const posId = `${templateId}-pos-${key}`
      positions.push({ id: posId, part_id: partId, position_key: key, name: model.names[key], sort_order: ki })
      model.lines[key].forEach((l, li) => {
        lines.push({ id: lineId(key, li), position_id: posId, profile_family: l.profile_family, length_rule_type: l.length_rule_type,
          length_deduction_mm: String(l.length_deduction_mm), deduction_auto: l.deduction_auto, length_factor: String(l.length_factor),
          quantity_value: String(l.quantity_value), thickness_role: l.thickness_role, sort_order: li })
        l.ends.forEach((pair, piece) => pair.forEach((e, end) => ends.push({
          id: `${lineId(key, li)}-${piece}-${end}`, position_profile_id: lineId(key, li), piece_index: piece, end_index: end, mode: e.mode,
          butt_to_profile_id: e.to ? lineId(e.to.key, e.to.line) : null, deduction_mm: e.deduction_mm == null ? null : String(e.deduction_mm),
        })))
      })
    })
  })
  return { parts, positions, lines, ends }
}

const named = () => {
  const m = startModel('sliding_2')
  for (const k of Object.keys(m.lines)) m.lines[k][0].profile_family = `F-${k}`
  return m
}

describe('modelFromRows', () => {
  it('returns null for a template without layout_kind (legacy) or with an unknown one', () => {
    expect(modelFromRows({ template: { id: 't1' }, parts: [], positions: [], lines: [], ends: [] })).toBeNull()
    expect(modelFromRows({ template: { id: 't1', layout_kind: null } })).toBeNull()
    expect(modelFromRows({ template: null })).toBeNull()
    expect(modelFromRows({ template: { id: 't1', layout_kind: 'nope' } })).toBeNull()
  })

  it('round-trips the default model (rows built by hand)', () => {
    const m = named()
    expect(modelFromRows({ template: { id: 't1', layout_kind: 'sliding_2' }, ...rowsOf(m) })).toEqual(m)
  })

  it('round-trips an edited model: part count, manual overlap, extra line, flipped corner, manual end deduction', () => {
    let m = named()
    m = setPartCount(m, 'sash', 3)
    m.parts[1].overlap_mode = 'manual'; m.parts[1].overlap_mm = 12.5
    m = addLine(m, 'frame_top')
    m.lines.frame_top[1].profile_family = 'cover'
    m = setEndMode(m, 'frame_top', 0, 0, 0, 'through')
    m.lines.sash_top[0].ends[1][0].deduction_mm = 30
    m.lines.sash_top[0].length_factor = 0.5
    m.lines.key_stile[0].deduction_auto = false; m.lines.key_stile[0].length_deduction_mm = 80
    m.names.hook_stile = 'เสาเกี่ยวพิเศษ'
    const back = modelFromRows({ template: { id: 't1', layout_kind: 'sliding_2' }, ...rowsOf(m) })
    expect(back).toEqual(m)
    expect(validateCorners(back)).toEqual(validateCorners(m))
  })

  it('only uses the rows of its own template when given every tenant row', () => {
    const a = named()
    const b = setPartCount(named(), 'sash', 4)
    const ra = rowsOf(a, 'tA'); const rb = rowsOf(b, 'tB')
    const all = { parts: [...rb.parts, ...ra.parts], positions: [...rb.positions, ...ra.positions], lines: [...rb.lines, ...ra.lines], ends: [...rb.ends, ...ra.ends] }
    expect(modelFromRows({ template: { id: 'tA', layout_kind: 'sliding_2' }, ...all })).toEqual(a)
    expect(modelFromRows({ template: { id: 'tB', layout_kind: 'sliding_2' }, ...all })).toEqual(b)
  })

  it('a layout_kind template with no rows at all is the default model (positions without a profile family)', () => {
    const m = modelFromRows({ template: { id: 't1', layout_kind: 'sliding_2' } })
    expect(m).toEqual(startModel('sliding_2'))
  })

  it('tolerates partial rows: missing part, position, ends; dangling butt target; junk numerics', () => {
    const full = rowsOf(named())
    const rows = {
      parts: full.parts.filter(p => p.part_key === 'sash').map(p => ({ ...p, count: 'x', overlap_mm: null, overlap_mode: null })),
      positions: full.positions.filter(p => p.position_key !== 'key_stile'),
      lines: full.lines.map(l => (l.id === 't1-hook_stile-0' ? { ...l, length_factor: '0', quantity_value: null, deduction_auto: null, length_deduction_mm: 'abc' } : l)),
      ends: full.ends
        .filter(e => !(e.position_profile_id === 't1-sash_top-0' && e.piece_index === 1))
        .map(e => (e.position_profile_id === 't1-sash_bottom-0' && e.end_index === 0 ? { ...e, butt_to_profile_id: 'ghost' } : e)),
    }
    const m = modelFromRows({ template: { id: 't1', layout_kind: 'sliding_2' }, ...rows })
    const def = startModel('sliding_2')
    // the frame part had no row: its positions' lines came with the frame part rows, so they fall back to defaults
    expect(m.parts.map(p => p.key)).toEqual(['frame', 'sash'])
    expect(m.parts[0]).toEqual(def.parts[0])
    expect(m.parts[1]).toEqual({ ...def.parts[1], count: 2, overlap_mode: 'auto_hook', overlap_mm: 0 })
    expect(m.lines.frame_top).toEqual(def.lines.frame_top)
    // missing position -> default line (empty family, so the expander reports it instead of dropping it)
    expect(m.lines.key_stile).toEqual(def.lines.key_stile)
    const hook = m.lines.hook_stile[0]
    expect(hook.profile_family).toBe('F-hook_stile')
    expect(hook).toMatchObject({ length_factor: 1, quantity_value: 1, deduction_auto: true, length_deduction_mm: 0 })
    // missing piece ends are filled with the default pair; every line has one pair per piece
    expect(m.lines.sash_top[0].ends).toHaveLength(2)
    expect(m.lines.sash_top[0].ends[1]).toEqual(def.lines.sash_top[0].ends[1])
    // a butt end whose target row is gone has no target (the expander then says no_butt_target)
    expect(m.lines.sash_bottom[0].ends[0][0]).toEqual({ mode: 'butt', to: null, deduction_mm: null })
  })

  it('end rows beyond the part count are dropped, missing trailing pieces are added', () => {
    const big = rowsOf(setPartCount(named(), 'sash', 3))
    const parts = big.parts.map(p => (p.part_key === 'sash' ? { ...p, count: '2' } : p))
    const m = modelFromRows({ template: { id: 't1', layout_kind: 'sliding_2' }, ...big, parts })
    expect(m.lines.sash_top[0].ends).toHaveLength(2)
    const small = rowsOf(named())
    const parts3 = small.parts.map(p => (p.part_key === 'sash' ? { ...p, count: 3 } : p))
    const m3 = modelFromRows({ template: { id: 't1', layout_kind: 'sliding_2' }, ...small, parts: parts3 })
    expect(m3.lines.key_stile[0].ends).toHaveLength(3)
  })
})

describe('partModelsByTemplate', () => {
  it('builds one model per layout_kind template, none for legacy templates', () => {
    const r = rowsOf(named(), 'tA')
    const out = partModelsByTemplate({ templates: [{ id: 'tA', layout_kind: 'sliding_2' }, { id: 'tL' }], ...r })
    expect(Object.keys(out)).toEqual(['tA'])
    expect(out.tA).toEqual(named())
    expect(partModelsByTemplate({ templates: null })).toEqual({})
  })
})
