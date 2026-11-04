import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = []
let signResult = { data: [], error: null }
let uploadError = null
let updateError = null
const bucket = {
  createSignedUrls: vi.fn(async (paths) => { calls.push(['sign', paths.length]); return signResult.error ? signResult : { data: paths.map(p => ({ path: p, signedUrl: `https://s/${p}` })), error: null } }),
  upload: vi.fn(async (path) => { calls.push(['upload', path]); return { error: uploadError } }),
  remove: vi.fn(async (paths) => { calls.push(['remove', paths]); return { error: null } }),
}
vi.mock('./supabase.js', () => ({
  supabase: {
    storage: { from: () => bucket },
    from: (t) => ({ update: (v) => ({ eq: async (k, id) => { calls.push(['update', t, v, id]); return { error: updateError } } }) }),
  },
}))

const { thicknessLabel, profileImagePath, signImagePaths, clearImageUrlCache, replaceProfileImage, removeProfileImage } = await import('./profileImages.js')

beforeEach(() => { calls.length = 0; signResult = { data: [], error: null }; uploadError = null; updateError = null; clearImageUrlCache() })

describe('thicknessLabel', () => {
  it('matches the imported pictures', () => {
    expect(thicknessLabel(2)).toBe('t = 2.0 mm')
    expect(thicknessLabel(1.2)).toBe('t = 1.2 mm')
    expect(thicknessLabel(1.25)).toBe('t = 1.25 mm')
    expect(thicknessLabel('1.5')).toBe('t = 1.5 mm')
  })
  it('shows ? when the thickness is unknown', () => {
    for (const t of [null, undefined, '', 0, 'x']) expect(thicknessLabel(t)).toBe('t = ?')
  })
})

describe('signImagePaths', () => {
  it('signs in chunks of 100 and caches', async () => {
    const paths = Array.from({ length: 150 }, (_, i) => `t/profiles/${i}.png`)
    const a = await signImagePaths([...paths, null, paths[0]], 1000)
    expect(Object.keys(a)).toHaveLength(150)
    expect(calls).toEqual([['sign', 100], ['sign', 50]])
    calls.length = 0
    const b = await signImagePaths(paths.slice(0, 3), 2000)
    expect(calls).toEqual([])
    expect(b[paths[1]]).toBe(`https://s/${paths[1]}`)
  })
  it('signs again after the cached URL is near expiry', async () => {
    await signImagePaths(['a.png'], 0)
    calls.length = 0
    await signImagePaths(['a.png'], 3301 * 1000)
    expect(calls).toEqual([['sign', 1]])
  })
})

describe('replaceProfileImage', () => {
  const file = { type: 'image/png' }
  const stamp = vi.fn(async (f, t) => ({ stamped: t }))
  it('uploads under a new name, points the profile at it, then drops the old file', async () => {
    const path = await replaceProfileImage({ tenantId: 'T', profile: { id: 'P', thickness_mm: 1.2, image_path: 'T/profiles/P.png' }, file, stamp, now: 7 })
    expect(path).toBe(profileImagePath('T', 'P', 7))
    expect(stamp).toHaveBeenCalledWith(file, 1.2)
    expect(calls).toEqual([['upload', 'T/profiles/P-7.png'], ['update', 'alu_profiles', { image_path: 'T/profiles/P-7.png' }, 'P'], ['remove', ['T/profiles/P.png']]])
  })
  it('refuses a non-image file', async () => {
    await expect(replaceProfileImage({ tenantId: 'T', profile: { id: 'P' }, file: { type: 'application/pdf' }, stamp })).rejects.toThrow('เลือกไฟล์รูป')
    expect(calls).toEqual([])
  })
  it('keeps the old picture and removes the new upload when saving the profile fails', async () => {
    updateError = { message: 'denied' }
    await expect(replaceProfileImage({ tenantId: 'T', profile: { id: 'P', image_path: 'old.png' }, file, stamp, now: 9 })).rejects.toEqual({ message: 'denied' })
    expect(calls.at(-1)).toEqual(['remove', ['T/profiles/P-9.png']])
    expect(calls.some(c => c[0] === 'remove' && c[1][0] === 'old.png')).toBe(false)
  })
  it('stops when the upload fails', async () => {
    uploadError = { message: 'quota' }
    await expect(replaceProfileImage({ tenantId: 'T', profile: { id: 'P' }, file, stamp })).rejects.toEqual({ message: 'quota' })
    expect(calls.map(c => c[0])).toEqual(['upload'])
  })
})

describe('removeProfileImage', () => {
  it('clears the profile first, then the file', async () => {
    await removeProfileImage({ profile: { id: 'P', image_path: 'x.png' } })
    expect(calls).toEqual([['update', 'alu_profiles', { image_path: null }, 'P'], ['remove', ['x.png']]])
  })
  it('keeps the file when clearing the profile fails', async () => {
    updateError = { message: 'denied' }
    await expect(removeProfileImage({ profile: { id: 'P', image_path: 'x.png' } })).rejects.toEqual({ message: 'denied' })
    expect(calls.map(c => c[0])).toEqual(['update'])
  })
})
