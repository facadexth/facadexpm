// What the notification badges and bell show. The counts come from the
// pending_counts() database function (migration 2026-10-03-06); this file says
// what each count is called, which page it lives on, and who may see it.

export const PENDING_ITEMS = [
  { key: 'leave_pending',       icon: '🏖️', label: 'คำขอลารออนุมัติ',                    tab: 'hr' },
  { key: 'advances_pending',    icon: '💸', label: 'คำขอเบิกเงินรออนุมัติ',                tab: 'hr' },
  { key: 'po_draft',            icon: '📦', label: 'ใบสั่งซื้อฉบับร่าง รอเลือกซัพพลายเออร์', tab: 'purchase_orders' },
  // The list of ALL open problem reports is on the Communication Center page (owner only);
  // an ADMIN, who cannot open it, is sent to the Sites page, where each day's reports are.
  { key: 'issues_open',         icon: '🚧', label: 'แจ้งปัญหาจากหน้างานที่ยังไม่แก้',        tab: 'communication_center', fallbackTabs: ['sites'] },
  { key: 'cheques_due',         icon: '🏦', label: 'เช็คใกล้ครบกำหนด',                    tab: 'cheques' },
  // OWNER only in practice: the Communication Center is owner-only and there is no fallback page.
  { key: 'offboarded_in_group', icon: '⚠️', label: 'ช่างพ้นสภาพ รอลบออกจากกลุ่ม LINE', tab: 'communication_center' },
  // Customers who messaged the tenant's own LINE OA asking for a quote or a repair (owner only in practice,
  // like offboarded_in_group: the Communication Center is owner-only).
  { key: 'customer_requests_open', icon: '💬', label: 'ลูกค้าทักทาง LINE', tab: 'communication_center' },
  { key: 'quotations_followup', icon: '📋', label: 'ใบเสนอราคาใกล้หมดวันยืนราคา',          tab: 'quotations' },
]

// Items that have something waiting AND whose page this user can open.
// `canSeeTab(tabId)` is the app's own gate (role, module, per-role permission),
// so a badge never points at a page the user cannot reach.
export function visiblePendingItems(counts, canSeeTab) {
  if (!counts) return []
  return PENDING_ITEMS
    .map(item => ({ ...item, count: Number(counts[item.key]) || 0 }))
    .filter(item => item.count > 0)
    // Point at the first page the user can open (the item's own page, then its fallbacks).
    .map(item => ({ ...item, tab: [item.tab, ...(item.fallbackTabs || [])].find(canSeeTab) }))
    .filter(item => item.tab)
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

export function pendingItemByKey(key) {
  return PENDING_ITEMS.find(i => i.key === key) || null
}

// Which page a notification about `key` opens for THIS user: the item's own page, then
// its fallbacks, whichever the user can see first. Unknown key or nothing visible ->
// the tab the push payload named (the app's access gate redirects if even that is closed).
export function resolvePendingTab(key, canSeeTab, fallbackTab = null) {
  const item = pendingItemByKey(key)
  if (!item) return fallbackTab
  return [item.tab, ...(item.fallbackTabs || [])].find(canSeeTab) || fallbackTab
}

// A closed app is launched from a Web Push tap at `/#tab=<id>&pending=<key>` (push-handler.js).
export function parsePushHash(hash) {
  const m = /^#tab=([\w-]+)(?:&pending=([\w-]+))?$/.exec(hash || '')
  if (!m) return null
  return { tab: m[1], pending: pendingItemByKey(m[2]) ? m[2] : null }
}
