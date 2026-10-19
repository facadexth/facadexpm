import { describe, it, expect, vi } from 'vitest'

vi.mock('./supabase.js', () => ({ supabase: {} }))
const { pushResultNotice } = await import('./repairPush.js')

describe('pushResultNotice', () => {
  it('sent', () => expect(pushResultNotice({ data: { sent: true } })).toEqual({ kind: 'success', text: 'ส่งไลน์ให้ลูกค้าแล้ว' }))
  it.each([
    ['off', 'ไม่ได้ส่ง: ปิดการแจ้งลูกค้าอยู่'],
    ['budget', 'ไม่ได้ส่ง: เกินโควต้าวันนี้'],
    ['no_recipient', 'ไม่ได้ส่ง: ลูกค้ายังไม่ได้เชื่อม LINE'],
  ])('skipped %s', (k, text) => expect(pushResultNotice({ data: { sent: false, skipped: k } })).toEqual({ kind: 'warning', text }))
  it('skipped error', () => expect(pushResultNotice({ data: { sent: false, skipped: 'error' } })).toEqual({ kind: 'error', text: 'ส่งไลน์ไม่สำเร็จ' }))
  it('409 bodies', () => {
    expect(pushResultNotice({ errorBody: { error: 'already_reported' } }).text).toBe('ไม่ได้ส่ง: ส่งรายงานไปแล้ว')
    expect(pushResultNotice({ errorBody: { error: 'not_scheduled' } }).text).toBe('ไม่ได้ส่ง: งานยังไม่อยู่สถานะนัดเข้า')
    expect(pushResultNotice({ errorBody: { error: 'not_done' } }).text).toBe('ไม่ได้ส่ง: งานยังไม่เสร็จ')
  })
  it('anything else is a failure', () => {
    expect(pushResultNotice({ errorBody: null })).toEqual({ kind: 'error', text: 'ส่งไลน์ไม่สำเร็จ' })
    expect(pushResultNotice({ data: null })).toEqual({ kind: 'error', text: 'ส่งไลน์ไม่สำเร็จ' })
  })
})
