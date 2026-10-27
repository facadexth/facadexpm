import { describe, it, expect, beforeEach, vi } from 'vitest'
import { parseDeepLink, saveDeepLink, takeDeepLink, resolveEstimationLink, NOT_FOUND_TEXT } from './deepLink.js'

describe('parseDeepLink', () => {
  it('reads the tab and the known params', () => {
    expect(parseDeepLink('#tab=estimation&project=a&item=b')).toEqual({ tab: 'estimation', params: { project: 'a', item: 'b' } })
    expect(parseDeepLink('#tab=estimation&offcut=OC-0001')).toEqual({ tab: 'estimation', params: { offcut: 'OC-0001' } })
  })
  it('old #tab=x still works', () => {
    expect(parseDeepLink('#tab=x')).toEqual({ tab: 'x', params: {} })
    expect(parseDeepLink('#tab=hr-leave')).toEqual({ tab: 'hr-leave', params: {} })
  })
  it('junk is null', () => {
    for (const h of ['', '#', '#foo=bar', '#tab=', '#tab=a b', '#tab=<x>', '#project=a&tab=estimation', null, undefined, 42]) expect(parseDeepLink(h)).toBeNull()
  })
  it('ignores unknown keys and values outside [\\w-]{1,64}', () => {
    const long = 'a'.repeat(65)
    expect(parseDeepLink(`#tab=estimation&evil=1&project=a%20b&item=${long}&offcut=<x>&__proto__=1`)).toEqual({ tab: 'estimation', params: {} })
    expect(parseDeepLink('#tab=estimation&project=a&project=b')).toEqual({ tab: 'estimation', params: { project: 'a' } })
    expect(parseDeepLink('#tab=estimation&noequals&item=b')).toEqual({ tab: 'estimation', params: { item: 'b' } })
  })
})

describe('saveDeepLink / takeDeepLink', () => {
  let store
  beforeEach(() => {
    store = {}
    vi.stubGlobal('sessionStorage', { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v) }, removeItem: k => { delete store[k] } })
  })
  it('round-trips once for the same tab, then is gone', () => {
    saveDeepLink({ tab: 'estimation', params: { project: 'a' } })
    expect(takeDeepLink('estimation')).toEqual({ project: 'a' })
    expect(takeDeepLink('estimation')).toBeNull()
  })
  it('saves nothing without params; another tab or a stale link is dropped', () => {
    saveDeepLink({ tab: 'estimation', params: {} })
    expect(store).toEqual({})
    saveDeepLink({ tab: 'other', params: { project: 'a' } })
    expect(takeDeepLink('estimation')).toBeNull()
    expect(store).toEqual({})
    saveDeepLink({ tab: 'estimation', params: { project: 'a' } }, 1000)
    expect(takeDeepLink('estimation', 1000 + 11 * 60 * 1000)).toBeNull()
  })
  it('re-checks what comes back from storage', () => {
    store.deeplink = JSON.stringify({ tab: 'estimation', at: Date.now(), params: { project: 'ok', item: 'x y', evil: 'z' } })
    expect(takeDeepLink('estimation')).toEqual({ project: 'ok' })
    store.deeplink = '{not json'
    expect(takeDeepLink('estimation')).toBeNull()
  })
  it('never throws when storage is blocked', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => { throw new Error('blocked') } })
    expect(() => saveDeepLink({ tab: 'estimation', params: { project: 'a' } })).not.toThrow()
    expect(takeDeepLink('estimation')).toBeNull()
  })
})

describe('resolveEstimationLink', () => {
  const projects = [{ id: 'p1' }, { id: 'p2' }]
  const openings = [{ id: 'i1', project_id: 'p1' }, { id: 'i2', project_id: 'p2' }]
  it('project and item inside the loaded lists', () => {
    expect(resolveEstimationLink({ project: 'p1', item: 'i1' }, { projects, openings })).toEqual({ projectId: 'p1', itemId: 'i1' })
    expect(resolveEstimationLink({ project: 'p2' }, { projects, openings })).toEqual({ projectId: 'p2' })
    expect(resolveEstimationLink({ item: 'i2' }, { projects, openings })).toEqual({ projectId: 'p2', itemId: 'i2' })
  })
  it('unknown project or item (or an item of another project) is a notice, never a blank modal', () => {
    expect(resolveEstimationLink({ project: 'nope' }, { projects, openings })).toEqual({ notice: NOT_FOUND_TEXT })
    expect(resolveEstimationLink({ project: 'p1', item: 'nope' }, { projects, openings })).toEqual({ projectId: 'p1', notice: NOT_FOUND_TEXT })
    expect(resolveEstimationLink({ project: 'p1', item: 'i2' }, { projects, openings })).toEqual({ projectId: 'p1', notice: NOT_FOUND_TEXT })
    expect(NOT_FOUND_TEXT).toBe('ไม่พบโปรเจกต์/บานนี้ หรือไม่มีสิทธิ์เข้าถึง')
  })
  it('offcut: its source project on the BOM tab; not in stock or project not loaded is a notice with the code', () => {
    const off = { code: 'OC-0003', status: 'in_stock', source_project_id: 'p2' }
    expect(resolveEstimationLink({ offcut: 'OC-0003' }, { projects, openings, offcut: off })).toEqual({ projectId: 'p2', tab: 'bom', offcutCode: 'OC-0003' })
    for (const o of [null, { ...off, status: 'used' }, { ...off, source_project_id: 'gone' }, { ...off, source_project_id: null }]) {
      const r = resolveEstimationLink({ offcut: 'OC-0003' }, { projects, openings, offcut: o })
      expect(r.projectId).toBeUndefined()
      expect(r.notice).toContain('OC-0003')
    }
  })
  it('nothing usable → empty', () => {
    expect(resolveEstimationLink({}, { projects, openings })).toEqual({})
  })
})
