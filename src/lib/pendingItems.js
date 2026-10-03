// What the notification badges and bell show. The counts come from the
// pending_counts() database function (migration 2026-10-03-06); this file says
// what each count is called, which page it lives on, and who may see it.

export const PENDING_ITEMS = [
  { key: 'leave_pending',       icon: '🏖️', label: 'คำขอลารออนุมัติ',                    tab: 'hr' },
  { key: 'po_draft',            icon: '📦', label: 'ใบสั่งซื้อฉบับร่าง รอเลือกซัพพลายเออร์', tab: 'purchase_orders' },
  { key: 'issues_open',         icon: '🚧', label: 'แจ้งปัญหาจากหน้างานที่ยังไม่แก้',        tab: 'sites' },
  { key: 'cheques_due',         icon: '🏦', label: 'เช็คใกล้ครบกำหนด',                    tab: 'cheques' },
  { key: 'invoices_due',        icon: '🧾', label: 'ไซท์ที่ถึงกำหนดออกใบแจ้งหนี้เดือนนี้',    tab: 'invoices' },
  { key: 'quotations_followup', icon: '📋', label: 'ใบเสนอราคาถึงวันติดตาม',               tab: 'quotations' },
]

// Items that have something waiting AND whose page this user can open.
// `canSeeTab(tabId)` is the app's own gate (role, module, per-role permission),
// so a badge never points at a page the user cannot reach.
export function visiblePendingItems(counts, canSeeTab) {
  if (!counts) return []
  return PENDING_ITEMS
    .map(item => ({ ...item, count: Number(counts[item.key]) || 0 }))
    .filter(item => item.count > 0 && canSeeTab(item.tab))
}

export function totalPending(items) {
  return items.reduce((sum, i) => sum + i.count, 0)
}

// tab id -> number waiting on that page.
export function badgeByTab(items) {
  const out = {}
  for (const i of items) out[i.tab] = (out[i.tab] || 0) + i.count
  return out
}

// A group header ("รายรับ") shows the sum of its sub-tabs.
export function badgeForTab(tab, byTab) {
  if (tab.children) return tab.children.reduce((s, c) => s + (byTab[c.id] || 0), 0)
  return byTab[tab.id] || 0
}

// "99+" so a big number cannot break the nav layout.
export function formatBadge(n) {
  if (!n || n < 1) return ''
  return n > 99 ? '99+' : String(n)
}
