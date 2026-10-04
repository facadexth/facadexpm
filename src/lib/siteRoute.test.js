import { describe, it, expect, vi } from 'vitest'

vi.mock('./supabase.js', () => ({ supabase: {} }))
import { readOrigin, routeErrorMessage } from './siteRoute.js'

describe('siteRoute', () => {
  it('reads the saved base point', () => {
    expect(readOrigin({ travel_origin_lat: '13.75', travel_origin_lng: '100.5' })).toEqual({ lat: 13.75, lng: 100.5 })
  })
  it('is null until both coordinates are saved', () => {
    expect(readOrigin({})).toBeNull()
    expect(readOrigin({ travel_origin_lat: '13.75' })).toBeNull()
  })
  it('gives a plain message for each known failure and a fallback', () => {
    expect(routeErrorMessage('daily_limit')).toContain('ครบจำนวน')
    expect(routeErrorMessage('whatever')).toContain('ไม่สำเร็จ')
  })
})
