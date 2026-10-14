import { describe, it, expect, vi, beforeEach } from 'vitest'

// Fake supabase: controllable session + platform_admins lookup.
const state = { session: null, adminRows: {}, lookups: 0 }
vi.mock('../lib/supabase.js', () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: state.session } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    from: (table) => {
      let email = null
      const q = {
        select: () => q,
        eq: (_c, v) => { email = v; return q },
        maybeSingle: async () => {
          state.lookups++
          if (table !== 'platform_admins') return { data: null, error: null }
          return { data: state.adminRows[email] ? { user_email: email } : null, error: null }
        },
      }
      return q
    },
  },
}))
const { checkPlatformAdmin } = await import('./useSupabase.js')

beforeEach(() => { state.session = null; state.adminRows = {}; state.lookups = 0 })

describe('checkPlatformAdmin', () => {
  it('is false with no session and never queries the table', async () => {
    expect(await checkPlatformAdmin()).toBe(false)
    expect(state.lookups).toBe(0)
  })

  it('is true only for an email listed in platform_admins', async () => {
    state.adminRows = { 'contact@facadex.co.th': true }
    state.session = { user: { email: 'contact@facadex.co.th' } }
    expect(await checkPlatformAdmin()).toBe(true)

    // same tab, different account signed in afterwards -> must re-evaluate to false
    state.session = { user: { email: 'demo-owner@facadex.co.th' } }
    expect(await checkPlatformAdmin()).toBe(false)
  })
})
