import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = []
let uploadError = null
let updateResult = { data: [{ id: 'P' }], error: null }
const bucket = {
  upload: vi.fn(async (path) => { calls.push(['upload', path]); return { error: uploadError } }),
  remove: vi.fn(async (paths) => { calls.push(['remove', paths]); return { error: null } }),
}
vi.mock('./supabase.js', () => ({
  supabase: {
    storage: { from: () => bucket },
    from: (t) => ({ update: (v) => ({ eq: (k, id) => ({ select: async () => { calls.push(['update', t, v, id]); return updateResult } }) }) }),
  },
}))

const { providerLogoPath, replaceProviderLogo, removeProviderLogo } = await import('./providerLogos.js')

beforeEach(() => { calls.length = 0; uploadError = null; updateResult = { data: [{ id: 'P' }], error: null } })

describe('replaceProviderLogo', () => {
  const file = { type: 'image/png' }
  const shrink = vi.fn(async () => ({ small: true }))
  it('uploads under a new name, points the extruder at it, then drops the old logo', async () => {
    const path = await replaceProviderLogo({ tenantId: 'T', provider: { id: 'P', logo_path: 'T/logos/P-1.png' }, file, shrink, now: 7 })
    expect(path).toBe(providerLogoPath('T', 'P', 7))
    expect(calls).toEqual([['upload', 'T/logos/P-7.png'], ['update', 'alu_providers', { logo_path: 'T/logos/P-7.png' }, 'P'], ['remove', ['T/logos/P-1.png']]])
  })
  it('refuses a non-image file', async () => {
    await expect(replaceProviderLogo({ tenantId: 'T', provider: { id: 'P' }, file: { type: 'application/pdf' }, shrink })).rejects.toThrow('เลือกไฟล์รูป')
    expect(calls).toEqual([])
  })
  it('removes the new upload and keeps the old logo when the save is refused', async () => {
    updateResult = { data: [], error: null } // RLS: no row updated, no error
    await expect(replaceProviderLogo({ tenantId: 'T', provider: { id: 'P', logo_path: 'old.png' }, file, shrink, now: 9 })).rejects.toThrow('ไม่มีสิทธิ์')
    expect(calls.at(-1)).toEqual(['remove', ['T/logos/P-9.png']])
    expect(calls.some(c => c[0] === 'remove' && c[1][0] === 'old.png')).toBe(false)
  })
  it('stops when the upload fails', async () => {
    uploadError = { message: 'quota' }
    await expect(replaceProviderLogo({ tenantId: 'T', provider: { id: 'P' }, file, shrink })).rejects.toEqual({ message: 'quota' })
    expect(calls.map(c => c[0])).toEqual(['upload'])
  })
})

describe('removeProviderLogo', () => {
  it('clears the path, then deletes the file', async () => {
    await removeProviderLogo({ provider: { id: 'P', logo_path: 'T/logos/P-1.png' } })
    expect(calls).toEqual([['update', 'alu_providers', { logo_path: null }, 'P'], ['remove', ['T/logos/P-1.png']]])
  })
  it('keeps the file when the save is refused', async () => {
    updateResult = { data: [], error: null }
    await expect(removeProviderLogo({ provider: { id: 'P', logo_path: 'x.png' } })).rejects.toThrow('ไม่มีสิทธิ์')
    expect(calls.map(c => c[0])).toEqual(['update'])
  })
})
