import { describe, it, expect, vi } from 'vitest'
import { handleCustomerForm, bangkokDay } from '../../supabase/functions/_shared/customer-form-logic.ts'
import { itemsDescription, LIMITS, LOCATIONS, SYMPTOMS, SLOTS } from '../../supabase/functions/_shared/repair-form.ts'

// 2026-11-25 10:00 Bangkok
const NOW = Date.UTC(2026, 10, 25, 3, 0, 0)
const LINK = 'ลิงก์หมดอายุ กดแจ้งซ่อมใน LINE อีกครั้ง'
const UPLOAD_FAIL = 'อัปโหลดรูปไม่สำเร็จ กรุณาลองใหม่'
const SEND_FAIL = 'ส่งไม่สำเร็จ กรุณาลองใหม่'
const SITE = '11111111-2222-3333-4444-555555555555'

const tokenRow = (over = {}) => ({
  id: 'tok1', tenantId: 't1', clientId: 'c1', lineUserId: 'U1', purpose: 'repair_form',
  expiresAt: new Date(NOW + 3600_000).toISOString(), usedAt: null, refTicketNumber: null, ...over,
})

function deps(over = {}) {
  return {
    loadToken: vi.fn(async () => tokenRow()),
    hasModule: vi.fn(async () => true),
    listSites: vi.fn(async () => [{ id: SITE, name: 'บ้านคุณสมชาย' }]),
    brand: vi.fn(async () => ({ clientName: 'คุณสมชาย', brandName: 'สร้างดี' })),
    countUploads: vi.fn(async () => 0),
    signUpload: vi.fn(async (path) => ({ signedUrl: `https://x/${path}?t=1`, token: 'up1' })),
    objectSize: vi.fn(async () => 1000),
    submitRpc: vi.fn(async () => ({ status: 'ok', ticket_id: 'r1', ticket_number: 'RP2611-007' })),
    pushReceived: vi.fn(async () => {}),
    ...over,
  }
}

const file = (name, mediaType = 'image') => ({ path: `t1/form-tok1/${name}`, mediaType, bytes: 1000 })
const item = (over = {}) => ({ location: 'ห้องนอน', symptom: 'รั่วซึม', files: [file('1-abcdef.jpg')], ...over })
const payload = (over = {}) => ({ siteId: SITE, items: [item()], preferredDays: [], preferredSlot: null, ...over })
const submit = (p = payload()) => ({ action: 'submit', token: 'abc', payload: p })

describe('bangkokDay', () => {
  it('is UTC+7', () => {
    expect(bangkokDay(Date.UTC(2026, 10, 24, 17, 0, 0))).toBe('2026-11-25')
    expect(bangkokDay(Date.UTC(2026, 10, 24, 16, 59, 59))).toBe('2026-11-24')
  })
})

describe('info', () => {
  const info = { action: 'info', token: 'abc' }

  it('expired token → reason expired', async () => {
    const d = deps({ loadToken: vi.fn(async () => tokenRow({ expiresAt: new Date(NOW - 1).toISOString() })) })
    const r = await handleCustomerForm(info, d, NOW)
    expect(r).toEqual({ status: 200, body: { reason: 'expired' } })
  })

  it('expires exactly now → expired', async () => {
    const d = deps({ loadToken: vi.fn(async () => tokenRow({ expiresAt: new Date(NOW).toISOString() })) })
    expect((await handleCustomerForm(info, d, NOW)).body).toEqual({ reason: 'expired' })
  })

  it('used token → reason used + ticket number', async () => {
    const d = deps({ loadToken: vi.fn(async () => tokenRow({ usedAt: new Date(NOW).toISOString(), refTicketNumber: 'RP2611-007' })) })
    const r = await handleCustomerForm(info, d, NOW)
    expect(r).toEqual({ status: 200, body: { reason: 'used', ticketNumber: 'RP2611-007' } })
  })

  it('unknown token → not_found', async () => {
    const d = deps({ loadToken: vi.fn(async () => null) })
    expect((await handleCustomerForm(info, d, NOW)).body).toEqual({ reason: 'not_found' })
  })

  it('review-purpose token → not_found (R3)', async () => {
    const d = deps({ loadToken: vi.fn(async () => tokenRow({ purpose: 'review' })) })
    expect((await handleCustomerForm(info, d, NOW)).body).toEqual({ reason: 'not_found' })
  })

  it('hasModule false → line_bot_disabled', async () => {
    const d = deps({ hasModule: vi.fn(async () => false) })
    expect((await handleCustomerForm(info, d, NOW)).body).toEqual({ reason: 'line_bot_disabled' })
    expect(d.hasModule).toHaveBeenCalledWith('t1')
  })

  it('0 sites → no_sites', async () => {
    const d = deps({ listSites: vi.fn(async () => []) })
    expect((await handleCustomerForm(info, d, NOW)).body).toEqual({ reason: 'no_sites' })
  })

  it('1 site → full info', async () => {
    const d = deps()
    const r = await handleCustomerForm(info, d, NOW)
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.sites.length).toBe(1)
    expect(r.body.sites[0]).toEqual({ id: SITE, name: 'บ้านคุณสมชาย' })
    expect(r.body.clientName).toBe('คุณสมชาย')
    expect(r.body.brandName).toBe('สร้างดี')
    expect(r.body.bounds).toEqual({ min: '2026-11-26', max: '2027-01-24' })
    expect(r.body.locations).toEqual(LOCATIONS)
    expect(r.body.symptoms).toEqual(SYMPTOMS)
    expect(r.body.limits).toEqual(LIMITS)
    expect(r.body.slots).toEqual(SLOTS)
    expect(d.listSites).toHaveBeenCalledWith('t1', 'c1')
    expect(d.brand).toHaveBeenCalledWith('t1', 'c1')
  })

  it('missing token → 400', async () => {
    expect((await handleCustomerForm({ action: 'info' }, deps(), NOW)).status).toBe(400)
  })

  it('unknown action → 400', async () => {
    expect((await handleCustomerForm({ action: 'nope', token: 'abc' }, deps(), NOW)).status).toBe(400)
  })

  it('a dep throws → 500 generic, no raw text', async () => {
    const d = deps({ loadToken: vi.fn(async () => { throw new Error('relation "x" does not exist') }) })
    const r = await handleCustomerForm(info, d, NOW)
    expect(r).toEqual({ status: 500, body: { errors: [SEND_FAIL] } })
  })
})

describe('upload_url', () => {
  const up = (over = {}) => ({ action: 'upload_url', token: 'abc', mediaType: 'image', mime: 'image/jpeg', bytes: 1000, ...over })

  it('image/heic → 400 bad_type', async () => {
    const d = deps()
    const r = await handleCustomerForm(up({ mime: 'image/heic' }), d, NOW)
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('bad_type')
    expect(d.signUpload).not.toHaveBeenCalled()
  })

  it('video/mp4 10 MB → path under the token folder', async () => {
    const d = deps()
    const r = await handleCustomerForm(up({ mediaType: 'video', mime: 'video/mp4', bytes: 10 * 1024 * 1024 }), d, NOW)
    expect(r.status).toBe(200)
    expect(r.body.path).toMatch(/^t1\/form-tok1\/\d+-[a-z0-9]{6}\.mp4$/)
    expect(r.body.signedUrl).toBe(`https://x/${r.body.path}?t=1`)
    expect(r.body.uploadToken).toBe('up1')
    expect(d.signUpload).toHaveBeenCalledWith(r.body.path)
  })

  it.each([
    ['image/jpeg', 'image', 'jpg'], ['image/png', 'image', 'png'],
    ['video/quicktime', 'video', 'mov'], ['video/webm', 'video', 'webm'],
  ])('%s → .%s', async (mime, mediaType, ext) => {
    const r = await handleCustomerForm(up({ mime, mediaType }), deps(), NOW)
    expect(r.body.path.endsWith(`.${ext}`)).toBe(true)
  })

  it('mediaType not matching the mime → 400 bad_type', async () => {
    const r = await handleCustomerForm(up({ mediaType: 'image', mime: 'video/quicktime' }), deps(), NOW)
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('bad_type')
  })

  it('over 50 MB → 400 too_big', async () => {
    const r = await handleCustomerForm(up({ bytes: LIMITS.maxBytes + 1 }), deps(), NOW)
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('too_big')
  })

  it('bytes not a number → 400', async () => {
    const r = await handleCustomerForm(up({ bytes: 'lots' }), deps(), NOW)
    expect(r.status).toBe(400)
  })

  it('the 120th upload is allowed, the 121st → 429 too_many', async () => {
    const ok = await handleCustomerForm(up(), deps({ countUploads: vi.fn(async () => 119) }), NOW)
    expect(ok.status).toBe(200)
    const d = deps({ countUploads: vi.fn(async () => 120) })
    const r = await handleCustomerForm(up(), d, NOW)
    expect(r.status).toBe(429)
    expect(r.body.error).toBe('too_many')
    expect(d.countUploads).toHaveBeenCalledWith('t1', 'tok1')
    expect(d.signUpload).not.toHaveBeenCalled()
  })

  it('expired token → 400 link message, no signing', async () => {
    const d = deps({ loadToken: vi.fn(async () => tokenRow({ expiresAt: new Date(NOW - 1).toISOString() })) })
    const r = await handleCustomerForm(up(), d, NOW)
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ reason: 'expired', errors: [LINK] })
    expect(d.signUpload).not.toHaveBeenCalled()
  })

  it('used token → refused with the ticket number', async () => {
    const d = deps({ loadToken: vi.fn(async () => tokenRow({ usedAt: 'x', refTicketNumber: 'RP2611-007' })) })
    const r = await handleCustomerForm(up(), d, NOW)
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ reason: 'used', ticketNumber: 'RP2611-007' })
    expect(d.signUpload).not.toHaveBeenCalled()
  })

  it('review-purpose token → not_found', async () => {
    const d = deps({ loadToken: vi.fn(async () => tokenRow({ purpose: 'review' })) })
    const r = await handleCustomerForm(up(), d, NOW)
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ reason: 'not_found', errors: [LINK] })
  })

  it('module off → refused', async () => {
    const d = deps({ hasModule: vi.fn(async () => false) })
    const r = await handleCustomerForm(up(), d, NOW)
    expect(r.status).toBe(403)
    expect(r.body.reason).toBe('line_bot_disabled')
    expect(d.signUpload).not.toHaveBeenCalled()
  })
})

describe('submit', () => {
  it('valid → RPC with description, push, ok', async () => {
    const d = deps()
    const p = payload({ items: [item(), item({ location: 'ครัว', room: 'ชั้น 2', files: [file('2-bbbbbb.png')] })] })
    const r = await handleCustomerForm(submit(p), d, NOW)
    expect(r).toEqual({ status: 200, body: { ok: true, ticketNumber: 'RP2611-007' } })
    expect(d.submitRpc).toHaveBeenCalledTimes(1)
    const [tok, sent] = d.submitRpc.mock.calls[0]
    expect(tok).toBe('abc')
    expect(sent.description).toBe(itemsDescription(p.items))
    expect(sent.siteId).toBe(SITE)
    expect(sent.items[1].files[0]).toEqual({ path: 't1/form-tok1/2-bbbbbb.png', mediaType: 'image', bytes: 1000 })
    expect(d.pushReceived).toHaveBeenCalledWith('t1', 'U1', 'RP2611-007')
  })

  it('general note is appended to the description (R6)', async () => {
    const d = deps()
    await handleCustomerForm(submit(payload({ note: '  โทรก่อนเข้า ' })), d, NOW)
    const sent = d.submitRpc.mock.calls[0][1]
    expect(sent.description).toBe(`${itemsDescription(payload().items)}\nหมายเหตุ: โทรก่อนเข้า`)
  })

  it('free text is capped like the page: room 100, notes 1000', async () => {
    const d = deps()
    const long = 'ก'.repeat(5000)
    await handleCustomerForm(submit(payload({ note: long, items: [item({ room: 'ห'.repeat(500), note: 'x'.repeat(5000) })] })), d, NOW)
    const sent = d.submitRpc.mock.calls[0][1]
    expect(sent.description).toContain(`\nหมายเหตุ: ${'ก'.repeat(1000)}`)
    expect(sent.description).not.toContain('ก'.repeat(1001))
    expect(sent.items[0].room).toHaveLength(100)
    expect(sent.items[0].note).toHaveLength(1000)
  })

  it('sends the real stored size, not the declared one', async () => {
    const d = deps({ objectSize: vi.fn(async () => 4321) })
    await handleCustomerForm(submit(), d, NOW)
    expect(d.submitRpc.mock.calls[0][1].items[0].files[0].bytes).toBe(4321)
  })

  it('validation errors → 400 {errors}, no RPC', async () => {
    const d = deps()
    const r = await handleCustomerForm(submit(payload({ items: [] })), d, NOW)
    expect(r.status).toBe(400)
    expect(r.body.errors).toContain('ยังไม่มีรายการ')
    expect(d.submitRpc).not.toHaveBeenCalled()
  })

  it('preferred day today (Bangkok) is rejected', async () => {
    const d = deps()
    const r = await handleCustomerForm(submit(payload({ preferredDays: ['2026-11-25'], preferredSlot: 'day' })), d, NOW)
    expect(r.status).toBe(400)
    expect(r.body.errors).toContain('เลือกวันตั้งแต่พรุ่งนี้')
  })

  it('missing object (objectSize null) → 400, RPC not called', async () => {
    const d = deps({ objectSize: vi.fn(async () => null) })
    const r = await handleCustomerForm(submit(), d, NOW)
    expect(r).toEqual({ status: 400, body: { errors: [UPLOAD_FAIL] } })
    expect(d.submitRpc).not.toHaveBeenCalled()
  })

  it('stored object over 50 MB → 400, RPC not called', async () => {
    const d = deps({ objectSize: vi.fn(async () => LIMITS.maxBytes + 1) })
    const r = await handleCustomerForm(submit(), d, NOW)
    expect(r).toEqual({ status: 400, body: { errors: [UPLOAD_FAIL] } })
    expect(d.submitRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['image + .mov', file('1-abcdef.mov', 'image')],
    ['video + .jpg', file('1-abcdef.jpg', 'video')],
    ['no extension', file('1-abcdef', 'image')],
  ])('mediaType/extension mismatch (%s) → 400, no storage or RPC', async (_n, f) => {
    const d = deps()
    const r = await handleCustomerForm(submit(payload({ items: [item({ files: [file('0-aaaaaa.jpg'), f] })] })), d, NOW)
    expect(r).toEqual({ status: 400, body: { errors: [UPLOAD_FAIL] } })
    expect(d.submitRpc).not.toHaveBeenCalled()
  })

  it('a path outside this token folder → 400 before any storage lookup', async () => {
    const d = deps()
    const bad = { path: 't2/form-other/1-abcdef.jpg', mediaType: 'image', bytes: 1000 }
    const r = await handleCustomerForm(submit(payload({ items: [item({ files: [bad] })] })), d, NOW)
    expect(r).toEqual({ status: 400, body: { errors: [UPLOAD_FAIL] } })
    expect(d.objectSize).not.toHaveBeenCalled()
    expect(d.submitRpc).not.toHaveBeenCalled()
  })

  it('a video without seconds is accepted (length is client-only)', async () => {
    const d = deps()
    const files = [file('1-abcdef.jpg'), file('2-abcdef.mp4', 'video')]
    const r = await handleCustomerForm(submit(payload({ items: [item({ files })] })), d, NOW)
    expect(r.status).toBe(200)
  })

  it('RPC already → 200 already:true, no push', async () => {
    const d = deps({ submitRpc: vi.fn(async () => ({ status: 'already', ticket_number: 'RP2611-007' })) })
    const r = await handleCustomerForm(submit(), d, NOW)
    expect(r).toEqual({ status: 200, body: { ok: true, ticketNumber: 'RP2611-007', already: true } })
    expect(d.pushReceived).not.toHaveBeenCalled()
  })

  it('token already used before submit → 200 already:true, no RPC, no push', async () => {
    const d = deps({ loadToken: vi.fn(async () => tokenRow({ usedAt: 'x', refTicketNumber: 'RP2611-007' })) })
    const r = await handleCustomerForm(submit(), d, NOW)
    expect(r).toEqual({ status: 200, body: { ok: true, ticketNumber: 'RP2611-007', already: true } })
    expect(d.submitRpc).not.toHaveBeenCalled()
    expect(d.pushReceived).not.toHaveBeenCalled()
  })

  it('expired token → 400 link message, no RPC', async () => {
    const d = deps({ loadToken: vi.fn(async () => tokenRow({ expiresAt: new Date(NOW - 1).toISOString() })) })
    const r = await handleCustomerForm(submit(), d, NOW)
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ reason: 'expired', errors: [LINK] })
    expect(d.submitRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['site', 'ไซท์ไม่ถูกต้อง'],
    ['path', UPLOAD_FAIL],
    ['empty', 'ยังไม่มีรายการ'],
    ['expired', LINK],
    ['not_found', LINK],
  ])('RPC invalid/%s → 400 %s', async (reason, msg) => {
    const d = deps({ submitRpc: vi.fn(async () => ({ status: 'invalid', reason })) })
    const r = await handleCustomerForm(submit(), d, NOW)
    expect(r).toEqual({ status: 400, body: { errors: [msg] } })
    expect(d.pushReceived).not.toHaveBeenCalled()
  })

  it('RPC throws → 500 generic, never raw SQL text (R7)', async () => {
    const d = deps({ submitRpc: vi.fn(async () => { throw new Error('duplicate key value violates unique constraint') }) })
    const r = await handleCustomerForm(submit(), d, NOW)
    expect(r).toEqual({ status: 500, body: { errors: [SEND_FAIL] } })
    expect(JSON.stringify(r.body)).not.toMatch(/duplicate|constraint/)
  })

  it('RPC returns something unexpected → 500 generic', async () => {
    const d = deps({ submitRpc: vi.fn(async () => null) })
    expect(await handleCustomerForm(submit(), d, NOW)).toEqual({ status: 500, body: { errors: [SEND_FAIL] } })
  })

  it('pushReceived throws → still 200 ok', async () => {
    const d = deps({ pushReceived: vi.fn(async () => { throw new Error('LINE down') }) })
    const r = await handleCustomerForm(submit(), d, NOW)
    expect(r).toEqual({ status: 200, body: { ok: true, ticketNumber: 'RP2611-007' } })
  })

  it('payload not an object → 400 errors', async () => {
    const d = deps()
    const r = await handleCustomerForm({ action: 'submit', token: 'abc', payload: 'x' }, d, NOW)
    expect(r.status).toBe(400)
    expect(Array.isArray(r.body.errors)).toBe(true)
    expect(d.submitRpc).not.toHaveBeenCalled()
  })
})
