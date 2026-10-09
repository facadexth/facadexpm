// Render smoke test for the compare tab (server-side render: no effects/clicks).
import { describe, it, expect, vi } from 'vitest'
import { renderToString } from 'react-dom/server'

const insert = vi.fn()
const from = vi.fn(() => ({ insert, update: insert, upsert: insert, delete: insert }))
vi.mock('../../lib/supabase.js', () => ({ supabase: { from }, fmt: n => (n == null || isNaN(n) ? '—' : Number(n).toFixed(2)) }))
vi.mock('../../hooks/useTenant.js', () => ({ useTenant: () => ({ hasModuleAccess: () => true }) }))
vi.mock('../../hooks/useUserRole.js', () => ({ useUserRole: () => ({ isAtLeast: () => true, role: 'ADMIN' }) }))
const stored = { id: 's1', kind: 'agreed', quotation_id: 'q1', revision: 1, sub_no: 2, created_at: '2026-10-09T03:00:00Z',
  items: [{ openingId: 'a', name: 'W-01', quantity: 2, offeredPrice: 12000, agreedUnit: 11500, discountShare: 250, agreedNet: 11250, diff: -750, diffPct: -6.25, costBase: 10000, setProfitPct: 25, realProfitPct: 14.1, profitDiffPts: -10.9 }],
  totals: { offeredTotal: 24000, agreedTotal: 22500, reductionPct: 6.25, setProfitPct: 25, realProfitPct: 14.1, extras: { removed: [{ openingId: 'z', name: 'W-09' }], added: [] } } }
vi.mock('../../hooks/usePriceStructure.js', () => ({ usePriceStructure: () => ({ link: { quotation_id: 'q1' }, lines: [], snapshots: [stored], loading: false, refetch() {} }) }))
const { default: CompareTab, CompareView, CONFIRM_SENT_TEXT, runCompare } = await import('./CompareTab.jsx')
const clean = h => h.replace(/<!-- -->/g, '')

describe('CompareTab', () => {
  it('shows the stored comparison with mockup headers and never writes on render', () => {
    const h = clean(renderToString(<CompareTab project={{ id: 'p1' }} canEdit />))
    for (const t of ['รายการ', 'จำนวน', 'เสนอ', 'ตกลง (ต่อชุด)', 'ส่วนลดท้ายบิล (กระจาย)', 'ตกลงจริง', 'ต่าง บาท', 'ต่าง %', 'ต้นทุนฐาน', 'กำไรที่ตั้ง', 'กำไรจริง', 'เทียบที่ตั้ง']) expect(h).toContain(`>${t}<`)
    expect(h).toContain('W-01'); expect(h).toContain('R1-2'); expect(h).toContain('ยอดที่เสนอ'); expect(h).toContain('W-09')
    expect(h).not.toMatch(/NaN|undefined/)
    expect(insert).not.toHaveBeenCalled(); expect(from).not.toHaveBeenCalled()
  })
  it('button is disabled for a draft quotation', () => {
    const h = clean(renderToString(<CompareView quotation={{ status: 'draft' }} shown={null} history={[]} canPull />))
    expect(h).toMatch(/<button[^>]*disabled=""[^>]*>ดึงราคาที่ตกลงกลับมาเทียบ/)
    expect(h).toContain('ยังไม่เคยดึงราคาที่ตกลง')
  })
  it('enabled for accepted, and shows the inline confirm text for sent', () => {
    const a = clean(renderToString(<CompareView quotation={{ status: 'accepted' }} shown={null} history={[]} canPull />))
    expect(a).not.toMatch(/<button[^>]*disabled=""[^>]*>ดึงราคาที่ตกลงกลับมาเทียบ/)
    const s = clean(renderToString(<CompareView quotation={{ status: 'sent' }} shown={null} history={[]} canPull confirming />))
    expect(s).toContain(CONFIRM_SENT_TEXT)
  })

  it('shows opening_no with the item name, the third-card hint and "0" for an exact zero difference', () => {
    const z = { ...stored, items: [{ ...stored.items[0], diff: 0, diffPct: 0 }] }
    const shown = { rows: z.items, extras: { removed: [], added: [] }, summary: z.totals }
    const h = clean(renderToString(<CompareView quotation={{ status: 'accepted' }} shown={shown} history={[]} canPull itemsById={{ a: { item_name: 'หน้าต่างบานเลื่อน 2 บาน' } }} />))
    expect(h).toContain('หน้าต่างบานเลื่อน 2 บาน'); expect(h).toContain('กำไรจริงคิดทับรวมต้นทุนของทุกรายการ'); expect(h).toContain('>0<')
  })
})

describe('runCompare (the only write path)', () => {
  const sent = { kind: 'sent', quotation_id: 'q1', revision: 1, sub_no: 1, price_as_of: '2026-10-01', factors: {}, items: [{ opening_id: 'a', opening_no: 'W-01', v: 8000, w: 500, z: 500, pm: 1000, price: 12000, quantity: 1, profitPct: 25 }] }
  function fakeClient() {
    const writes = [], reads = []
    const chain = (table, data) => {
      const c = { select: () => c, eq: () => c, maybeSingle: () => Promise.resolve({ data: data[0] || null, error: null }), then: (res, rej) => Promise.resolve({ data, error: null }).then(res, rej) }
      return c
    }
    return { writes, reads, from(table) {
      reads.push(table)
      const rows = table === 'quotations' ? [{ id: 'q1', status: 'accepted', revision: 1 }] : [{ id: 'r-a', item_type: 'item', unit_price: 11000, quantity: 1, line_total: 11000 }]
      const c = chain(table, rows)
      c.insert = row => { writes.push({ table, row }); return Promise.resolve({ error: null }) }
      c.update = c.delete = c.upsert = () => { writes.push({ table, op: 'other' }); return Promise.resolve({ error: null }) }
      return c
    } }
  }
  it('does exactly one insert, on estimation_price_snapshots, kind agreed', async () => {
    const client = fakeClient()
    const out = await runCompare({ client, project: { id: 'p1' }, quotationId: 'q1', snapshots: [sent], lines: [{ opening_id: 'a', item_row_id: 'r-a' }] })
    expect(client.writes).toHaveLength(1)
    expect(client.writes[0].table).toBe('estimation_price_snapshots')
    expect(client.writes[0].row).toMatchObject({ kind: 'agreed', revision: 1, sub_no: 1, quotation_id: 'q1', project_id: 'p1' })
    expect(out.label).toBe('R1-1')
  })
  it('writes nothing when there is no sent snapshot or the quotation is gone', async () => {
    const c1 = fakeClient()
    await expect(runCompare({ client: c1, project: { id: 'p1' }, quotationId: 'q1', snapshots: [], lines: [] })).rejects.toThrow()
    expect(c1.writes).toHaveLength(0)
  })
  it('initial render does not touch the client at all', () => {
    const client = fakeClient()
    renderToString(<CompareTab project={{ id: 'p1' }} canEdit client={client} />)
    expect(client.reads).toHaveLength(0); expect(client.writes).toHaveLength(0)
  })
})
