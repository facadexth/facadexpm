// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { loadWorkOrderInput } from '../../supabase/functions/_shared/repair-workorder-load.ts'
import { loadWorkOrder, storageSigner, waitForSheetImages } from './repairWorkorderLoad.js'

// Fake supabase-js client: each table returns a canned { data, error }; every call is recorded.
function fakeDb(tables) {
  const calls = []
  const db = {
    from(table) {
      const call = { table, select: null, eqs: [], order: null, limit: null }
      calls.push(call)
      const result = () => {
        const r = tables[table]
        return typeof r === 'function' ? r(call) : (r || { data: [], error: null })
      }
      const c = {
        select: (s) => { call.select = s; return c },
        eq: (k, v) => { call.eqs.push([k, v]); return c },
        order: (k, o) => { call.order = [k, o]; return c },
        limit: (n) => { call.limit = n; return c },
        maybeSingle: () => Promise.resolve(result()),
        then: (res, rej) => Promise.resolve(result()).then(res, rej),
      }
      return c
    },
  }
  return { db, calls }
}

const TICKET = {
  id: 't1', tenant_id: 'tn1', ticket_number: 'RP2611-007', created_at: '2026-11-24T03:00:00Z', source: 'line',
  description: 'x', scheduled_date: '2026-11-27', scheduled_start: '09:00:00', duration_hours: 2,
  preferred_days: ['2026-11-27'], preferred_slot: 'day',
  sites: { name: 'บ้านคุณสมชาย', location: '12 ถ.สุขุมวิท', map_url: 'https://maps.app/x', lat: null, lng: null, handover_date: '2026-06-01', warranty_months: 12 },
  clients: { name: 'สมชาย ใจดี', phone: '0812345678' },
}

function tables(over = {}) {
  return {
    repair_tickets: { data: TICKET, error: null },
    repair_ticket_items: { data: [
      { id: 'i1', seq: 1, location: 'ห้องนอน', room: 'ชั้น 2', symptom: 'รั่วซึม', note: 'มุมขวา' },
      { id: 'i2', seq: 2, location: 'ห้องครัว', room: null, symptom: 'ล็อกไม่ได้', note: null },
    ], error: null },
    repair_ticket_media: { data: [
      { id: 'm1', item_id: 'i1', role: 'customer', media_type: 'image', storage_path: 'tn1/t1/a.jpg' },
      { id: 'm2', item_id: 'i1', role: 'customer', media_type: 'video', storage_path: 'tn1/t1/b.mp4' },
      { id: 'm3', item_id: 'i2', role: 'customer', media_type: 'file', storage_path: 'tn1/t1/c.pdf' },
      { id: 'm4', item_id: 'i2', role: 'customer', media_type: 'image', storage_path: 'tn1/t1/d.jpg' },
    ], error: null },
    worker_assignments: { data: [
      { worker_id: 'w1', is_team_leader: false, workers: { name: 'สมศักดิ์', nickname: 'ศักดิ์' } },
      { worker_id: 'w2', is_team_leader: false, workers: { name: 'บุญมี', nickname: null } },
      { worker_id: 'w1', is_team_leader: true, workers: { name: 'สมศักดิ์', nickname: 'ศักดิ์' } },
    ], error: null },
    document_receipts: { data: [{ signer_name: 'สมชาย', signed_at: '2026-11-27T05:30:00Z', signature_path: 'tn1/repair_ticket/t1/1.png' }], error: null },
    ...over,
  }
}

const signUrls = vi.fn(async (bucket, paths) => paths.map((p) => `https://signed/${bucket}/${p}`))
const TENANT = { company_name: 'สร้างดี', address: 'กทม.', phone: '02', logo_url: null }
const opts = { today: '2026-11-25', signUrls, tenant: TENANT }

describe('loadWorkOrderInput', () => {
  it('maps the rows into a WorkOrderInput (site, client, items, signed media, crew, receipt)', async () => {
    signUrls.mockClear()
    const { db } = fakeDb(tables())
    const input = await loadWorkOrderInput(db, 't1', opts)
    expect(input.tenant).toEqual(TENANT)
    expect(input.today).toBe('2026-11-25')
    expect(input.ticket).toMatchObject({ ticket_number: 'RP2611-007', source: 'line', scheduled_date: '2026-11-27', preferred_slot: 'day' })
    expect(input.site).toEqual(TICKET.sites)
    expect(input.client).toEqual(TICKET.clients)
    expect(input.items).toHaveLength(2)
    // file rows are dropped; only images are signed, videos keep url null
    expect(input.media).toEqual([
      { id: 'm1', item_id: 'i1', role: 'customer', media_type: 'image', url: 'https://signed/repair-media/tn1/t1/a.jpg' },
      { id: 'm2', item_id: 'i1', role: 'customer', media_type: 'video', url: null },
      { id: 'm4', item_id: 'i2', role: 'customer', media_type: 'image', url: 'https://signed/repair-media/tn1/t1/d.jpg' },
    ])
    expect(signUrls).toHaveBeenCalledWith('repair-media', ['tn1/t1/a.jpg', 'tn1/t1/d.jpg'])
    // one entry per worker; leader if any shift row is marked; nickname filled
    expect(input.crew).toEqual([
      { name: 'สมศักดิ์', nickname: 'ศักดิ์', is_team_leader: true },
      { name: 'บุญมี', nickname: null, is_team_leader: false },
    ])
    expect(input.receipt).toEqual({
      signer_name: 'สมชาย', signed_at: '2026-11-27T05:30:00Z',
      signature_url: 'https://signed/document-receipts/tn1/repair_ticket/t1/1.png',
    })
  })

  it('filters every query after the ticket by the ticket tenant (service-role safe)', async () => {
    const { db, calls } = fakeDb(tables())
    await loadWorkOrderInput(db, 't1', opts)
    const byTable = Object.fromEntries(calls.map((c) => [c.table, c]))
    expect(byTable.repair_tickets.eqs).toEqual([['id', 't1']])
    for (const t of ['repair_ticket_items', 'repair_ticket_media', 'worker_assignments', 'document_receipts']) {
      expect(byTable[t].eqs).toContainEqual(['tenant_id', 'tn1'])
    }
    expect(byTable.repair_ticket_media.eqs).toContainEqual(['role', 'customer'])
    expect(byTable.worker_assignments.eqs).toEqual(expect.arrayContaining([['repair_ticket_id', 't1'], ['date', '2026-11-27']]))
    expect(byTable.worker_assignments.select).toContain('is_team_leader')
    expect(byTable.worker_assignments.select).toContain('workers(name, nickname)')
    expect(byTable.document_receipts.eqs).toEqual(expect.arrayContaining([['document_type', 'repair_ticket'], ['document_id', 't1']]))
    expect(byTable.document_receipts.order).toEqual(['signed_at', { ascending: false }])
    expect(byTable.document_receipts.limit).toBe(1)
    expect(byTable.repair_tickets.select).toContain('sites(name, location, map_url, lat, lng, handover_date, warranty_months)')
    expect(byTable.repair_tickets.select).toContain('clients(name, phone)')
  })

  it('no appointment -> no crew query, empty crew; no receipt -> null; no media -> no signing', async () => {
    const fn = vi.fn(async () => [])
    const { db, calls } = fakeDb(tables({
      repair_tickets: { data: { ...TICKET, scheduled_date: null }, error: null },
      repair_ticket_media: { data: [], error: null },
      document_receipts: { data: [], error: null },
    }))
    const input = await loadWorkOrderInput(db, 't1', { ...opts, signUrls: fn })
    expect(calls.some((c) => c.table === 'worker_assignments')).toBe(false)
    expect(input.crew).toEqual([])
    expect(input.receipt).toBeNull()
    expect(input.media).toEqual([])
    expect(fn).not.toHaveBeenCalled()
  })

  it('throws โหลดใบงานซ่อมไม่สำเร็จ on a query error or a missing ticket', async () => {
    await expect(loadWorkOrderInput(fakeDb(tables({ repair_ticket_items: { data: null, error: { message: 'boom' } } })).db, 't1', opts))
      .rejects.toThrow('โหลดใบงานซ่อมไม่สำเร็จ: boom')
    await expect(loadWorkOrderInput(fakeDb(tables({ repair_tickets: { data: null, error: null } })).db, 't1', opts))
      .rejects.toThrow('โหลดใบงานซ่อมไม่สำเร็จ: ไม่พบงานซ่อมนี้')
    await expect(loadWorkOrderInput(fakeDb(tables({ document_receipts: { data: null, error: { message: 'rls' } } })).db, 't1', opts))
      .rejects.toThrow('โหลดใบงานซ่อมไม่สำเร็จ: rls')
  })
})

describe('loadWorkOrder (web wrapper)', () => {
  it('signs through supabase.storage and returns the built WorkOrder', async () => {
    const { db } = fakeDb(tables())
    const createSignedUrls = vi.fn(async (paths) => ({ data: paths.map((p) => ({ path: p, signedUrl: `u:${p}` })), error: null }))
    db.storage = { from: vi.fn(() => ({ createSignedUrls })) }
    const wo = await loadWorkOrder(db, 't1', { ...TENANT, id: 'tn1', tax_id: 'x' })
    expect(wo.number).toBe('RP2611-007')
    expect(wo.company).toEqual({ name: 'สร้างดี', address: 'กทม.', phone: '02', logoUrl: null })
    expect(wo.crewText).toBe('สมศักดิ์ (ศักดิ์) (หัวหน้าทีม), บุญมี')
    expect(wo.rows[0].photos).toEqual([{ url: 'u:tn1/t1/a.jpg', video: false }, { url: null, video: true }])
    expect(wo.receipt.signature_url).toBe('u:tn1/repair_ticket/t1/1.png')
    expect(db.storage.from).toHaveBeenCalledWith('repair-media')
    expect(db.storage.from).toHaveBeenCalledWith('document-receipts')
  })

  it('storageSigner degrades to nulls when signing fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sb = { storage: { from: () => ({ createSignedUrls: async () => ({ data: null, error: { message: 'down' } }) }) } }
    expect(await storageSigner(sb)('repair-media', ['a', 'b'])).toEqual([null, null])
    warn.mockRestore()
  })
})

describe('waitForSheetImages', () => {
  const img = (complete, alt = '') => {
    const el = document.createElement('img')
    if (alt) el.alt = alt
    Object.defineProperty(el, 'complete', { configurable: true, get: () => complete.value })
    return el
  }

  it('waits for every image and for the QR when needed', async () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const photo = { value: false }
    root.appendChild(img(photo))
    let done = false
    const p = waitForSheetImages(root, { needQr: true, intervalMs: 5 }).then((v) => { done = v })
    await new Promise((r) => setTimeout(r, 20))
    expect(done).toBe(false)
    photo.value = true
    await new Promise((r) => setTimeout(r, 20))
    expect(done).toBe(false) // QR not drawn yet
    root.appendChild(img({ value: true }, 'แผนที่'))
    await p
    expect(done).toBe(true)
    root.remove()
  })

  it('resolves false after the timeout so the button never stays locked', async () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    root.appendChild(img({ value: false }))
    expect(await waitForSheetImages(root, { timeoutMs: 20, intervalMs: 5 })).toBe(false)
    root.remove()
  })
})
