import { describe, it, expect, vi, beforeEach } from 'vitest'

// signature rows and workers' names by email; the logged-in user is me@x.co
const SIGS = { 'maker@x.co': 'T/maker@x.co/signature.png', 'me@x.co': 'T/me@x.co/signature.png' }
const NAMES = { 'maker@x.co': 'คุณผู้ทำ', 'me@x.co': 'คุณผู้เปิด', 'nosig@x.co': 'คนไม่มีลายเซ็น' }
const asked = []
vi.mock('../lib/supabase.js', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { email: 'me@x.co' } } } }) },
    from: () => ({ select: () => ({ eq: (_c, email) => ({ maybeSingle: async () => { asked.push(email); return { data: SIGS[email] ? { signature_path: SIGS[email] } : null } } }) }) }),
    rpc: async (_fn, { p_email }) => ({ data: NAMES[p_email] || null }),
    storage: { from: () => ({ createSignedUrl: async path => ({ data: { signedUrl: 'https://signed/' + path } }) }) },
  },
}))
const { loadDocumentSigner } = await import('./useSupabase.js')

describe('loadDocumentSigner: the document maker signs, not the viewer', () => {
  beforeEach(() => { asked.length = 0 })

  it('a saved document shows its maker (created_by), not the logged-in viewer', async () => {
    expect(await loadDocumentSigner('maker@x.co')).toEqual({ url: 'https://signed/T/maker@x.co/signature.png', name: 'คุณผู้ทำ' })
    expect(asked).toEqual(['maker@x.co'])
  })

  it('maker unknown (null) -> nothing, and the viewer is never looked up', async () => {
    expect(await loadDocumentSigner(null)).toBeNull()
    expect(asked).toEqual([])
  })

  it('undefined (sample / unsaved preview) -> the logged-in user', async () => {
    expect((await loadDocumentSigner(undefined)).name).toBe('คุณผู้เปิด')
  })

  it('maker without a drawn signature -> name only; unknown email -> null', async () => {
    expect(await loadDocumentSigner('nosig@x.co')).toEqual({ url: null, name: 'คนไม่มีลายเซ็น' })
    expect(await loadDocumentSigner('ghost@x.co')).toBeNull()
  })
})
