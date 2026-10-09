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
const { default: CompareTab, CompareView, CONFIRM_SENT_TEXT } = await import('./CompareTab.jsx')
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
})
