import { describe, it, expect, vi, beforeEach } from 'vitest'

const tables = {}
const log = []
let insertCount = 0
vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: (t) => {
      const q = { _filters: [] }
      ;['select', 'in', 'order', 'not', 'is'].forEach((m) => { q[m] = (...a) => { if (m === 'in') q._filters.push(a); return q } })
      q.eq = (...a) => { q._filters.push(a); if (q._op) log.push([t, q._op, q._payload, ...a]); return q }
      q.delete = () => { q._op = 'delete'; return q }
      q.update = (p) => { q._op = 'update'; q._payload = p; return q }
      q.insert = (p) => { log.push([t, 'insert', p]); q._op = 'insert'; q._payload = p; return q }
      q.single = async () => ({ data: q._op === 'insert' ? { id: `new${++insertCount}`, ...q._payload } : { id: 'r1', ...q._payload }, error: null })
      q.then = (res, rej) => Promise.resolve({ data: null, error: null }).then(res, rej)
      q.range = async () => {
        let rows = tables[t] || []
        for (const [col, v] of q._filters) rows = rows.filter(r => Array.isArray(v) ? v.includes(r[col]) : r[col] === v)
        return { data: rows, error: null }
      }
      return q
    },
    storage: { from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ error: null }) }) },
  },
}))
vi.mock('./useProgressBillingData.js', () => ({
  fetchProgressBillingData: async () => ({ boqByQuotationItem: {}, splitsByBoq: {}, phases: [], cards: [], phaseDraws: [] }),
}))
const spy = vi.fn(() => ({ rows: [], totals: {} }))
vi.mock('../lib/deliveryReport.js', () => ({ buildReportRows: (...a) => spy(...a) }))

import { fetchDeliveryReport, saveDeliveryReport, reissueDeliveryReport } from './useDeliveryReport.js'

beforeEach(() => { log.length = 0; spy.mockClear() })

describe('useDeliveryReport', () => {
  it('earlier invoices are filtered to same quotation, non-void, before this one', async () => {
    Object.assign(tables, {
      invoices: [
        { id: 'cur', invoice_number: 'IN2609-002', invoice_date: '2026-09-10', quotation_id: 'q1', site_id: 's1', status: 'sent' },
        { id: 'a', invoice_number: 'IN2609-001', invoice_date: '2026-09-10', quotation_id: 'q1', status: 'paid' },
        { id: 'b', invoice_number: 'IN2608-005', invoice_date: '2026-08-01', quotation_id: 'q1', status: 'sent' },
        { id: 'v', invoice_number: 'IN2607-001', invoice_date: '2026-07-01', quotation_id: 'q1', status: 'void' },
        { id: 'later', invoice_number: 'IN2609-003', invoice_date: '2026-09-10', quotation_id: 'q1', status: 'sent' },
        { id: 'other', invoice_number: 'IN2601-001', invoice_date: '2026-01-01', quotation_id: 'q2', status: 'paid' },
      ],
      invoice_items: [
        { id: 'i-cur', invoice_id: 'cur' }, { id: 'i-a', invoice_id: 'a' }, { id: 'i-b', invoice_id: 'b' },
        { id: 'i-v', invoice_id: 'v' }, { id: 'i-later', invoice_id: 'later' }, { id: 'i-other', invoice_id: 'other' },
      ],
      invoice_item_phases: [], quotations: [{ id: 'q1' }], quotation_items: [], phase_tasks: [],
      site_drawings: [], delivery_reports: [], line_site_photos: [],
    })
    const d = await fetchDeliveryReport('cur')
    const arg = spy.mock.calls[0][0]
    expect(arg.invoiceItems.map(i => i.id)).toEqual(['i-cur'])
    expect(arg.earlierItems.map(i => i.invoice_id)).toEqual(['b', 'a'])
    expect(d.current).toBeNull()
  })

  it('saveDeliveryReport replaces cards', async () => {
    await saveDeliveryReport({ reportId: 'r1', invoiceId: 'cur', siteId: 's1', phaseIds: ['p1'], note: 'n',
      cards: [{ taskId: 't1', cardTitle: 'กระจก', photoIds: ['ph1'], caption: 'c' }] })
    const cardOps = log.filter(l => l[0] === 'delivery_report_cards')
    expect(cardOps.map(l => l[1])).toEqual(['delete', 'insert'])
    expect(cardOps[0][3]).toBe('report_id')
    expect(cardOps[1][2]).toEqual([{ report_id: 'r1', task_id: 't1', card_title: 'กระจก', photo_ids: ['ph1'], caption: 'c', sort_order: 0 }])
  })

  it('reissue marks old replaced after inserting new', async () => {
    const r = await reissueDeliveryReport({ id: 'old', invoice_id: 'cur', site_id: 's1', status: 'signed' },
      { phaseIds: [], note: null, cards: [] })
    const ops = log.filter(l => l[0] === 'delivery_reports')
    expect(ops[0][1]).toBe('insert')
    expect(ops[0][2].replaces_id).toBe('old')
    expect(ops[ops.length - 1]).toEqual(['delivery_reports', 'update', { status: 'replaced' }, 'id', 'old'])
    expect(r.replaces_id).toBe('old')
  })
})
