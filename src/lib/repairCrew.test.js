import { describe, it, expect, vi } from 'vitest'

vi.mock('./supabase.js', () => ({ supabase: {} }))
const { releasesCrew } = await import('./repairCrew.js')

describe('releasesCrew (R30)', () => {
  it('ไม่รับ always releases', () => {
    expect(releasesCrew('pending_review', 'declined')).toBe(true)
    expect(releasesCrew('received', 'declined')).toBe(true)
  })
  it('back to รับเรื่อง from a booked status releases', () => {
    expect(releasesCrew('scheduled', 'received')).toBe(true)
  })
  it('accepting a new LINE ticket does not', () => {
    expect(releasesCrew('pending_review', 'received')).toBe(false)
  })
  it('other moves do not', () => {
    expect(releasesCrew('scheduled', 'in_progress')).toBe(false)
    expect(releasesCrew('in_progress', 'scheduled')).toBe(false)
    expect(releasesCrew('done', 'in_progress')).toBe(false)
  })
})
