// Role capabilities. PM is a sibling of ADMIN (site operations, no money), so
// pages ask "can this role do X" here instead of ranking roles in a line.
const HIERARCHY = { OWNER: 3, ADMIN: 2, WORKER: 1 }

export const ROLE_OPTIONS = ['OWNER', 'ADMIN', 'PM', 'WORKER']
export const ROLE_LABELS = { OWNER: 'เจ้าของ', ADMIN: 'แอดมิน', PM: 'PM (ผู้จัดการโครงการ)', WORKER: 'ช่าง' }

// ADMIN-level tabs a PM may open, by tab id. Never by permKey: the supplier
// credit-note and tax-invoice tabs share permKey 'purchase_orders'.
export const PM_TAB_IDS = new Set(['sites', 'site_detail', 'purchase_orders', 'inventory'])

export const isPm = role => role === 'PM'
export const canManageSites = role => role === 'OWNER' || role === 'ADMIN' || role === 'PM'
export const canSeeMoney = role => role === 'OWNER' || role === 'ADMIN'
export const canManageTeams = role => role === 'OWNER' || role === 'PM'
export const canApproveLeave = role => role === 'OWNER' || role === 'ADMIN' || role === 'PM'

export function roleMeetsTab(role, tab) {
  if (role === 'PM') return tab.minRole === 'WORKER' || PM_TAB_IDS.has(tab.id)
  return (HIERARCHY[role] ?? 0) >= (HIERARCHY[tab.minRole] ?? 0)
}

// Data hooks are plain functions without the role; App sets this once the role resolves.
let currentRole = null
export function setCurrentRole(role) { currentRole = role ?? null }
export function getCurrentRole() { return currentRole }
