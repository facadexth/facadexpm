import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SAFETY_NOTE, resolveSafetyNote, runOfDays, buildJobSheet,
} from '../../supabase/functions/_shared/site-jobsheet.ts'
import { QUANTITY_BLOCKED_MESSAGE, PARENT_BLOCKED_MESSAGE } from '../../supabase/functions/_shared/lineTaskRules.ts'

const card = (over = {}) => ({
  id: 'c1', phase_id: 'p1', name: 'งาน', zone: null, status: 'not_started', sort_order: 0,
  progress_mode: 'status', planned_qty: null, done_qty: null, unit: null, issue_report_id: null,
  has_children: false, worker_ids: [], updated_at: '2026-11-20T03:00:00Z', ...over,
})

const base = (over = {}) => ({
  tenant: { company_name: 'บจก. ทดสอบ', address: '1 ถนน', phone: '02-111', logo_url: null },
  date: '2026-11-26',
  site: { id: 's1', name: 'บ้านคุณเอ', location: 'บางนา', map_url: null, lat: 13.7, lng: 100.5, safety_note: null },
  tenantSafetyDefault: null,
  run: { index: 3, total: 5, from: '2026-11-24', to: '2026-11-28' },
  crew: [
    { worker_id: 'w1', name: 'สมชาย', nickname: 'ชาย', shifts: ['evening', 'morning'], is_team_leader: true },
    { worker_id: 'w3', name: 'มานะ', nickname: null, shifts: ['morning'], is_team_leader: false },
    { worker_id: 'w2', name: 'กิตติ', nickname: 'กิต', shifts: ['morning'], is_team_leader: false },
  ],
  phases: [
    { id: 'p2', name: 'ติดตั้งบานกระจก', sort_order: 2 },
    { id: 'p1', name: 'ติดตั้งโครง', sort_order: 1 },
    { id: 'pi', name: 'ปัญหา', sort_order: 99, is_issue_phase: true },
  ],
  cards: [],
  drawings: [],
  viewerWorkerId: null,
  ...over,
})

describe('resolveSafetyNote', () => {
  it('site note wins, trimmed', () => {
    expect(resolveSafetyNote('  ระวังสายไฟ  ', 'ค่าบริษัท')).toBe('ระวังสายไฟ')
  })
  it('falls back to tenant default when site blank', () => {
    expect(resolveSafetyNote('   ', ' ค่าบริษัท ')).toBe('ค่าบริษัท')
    expect(resolveSafetyNote(null, 'ค่าบริษัท')).toBe('ค่าบริษัท')
  })
  it('falls back to built-in default', () => {
    expect(resolveSafetyNote(null, '  ')).toBe(DEFAULT_SAFETY_NOTE)
    expect(resolveSafetyNote()).toBe(DEFAULT_SAFETY_NOTE)
    expect(DEFAULT_SAFETY_NOTE).toBe('ก่อนเริ่มงาน: ตรวจอุปกรณ์เซฟตี้ · ใส่เข็มขัดนิรภัยเมื่อทำงานที่สูง · ปูผ้ากันเปื้อนพื้น · เก็บเศษวัสดุและทำความสะอาดก่อนกลับ')
  })
})

describe('runOfDays', () => {
  it('5 consecutive days, today is the 3rd', () => {
    expect(runOfDays(['2026-11-28', '2026-11-24', '2026-11-26', '2026-11-25', '2026-11-27'], '2026-11-26'))
      .toEqual({ index: 3, total: 5, from: '2026-11-24', to: '2026-11-28' })
  })
  it('Fri -> Mon (3 days) continues the run', () => {
    expect(runOfDays(['2026-11-19', '2026-11-20', '2026-11-23', '2026-11-24'], '2026-11-23'))
      .toEqual({ index: 3, total: 4, from: '2026-11-19', to: '2026-11-24' })
  })
  it('Thu -> Mon (4 days) starts a new run', () => {
    expect(runOfDays(['2026-11-18', '2026-11-19', '2026-11-23', '2026-11-24'], '2026-11-23'))
      .toEqual({ index: 1, total: 2, from: '2026-11-23', to: '2026-11-24' })
    expect(runOfDays(['2026-11-18', '2026-11-19', '2026-11-23'], '2026-11-19'))
      .toEqual({ index: 2, total: 2, from: '2026-11-18', to: '2026-11-19' })
  })
  it('today absent -> null', () => {
    expect(runOfDays(['2026-11-24', '2026-11-25'], '2026-11-26')).toBeNull()
    expect(runOfDays([], '2026-11-26')).toBeNull()
  })
  it('duplicates are counted once', () => {
    expect(runOfDays(['2026-11-26', '2026-11-26', '2026-11-25', '2026-11-25'], '2026-11-26'))
      .toEqual({ index: 2, total: 2, from: '2026-11-25', to: '2026-11-26' })
  })
  it('crosses a month end', () => {
    expect(runOfDays(['2026-11-30', '2026-12-01'], '2026-12-01'))
      .toEqual({ index: 2, total: 2, from: '2026-11-30', to: '2026-12-01' })
  })
})

describe('buildJobSheet header', () => {
  it('date, run, company, site, safety', () => {
    const s = buildJobSheet(base())
    expect(s.dateText).toBe('พฤหัส 26/11/2569') // 2026-11-26 is a Thursday
    expect(buildJobSheet(base({ date: '2026-11-25' })).dateText).toBe('พ 25/11/2569')
    expect(s.runText).toBe('วันที่ 3 จาก 5 · 24–28/11/2569')
    expect(s.company).toEqual({ name: 'บจก. ทดสอบ', address: '1 ถนน', phone: '02-111', logoUrl: null })
    expect(s.siteName).toBe('บ้านคุณเอ')
    expect(s.address).toBe('บางนา')
    expect(s.mapUrl).toBe('https://www.google.com/maps?q=13.7,100.5')
    expect(s.safetyNote).toBe(DEFAULT_SAFETY_NOTE)
    expect(buildJobSheet(base({ tenantSafetyDefault: 'ค่าบริษัท' })).safetyNote).toBe('ค่าบริษัท')
  })
  it('runText across months, years, single day, none', () => {
    expect(buildJobSheet(base({ run: { index: 3, total: 5, from: '2026-11-28', to: '2026-12-02' } })).runText)
      .toBe('วันที่ 3 จาก 5 · 28/11–02/12/2569')
    expect(buildJobSheet(base({ run: { index: 2, total: 3, from: '2026-12-31', to: '2027-01-01' } })).runText)
      .toBe('วันที่ 2 จาก 3 · 31/12/2569–01/01/2570')
    expect(buildJobSheet(base({ run: { index: 1, total: 1, from: '2026-11-26', to: '2026-11-26' } })).runText)
      .toBe('วันที่ 1 จาก 1 · 26/11/2569')
    expect(buildJobSheet(base({ run: null })).runText).toBeNull()
  })
  it('leader text with shifts, crew in name order', () => {
    const s = buildJobSheet(base())
    expect(s.leaderText).toBe('สมชาย (ชาย) · เช้า + บ่าย')
    expect(s.crewText).toBe('กิตติ (กิต), มานะ')
  })
  it('several leaders; none -> "-"', () => {
    const crew = [
      { worker_id: 'w1', name: 'สมชาย', nickname: 'ชาย', shifts: ['morning'], is_team_leader: true },
      { worker_id: 'w2', name: 'กิตติ', nickname: null, shifts: ['evening'], is_team_leader: true },
    ]
    const s = buildJobSheet(base({ crew }))
    expect(s.leaderText).toBe('สมชาย (ชาย) · เช้า, กิตติ · บ่าย')
    expect(s.crewText).toBe('-')
    const n = buildJobSheet(base({ crew: [] }))
    expect(n.leaderText).toBe('-')
    expect(n.crewText).toBe('-')
  })
  it('viewerIsLeader', () => {
    expect(buildJobSheet(base({ viewerWorkerId: 'w1' })).viewerIsLeader).toBe(true)
    expect(buildJobSheet(base({ viewerWorkerId: 'w2' })).viewerIsLeader).toBe(false)
    expect(buildJobSheet(base()).viewerIsLeader).toBe(false)
  })
})

describe('buildJobSheet cards', () => {
  it('groups by phase sort_order, then zone, then card sort_order', () => {
    const cards = [
      card({ id: 'a', phase_id: 'p2', zone: 'ชั้น 1', sort_order: 1 }),
      card({ id: 'b', phase_id: 'p1', zone: 'ชั้น 2', sort_order: 2 }),
      card({ id: 'c', phase_id: 'p1', zone: 'ชั้น 2', sort_order: 1 }),
      card({ id: 'd', phase_id: 'p1', zone: null, sort_order: 0 }),
      card({ id: 'e', phase_id: 'p1', zone: 'ชั้น 1', sort_order: 5 }),
    ]
    const s = buildJobSheet(base({ cards }))
    expect(s.groups.map((g) => [g.phase, g.zone, g.cards.map((c) => c.id)])).toEqual([
      ['ติดตั้งโครง', 'ชั้น 1', ['e']],
      ['ติดตั้งโครง', 'ชั้น 2', ['c', 'b']],
      ['ติดตั้งโครง', 'ทั่วไป', ['d']],
      ['ติดตั้งบานกระจก', 'ชั้น 1', ['a']],
    ])
    expect(s.cardCount).toBe(5)
  })
  it('issue cards go to problems (issue phase or issue_report_id), not-done only', () => {
    const cards = [
      card({ id: 'i1', phase_id: 'pi', name: 'กระจกแตก', zone: 'ชั้น 3' }),
      card({ id: 'i2', phase_id: 'p1', name: 'รั่ว', issue_report_id: 'r1' }),
      card({ id: 'i3', phase_id: 'pi', name: 'แก้แล้ว', status: 'done', updated_at: '2026-11-26T02:00:00Z' }),
      card({ id: 'n1', phase_id: 'p1' }),
    ]
    const s = buildJobSheet(base({ cards }))
    expect(s.problems).toEqual([
      { id: 'i1', name: 'กระจกแตก', zone: 'ชั้น 3' },
      { id: 'i2', name: 'รั่ว', zone: 'ทั่วไป' },
    ])
    expect(s.groups.flatMap((g) => g.cards.map((c) => c.id))).toEqual(['n1'])
  })
  it('done today (Bangkok date) kept, done earlier dropped', () => {
    const cards = [
      card({ id: 'today', status: 'done', updated_at: '2026-11-25T18:30:00Z' }), // 01:30 on 26th in Bangkok
      card({ id: 'yday', status: 'done', updated_at: '2026-11-25T16:00:00Z' }), // 23:00 on 25th in Bangkok
      card({ id: 'nodate', status: 'done', updated_at: null }),
      card({ id: 'open', status: 'in_progress' }),
    ]
    const s = buildJobSheet(base({ cards }))
    const shown = s.groups.flatMap((g) => g.cards)
    expect(shown.map((c) => c.id).sort()).toEqual(['open', 'today'])
    expect(shown.find((c) => c.id === 'today').statusText).toBe('เสร็จแล้ว')
    expect(shown.find((c) => c.id === 'open').statusText).toBe('กำลังทำ')
    expect(buildJobSheet(base({ cards: [card()] })).groups[0].cards[0].statusText).toBe('ยังไม่เริ่ม')
  })
  it('qty text', () => {
    const cards = [
      card({ id: 'q1', sort_order: 1, progress_mode: 'quantity', planned_qty: 20, done_qty: 12, unit: 'ชุด' }),
      card({ id: 'q2', sort_order: 2, progress_mode: 'quantity', planned_qty: 7.5, done_qty: 0, unit: null }),
      card({ id: 's1', sort_order: 3 }),
    ]
    const shown = buildJobSheet(base({ cards })).groups[0].cards
    expect(shown.map((c) => c.qtyText)).toEqual(['12/20 ชุด', '0/7.5', '-'])
  })
  it('mine first within a group, owners text', () => {
    const cards = [
      card({ id: 'x', sort_order: 1, worker_ids: ['w2', 'w3'] }),
      card({ id: 'y', sort_order: 2, worker_ids: ['w1'] }),
      card({ id: 'z', sort_order: 3, worker_ids: ['unknown'] }),
    ]
    const shown = buildJobSheet(base({ cards, viewerWorkerId: 'w1' })).groups[0].cards
    expect(shown.map((c) => [c.id, c.mine])).toEqual([['y', true], ['x', false], ['z', false]])
    expect(shown.map((c) => c.ownersText)).toEqual(['สมชาย', 'กิตติ, มานะ', '-'])
  })
  it('canClose false for quantity and parent cards, with blocked text', () => {
    const cards = [
      card({ id: 'q', sort_order: 1, progress_mode: 'quantity', planned_qty: 5, done_qty: 1 }),
      card({ id: 'p', sort_order: 2, has_children: true }),
      card({ id: 's', sort_order: 3 }),
      card({ id: 'd', sort_order: 4, status: 'done', updated_at: '2026-11-26T05:00:00Z' }),
    ]
    const shown = buildJobSheet(base({ cards })).groups[0].cards
    expect(shown.map((c) => [c.id, c.canClose, c.blockedText])).toEqual([
      ['q', false, QUANTITY_BLOCKED_MESSAGE],
      ['p', false, PARENT_BLOCKED_MESSAGE],
      ['s', true, null],
      ['d', false, null],
    ])
    expect(QUANTITY_BLOCKED_MESSAGE).toBe('งานนี้นับเป็นจำนวน ให้ PM บันทึกยอดในแอป')
    expect(PARENT_BLOCKED_MESSAGE).toBe('งานนี้มีงานย่อย ให้กดเสร็จที่งานย่อย')
  })
  it('progressText = phase with the most open cards, share done', () => {
    const cards = [
      card({ id: 'a', phase_id: 'p1', status: 'done' }),
      card({ id: 'b', phase_id: 'p1' }),
      card({ id: 'c', phase_id: 'p2', status: 'done' }),
      card({ id: 'd', phase_id: 'p2' }),
      card({ id: 'e', phase_id: 'p2', status: 'in_progress' }),
      card({ id: 'i1', phase_id: 'pi' }),
      card({ id: 'i2', phase_id: 'pi' }),
      card({ id: 'i3', phase_id: 'pi' }),
    ]
    expect(buildJobSheet(base({ cards })).progressText).toBe('ติดตั้งบานกระจก · คืบหน้า 33%')
    expect(buildJobSheet(base()).progressText).toBeNull()
  })
  it('passes drawings through', () => {
    const drawings = [{ id: 'g1', title: 'แบบชั้น 1', url: 'https://x/a.pdf' }]
    expect(buildJobSheet(base({ drawings })).drawings).toEqual(drawings)
    const typed = [{ id: 'g1', title: 'แบบชั้น 1', url: 'https://x/a.pdf', mime: 'application/pdf' }, { id: 'g2', title: 'รูป', url: 'https://x/b.png', mime: 'image/png' }]
    expect(buildJobSheet(base({ drawings: typed })).drawings.map((d) => d.mime)).toEqual(['application/pdf', 'image/png'])
  })
})
