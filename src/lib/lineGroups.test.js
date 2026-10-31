import { describe, it, expect } from 'vitest'
import { decideGroupClaim, planGroupRemoval } from '../../supabase/functions/_shared/line-groups.ts'

describe('decideGroupClaim', () => {
  const base = { claimingTenantId: 'T1', canAdd: true, existingCount: 0, alreadyLinkedTenantId: null }
  it('first group becomes the notify group', () => {
    expect(decideGroupClaim(base)).toEqual({ action: 'insert', isNotify: true })
  })
  it('later groups are not notify', () => {
    expect(decideGroupClaim({ ...base, existingCount: 2 })).toEqual({ action: 'insert', isNotify: false })
  })
  it('refuses when the tier cap is reached', () => {
    expect(decideGroupClaim({ ...base, existingCount: 2, canAdd: false })).toEqual({ action: 'refuse-cap' })
  })
  it('refuses a group already linked to another tenant', () => {
    expect(decideGroupClaim({ ...base, alreadyLinkedTenantId: 'T2' })).toEqual({ action: 'refuse-other-tenant' })
  })
  it('re-claiming own group is a no-op', () => {
    expect(decideGroupClaim({ ...base, alreadyLinkedTenantId: 'T1', existingCount: 1 })).toEqual({ action: 'already-linked' })
  })
})

describe('planGroupRemoval', () => {
  const gs = [{ id: 'a', is_notify: true }, { id: 'b', is_notify: false }, { id: 'c', is_notify: false }]
  it('removing a non-notify group needs nothing else', () => {
    expect(planGroupRemoval(gs, 'b')).toEqual({ ok: true, setNotifyId: null })
  })
  it('removing the notify group requires picking a new one when others remain', () => {
    expect(planGroupRemoval(gs, 'a')).toEqual({ ok: false, reason: 'must-pick-notify' })
    expect(planGroupRemoval(gs, 'a', 'c')).toEqual({ ok: true, setNotifyId: 'c' })
  })
  it('removing the only group is fine', () => {
    expect(planGroupRemoval([gs[0]], 'a')).toEqual({ ok: true, setNotifyId: null })
  })
  it('rejects a new notify id that is the removed group or not in the list', () => {
    expect(planGroupRemoval(gs, 'a', 'a')).toEqual({ ok: false, reason: 'must-pick-notify' })
    expect(planGroupRemoval(gs, 'a', 'zzz')).toEqual({ ok: false, reason: 'must-pick-notify' })
  })
})
