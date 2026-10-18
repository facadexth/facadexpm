import { describe, it, expect } from 'vitest'
import {
  matchDMAction, matchGroupAction, matchGroupInfoAction, groupAdvanceHint, requestMenuChips,
  resolveEffectivePhrases, resolveEnabled, advancePhrasesFromSettings, advanceItemsForReply, formatBaht,
  ADVANCE_COMMAND_KEYS, SCHEDULE_COMMAND_DEFAULTS as EDGE_SCHEDULE_DEFAULTS,
  ADVANCE_NOT_ALLOWED_MESSAGE, ADVANCE_DM_ONLY_MESSAGE, REQUEST_MENU_PROMPT, advanceLinkMessage,
} from '../../supabase/functions/_shared/line-command-match.ts'
import { leaveRemainingFromCounts, bangkokYear } from '../../supabase/functions/_shared/leave-quota.ts'
import * as appSettings from './lineCommandSettings.js'

// Regression: every phrase that existed before the salary-advance work must route
// exactly as it did (the matcher moved from line-webhook/index.ts to _shared).
describe('matchDMAction: old phrases unchanged', () => {
  const cases = [
    ['ขอเบิกปูน', 'material_request'],
    ['ขอเบิกของ', 'material_request'],
    ['เบิกของ', 'material_request'],
    ['อยากเบิกทราย 3 ถุง', 'material_request'],
    ['ขอลา', 'leave'],
    ['ลากิจพรุ่งนี้', 'leave'],
    ['ลาป่วย', 'leave'],
    ['อยากลา', 'leave'],
    ['แจ้งปัญหา', 'issue_report'],
    ['ท่อมีปัญหา', 'issue_report'],
    ['ไม่มีปัญหา', null],
    ['ไปตลาด', null],
    ['เช็คอิน/เช็คเอาท์', 'time_clock'],
    ['ตารางงาน', 'schedule_menu'],
    ['เช็คอิน', 'check_in'],
    ['เช็คเอาท์', 'check_out'],
    ['รูปภาพหน้างาน', 'site_photo'],
    ['งานเสร็จ', 'job_done_start'],
    ['เสร็จงานแล้ว', 'job_done_start'],
    ['งานวันนี้', 'today_job'],
    ['งานวันพรุ่งนี้', 'tomorrow_job'],
    ['งานอาทิตย์นี้', 'this_week_job'],
    ['งานอาทิตย์หน้า', 'next_week_job'],
    ['สวัสดีครับ', null],
  ]
  it.each(cases)('%s -> %s', (text, expected) => {
    expect(matchDMAction(text, {})).toBe(expected)
  })
  it('renamed schedule phrases still route', () => {
    const s = { today_job: { command_key: 'today_job', enabled_dm: true, enabled_group: true, custom_phrase: 'ไปไหนวันนี้' } }
    expect(matchDMAction('ไปไหนวันนี้', s)).toBe('today_job')
    expect(matchDMAction('งานวันนี้', s)).toBe(null)
  })
})

describe('matchDMAction: salary advance + request menus', () => {
  const cases = [
    ['เบิกเงิน', 'advance_request'],
    ['ขอเบิกเงิน', 'advance_request'],
    ['ขอเบิกเงิน 3000', 'advance_request'],
    ['อยากเบิกเงิน', 'advance_request'],
    ['ยอดเบิก', 'advance_status'],
    ['ยื่นคำขอ', 'request_menu'],
    ['สถานะคำขอ', 'request_status'],
  ]
  it.each(cases)('%s -> %s', (text, expected) => {
    expect(matchDMAction(text, {})).toBe(expected)
  })
  it('leave beats advance in DM', () => {
    expect(matchDMAction('ขอลาครึ่งวัน ไปเบิกเงินที่ธนาคาร', {})).toBe('leave')
  })
  it('"ขอเบิกเงิน" is money, "ขอเบิกปูน" stays material (both directions)', () => {
    expect(matchDMAction('ขอเบิกเงิน', {})).toBe('advance_request')
    expect(matchDMAction('ขอเบิกปูน', {})).toBe('material_request')
  })
  it('the request-menu chips route to the existing flows', () => {
    for (const c of requestMenuChips({ leaveOn: true, materialOn: true, advanceOn: true, advancePhrase: 'เบิกเงิน' })) {
      if (c.text === 'ยกเลิก') continue
      expect(matchDMAction(c.text, {})).toBe({ 'ขอลา': 'leave', 'ขอเบิกของ': 'material_request', 'เบิกเงิน': 'advance_request' }[c.text])
    }
  })
  it('uses renamed advance phrases, and keeps the built-in money phrases as a guard', () => {
    const s = { advance_request: { command_key: 'advance_request', enabled_dm: true, enabled_group: false, custom_phrase: 'ขอเงินล่วงหน้า, เงินด่วน' } }
    expect(matchDMAction('ขอเงินล่วงหน้า', s)).toBe('advance_request')
    expect(matchDMAction('เงินด่วน', s)).toBe('advance_request')
    expect(matchDMAction('เบิกเงิน', s)).toBe('advance_request')
    // money guard: never the material flow after a rename
    expect(matchDMAction('ขอเบิกเงิน', s)).toBe('advance_request')
    const st = { advance_status: { command_key: 'advance_status', enabled_dm: true, enabled_group: false, custom_phrase: 'ขอยอดเงิน' } }
    expect(matchDMAction('ยอดเบิก', st)).toBe('advance_status')
  })
  it('a problem report wins over the advance match', () => {
    expect(matchDMAction('แจ้งปัญหา เบิกเงินไม่ได้', {})).toBe('issue_report')
    expect(matchDMAction('ไม่มีปัญหา ขอเบิกเงิน', {})).toBe('advance_request')
  })
  it('"ยอดเบิกของ" falls through to material, as before', () => {
    expect(matchDMAction('ยอดเบิกของ', {})).toBe('material_request')
    expect(matchDMAction('ยอดเบิก', {})).toBe('advance_status')
  })
  it('matches even when the command is off (caller replies "disabled")', () => {
    const s = { advance_status: { command_key: 'advance_status', enabled_dm: false, enabled_group: false, custom_phrase: null } }
    expect(matchDMAction('ยอดเบิก', s)).toBe('advance_status')
    expect(resolveEnabled('advance_status', s, 'dm')).toBe(false)
    expect(resolveEnabled('advance_request', {}, 'dm')).toBe(true)
  })
})

describe('group path', () => {
  it('matchGroupAction unchanged', () => {
    expect(matchGroupAction('ขอเบิกปูน')).toBe('material_request')
    expect(matchGroupAction('เบิกของ')).toBe('material_request')
    expect(matchGroupAction('ขอลา')).toBe('leave')
    expect(matchGroupAction('มีปัญหา')).toBe('issue_report')
    expect(matchGroupAction('ไม่มีปัญหา')).toBe(null)
  })
  it('money phrases get the DM-only hint, before the material match', () => {
    expect(groupAdvanceHint('ขอเบิกเงิน', {})).toBe('hint')
    expect(groupAdvanceHint('เบิกเงิน', {})).toBe('hint')
    expect(groupAdvanceHint('ยอดเบิก', {})).toBe('hint')
  })
  it('money guard in a group after a rename: still the hint, never material', () => {
    const s = { advance_request: { command_key: 'advance_request', enabled_dm: true, enabled_group: false, custom_phrase: 'เงินด่วน' } }
    expect(groupAdvanceHint('ขอเบิกเงิน', s)).toBe('hint')
    expect(groupAdvanceHint('เงินด่วน', s)).toBe('hint')
  })
  it('a problem report in a group is not swallowed by the hint', () => {
    expect(groupAdvanceHint('แจ้งปัญหา เบิกเงินไม่ได้', {})).toBe(null)
    expect(matchGroupAction('แจ้งปัญหา เบิกเงินไม่ได้')).toBe('issue_report')
  })
  it('hint only for a short message (<= 30 chars trimmed); longer chatter is ignored', () => {
    const long = 'เมื่อวานพี่เขาบอกว่าจะไปเบิกเงินที่ธนาคารตอนบ่ายครับ'
    expect(long.trim().length).toBeGreaterThan(30)
    expect(groupAdvanceHint(long, {})).toBe('ignore')
    expect(groupAdvanceHint('  ขอเบิกเงิน 3000 ครับ  ', {})).toBe('hint')
  })
  it('"ยอดเบิกของ" in a group is not money', () => {
    expect(groupAdvanceHint('ยอดเบิกของ', {})).toBe(null)
    expect(matchGroupAction('ยอดเบิกของ')).toBe('material_request')
  })
  it('request menus are ignored silently in a group', () => {
    expect(groupAdvanceHint('ยื่นคำขอ', {})).toBe('ignore')
    expect(groupAdvanceHint('สถานะคำขอ', {})).toBe('ignore')
  })
  it('old group phrases are not touched', () => {
    for (const t of ['ขอเบิกปูน', 'เบิกของ', 'ขอลา', 'แจ้งปัญหา', 'งานวันนี้']) expect(groupAdvanceHint(t, {})).toBe(null)
    expect(matchGroupInfoAction('งานวันนี้', {})).toBe('today_job')
  })
})

describe('payslip_request', () => {
  it('routes in DM, ignored in a group, never material or leave', () => {
    expect(matchDMAction('ขอสลิปเงินเดือน', {})).toBe('payslip_request')
    expect(groupAdvanceHint('ขอสลิปเงินเดือน', {})).toBe(null)
    expect(matchGroupAction('ขอสลิปเงินเดือน')).toBe(null) // bare payslip text stays silent in a group
    expect(groupAdvanceHint('ขอเบิกปูน 2 ถุง ขอสลิปด้วย', {})).toBe(null)
    expect(matchGroupAction('ขอเบิกปูน 2 ถุง ขอสลิปด้วย')).toBe('material_request')
    expect(ADVANCE_COMMAND_KEYS).toContain('payslip_request')
    expect(appSettings.ADVANCE_COMMAND_KEYS).toEqual(ADVANCE_COMMAND_KEYS)
  })
  it('chip order and off state', () => {
    const o = { leaveOn: true, materialOn: true, advanceOn: true, advancePhrase: 'เบิกเงิน', payslipPhrase: 'ขอสลิป' }
    expect(requestMenuChips({ ...o, payslipOn: true }).map(c => c.text)).toEqual(['ขอลา', 'ขอเบิกของ', 'เบิกเงิน', 'ขอสลิปเงินเดือน', 'ยกเลิก'])
    expect(requestMenuChips({ ...o, payslipOn: true })[3].label).toBe('🧾 ขอสลิปเงินเดือน')
    expect(requestMenuChips({ ...o, payslipOn: false }).map(c => c.text)).toEqual(['ขอลา', 'ขอเบิกของ', 'เบิกเงิน', 'ยกเลิก'])
    expect(requestMenuChips({ ...o, payslipOn: true, payslipPhrase: 'สลิปเดือนนี้' })[3].text).toBe('สลิปเดือนนี้')
  })
})

describe('requestMenuChips', () => {
  it('all on: the four chips from the addendum', () => {
    expect(requestMenuChips({ leaveOn: true, materialOn: true, advanceOn: true, advancePhrase: 'เบิกเงิน' })).toEqual([
      { label: '🏖️ ขอลา', text: 'ขอลา' },
      { label: '📦 เบิกของ', text: 'ขอเบิกของ' },
      { label: '💸 เบิกเงิน', text: 'เบิกเงิน' },
      { label: 'ยกเลิก', text: 'ยกเลิก' },
    ])
  })
  it('no payroll: no เบิกเงิน chip', () => {
    expect(requestMenuChips({ leaveOn: true, materialOn: true, advanceOn: false, advancePhrase: 'เบิกเงิน' }).map(c => c.text)).toEqual(['ขอลา', 'ขอเบิกของ', 'ยกเลิก'])
  })
  it('renamed advance phrase is what the chip sends', () => {
    expect(requestMenuChips({ leaveOn: false, materialOn: false, advanceOn: true, advancePhrase: 'เงินด่วน' })).toEqual([
      { label: '💸 เบิกเงิน', text: 'เงินด่วน' }, { label: 'ยกเลิก', text: 'ยกเลิก' },
    ])
  })
  it('everything off: empty (caller replies disabled)', () => {
    expect(requestMenuChips({ leaveOn: false, materialOn: false, advanceOn: false })).toEqual([])
  })
})

describe('reply texts', () => {
  it('are the exact global-constraint / brief strings', () => {
    expect(ADVANCE_NOT_ALLOWED_MESSAGE).toBe('ยังขอเบิกเงินผ่าน LINE ไม่ได้ ติดต่อแอดมินครับ')
    expect(ADVANCE_DM_ONLY_MESSAGE).toBe('ขอเบิกเงินทางแชตส่วนตัวกับบอทนะครับ')
    expect(REQUEST_MENU_PROMPT).toBe('เลือกคำขอที่ต้องการครับ')
    expect(advanceLinkMessage('https://x/f/abc')).toBe('💸 กดลิงก์นี้เพื่อกรอกขอเบิกเงินครับ (ใช้ได้ 30 นาที)\nhttps://x/f/abc')
  })
  it('formatBaht', () => {
    expect(formatBaht(12500)).toBe('12,500')
    expect(formatBaht(1250.5)).toBe('1,250.5')
    expect(formatBaht(0)).toBe('0')
  })
})

describe('advanceItemsForReply', () => {
  const now = Date.parse('2026-10-18T00:00:00Z')
  const summary = {
    outstanding: 1000, pendingOther: 0,
    items: [
      { id: 'p', status: 'pending' }, { id: 'a', status: 'approved' },
      { id: 'r-new', status: 'rejected' }, { id: 'r-old', status: 'rejected' }, { id: 's-old', status: 'settled' },
    ],
  }
  const at = { p: '2025-01-01T00:00:00Z', a: '2025-01-01T00:00:00Z', 'r-new': '2026-10-01T00:00:00Z', 'r-old': '2026-06-01T00:00:00Z', 's-old': '2026-01-01T00:00:00Z' }
  it('keeps open ones always and closed ones from the last 90 days', () => {
    const out = advanceItemsForReply(summary, at, now)
    expect(out.items.map(i => i.id)).toEqual(['p', 'a', 'r-new'])
    expect(out.outstanding).toBe(1000)
  })
  it('caps the list', () => {
    expect(advanceItemsForReply(summary, at, now, 2).items.map(i => i.id)).toEqual(['p', 'a'])
  })
})

describe('leave-quota (moved from field-form)', () => {
  it('each leave row is half a day', () => {
    expect(leaveRemainingFromCounts(2, 1, 6, 30)).toEqual({ remainingPersonal: 5, remainingSick: 29.5 })
  })
  it('bangkokYear rolls over at Bangkok midnight', () => {
    expect(bangkokYear(Date.parse('2026-12-31T16:59:00Z'))).toBe(2026)
    expect(bangkokYear(Date.parse('2026-12-31T17:00:00Z'))).toBe(2027)
  })
})

describe('edge copy stays in sync with src/lib/lineCommandSettings.js', () => {
  it('same advance keys and default phrases', () => {
    expect(ADVANCE_COMMAND_KEYS).toEqual(appSettings.ADVANCE_COMMAND_KEYS)
    for (const k of ADVANCE_COMMAND_KEYS) expect(resolveEffectivePhrases(k, {})).toEqual(appSettings.resolveEffectivePhrases(k, {}))
    expect(advancePhrasesFromSettings({}).advance_request).toEqual(['เบิกเงิน'])
  })
  it('same schedule defaults', () => {
    expect(EDGE_SCHEDULE_DEFAULTS).toEqual(appSettings.SCHEDULE_COMMAND_DEFAULTS)
  })
  it('the material keywords the edge matches are the app\'s reserved material phrases', () => {
    for (const p of appSettings.FIXED_COMMAND_PHRASES.material_request) expect(matchGroupAction(p)).toBe('material_request')
  })
})
