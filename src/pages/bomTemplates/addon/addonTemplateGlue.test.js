import { describe, it, expect, vi } from 'vitest'
vi.mock('../../../lib/supabase.js', () => ({ supabase: {} }))
const { setsFromRows, setsToSave, addonSaveProblem, saveAddonSets, loadAddonSets, anyDirty, LOADING } = await import('./addonTemplateGlue.js')
const { defaultAddonPieces, setKey } = await import('../../../lib/addonModel.js')

const K = setKey('merge', 'fixed', 'top')
const KA = setKey('attach', 'fixed', 'top')
const merge = defaultAddonPieces({ mode: 'merge', kind: 'fixed', position: 'top' })
const attach = defaultAddonPieces({ mode: 'attach', kind: 'fixed', position: 'top' })

function fakeSupabase(selectRows = []) {
  const calls = []
  const from = (table) => ({
    delete: () => ({ eq: (c, v) => { calls.push(['delete', table, c, v]); return Promise.resolve({ error: null }) } }),
    insert: (rows) => { calls.push(['insert', table, rows]); return Promise.resolve({ error: null }) },
    select: () => ({ in: (c, ids) => { calls.push(['select', table, c, ids]); return Promise.resolve({ data: selectRows, error: null }) } }),
  })
  return { from, calls }
}

describe('addonTemplateGlue', () => {
  it('loaded rows become clean sets keyed by setKey', async () => {
    const sb = fakeSupabase(merge.map((r, i) => ({ ...r, id: 'r' + i, template_id: 't1', tenant_id: 'x' })))
    const sets = await loadAddonSets({ supabase: sb, templateId: 't1' })
    expect(Object.keys(sets)).toEqual([K])
    expect(sets[K].dirty).toBe(false)
    expect(sets[K].rows).toHaveLength(8)
    expect(sets[K].rows[0].id).toBeUndefined()
  })
  it('nothing edited: no problem, nothing written', async () => {
    const sb = fakeSupabase()
    const sets = setsFromRows(merge)
    expect(anyDirty(sets)).toBe(false)
    expect(addonSaveProblem({ addonSets: sets, status: 'loading' })).toBe(null)
    expect(await saveAddonSets({ supabase: sb, templateId: 't1', addonSets: sets })).toBe(false)
    expect(sb.calls).toEqual([])
  })
  it('an edited set writes itself plus the loaded sets (delete then insert), never the untouched defaults', async () => {
    const sb = fakeSupabase()
    const sets = { ...setsFromRows(merge), [KA]: { rows: attach.map(r => ({ ...r, profile_family: 'F' })), dirty: true } }
    expect(addonSaveProblem({ addonSets: sets, status: 'ready' })).toBe(null)
    expect(await saveAddonSets({ supabase: sb, templateId: 't1', addonSets: sets })).toBe(true)
    expect(sb.calls[0]).toEqual(['delete', 'bom_template_addon_pieces', 'template_id', 't1'])
    const rows = sb.calls[1][2]
    expect(rows).toHaveLength(13)
    expect(rows.every(r => r.template_id === 't1')).toBe(true)
    expect(rows.filter(r => r.mode === 'attach').every(r => r.position === null)).toBe(true)
  })
  it('edits while loading / after a failed load are refused before anything is written', () => {
    const sets = { [KA]: { rows: attach, dirty: true } }
    expect(addonSaveProblem({ addonSets: sets, status: 'loading' })).toBe(LOADING)
    expect(addonSaveProblem({ addonSets: sets, status: 'error', error: 'boom' })).toContain('boom')
  })
  it('a bad row is a Thai problem', () => {
    const sets = { [KA]: { rows: attach.map((r, i) => (i ? r : { ...r, length_factor: null })), dirty: true } }
    expect(addonSaveProblem({ addonSets: sets, status: 'ready' })).toContain('ตัวคูณความยาวต้องมากกว่า 0')
  })
  it('setsToSave skips empty sets', () => {
    expect(setsToSave({ a: { rows: [], dirty: true }, b: { rows: [1], dirty: false } })).toEqual({ b: [1] })
  })
})
