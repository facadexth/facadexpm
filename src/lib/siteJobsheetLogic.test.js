import { describe, it, expect, vi } from 'vitest'
import {
  handleSiteJobsheet, SIGNED_URL_SECONDS, MAX_UPLOADS_PER_TOKEN_PER_DAY, MAX_PHOTO_BYTES, PHOTO_BUCKET,
} from '../../supabase/functions/_shared/site-jobsheet-logic.ts'
import {
  QUANTITY_BLOCKED_MESSAGE, PARENT_BLOCKED_MESSAGE, PLAN_GATE_MESSAGE,
} from '../../supabase/functions/_shared/lineTaskRules.ts'

// 2026-11-26 10:00 Bangkok
const NOW = Date.UTC(2026, 10, 26, 3, 0, 0)
const TODAY = '2026-11-26'
const DIR = `tn1/s1/${TODAY}`
const P1 = `${DIR}/js-tok1-${NOW}-aaaaaa.jpg`
const P2 = `${DIR}/js-tok1-${NOW}-bbbbbb.png`

const tokenRow = (over = {}) => ({
  id: 'tok1', tenantId: 'tn1', workerId: 'w1', actionType: 'site_jobsheet', siteId: 's1',
  expiresAt: new Date(NOW + 3600_000).toISOString(), ...over,
})
const workerRow = (over = {}) => ({ id: 'w1', tenantId: 'tn1', status: 'active', ...over })
const leaderRow = (over = {}) => ({ siteId: 's1', type: 'site', repairTicketId: null, isTeamLeader: true, ...over })
const cardRow = (over = {}) => ({
  id: 'c1', tenantId: 'tn1', siteId: 's1', status: 'not_started', progressMode: 'status', parentTaskId: null, hasChildren: false, ...over,
})
const SHEET = { siteName: 'ไซต์ A', groups: [], viewerIsLeader: true }

function deps(over = {}) {
  return {
    loadToken: vi.fn(async () => tokenRow()),
    loadWorker: vi.fn(async () => workerRow()),
    hasModule: vi.fn(async () => true),
    loadAssignments: vi.fn(async () => [leaderRow()]),
    loadSheet: vi.fn(async () => SHEET),
    countUploads: vi.fn(async () => 0),
    signUpload: vi.fn(async () => ({ signedUrl: 'https://x/upload', token: 'up1' })),
    photoExists: vi.fn(async () => true),
    loadCard: vi.fn(async () => cardRow()),
    updateCardStatus: vi.fn(async () => ({ updated: 1 })),
    insertPhotos: vi.fn(async () => {}),
    ...over,
  }
}

const view = { action: 'view', token: 'abc' }
const upload = (over = {}) => ({ action: 'upload_url', token: 'abc', mime: 'image/jpeg', bytes: 500_000, ...over })
const update = (over = {}) => ({ action: 'card_update', token: 'abc', taskId: 'c1', mode: 'done', note: ' ติดตั้งเสร็จ ', photos: [P1], ...over })

describe('token checks (all actions)', () => {
  for (const body of [view, upload(), update()]) {
    describe(body.action, () => {
      it('unknown token → not_found', async () => {
        const d = deps({ loadToken: vi.fn(async () => null) })
        expect(await handleSiteJobsheet(body, d, NOW)).toEqual({ status: 200, body: { reason: 'not_found' } })
      })

      it('other action_type → not_found', async () => {
        const d = deps({ loadToken: vi.fn(async () => tokenRow({ actionType: 'repair_workorder' })) })
        expect((await handleSiteJobsheet(body, d, NOW)).body).toEqual({ reason: 'not_found' })
      })

      it('token without site → not_found', async () => {
        const d = deps({ loadToken: vi.fn(async () => tokenRow({ siteId: null })) })
        expect((await handleSiteJobsheet(body, d, NOW)).body).toEqual({ reason: 'not_found' })
      })

      it('expired (reused tomorrow) → expired, nothing loaded', async () => {
        const d = deps({ loadToken: vi.fn(async () => tokenRow({ expiresAt: new Date(NOW - 1).toISOString() })) })
        expect((await handleSiteJobsheet(body, d, NOW)).body).toEqual({ reason: 'expired' })
        expect(d.loadSheet).not.toHaveBeenCalled()
        expect(d.loadAssignments).not.toHaveBeenCalled()
      })

      it('worker not active / other tenant → not_found', async () => {
        const d = deps({ loadWorker: vi.fn(async () => workerRow({ status: 'inactive' })) })
        expect((await handleSiteJobsheet(body, d, NOW)).body).toEqual({ reason: 'not_found' })
        const d2 = deps({ loadWorker: vi.fn(async () => workerRow({ tenantId: 'other' })) })
        expect((await handleSiteJobsheet(body, d2, NOW)).body).toEqual({ reason: 'not_found' })
      })

      it('module off → line_bot_disabled', async () => {
        const d = deps({ hasModule: vi.fn(async () => false) })
        expect((await handleSiteJobsheet(body, d, NOW)).body).toEqual({ reason: 'line_bot_disabled' })
        expect(d.hasModule).toHaveBeenCalledWith('tn1')
      })

      it('no assignment today → not_assigned; asked for Bangkok today', async () => {
        const d = deps({ loadAssignments: vi.fn(async () => []) })
        expect((await handleSiteJobsheet(body, d, NOW)).body).toEqual({ reason: 'not_assigned' })
        expect(d.loadAssignments).toHaveBeenCalledWith('tn1', 'w1', TODAY)
        expect(d.loadSheet).not.toHaveBeenCalled()
        expect(d.updateCardStatus).not.toHaveBeenCalled()
        expect(d.signUpload).not.toHaveBeenCalled()
      })

      it('repair-only assignment at the site → not_assigned', async () => {
        const d = deps({ loadAssignments: vi.fn(async () => [leaderRow({ repairTicketId: 't9' })]) })
        expect((await handleSiteJobsheet(body, d, NOW)).body).toEqual({ reason: 'not_assigned' })
      })

      it('moved to another site today → not_assigned', async () => {
        const d = deps({ loadAssignments: vi.fn(async () => [leaderRow({ siteId: 's2' })]) })
        expect((await handleSiteJobsheet(body, d, NOW)).body).toEqual({ reason: 'not_assigned' })
      })

      it('factory row at the site is not an install day → not_assigned', async () => {
        const d = deps({ loadAssignments: vi.fn(async () => [leaderRow({ type: 'factory' })]) })
        expect((await handleSiteJobsheet(body, d, NOW)).body).toEqual({ reason: 'not_assigned' })
      })

      it('unexpected throw → 500 generic, no raw text', async () => {
        const d = deps({ loadToken: vi.fn(async () => { throw new Error('relation does not exist') }) })
        expect(await handleSiteJobsheet(body, d, NOW)).toEqual({ status: 500, body: { error: 'failed' } })
      })
    })
  }

  it('Bangkok date: 23:30 UTC on the 25th is the 26th in Bangkok', async () => {
    const d = deps()
    await handleSiteJobsheet(view, d, Date.UTC(2026, 10, 25, 23, 30))
    expect(d.loadAssignments).toHaveBeenCalledWith('tn1', 'w1', TODAY)
  })
})

describe('bad input → 400', () => {
  it('body / token / action', async () => {
    expect(await handleSiteJobsheet(null, deps(), NOW)).toEqual({ status: 400, body: { error: 'bad_request' } })
    expect((await handleSiteJobsheet({ action: 'view' }, deps(), NOW)).body).toEqual({ error: 'missing_token' })
    expect((await handleSiteJobsheet({ action: 'view', token: 'x'.repeat(129) }, deps(), NOW)).status).toBe(400)
    expect((await handleSiteJobsheet({ action: 'nope', token: 'abc' }, deps(), NOW)).body).toEqual({ error: 'unknown_action' })
  })

  it('upload_url mime / bytes checked before the token', async () => {
    const d = deps()
    expect((await handleSiteJobsheet(upload({ mime: 'image/heic' }), d, NOW)).body).toEqual({ error: 'bad_type' })
    expect((await handleSiteJobsheet(upload({ mime: 'video/mp4' }), d, NOW)).body).toEqual({ error: 'bad_type' })
    expect((await handleSiteJobsheet(upload({ bytes: 0 }), d, NOW)).body).toEqual({ error: 'bad_size' })
    expect((await handleSiteJobsheet(upload({ bytes: '100' }), d, NOW)).body).toEqual({ error: 'bad_size' })
    expect((await handleSiteJobsheet(upload({ bytes: MAX_PHOTO_BYTES + 1 }), d, NOW)).body).toEqual({ error: 'too_big' })
    expect(d.loadToken).not.toHaveBeenCalled()
  })

  it('card_update fields checked before the token', async () => {
    const d = deps()
    const r = async (over) => (await handleSiteJobsheet(update(over), d, NOW))
    expect((await r({ taskId: '' })).body).toEqual({ error: 'bad_task' })
    expect((await r({ mode: 'skip' })).body).toEqual({ error: 'bad_mode' })
    expect((await r({ note: 5 })).body).toEqual({ error: 'bad_note' })
    expect((await r({ note: 'ก'.repeat(501) })).body).toEqual({ error: 'bad_note' })
    expect((await r({ photos: [] })).body).toEqual({ error: 'bad_photos' })
    expect((await r({ photos: undefined })).body).toEqual({ error: 'bad_photos' })
    expect((await r({ photos: Array.from({ length: 11 }, (_, i) => `${DIR}/js-${i}.jpg`) })).body).toEqual({ error: 'bad_photos' })
    expect((await r({ photos: [P1, P1] })).body).toEqual({ error: 'bad_photo' })
    expect((await r({ photos: [7] })).body).toEqual({ error: 'bad_photo' })
    expect((await r({ photos: [P1] })).status).toBe(200)
    expect(d.loadToken).toHaveBeenCalledTimes(1)
  })

  it('note of exactly 500 is fine', async () => {
    expect((await handleSiteJobsheet(update({ note: 'ก'.repeat(500) }), deps(), NOW)).body.ok).toBe(true)
  })
})

describe('view', () => {
  it('leader → sheet for the token site, Bangkok today, viewer = token worker', async () => {
    const d = deps()
    expect(await handleSiteJobsheet(view, d, NOW)).toEqual({ status: 200, body: { ok: true, sheet: SHEET } })
    expect(d.loadSheet).toHaveBeenCalledWith('tn1', 's1', TODAY, 'w1')
  })

  it('booked but not leader → still sees the sheet', async () => {
    const d = deps({ loadAssignments: vi.fn(async () => [leaderRow({ isTeamLeader: false })]) })
    expect((await handleSiteJobsheet(view, d, NOW)).body).toEqual({ ok: true, sheet: SHEET })
  })

  it('leader on any of the worker rows at the site counts (shift rows)', async () => {
    const d = deps({ loadAssignments: vi.fn(async () => [leaderRow({ isTeamLeader: false }), leaderRow()]) })
    expect((await handleSiteJobsheet(upload(), d, NOW)).body.path).toBeTruthy()
  })

  it('leader at another site does not make you leader here', async () => {
    const d = deps({ loadAssignments: vi.fn(async () => [leaderRow({ isTeamLeader: false }), leaderRow({ siteId: 's2' })]) })
    expect((await handleSiteJobsheet(upload(), d, NOW)).body).toEqual({ reason: 'not_leader' })
  })

  it('signed urls last 30 minutes', () => {
    expect(SIGNED_URL_SECONDS).toBe(1800)
    expect(PHOTO_BUCKET).toBe('line-site-photos')
  })
})

describe('upload_url', () => {
  it('leader → signed upload under <tenant>/<site>/<date>/js-<token>-<now>-<rand>.<ext>', async () => {
    const d = deps()
    const r = await handleSiteJobsheet(upload(), d, NOW)
    expect(r.status).toBe(200)
    expect(r.body.path).toMatch(new RegExp(`^tn1/s1/${TODAY}/js-tok1-${NOW}-[a-z0-9]{6}\\.jpg$`))
    expect(r.body).toMatchObject({ signedUrl: 'https://x/upload', uploadToken: 'up1' })
    expect(d.signUpload).toHaveBeenCalledWith(r.body.path)
    expect(d.countUploads).toHaveBeenCalledWith(DIR, 'js-tok1-')
  })

  it('png → .png', async () => {
    expect((await handleSiteJobsheet(upload({ mime: 'image/png' }), deps(), NOW)).body.path).toMatch(/\.png$/)
  })

  it('non-leader → not_leader, no url', async () => {
    const d = deps({ loadAssignments: vi.fn(async () => [leaderRow({ isTeamLeader: false })]) })
    expect(await handleSiteJobsheet(upload(), d, NOW)).toEqual({ status: 200, body: { reason: 'not_leader' } })
    expect(d.signUpload).not.toHaveBeenCalled()
  })

  it(`cap: ${MAX_UPLOADS_PER_TOKEN_PER_DAY} per token per day → 429 too_many`, async () => {
    expect(MAX_UPLOADS_PER_TOKEN_PER_DAY).toBe(30)
    const d = deps({ countUploads: vi.fn(async () => 30) })
    expect(await handleSiteJobsheet(upload(), d, NOW)).toEqual({ status: 429, body: { error: 'too_many' } })
    expect(d.signUpload).not.toHaveBeenCalled()
    const d2 = deps({ countUploads: vi.fn(async () => 29) })
    expect((await handleSiteJobsheet(upload(), d2, NOW)).status).toBe(200)
  })

  it('signing fails → 500 generic', async () => {
    const d = deps({ signUpload: vi.fn(async () => { throw new Error('bucket not found') }) })
    expect(await handleSiteJobsheet(upload(), d, NOW)).toEqual({ status: 500, body: { error: 'failed' } })
  })
})

describe('card_update', () => {
  it('done → status done (tenant+site+id), one photo row per photo, fresh sheet', async () => {
    const d = deps()
    const r = await handleSiteJobsheet(update({ photos: [P1, P2] }), d, NOW)
    expect(r).toEqual({ status: 200, body: { ok: true, sheet: SHEET } })
    expect(d.loadCard).toHaveBeenCalledWith('tn1', 's1', 'c1')
    expect(d.updateCardStatus).toHaveBeenCalledWith('tn1', 's1', 'c1', 'done')
    expect(d.insertPhotos).toHaveBeenCalledWith([P1, P2].map((p) => ({
      tenant_id: 'tn1', worker_id: 'w1', site_id: 's1', date: TODAY, photo_path: p,
      description: 'ติดตั้งเสร็จ', task_id: 'c1', customer_visible: false,
    })))
    expect(d.photoExists).toHaveBeenCalledWith(P1)
    expect(d.photoExists).toHaveBeenCalledWith(P2)
    expect(d.loadSheet).toHaveBeenCalledTimes(1)
  })

  it('empty note → description null', async () => {
    const d = deps()
    await handleSiteJobsheet(update({ note: '   ' }), d, NOW)
    expect(d.insertPhotos.mock.calls[0][0][0].description).toBeNull()
    const d2 = deps()
    await handleSiteJobsheet(update({ note: undefined }), d2, NOW)
    expect(d2.insertPhotos.mock.calls[0][0][0].description).toBeNull()
  })

  it('non-leader forged card_update → not_leader, nothing written', async () => {
    const d = deps({ loadAssignments: vi.fn(async () => [leaderRow({ isTeamLeader: false })]) })
    expect(await handleSiteJobsheet(update(), d, NOW)).toEqual({ status: 200, body: { reason: 'not_leader' } })
    expect(d.updateCardStatus).not.toHaveBeenCalled()
    expect(d.insertPhotos).not.toHaveBeenCalled()
  })

  describe('photo prefix check → 400 bad_photo, nothing written', () => {
    const bad = {
      'other tenant': `tn2/s1/${TODAY}/js-tok1-1-a.jpg`,
      'other site': `tn1/s2/${TODAY}/js-tok1-1-a.jpg`,
      'other day': `tn1/s1/2026-11-25/js-tok1-1-a.jpg`,
      'LINE photo (not js-)': `${DIR}/line-1.jpg`,
      'dot dot': `${DIR}/js-../../x.jpg`,
      'sub folder': `${DIR}/js-x/y.jpg`,
      'not an image': `${DIR}/js-tok1-1-a.mp4`,
      'prefix only': `${DIR}/js-`,
    }
    for (const [name, path] of Object.entries(bad)) {
      it(name, async () => {
        const d = deps()
        expect(await handleSiteJobsheet(update({ photos: [P1, path] }), d, NOW)).toEqual({ status: 400, body: { error: 'bad_photo' } })
        expect(d.updateCardStatus).not.toHaveBeenCalled()
        expect(d.insertPhotos).not.toHaveBeenCalled()
      })
    }
  })

  it('path not in storage → 400 bad_photo, nothing written', async () => {
    const d = deps({ photoExists: vi.fn(async (p) => p !== P2) })
    expect(await handleSiteJobsheet(update({ photos: [P1, P2] }), d, NOW)).toEqual({ status: 400, body: { error: 'bad_photo' } })
    expect(d.updateCardStatus).not.toHaveBeenCalled()
    expect(d.insertPhotos).not.toHaveBeenCalled()
  })

  it('card of another site / tenant / gone → card_not_found', async () => {
    for (const card of [cardRow({ siteId: 's2' }), cardRow({ tenantId: 'tn2' }), null]) {
      const d = deps({ loadCard: vi.fn(async () => card) })
      expect((await handleSiteJobsheet(update(), d, NOW)).body).toEqual({ reason: 'card_not_found' })
      expect(d.updateCardStatus).not.toHaveBeenCalled()
      expect(d.insertPhotos).not.toHaveBeenCalled()
    }
  })

  it('quantity card done → refused with QUANTITY_BLOCKED_MESSAGE, nothing written', async () => {
    const d = deps({ loadCard: vi.fn(async () => cardRow({ progressMode: 'quantity' })) })
    expect(await handleSiteJobsheet(update(), d, NOW)).toEqual({ status: 200, body: { reason: 'blocked', message: QUANTITY_BLOCKED_MESSAGE } })
    expect(d.updateCardStatus).not.toHaveBeenCalled()
    expect(d.insertPhotos).not.toHaveBeenCalled()
  })

  it('parent card done → refused with PARENT_BLOCKED_MESSAGE', async () => {
    const d = deps({ loadCard: vi.fn(async () => cardRow({ hasChildren: true })) })
    expect((await handleSiteJobsheet(update(), d, NOW)).body).toEqual({ reason: 'blocked', message: PARENT_BLOCKED_MESSAGE })
    expect(d.updateCardStatus).not.toHaveBeenCalled()
  })

  it('quantity card continue → still works (not_started → in_progress + photos)', async () => {
    const d = deps({ loadCard: vi.fn(async () => cardRow({ progressMode: 'quantity' })) })
    expect((await handleSiteJobsheet(update({ mode: 'continue' }), d, NOW)).body.ok).toBe(true)
    expect(d.updateCardStatus).toHaveBeenCalledWith('tn1', 's1', 'c1', 'in_progress', 'not_started')
    expect(d.insertPhotos).toHaveBeenCalledTimes(1)
  })

  it('continue on in_progress / done card → no status change, photos still saved', async () => {
    for (const status of ['in_progress', 'done']) {
      const d = deps({ loadCard: vi.fn(async () => cardRow({ status })) })
      expect((await handleSiteJobsheet(update({ mode: 'continue' }), d, NOW)).body.ok).toBe(true)
      expect(d.updateCardStatus).not.toHaveBeenCalled()
      expect(d.insertPhotos).toHaveBeenCalledTimes(1)
    }
  })

  it('done on a card already done → no update, photos saved', async () => {
    const d = deps({ loadCard: vi.fn(async () => cardRow({ status: 'done' })) })
    expect((await handleSiteJobsheet(update(), d, NOW)).body.ok).toBe(true)
    expect(d.updateCardStatus).not.toHaveBeenCalled()
    expect(d.insertPhotos).toHaveBeenCalledTimes(1)
  })

  it('DB trigger refusal (PLAN gate) → blocked with doneErrorReply text, no photos', async () => {
    const d = deps({ updateCardStatus: vi.fn(async () => ({ errorMessage: 'ERROR: ต้องบันทึก PLAN v1 ก่อน' })) })
    expect(await handleSiteJobsheet(update(), d, NOW)).toEqual({ status: 200, body: { reason: 'blocked', message: PLAN_GATE_MESSAGE } })
    expect(d.insertPhotos).not.toHaveBeenCalled()
  })

  it('other DB error on update → 500 generic, no photos, no raw text', async () => {
    const d = deps({ updateCardStatus: vi.fn(async () => ({ errorMessage: 'deadlock detected' })) })
    expect(await handleSiteJobsheet(update(), d, NOW)).toEqual({ status: 500, body: { error: 'failed' } })
    expect(d.insertPhotos).not.toHaveBeenCalled()
    const d2 = deps({ loadCard: vi.fn(async () => cardRow()), updateCardStatus: vi.fn(async () => ({ errorMessage: 'x' })) })
    expect((await handleSiteJobsheet(update({ mode: 'continue' }), d2, NOW)).status).toBe(500)
    expect(d2.insertPhotos).not.toHaveBeenCalled()
  })

  it('update hits 0 rows on done → card_not_found, no photos', async () => {
    const d = deps({ updateCardStatus: vi.fn(async () => ({ updated: 0 })) })
    expect((await handleSiteJobsheet(update(), d, NOW)).body).toEqual({ reason: 'card_not_found' })
    expect(d.insertPhotos).not.toHaveBeenCalled()
  })

  it('photo insert fails → status put back, 500 generic', async () => {
    const d = deps({ insertPhotos: vi.fn(async () => { throw new Error('violates fk') }) })
    expect(await handleSiteJobsheet(update(), d, NOW)).toEqual({ status: 500, body: { error: 'failed' } })
    expect(d.updateCardStatus).toHaveBeenLastCalledWith('tn1', 's1', 'c1', 'not_started')
    expect(d.loadSheet).not.toHaveBeenCalled()
  })

  it('photo insert fails with no status change → nothing to put back', async () => {
    const d = deps({ loadCard: vi.fn(async () => cardRow({ status: 'in_progress' })), insertPhotos: vi.fn(async () => { throw new Error('x') }) })
    expect((await handleSiteJobsheet(update({ mode: 'continue' }), d, NOW)).status).toBe(500)
    expect(d.updateCardStatus).not.toHaveBeenCalled()
  })
})
