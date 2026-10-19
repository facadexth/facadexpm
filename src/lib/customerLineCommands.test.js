import { describe, it, expect } from 'vitest'
import { matchCustomerCommand, looksLikeInviteCode } from '../../supabase/functions/_shared/customer-line-commands.ts'

describe('matchCustomerCommand', () => {
  it('maps each exact phrase to its command', () => {
    expect(matchCustomerCommand('ขอใบเสนอราคา')).toBe('quote')
    expect(matchCustomerCommand('สถานะงาน')).toBe('status')
    expect(matchCustomerCommand('แจ้งซ่อม')).toBe('repair')
    expect(matchCustomerCommand('สถานะแจ้งซ่อม')).toBe('repair_status')
    expect(matchCustomerCommand('ประกันของฉัน')).toBe('warranty')
    expect(matchCustomerCommand('ติดต่อเรา')).toBe('contact')
  })
  it('trims and removes inner spaces', () => {
    expect(matchCustomerCommand(' สถานะ งาน ')).toBe('status')
    expect(matchCustomerCommand('  ขอ ใบ เสนอราคา  ')).toBe('quote')
  })
  it('returns null for anything else', () => {
    expect(matchCustomerCommand('สวัสดี')).toBe(null)
    expect(matchCustomerCommand('')).toBe(null)
    expect(matchCustomerCommand('สถานะ')).toBe(null)
  })
})

describe('looksLikeInviteCode', () => {
  it('accepts 6 characters from the invite alphabet, case-insensitive', () => {
    expect(looksLikeInviteCode('k7p2qm')).toBe(true)
    expect(looksLikeInviteCode(' K7P2QM ')).toBe(true)
  })
  it('rejects 0, 1, I, L, O and O-like characters outside the alphabet', () => {
    expect(looksLikeInviteCode('K7P2Q0')).toBe(false)
    expect(looksLikeInviteCode('K7P2QI')).toBe(false)
    expect(looksLikeInviteCode('K7P2QO')).toBe(false)
  })
  it('rejects wrong lengths', () => {
    expect(looksLikeInviteCode('K7P2QMX')).toBe(false)
    expect(looksLikeInviteCode('K7P2Q')).toBe(false)
  })
})
