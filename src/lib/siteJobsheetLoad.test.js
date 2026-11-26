// @vitest-environment jsdom
// (jsdom: storageSigner comes from repairWorkorderLoad.js -> photoUpload.js -> supabase client, which needs WebSocket)
import { describe, it, expect, vi } from 'vitest'
import { loadJobSheetInput, decodeSettingText } from '../../supabase/functions/_shared/site-jobsheet-load.ts'
import { loadJobSheet, pmSiteFallback, pmWorkerNames } from './siteJobsheetLoad.js'

// Fake supabase-js client: each table returns a canned { data, error } (or a function of the recorded
// call); every call is recorded with its filters.
function fakeDb(tables) {
  const calls = []
  const db = {
    from(table) {
      const call = { table, select: null, eqs: [], is: [], gte: [], lte: [], order: null }
      calls.push(call)
      const result = () => {
        const r = tables[table]
        return typeof r === 'function' ? r(call) : (r || { data: [], error: null })
      }
      const c = {
        select: (s) => { call.select = s; return c },
        eq: (k, v) => { call.eqs.push([k, v]); return c },
        is: (k, v) => { call.is.push([k, v]); return c },
        gte: (k, v) => { call.gte.push([k, v]); return c },
        lte: (k, v) => { call.lte.push([k, v]); return c },
        order: (k, o) => { call.order = [k, o]; return c },
        maybeSingle: () => Promise.resolve(result()),
        then: (res, rej) => Promise.resolve(result()).then(res, rej),
      }
      return c
    },
  }
  return { db, calls }
}

const DATE = '2026-11-26'
const SITE = {
  id: 's1', tenant_id: 'tn1', name: 'บ้านคุณสมชาย', site_number: 'S-012', location: '12 ถ.สุขุมวิท',
  map_url: 'https://maps.app/x', lat: 13.7, lng: 100.5, safety_note: null,
}
const W = (name, nickname = null) => ({ name, nickname })
const TODAY_ROWS = [
  { worker_id: 'w2', shift: 'morning', is_team_leader: false, workers: W('บุญมี') },
  { worker_id: 'w1', shift: 'morning', is_team_leader: false, workers: W('สมศักดิ์', 'ศักดิ์') },
  { worker_id: 'w1', shift: 'evening', is_team_leader: true, workers: W('สมศักดิ์', 'ศักดิ์') },
  { worker_id: 'w2', shift: 'morning', is_team_leader: false, workers: W('บุญมี') },
]
const isTodayCall = (call) => call.eqs.some(([k]) => k === 'date')

function tables(over = {}) {
  const runRows = over.runRows ?? {
    // w1: Mon 23, Tue 24 here; Wed 25 at another site; Thu 26 (today) + Fri 27 here
    w1: [
      { date: '2026-11-23', site_id: 's1' }, { date: '2026-11-24', site_id: 's1' },
      { date: '2026-11-25', site_id: 's2' },
      { date: '2026-11-26', site_id: 's1' }, { date: '2026-11-26', site_id: 's1' }, { date: '2026-11-27', site_id: 's1' },
    ],
    w2: [{ date: '2026-11-24', site_id: 's1' }, { date: '2026-11-25', site_id: 's1' }, { date: '2026-11-26', site_id: 's1' }],
  }
  return {
    sites: { data: SITE, error: null },
    app_settings: { data: { value: 'ใส่หมวกนิรภัย' }, error: null },
    worker_assignments: (call) => {
      if (isTodayCall(call)) return { data: over.todayRows ?? TODAY_ROWS, error: null }
      const w = call.eqs.find(([k]) => k === 'worker_id')?.[1]
      return { data: runRows[w] || [], error: null }
    },
    site_phases: { data: [
      { id: 'p1', name: 'ติดตั้งกรอบ', sort_order: 1, is_issue_phase: false },
      { id: 'p9', name: 'ปัญหา', sort_order: 9, is_issue_phase: null },
    ], error: null },
    phase_tasks: { data: [
      { id: 'k1', phase_id: 'p1', name: 'กรอบชั้น 1', zone: 'A', status: 'in_progress', sort_order: 1, progress_mode: 'quantity',
        planned_qty: 10, done_qty: 4, issue_report_id: null, parent_task_id: null, updated_at: null,
        boq_items: { unit: 'ชุด' }, phase_task_workers: [{ worker_id: 'w1' }, { worker_id: 'w2' }] },
      { id: 'k2', phase_id: 'p1', name: 'บานย่อย', zone: 'A', status: 'not_started', sort_order: 2, progress_mode: 'status',
        planned_qty: null, done_qty: 0, issue_report_id: null, parent_task_id: 'k1', updated_at: null,
        boq_items: null, phase_task_workers: [] },
    ], error: null },
    site_drawings: { data: [
      { id: 'd1', title: 'แปลนชั้น 1', file_path: 'tn1/s1/a.png', mime: 'image/png' },
      { id: 'd2', title: 'แปลนชั้น 2', file_path: 'tn1/s1/b.pdf', mime: 'application/pdf' },
    ], error: null },
    ...over.tables,
  }
}

const signUrls = vi.fn(async (bucket, paths) => paths.map((p) => `https://signed/${bucket}/${p}`))
const TENANT = { company_name: 'สร้างดี', address: 'กทม.', phone: '02', logo_url: null }
const opts = (o = {}) => ({ date: DATE, tenant: TENANT, signUrls, ...o })

describe('loadJobSheetInput', () => {
  it('filters every query after the site by the site tenant (service-role safe)', async () => {
    const { db, calls } = fakeDb(tables())
    await loadJobSheetInput(db, 's1', opts())
    expect(calls[0].table).toBe('sites')
    expect(calls[0].eqs).toEqual([['id', 's1']])
    expect(calls.length).toBeGreaterThan(6)
    for (const c of calls.slice(1)) expect(c.eqs).toContainEqual(['tenant_id', 'tn1'])
    const settings = calls.find((c) => c.table === 'app_settings')
    expect(settings.eqs).toContainEqual(['key', 'site_safety_note_default'])
    for (const t of ['site_phases', 'phase_tasks', 'site_drawings']) {
      expect(calls.find((c) => c.table === t).eqs).toContainEqual(['site_id', 's1'])
    }
    const tasks = calls.find((c) => c.table === 'phase_tasks')
    expect(tasks.select).toContain('boq_items(unit)')
    expect(tasks.select).toContain('phase_task_workers(worker_id)')
    expect(calls.find((c) => c.table === 'site_drawings').order).toEqual(['sort_order', { ascending: true }])
  })

  it('crew: install rows only, one entry per worker, shifts merged, leader if any row marked', async () => {
    const { db, calls } = fakeDb(tables())
    const input = await loadJobSheetInput(db, 's1', opts())
    const today = calls.find((c) => c.table === 'worker_assignments' && isTodayCall(c))
    expect(today.eqs).toEqual(expect.arrayContaining([['site_id', 's1'], ['date', DATE], ['type', 'site']]))
    expect(today.is).toEqual([['repair_ticket_id', null]])
    expect(input.crew).toEqual([
      { worker_id: 'w2', name: 'บุญมี', nickname: null, shifts: ['morning'], is_team_leader: false },
      { worker_id: 'w1', name: 'สมศักดิ์', nickname: 'ศักดิ์', shifts: ['morning', 'evening'], is_team_leader: true },
    ])
  })

  it('run (staff): the leader, ±21 days, a day at another site starts a new run', async () => {
    const { db, calls } = fakeDb(tables())
    const input = await loadJobSheetInput(db, 's1', opts())
    const runCall = calls.find((c) => c.table === 'worker_assignments' && !isTodayCall(c))
    expect(runCall.eqs).toEqual(expect.arrayContaining([['worker_id', 'w1'], ['type', 'site'], ['tenant_id', 'tn1']]))
    expect(runCall.eqs.some(([k]) => k === 'site_id')).toBe(false) // all sites, to see the breaks
    expect(runCall.is).toEqual([['repair_ticket_id', null]])
    expect(runCall.gte).toEqual([['date', '2026-11-05']])
    expect(runCall.lte).toEqual([['date', '2026-12-17']])
    // 23, 24 | 25 elsewhere | 26, 27 -> today is day 1 of 2
    expect(input.run).toEqual({ index: 1, total: 2, from: '2026-11-26', to: '2026-11-27' })
    expect(input.viewerWorkerId).toBeNull()
  })

  it('run (crew page): viewerWorkerId is used and passed through', async () => {
    const { db, calls } = fakeDb(tables())
    const input = await loadJobSheetInput(db, 's1', opts({ viewerWorkerId: 'w2' }))
    const runCall = calls.find((c) => c.table === 'worker_assignments' && !isTodayCall(c))
    expect(runCall.eqs).toContainEqual(['worker_id', 'w2'])
    expect(input.run).toEqual({ index: 3, total: 3, from: '2026-11-24', to: '2026-11-26' })
    expect(input.viewerWorkerId).toBe('w2')
  })

  it('run: a half day elsewhere today does not hide today; no leader -> first crew member; no crew -> null', async () => {
    const both = { w2: [{ date: DATE, site_id: 's1' }, { date: DATE, site_id: 's2' }, { date: '2026-11-25', site_id: 's1' }] }
    const noLeader = TODAY_ROWS.map((r) => ({ ...r, is_team_leader: false }))
    const { db, calls } = fakeDb(tables({ todayRows: noLeader, runRows: both }))
    const input = await loadJobSheetInput(db, 's1', opts())
    expect(calls.find((c) => c.table === 'worker_assignments' && !isTodayCall(c)).eqs).toContainEqual(['worker_id', 'w2'])
    expect(input.run).toEqual({ index: 2, total: 2, from: '2026-11-25', to: DATE })

    const empty = fakeDb(tables({ todayRows: [] }))
    const none = await loadJobSheetInput(empty.db, 's1', opts())
    expect(none.crew).toEqual([])
    expect(none.run).toBeNull()
    expect(empty.calls.filter((c) => c.table === 'worker_assignments')).toHaveLength(1)
  })

  it('cards: unit from the BOQ line, has_children from the same rows, worker ids; phases + site mapped', async () => {
    const { db } = fakeDb(tables())
    const input = await loadJobSheetInput(db, 's1', opts())
    expect(input.cards[0]).toMatchObject({ id: 'k1', unit: 'ชุด', has_children: true, worker_ids: ['w1', 'w2'], planned_qty: 10, done_qty: 4 })
    expect(input.cards[1]).toMatchObject({ id: 'k2', unit: null, has_children: false, worker_ids: [] })
    expect(input.phases[1]).toEqual({ id: 'p9', name: 'ปัญหา', sort_order: 9, is_issue_phase: false })
    expect(input.site).toEqual({
      id: 's1', name: 'บ้านคุณสมชาย', site_number: 'S-012', location: '12 ถ.สุขุมวิท', map_url: 'https://maps.app/x',
      lat: 13.7, lng: 100.5, safety_note: null,
    })
    expect(input.tenant).toEqual(TENANT)
    expect(input.date).toBe(DATE)
    expect(input.tenantSafetyDefault).toBe('ใส่หมวกนิรภัย')
  })

  it('drawings are signed in the site-drawings bucket, in order', async () => {
    signUrls.mockClear()
    const { db, calls } = fakeDb(tables())
    const input = await loadJobSheetInput(db, 's1', opts())
    expect(signUrls).toHaveBeenCalledWith('site-drawings', ['tn1/s1/a.png', 'tn1/s1/b.pdf'])
    expect(input.drawings).toEqual([
      { id: 'd1', title: 'แปลนชั้น 1', url: 'https://signed/site-drawings/tn1/s1/a.png', mime: 'image/png' },
      { id: 'd2', title: 'แปลนชั้น 2', url: 'https://signed/site-drawings/tn1/s1/b.pdf', mime: 'application/pdf' },
    ])
    const fn = vi.fn(async () => [])
    const none = await loadJobSheetInput(fakeDb(tables({ tables: { site_drawings: { data: [], error: null } } })).db, 's1', opts({ signUrls: fn }))
    expect(none.drawings).toEqual([])
    expect(calls.find((c) => c.table === 'site_drawings').select).toContain('mime')
    expect(fn).not.toHaveBeenCalled()
  })

  it('tenant default safety note: plain or JSON-encoded text; missing -> null', async () => {
    expect(decodeSettingText('"ระวังที่สูง"')).toBe('ระวังที่สูง')
    expect(decodeSettingText('ระวังที่สูง')).toBe('ระวังที่สูง')
    expect(decodeSettingText('"broken')).toBe('"broken')
    expect(decodeSettingText(undefined)).toBeNull()
    const { db } = fakeDb(tables({ tables: { app_settings: { data: null, error: null } } }))
    expect((await loadJobSheetInput(db, 's1', opts())).tenantSafetyDefault).toBeNull()
  })

  it('throws โหลดใบงานไม่สำเร็จ on a query error or a missing site', async () => {
    await expect(loadJobSheetInput(fakeDb(tables({ tables: { sites: { data: null, error: null } } })).db, 's1', opts()))
      .rejects.toThrow('โหลดใบงานไม่สำเร็จ: ไม่พบไซต์นี้')
    await expect(loadJobSheetInput(fakeDb(tables({ tables: { phase_tasks: { data: null, error: { message: 'boom' } } } })).db, 's1', opts()))
      .rejects.toThrow('โหลดใบงานไม่สำเร็จ: boom')
    await expect(loadJobSheetInput(fakeDb(tables({ tables: { worker_assignments: { data: null, error: { message: 'rls' } } } })).db, 's1', opts()))
      .rejects.toThrow('โหลดใบงานไม่สำเร็จ: rls')
  })
})

describe('loadJobSheet (web wrapper)', () => {
  it('signs through supabase.storage (30 min) and returns the built JobSheet', async () => {
    const { db } = fakeDb(tables())
    const createSignedUrls = vi.fn(async (paths) => ({ data: paths.map((p) => ({ path: p, signedUrl: `u:${p}` })), error: null }))
    db.storage = { from: vi.fn(() => ({ createSignedUrls })) }
    const sheet = await loadJobSheet(db, 's1', { ...TENANT, id: 'tn1', tax_id: 'x' }, DATE)
    expect(db.storage.from).toHaveBeenCalledWith('site-drawings')
    expect(createSignedUrls).toHaveBeenCalledWith(['tn1/s1/a.png', 'tn1/s1/b.pdf'], 1800)
    expect(sheet.company).toEqual({ name: 'สร้างดี', address: 'กทม.', phone: '02', logoUrl: null })
    expect(sheet.siteName).toBe('บ้านคุณสมชาย')
    expect(sheet.safetyNote).toBe('ใส่หมวกนิรภัย')
    expect(sheet.runText).toMatch(/^วันที่ 1 จาก 2/)
    expect(sheet.viewerIsLeader).toBe(false)
    expect(sheet.drawings[0].url).toBe('u:tn1/s1/a.png')
    expect(sheet.drawings.map((d) => d.mime)).toEqual(['image/png', 'application/pdf'])
  })

  // PM: RLS hides sites + workers (OWNER/ADMIN only) and site_drawings; pm_sites()/pm_workers() fill in.
  function pmDb(rpcData, rpcError = null) {
    const blankCrew = TODAY_ROWS.map((r) => ({ ...r, workers: null }))
    const { db, calls } = fakeDb(tables({ todayRows: blankCrew, tables: { sites: { data: null, error: null }, site_drawings: { data: [], error: null } } }))
    const rpcCalls = []
    db.rpc = (fn) => {
      const call = { fn, filters: [] }
      rpcCalls.push(call)
      const out = () => (rpcError ? { data: null, error: rpcError } : { data: rpcData[fn] ?? null, error: null })
      const b = {
        eq: (k, v) => { call.filters.push(['eq', k, v]); return b },
        in: (k, v) => { call.filters.push(['in', k, v]); return b },
        maybeSingle: () => Promise.resolve(out()),
        then: (res, rej) => Promise.resolve(out()).then(res, rej),
      }
      return b
    }
    db.storage = { from: vi.fn(() => ({ createSignedUrls: vi.fn() })) }
    return { db, calls, rpcCalls }
  }
  const { tenant_id: _omit, ...PM_SITE_ROW } = { ...SITE, safety_note: 'ระวังสายไฟ', client_name: 'x' }

  it('PM: site from pm_sites() (tenant from the logged-in tenant), crew names from pm_workers(), no drawings', async () => {
    const { db, calls, rpcCalls } = pmDb({
      pm_sites: PM_SITE_ROW,
      pm_workers: [{ id: 'w1', name: 'สมศักดิ์', nickname: 'ศักดิ์' }, { id: 'w2', name: 'บุญมี', nickname: null }],
    })
    const sheet = await loadJobSheet(db, 's1', { ...TENANT, id: 'tn1' }, DATE)
    expect(rpcCalls[0]).toEqual({ fn: 'pm_sites', filters: [['eq', 'id', 's1']] })
    expect(rpcCalls[1].fn).toBe('pm_workers')
    expect(rpcCalls[1].filters[0][0]).toBe('in')
    expect([...rpcCalls[1].filters[0][2]].sort()).toEqual(['w1', 'w2'])
    // every later query still filtered by the tenant
    for (const c of calls.filter((c) => c.table !== 'sites')) expect(c.eqs).toContainEqual(['tenant_id', 'tn1'])
    expect(sheet.siteName).toBe('บ้านคุณสมชาย')
    expect(sheet.safetyNote).toBe('ระวังสายไฟ')
    expect(sheet.leaderText).toContain('ศักดิ์')
    expect(sheet.crewText).toContain('บุญมี')
    expect(sheet.drawings).toEqual([])
  })

  it('PM fallback: no tenant id or an RPC error -> ไม่พบไซต์นี้ / names left blank', async () => {
    await expect(loadJobSheet(pmDb({ pm_sites: PM_SITE_ROW }).db, 's1', { ...TENANT }, DATE))
      .rejects.toThrow('โหลดใบงานไม่สำเร็จ: ไม่พบไซต์นี้')
    await expect(loadJobSheet(pmDb({}, { message: 'x' }).db, 's1', { ...TENANT, id: 'tn1' }, DATE))
      .rejects.toThrow('โหลดใบงานไม่สำเร็จ: ไม่พบไซต์นี้')
    expect(await pmWorkerNames(pmDb({}, { message: 'x' }).db)(['w1'])).toEqual({})
    expect(await pmSiteFallback(pmDb({ pm_sites: PM_SITE_ROW }).db, 'tn1')('s1')).toEqual({ ...PM_SITE_ROW, tenant_id: 'tn1' })
  })

  it('admin: the direct reads win, no RPC is called', async () => {
    const { db } = fakeDb(tables())
    db.rpc = vi.fn()
    db.storage = { from: vi.fn(() => ({ createSignedUrls: async (p) => ({ data: p.map((x) => ({ path: x, signedUrl: x })), error: null }) })) }
    await loadJobSheet(db, 's1', { ...TENANT, id: 'tn1' }, DATE)
    expect(db.rpc).not.toHaveBeenCalled()
  })
})
