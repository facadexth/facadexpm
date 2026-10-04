import { describe, it, expect } from 'vitest'
import { leaveRequestPush, materialRequestPush, issueReportPush, testPush } from '../../supabase/functions/_shared/web-push-messages.ts'
import { TABS_FOR_TEST } from './webPush.js'

describe('Web Push wording', () => {
  it('leave request names the worker, the kind of leave and the dates, and opens the HR page', () => {
    const p = leaveRequestPush('สมชาย', 'ลากิจ', ' (ช่วงเช้า)', '2026-10-05')
    expect(p.title).toContain('คำขอลา')
    expect(p.body).toBe('สมชาย ขอลากิจ (ช่วงเช้า) วันที่ 2026-10-05')
    expect(p.tab).toBe('hr')
  })
  it('material request opens purchase orders', () => {
    const p = materialRequestPush('สมหญิง', 'ไซท์ A')
    expect(p.body).toBe('สมหญิง ขอเบิกที่ไซต์ ไซท์ A')
    expect(p.tab).toBe('purchase_orders')
  })
  it('issue report shows only a short single-line snippet', () => {
    const long = 'ท่อรั่ว\nที่ชั้น 2 '.repeat(30)
    const p = issueReportPush('สมชาย', long)
    expect(p.body.startsWith('สมชาย: ')).toBe(true)
    expect(p.body).not.toContain('\n')
    expect(p.body.length).toBeLessThanOrEqual(90)
    expect(p.body.endsWith('…')).toBe(true)
    expect(p.tab).toBe('sites')
  })
  it('does not add an ellipsis to a short report', () => {
    expect(issueReportPush('ก', 'กระจกแตก').body).toBe('ก: กระจกแตก')
  })
  it('test notification is plain', () => {
    expect(testPush().title).toContain('ทดสอบ')
  })
  it('every notification points at a real app page', () => {
    const tabs = [leaveRequestPush('a', 'b', '', 'c'), materialRequestPush('a', 'b'), issueReportPush('a', 'b'), testPush()].map((p) => p.tab)
    for (const t of tabs) expect(TABS_FOR_TEST).toContain(t)
  })
})
