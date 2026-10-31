// Pure rules for linking / unlinking LINE groups (spec 2026-10-12). No I/O.
export type ClaimDecision =
  | { action: 'insert'; isNotify: boolean }
  | { action: 'already-linked' }
  | { action: 'refuse-other-tenant' }
  | { action: 'refuse-cap' }

export function decideGroupClaim(i: {
  alreadyLinkedTenantId: string | null; claimingTenantId: string; canAdd: boolean; existingCount: number
}): ClaimDecision {
  if (i.alreadyLinkedTenantId) {
    return i.alreadyLinkedTenantId === i.claimingTenantId ? { action: 'already-linked' } : { action: 'refuse-other-tenant' }
  }
  if (!i.canAdd) return { action: 'refuse-cap' }
  return { action: 'insert', isNotify: i.existingCount === 0 }
}

export function planGroupRemoval(
  groups: { id: string; is_notify: boolean }[], removeId: string, newNotifyId?: string,
): { ok: true; setNotifyId: string | null } | { ok: false; reason: 'must-pick-notify' } {
  const target = groups.find(g => g.id === removeId)
  const others = groups.filter(g => g.id !== removeId)
  if (!target?.is_notify || others.length === 0) return { ok: true, setNotifyId: null }
  if (newNotifyId && others.some(g => g.id === newNotifyId)) return { ok: true, setNotifyId: newNotifyId }
  return { ok: false, reason: 'must-pick-notify' }
}
