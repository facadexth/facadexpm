import { describe, it, expect } from 'vitest'
import { linkHint, linkHintMessage } from './userLinkHint.js'

const workers = [
  { name: 'สมชาย ใจดี', nickname: 'ชาย', email: 'chai@x.com' },
  { name: 'สมหญิง รักงาน', nickname: 'หญิง', email: null },
]

describe('linkHint', () => {
  it('is linked when a worker already has the email (case and spaces ignored)', () => {
    expect(linkHint({ email: ' Chai@X.com ', name: 'ใครก็ได้', workers }).kind).toBe('linked')
  })
  it('matches an unlinked worker by name', () => {
    const h = linkHint({ email: 'new@x.com', name: 'สมหญิง รักงาน', workers })
    expect(h.kind).toBe('name_match')
    expect(h.worker.name).toBe('สมหญิง รักงาน')
  })
  it('matches an unlinked worker by nickname', () => {
    expect(linkHint({ email: 'new@x.com', name: 'หญิง', workers }).kind).toBe('name_match')
  })
  it('does not name-match a worker that already has a different email', () => {
    expect(linkHint({ email: 'new@x.com', name: 'สมชาย ใจดี', workers }).kind).toBe('none')
  })
  it('is none when nothing matches or the list is empty', () => {
    expect(linkHint({ email: 'a@x.com', name: 'ไม่มี', workers }).kind).toBe('none')
    expect(linkHint({ email: 'a@x.com', name: 'ไม่มี', workers: null }).kind).toBe('none')
  })
  it('has no message when linked, and a message otherwise', () => {
    expect(linkHintMessage({ kind: 'linked' })).toBeNull()
    expect(linkHintMessage({ kind: 'none' })).toContain('หน้าบุคคล')
    expect(linkHintMessage({ kind: 'name_match', worker: { name: 'สมหญิง' } })).toContain('สมหญิง')
  })
})
