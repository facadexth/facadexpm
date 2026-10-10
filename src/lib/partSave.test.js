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

// ---- Task 7: save half ----
import { modelToRows, validateModel, saveModel, loadModel } from './partSave.js'
import { removeLine } from './partModel.js'

// Column lists of supabase/migrations/2026-10-15-01-bom-part-editor.sql (tenant_id is left to its DB default).
const COLS = {
  parts: ['id', 'template_id', 'part_key', 'name', 'count', 'overlap_mode', 'overlap_mm', 'sort_order'],
  positions: ['id', 'part_id', 'position_key', 'name', 'sort_order'],
  lines: ['id', 'position_id', 'profile_family', 'length_rule_type', 'length_deduction_mm', 'deduction_auto', 'length_factor', 'quantity_value', 'thickness_role', 'sort_order'],
  ends: ['id', 'position_profile_id', 'piece_index', 'end_index', 'mode', 'butt_to_profile_id', 'deduction_mm'],
}
const seqId = () => { let n = 0; return () => `id-${++n}` }
const T = { id: 't1', layout_kind: 'sliding_2' }
const roundTrip = m => modelFromRows({ template: T, ...modelToRows(m, 't1', seqId()) })

function edited() {
  let m = named()
  m = addLine(m, 'frame_side')
  m.lines.frame_side[1].profile_family = 'second-side'
  m.parts[1].overlap_mode = 'manual'; m.parts[1].overlap_mm = 25
  m.lines.key_stile[0].deduction_auto = false; m.lines.key_stile[0].length_deduction_mm = 80
  m = setEndMode(m, 'frame_top', 0, 0, 0, 'through')   // flipped corner: top runs through, left side butts
  m.lines.frame_side[0].ends[0][0].deduction_mm = 12
  return m
}

describe('modelToRows', () => {
  it('round-trips the default model and an edited one (second profile, manual override, flipped corner)', () => {
    expect(roundTrip(named())).toEqual(named())
    expect(roundTrip(startModel('sliding_2'))).toEqual(startModel('sliding_2'))
    const m = edited()
    expect(roundTrip(m)).toEqual(m)
    expect(roundTrip(setPartCount(m, 'sash', 3))).toEqual(setPartCount(m, 'sash', 3))
  })

  it('wires the FKs with the generated ids and resolves butt targets {key,line} to the target line row id', () => {
    const r = modelToRows(edited(), 't1', seqId())
    expect(r.parts.every(p => p.template_id === 't1')).toBe(true)
    const partIds = new Set(r.parts.map(p => p.id))
    expect(r.positions.every(p => partIds.has(p.part_id))).toBe(true)
    const posIds = new Set(r.positions.map(p => p.id))
    expect(r.lines.every(l => posIds.has(l.position_id))).toBe(true)
    const lineIds = new Set(r.lines.map(l => l.id))
    expect(r.ends.every(e => lineIds.has(e.position_profile_id))).toBe(true)
    expect(r.ends.filter(e => e.butt_to_profile_id).every(e => lineIds.has(e.butt_to_profile_id))).toBe(true)
    // frame_top butts frame_side line 0 by default
    const pos = key => r.positions.find(p => p.position_key === key).id
    const line = (key, i) => r.lines.filter(l => l.position_id === pos(key)).find(l => l.sort_order === i).id
    const topEnd1 = r.ends.find(e => e.position_profile_id === line('frame_top', 0) && e.piece_index === 0 && e.end_index === 1)
    expect(topEnd1).toMatchObject({ mode: 'butt', butt_to_profile_id: line('frame_side', 0) })
    // through ends carry neither target nor deduction
    expect(r.ends.filter(e => e.mode === 'through').every(e => e.butt_to_profile_id === null && e.deduction_mm === null)).toBe(true)
    // one end row per piece x end x line
    expect(r.ends.filter(e => e.position_profile_id === line('key_stile', 0))).toHaveLength(4)
  })

  it('a butt end whose target line was removed is written with butt_to_profile_id null', () => {
    const m = named()
    m.lines.sash_top[0].ends[0][0] = { mode: 'butt', to: { key: 'hook_stile', line: 5 }, deduction_mm: 10 }
    const r = modelToRows(m, 't1', seqId())
    const pos = r.positions.find(p => p.position_key === 'sash_top').id
    const lineId = r.lines.find(l => l.position_id === pos).id
    const e = r.ends.find(x => x.position_profile_id === lineId && x.piece_index === 0 && x.end_index === 0)
    expect(e).toMatchObject({ mode: 'butt', butt_to_profile_id: null, deduction_mm: 10 })
    // and via removeLine (which retargets to line 0 when lines remain): still a valid id, never a stale one
    let m2 = addLine(named(), 'hook_stile')
    m2.lines.sash_top[0].ends[0][0].to = { key: 'hook_stile', line: 1 }
    m2 = removeLine(m2, 'hook_stile', 1)
    const r2 = modelToRows(m2, 't1', seqId())
    const ids = new Set(r2.lines.map(l => l.id))
    expect(r2.ends.every(x => x.butt_to_profile_id === null || ids.has(x.butt_to_profile_id))).toBe(true)
  })

  it('rows contain only real columns (no editor keys, no tenant_id) and satisfy the CHECKs', () => {
    const m = edited()
    m.lines.frame_top[0].extra = 'x'; m.parts[0].junk = 1
    const r = modelToRows(m, 't1', seqId())
    for (const [table, rows] of Object.entries(r)) {
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) expect(Object.keys(row).sort()).toEqual([...COLS[table]].sort())
    }
    expect(r.parts.every(p => ['auto_hook', 'manual'].includes(p.overlap_mode) && p.count >= 1)).toBe(true)
    expect(r.ends.every(e => ['through', 'butt'].includes(e.mode) && [0, 1].includes(e.end_index))).toBe(true)
  })

  it('uses crypto.randomUUID by default', () => {
    const r = modelToRows(named(), 't1')
    expect(r.parts[0].id).toMatch(/^[0-9a-f-]{36}$/)
    expect(new Set([...r.parts, ...r.positions, ...r.lines, ...r.ends].map(x => x.id)).size).toBe(r.parts.length + r.positions.length + r.lines.length + r.ends.length)
  })
})

describe('validateModel', () => {
  it('accepts a filled default model and an edited one', () => {
    expect(validateModel(named())).toBeNull()
    expect(validateModel(edited())).toBeNull()
  })
  it('rejects an empty profile family', () => {
    expect(validateModel(startModel('sliding_2'))).toMatch(/โปรไฟล์/)
    const m = named(); m.lines.hook_stile[0].profile_family = '  '
    expect(validateModel(m)).toMatch(/เสาเกี่ยว/)
  })
  it('rejects a corner where both pieces run through, and one where both butt', () => {
    const m = named(); m.lines.frame_top[0].ends[0][0] = { mode: 'through', to: null, deduction_mm: null }
    expect(validateModel(m)).toMatch(/มุม/)
    const b = named(); b.lines.frame_side[0].ends[0][0] = { mode: 'butt', to: { key: 'frame_top', line: 0 }, deduction_mm: null }
    expect(validateModel(b)).toMatch(/มุม/)
  })
  it('rejects factor <= 0 and negative numbers', () => {
    const f = named(); f.lines.sash_top[0].length_factor = 0
    expect(validateModel(f)).toMatch(/สัดส่วน/)
    const d = named(); d.lines.frame_top[0].length_deduction_mm = -1
    expect(validateModel(d)).toBeTruthy()
    const q = named(); q.lines.frame_top[0].quantity_value = -1
    expect(validateModel(q)).toBeTruthy()
    const e = named(); e.lines.frame_top[0].ends[0][0].deduction_mm = -5
    expect(validateModel(e)).toBeTruthy()
    const c = named(); c.parts[1].count = 0
    expect(validateModel(c)).toBeTruthy()
  })
  it('enforces the overlap_mode contract: a known mode, manual needs a non-negative overlap', () => {
    const a = named(); a.parts[1].overlap_mode = 'auto'
    expect(validateModel(a)).toMatch(/ระยะซ้อน/)
    const b = named(); b.parts[1].overlap_mode = 'manual'; b.parts[1].overlap_mm = -3
    expect(validateModel(b)).toMatch(/ระยะซ้อน/)
    const c = named(); c.parts[1].overlap_mode = 'manual'; c.parts[1].overlap_mm = null
    expect(validateModel(c)).toMatch(/ระยะซ้อน/)
    const ok = named(); ok.parts[1].overlap_mode = 'manual'; ok.parts[1].overlap_mm = 0
    expect(validateModel(ok)).toBeNull()
  })
  it('a butt target must be an existing line of this model; a butt without target needs a deduction', () => {
    const m = named(); m.lines.sash_top[0].ends[0][0].to = { key: 'hook_stile', line: 3 }
    expect(validateModel(m)).toMatch(/ชน/)
    const n = named(); n.lines.sash_top[0].ends[0][0].to = { key: 'nope', line: 0 }
    expect(validateModel(n)).toMatch(/ชน/)
    const o = named(); o.lines.sash_top[0].ends[0][0].to = null
    expect(validateModel(o)).toMatch(/ชน/)
    o.lines.sash_top[0].ends[0][0].deduction_mm = 20
    expect(validateModel(o)).toBeNull()
  })
  it('rejects a missing or unknown model', () => {
    expect(validateModel(null)).toBeTruthy()
    expect(validateModel({ layout_kind: 'nope' })).toBeTruthy()
  })
})

// A fake supabase client: records every call, can fail one table/op.
function fakeClient({ failOn = null, data = {} } = {}) {
  const calls = []
  const client = {
    calls,
    from(table) {
      const result = op => (failOn && failOn.table === table && failOn.op === op ? { data: null, error: { message: `boom ${table}` } } : { data: op === 'select' ? data[table] || [] : null, error: null })
      return {
        delete() { return { eq(col, val) { calls.push(['delete', table, col, val]); return Promise.resolve(result('delete')) } } },
        insert(rows) { calls.push(['insert', table, rows.length]); return Promise.resolve(result('insert')) },
        select() {
          const q = { filters: [] }
          const done = () => { calls.push(['select', table, ...q.filters]); const r = result('select'); return r }
          const chain = {
            eq(col, val) { q.filters.push([col, val]); return chain },
            in(col, vals) { q.filters.push([col, vals]); return chain },
            then(res, rej) { return Promise.resolve(done()).then(res, rej) },
          }
          return chain
        },
      }
    },
  }
  return client
}

describe('saveModel', () => {
  it('deletes the template parts, then inserts parts -> positions -> lines -> ends', async () => {
    const c = fakeClient()
    await saveModel({ supabase: c, templateId: 't1', model: named() })
    expect(c.calls.map(x => `${x[0]} ${x[1]}`)).toEqual([
      'delete bom_template_parts', 'insert bom_template_parts', 'insert bom_template_positions',
      'insert bom_template_position_profiles', 'insert bom_template_piece_ends',
    ])
    expect(c.calls[0]).toEqual(['delete', 'bom_template_parts', 'template_id', 't1'])
  })
  for (const [table, op] of [['bom_template_parts', 'delete'], ['bom_template_parts', 'insert'], ['bom_template_positions', 'insert'], ['bom_template_position_profiles', 'insert'], ['bom_template_piece_ends', 'insert']]) {
    it(`stops at the first error (${op} ${table}) and throws it`, async () => {
      const c = fakeClient({ failOn: { table, op } })
      await expect(saveModel({ supabase: c, templateId: 't1', model: named() })).rejects.toThrow(`boom ${table}`)
      const last = c.calls[c.calls.length - 1]
      expect([last[0], last[1]]).toEqual([op, table])
    })
  }
  it('refuses to write an invalid model (nothing is deleted)', async () => {
    const c = fakeClient()
    await expect(saveModel({ supabase: c, templateId: 't1', model: startModel('sliding_2') })).rejects.toThrow(/โปรไฟล์/)
    expect(c.calls).toEqual([])
  })
})

describe('loadModel', () => {
  it('reads only this template rows (parts by template, then children by parent ids) and builds the model', async () => {
    const m = edited()
    const rows = modelToRows(m, 't1', seqId())
    const c = fakeClient({ data: { bom_template_parts: rows.parts, bom_template_positions: rows.positions, bom_template_position_profiles: rows.lines, bom_template_piece_ends: rows.ends } })
    expect(await loadModel({ supabase: c, template: T })).toEqual(m)
    expect(c.calls[0]).toEqual(['select', 'bom_template_parts', ['template_id', 't1']])
    expect(c.calls[1][1]).toBe('bom_template_positions')
    expect(c.calls[1][2][0]).toBe('part_id')
  })
  it('null for a legacy template without querying; the default model when no rows exist; throws on a read error', async () => {
    const c = fakeClient()
    expect(await loadModel({ supabase: c, template: { id: 't1' } })).toBeNull()
    expect(c.calls).toEqual([])
    expect(await loadModel({ supabase: c, template: T })).toEqual(startModel('sliding_2'))
    await expect(loadModel({ supabase: fakeClient({ failOn: { table: 'bom_template_positions', op: 'select' }, data: { bom_template_parts: [{ id: 'p', template_id: 't1', part_key: 'frame' }] } }), template: T })).rejects.toThrow('boom')
  })
})
