// @vitest-environment jsdom
// uploadSitePhoto must not use RETURNING (workers can INSERT but not SELECT line_site_photos).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const insert = vi.fn(() => ({ select, then: (r) => Promise.resolve({ error: null }).then(r) }))
const select = vi.fn()
const upload = vi.fn(async () => ({ error: null }))
vi.mock('./supabase.js', () => ({
  supabase: { from: () => ({ insert }), storage: { from: () => ({ upload, remove: async () => ({}) }) } },
}))

import { uploadSitePhoto, photoUploaderLabel } from './photoUpload.js'

beforeEach(() => {
  vi.clearAllMocks()
  globalThis.createImageBitmap = async () => ({ width: 10, height: 10, close() {} })
  HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} })
  HTMLCanvasElement.prototype.toBlob = function (cb) { cb(new Blob(['x'], { type: 'image/jpeg' })) }
})

describe('uploadSitePhoto', () => {
  it('sends a client-made id, never selects, accepts workerId null', async () => {
    const res = await uploadSitePhoto({ file: new Blob(['x']), tenantId: 't', workerId: null, siteId: 's', taskId: 'k', date: '2026-10-23' })
    const payload = insert.mock.calls[0][0]
    expect(payload.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(payload.worker_id).toBeNull()
    expect(payload.task_id).toBe('k')
    expect(select).not.toHaveBeenCalled()
    expect(res).toEqual({ id: payload.id, photo_path: payload.photo_path })
    expect(payload.photo_path).toMatch(/-office\.jpg$/)
  })
})

describe('photoUploaderLabel', () => {
  it('labels office uploads and falls back for workers', () => {
    expect(photoUploaderLabel({ worker_id: null, workers: null })).toBe('สำนักงาน')
    expect(photoUploaderLabel({ worker_id: 'w', workers: { nickname: 'ต้น' } })).toBe('ต้น')
    expect(photoUploaderLabel({ worker_id: 'w', workers: null }, 'ไม่ทราบชื่อ')).toBe('ไม่ทราบชื่อ')
  })
})
