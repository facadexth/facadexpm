import { describe, it, expect, vi } from 'vitest'

const calls = []
const chain = new Proxy({}, {
  get: (_, name) => {
    if (name === 'then') return (res) => res({ error: null })
    return (...args) => { calls.push([name, ...args]); return chain }
  },
})
vi.mock('./supabase.js', () => ({ supabase: { from: (t) => { calls.push(['from', t]); return chain } } }))
vi.mock('./photoUpload.js', () => ({ bangkokTodayIso: () => '2026-10-20' }))
const { releasesCrew, removeFutureUnconfirmedCrew } = await import('./repairCrew.js')

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

describe('removeFutureUnconfirmedCrew (R30, final fix)', () => {
  it('only deletes the ticket\'s own site rows at the ticket\'s site, today on, unconfirmed', async () => {
    calls.length = 0
    const { error } = await removeFutureUnconfirmedCrew('t1', 's1')
    expect(error).toBeNull()
    expect(calls).toEqual([
      ['from', 'worker_assignments'],
      ['delete'],
      ['eq', 'repair_ticket_id', 't1'],
      ['eq', 'type', 'site'],
      ['eq', 'site_id', 's1'],
      ['gte', 'date', '2026-10-20'],
      ['is', 'confirmed_at', null],
    ])
  })
  it('refuses to run without a site id', async () => {
    calls.length = 0
    const { error } = await removeFutureUnconfirmedCrew('t1', null)
    expect(error).toBeTruthy()
    expect(calls).toEqual([])
  })
})
