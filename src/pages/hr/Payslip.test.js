import { describe, it, expect, vi } from 'vitest'

vi.mock('../../lib/supabase.js', () => ({ supabase: {}, fmt: n => String(n) }))
vi.mock('../../lib/pdf.js', () => ({ downloadPDF: () => {} }))
vi.mock('../../hooks/useTenant.js', () => ({ useTenant: () => ({ tenant: null }) }))
vi.mock('../../components/Modal.jsx', () => ({ Modal: () => null }))
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { maskAcct, PayslipSheetView } from './Payslip.jsx'

describe('maskAcct', () => {
  it('shows only the last 4 digits of a 10-digit account, grouped 3-1-5-1', () => {
    expect(maskAcct('1234567890')).toBe('xxx-x-xx789-0')
  })
  it('ignores existing separators', () => {
    expect(maskAcct('123-4-56789-0')).toBe('xxx-x-xx789-0')
  })
  it('groups other lengths by 4 and keeps only the last 4 digits', () => {
    expect(maskAcct('123456789012345')).toBe('xxxx-xxxx-xxx2-345'.replace('xxx2-345', 'xxx2-345'))
  })
  it('returns a dash for empty', () => {
    expect(maskAcct(null)).toBe('—')
    expect(maskAcct('')).toBe('—')
  })
})

describe('PayslipSheetView (pure, data by props)', () => {
  const record = {
    worker_id: 'w1', net_pay: 1000, paid_date: '2026-09-30', facts: { daysWorked: 26 },
    workers: { name: 'สมชาย', nickname: 'ชาย', employee_code: 'E01', position: 'ช่าง' },
    salary_record_lines: [{ id: 'l1', pay_item_id: 'p1', name: 'เงินเดือน', side: 'earning', sort_order: 1, amount: 1000 }],
  }
  const render = props => renderToStaticMarkup(createElement(PayslipSheetView, { record, year: 2026, month: 9, tenant: { company_name: 'บจก. ทดสอบ', tax_id: '123' }, ...props }))

  it('closed month has no draft watermark', () => {
    const html = render({ period: { status: 'closed', paid_date: '2026-09-30' } })
    expect(html).not.toContain('ร่าง')
    expect(html).toContain('บจก. ทดสอบ')
  })
  it('draft month shows the watermark', () => {
    expect(render({ period: { status: 'draft' } })).toContain('ร่าง')
  })
  it('adds the OT 0 row from otItem when the record has no OT line', () => {
    const html = render({ period: { status: 'closed' }, otItem: { id: 'ot1', name: 'ค่าล่วงเวลา', sort_order: 5 } })
    expect(html).toContain('ค่าล่วงเวลา')
  })
  it('renders year-to-date only when ytd is given', () => {
    expect(render({ period: { status: 'closed' } })).not.toContain('สะสมปี')
    expect(render({ period: { status: 'closed' }, ytd: { earnings: 5, sso: 1, contrib: 2 } })).toContain('สะสมปี 2569')
  })
  it('shows เงินสมทบสะสม only when contribBalance is a number, outside the earning/deduction tables', () => {
    expect(render({ period: { status: 'closed' } })).not.toContain('เงินสมทบสะสม')
    expect(render({ period: { status: 'closed' }, contribBalance: null })).not.toContain('เงินสมทบสะสม')
    const html = render({ period: { status: 'closed' }, contribBalance: 1140 })
    expect(html).toContain('เงินสมทบสะสม <b>1140</b>')
    // not a table row: the money tables end before the summary line
    expect(html.indexOf('เงินสมทบสะสม')).toBeGreaterThan(html.lastIndexOf('</table>'))
  })
  it('the เงินสมทบสะสม line never wraps inside itself', () => {
    expect(render({ period: { status: 'closed' }, contribBalance: 1 })).toMatch(/\.cbal\{[^}]*white-space:nowrap/)
  })
  it('shows a zero balance (worker with no opening and no contribution yet)', () => {
    expect(render({ period: { status: 'closed' }, contribBalance: 0 })).toContain('เงินสมทบสะสม <b>0</b>')
  })
})
