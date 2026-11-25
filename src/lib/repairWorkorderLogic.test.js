import { describe, it, expect, vi } from 'vitest'
import {
  handleRepairWorkorder, decodePngDataUrl, MAX_SIGNATURE_BYTES, SIGNED_URL_SECONDS,
} from '../../supabase/functions/_shared/repair-workorder-logic.ts'

// 2026-11-25 10:00 Bangkok
const NOW = Date.UTC(2026, 10, 25, 3, 0, 0)

// 1x1 PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PNG = `data:image/png;base64,${PNG_B64}`

const tokenRow = (over = {}) => ({
  id: 'tok1', tenantId: 'tn1', workerId: 'w1', actionType: 'repair_workorder', repairTicketId: 't1',
  expiresAt: new Date(NOW + 3600_000).toISOString(), ...over,
})
const workerRow = (over = {}) => ({ id: 'w1', tenantId: 'tn1', name: 'สมศักดิ์ ใจดี', nickname: 'ศักดิ์', status: 'active', ...over })
const ticketRow = (over = {}) => ({ id: 't1', tenantId: 'tn1', ticketNumber: 'RP2611-007', status: 'scheduled', lineUserId: 'Ucust', ...over })
const WORK_ORDER = { number: 'RP2611-007', rows: [], receipt: null }

function deps(over = {}) {
  return {
    loadToken: vi.fn(async () => tokenRow()),
    loadWorker: vi.fn(async () => workerRow()),
    hasModule: vi.fn(async () => true),
    isAssigned: vi.fn(async () => true),
    loadTicket: vi.fn(async () => ticketRow()),
    loadWorkOrder: vi.fn(async () => WORK_ORDER),
    latestReceipt: vi.fn(async () => null),
    uploadSignature: vi.fn(async () => {}),
    removeSignature: vi.fn(async () => {}),
    insertReceipt: vi.fn(async (row) => ({ id: 'rc1', signer_name: row.signer_name, signed_at: '2026-11-25T03:00:00Z' })),
    createSignLink: vi.fn(async () => ({ id: 'link1' })),
    pushCustomer: vi.fn(async () => ({ sent: false, skipped: 'off' })),
    appUrl: 'https://changpm.app',
    ...over,
  }
}

const view = { action: 'view', token: 'abc' }
const sign = (over = {}) => ({ action: 'sign', token: 'abc', signerName: ' คุณสมชาย ', signaturePng: PNG, ...over })
const signLink = { action: 'sign_link', token: 'abc' }

describe('token checks (all actions)', () => {
  for (const body of [view, sign(), signLink]) {
    describe(body.action, () => {
      it('unknown token → not_found', async () => {
        const d = deps({ loadToken: vi.fn(async () => null) })
        expect(await handleRepairWorkorder(body, d, NOW)).toEqual({ status: 200, body: { reason: 'not_found' } })
      })

      it('other action_type (check_in token) → not_found', async () => {
        const d = deps({ loadToken: vi.fn(async () => tokenRow({ actionType: 'check_in', repairTicketId: null })) })
        expect((await handleRepairWorkorder(body, d, NOW)).body).toEqual({ reason: 'not_found' })
      })

      it('expired → expired', async () => {
        const d = deps({ loadToken: vi.fn(async () => tokenRow({ expiresAt: new Date(NOW).toISOString() })) })
        expect((await handleRepairWorkorder(body, d, NOW)).body).toEqual({ reason: 'expired' })
        expect(d.loadWorkOrder).not.toHaveBeenCalled()
      })

      it('worker not active → not_found', async () => {
        const d = deps({ loadWorker: vi.fn(async () => workerRow({ status: 'inactive' })) })
        expect((await handleRepairWorkorder(body, d, NOW)).body).toEqual({ reason: 'not_found' })
      })

      it('worker of another tenant → not_found', async () => {
        const d = deps({ loadWorker: vi.fn(async () => workerRow({ tenantId: 'other' })) })
        expect((await handleRepairWorkorder(body, d, NOW)).body).toEqual({ reason: 'not_found' })
      })

      it('module off → line_bot_disabled', async () => {
        const d = deps({ hasModule: vi.fn(async () => false) })
        expect((await handleRepairWorkorder(body, d, NOW)).body).toEqual({ reason: 'line_bot_disabled' })
        expect(d.hasModule).toHaveBeenCalledWith('tn1')
      })

      it('worker removed from the ticket → not_assigned, nothing loaded or written', async () => {
        const d = deps({ isAssigned: vi.fn(async () => false) })
        expect((await handleRepairWorkorder(body, d, NOW)).body).toEqual({ reason: 'not_assigned' })
        expect(d.isAssigned).toHaveBeenCalledWith('tn1', 'w1', 't1')
        expect(d.loadWorkOrder).not.toHaveBeenCalled()
        expect(d.uploadSignature).not.toHaveBeenCalled()
        expect(d.createSignLink).not.toHaveBeenCalled()
      })

      it('ticket gone or other tenant → not_found', async () => {
        const d = deps({ loadTicket: vi.fn(async () => ticketRow({ tenantId: 'other' })) })
        expect((await handleRepairWorkorder(body, d, NOW)).body).toEqual({ reason: 'not_found' })
        const d2 = deps({ loadTicket: vi.fn(async () => null) })
        expect((await handleRepairWorkorder(body, d2, NOW)).body).toEqual({ reason: 'not_found' })
      })

      it('declined ticket → declined', async () => {
        const d = deps({ loadTicket: vi.fn(async () => ticketRow({ status: 'declined' })) })
        expect((await handleRepairWorkorder(body, d, NOW)).body).toEqual({ reason: 'declined' })
        expect(d.loadWorkOrder).not.toHaveBeenCalled()
        expect(d.uploadSignature).not.toHaveBeenCalled()
        expect(d.createSignLink).not.toHaveBeenCalled()
      })
    })
  }

  it('used_at is ignored (multi-use token): a used token still views', async () => {
    const d = deps({ loadToken: vi.fn(async () => tokenRow({ usedAt: new Date(NOW - 1000).toISOString() })) })
    expect((await handleRepairWorkorder(view, d, NOW)).body.ok).toBe(true)
  })
})

describe('view', () => {
  it('ok → workOrder for the token ticket only, Bangkok today', async () => {
    const d = deps()
    const r = await handleRepairWorkorder(view, d, NOW)
    expect(r).toEqual({ status: 200, body: { ok: true, workOrder: WORK_ORDER } })
    expect(d.loadTicket).toHaveBeenCalledWith('tn1', 't1')
    expect(d.loadWorkOrder).toHaveBeenCalledWith('t1', 'tn1', '2026-11-25')
  })

  it('signed urls last 2 hours', () => {
    expect(SIGNED_URL_SECONDS).toBe(7200)
  })
})

describe('sign', () => {
  it('ok → uploads png to <tenant>/repair_ticket/<ticket>/<now>-crew.png and inserts the receipt', async () => {
    const d = deps()
    const r = await handleRepairWorkorder(sign(), d, NOW)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, receipt: { id: 'rc1', signer_name: 'คุณสมชาย', signed_at: '2026-11-25T03:00:00Z' } })
    const path = `tn1/repair_ticket/t1/${NOW}-crew.png`
    expect(d.uploadSignature).toHaveBeenCalledTimes(1)
    const [upPath, bytes] = d.uploadSignature.mock.calls[0]
    expect(upPath).toBe(path)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(d.insertReceipt).toHaveBeenCalledWith({
      tenant_id: 'tn1', document_type: 'repair_ticket', document_id: 't1',
      signer_name: 'คุณสมชาย', signature_path: path, signed_by: 'crew:สมศักดิ์ ใจดี',
    })
  })

  it('already signed and no force → already + existing receipt, nothing written', async () => {
    const existing = { id: 'rc0', signer_name: 'เดิม', signed_at: '2026-11-24T03:00:00Z' }
    const d = deps({ latestReceipt: vi.fn(async () => existing) })
    const r = await handleRepairWorkorder(sign(), d, NOW)
    expect(r).toEqual({ status: 200, body: { ok: true, already: true, receipt: existing } })
    expect(d.latestReceipt).toHaveBeenCalledWith('tn1', 't1')
    expect(d.uploadSignature).not.toHaveBeenCalled()
    expect(d.insertReceipt).not.toHaveBeenCalled()
  })

  it('already signed with force → signs again', async () => {
    const d = deps({ latestReceipt: vi.fn(async () => ({ id: 'rc0', signer_name: 'เดิม', signed_at: 'x' })) })
    const r = await handleRepairWorkorder(sign({ force: true }), d, NOW)
    expect(r.body.ok).toBe(true)
    expect(r.body.already).toBeUndefined()
    expect(d.insertReceipt).toHaveBeenCalledTimes(1)
  })

  it('force must be literally true', async () => {
    const d = deps({ latestReceipt: vi.fn(async () => ({ id: 'rc0', signer_name: 'เดิม', signed_at: 'x' })) })
    expect((await handleRepairWorkorder(sign({ force: 'yes' }), d, NOW)).body.already).toBe(true)
  })

  it('insert fails → uploaded file removed, 500 generic', async () => {
    const d = deps({ insertReceipt: vi.fn(async () => { throw new Error('violates check constraint') }) })
    const r = await handleRepairWorkorder(sign(), d, NOW)
    expect(r).toEqual({ status: 500, body: { error: 'failed' } })
    expect(d.removeSignature).toHaveBeenCalledWith(`tn1/repair_ticket/t1/${NOW}-crew.png`)
  })

  describe('bad png → 400 bad_signature (checked before the token)', () => {
    const cases = {
      missing: undefined,
      'jpeg data url': `data:image/jpeg;base64,${PNG_B64}`,
      'no prefix': PNG_B64,
      'not base64': 'data:image/png;base64,@@@@',
      'empty payload': 'data:image/png;base64,',
      'base64 but not a png': `data:image/png;base64,${btoa('hello world, not a png')}`,
    }
    for (const [name, value] of Object.entries(cases)) {
      it(name, async () => {
        const d = deps()
        const r = await handleRepairWorkorder(sign({ signaturePng: value }), d, NOW)
        expect(r).toEqual({ status: 400, body: { error: 'bad_signature' } })
        expect(d.loadToken).not.toHaveBeenCalled()
        expect(d.uploadSignature).not.toHaveBeenCalled()
      })
    }

    it('over 300 KB decoded', async () => {
      const big = new Uint8Array(MAX_SIGNATURE_BYTES + 1)
      big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const b64 = Buffer.from(big).toString('base64')
      const d = deps()
      const r = await handleRepairWorkorder(sign({ signaturePng: `data:image/png;base64,${b64}` }), d, NOW)
      expect(r).toEqual({ status: 400, body: { error: 'bad_signature' } })
    })

    it('exactly 300 KB is fine', () => {
      const ok = new Uint8Array(MAX_SIGNATURE_BYTES)
      ok.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const b64 = Buffer.from(ok).toString('base64')
      expect(decodePngDataUrl(`data:image/png;base64,${b64}`)?.length).toBe(MAX_SIGNATURE_BYTES)
      expect(MAX_SIGNATURE_BYTES).toBe(300 * 1024)
    })
  })

  describe('bad name → 400 bad_name', () => {
    for (const [name, value] of Object.entries({ missing: undefined, blank: '   ', 'too long': 'ก'.repeat(101), number: 5 })) {
      it(name, async () => {
        const d = deps()
        expect(await handleRepairWorkorder(sign({ signerName: value }), d, NOW)).toEqual({ status: 400, body: { error: 'bad_name' } })
        expect(d.loadToken).not.toHaveBeenCalled()
      })
    }
    it('100 chars after trim is fine', async () => {
      const d = deps()
      const r = await handleRepairWorkorder(sign({ signerName: `  ${'ก'.repeat(100)}  ` }), d, NOW)
      expect(r.body.ok).toBe(true)
      expect(d.insertReceipt.mock.calls[0][0].signer_name).toBe('ก'.repeat(100))
    })
  })
})

describe('sign_link', () => {
  it('creates a link with tenant + crew creator, pushes to the ticket LINE user; push off → sent false', async () => {
    const d = deps()
    const r = await handleRepairWorkorder(signLink, d, NOW)
    expect(r).toEqual({ status: 200, body: { ok: true, sent: false, url: 'https://changpm.app/sign/link1' } })
    expect(d.createSignLink).toHaveBeenCalledWith({
      tenant_id: 'tn1', document_type: 'repair_ticket', document_id: 't1', created_by: 'crew:สมศักดิ์ ใจดี',
    })
    expect(d.pushCustomer).toHaveBeenCalledWith('tn1', 'Ucust', 'กรุณาเซ็นรับงานซ่อม RP2611-007\nhttps://changpm.app/sign/link1')
  })

  it('push sent → sent true', async () => {
    const d = deps({ pushCustomer: vi.fn(async () => ({ sent: true, status: 200 })) })
    expect((await handleRepairWorkorder(signLink, d, NOW)).body.sent).toBe(true)
  })

  it('push throws → sent false, link still returned', async () => {
    const d = deps({ pushCustomer: vi.fn(async () => { throw new Error('boom') }) })
    expect((await handleRepairWorkorder(signLink, d, NOW)).body).toEqual({ ok: true, sent: false, url: 'https://changpm.app/sign/link1' })
  })
})

describe('request shape', () => {
  it('not an object → 400', async () => {
    expect((await handleRepairWorkorder(null, deps(), NOW))).toEqual({ status: 400, body: { error: 'bad_request' } })
  })
  it('missing / oversized token → 400', async () => {
    expect((await handleRepairWorkorder({ action: 'view' }, deps(), NOW)).body).toEqual({ error: 'missing_token' })
    expect((await handleRepairWorkorder({ action: 'view', token: 'x'.repeat(129) }, deps(), NOW)).status).toBe(400)
  })
  it('unknown action → 400', async () => {
    expect((await handleRepairWorkorder({ action: 'delete', token: 'abc' }, deps(), NOW))).toEqual({ status: 400, body: { error: 'unknown_action' } })
  })
  it('a dep throws → 500 generic, no raw text', async () => {
    const d = deps({ loadToken: vi.fn(async () => { throw new Error('relation "x" does not exist') }) })
    expect(await handleRepairWorkorder(view, d, NOW)).toEqual({ status: 500, body: { error: 'failed' } })
  })
})
