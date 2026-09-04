// ============================================================
// Per-role page permissions — client-side only (localStorage).
// Three levels per page: 'none' (hidden) | 'view' (read-only,
// tab visible but canEditPage() is false) | 'edit' (full access).
//
// NOT a security boundary: this only hides UI and toggles each
// page's own `canEdit` flag. The database (RLS) still only checks
// role (is_admin_or_owner()), so a WORKER/ADMIN set to 'view' here
// could still write via a direct API call. Fine for steering
// trusted staff away from mistakes; not a substitute for real
// per-user RLS if that's ever needed.
// ============================================================

export const PAGE_LABELS = {
  dashboard: '📊 ภาพรวม',
  assign: '📋 จ่ายงานช่าง',
  hr: '👷 บุคคล',
  sites: '🏗️ ไซท์งาน',
  expenses: '💸 รายจ่าย',
  purchase_orders: '🧾 ใบสั่งซื้อ',
  cheques: '🏦 เช็ค',
  quotations: '📋 ใบเสนอราคา',
  invoices: '🧾 ใบแจ้งหนี้',
  sales_report: '📊 รายงานการขาย',
  income: '💰 รายรับ',
  categories: '🏷️ หมวดหมู่',
  clients: '🏢 ลูกค้า',
  suppliers: '🏭 ผู้จำหน่าย',
  catalog_items: '📦 รายการสินค้า',
  labor_contractors: '🔧 ผู้รับเหมาค่าแรง',
  user_management: '👤 ผู้ใช้งาน',
  settings: '⚙️ ตั้งค่า',
}

export const DEFAULT_PERMISSIONS = {
  WORKER: {
    dashboard: 'edit',
    // 'view', not 'edit' -- src/pages/Assign.jsx and HR.jsx both hard-code
    // `isAtLeast('ADMIN') && canEditPage(...)` for their own canEdit, so a
    // WORKER's actual edit ability on these two pages is always false
    // regardless of what this table says (by design: WORKER only ever
    // sees their own schedule/record here, RLS enforces the same
    // restriction at the database level -- see each page's own comments).
    // This table previously said 'edit', which never matched real
    // behavior; corrected to describe what actually happens, not to
    // change it.
    assign: 'view',
    hr: 'view',
    sites: 'none',
    expenses: 'none',
    purchase_orders: 'none',
    cheques: 'none',
    quotations: 'none',
    invoices: 'none',
    sales_report: 'none',
    income: 'none',
    categories: 'none',
    clients: 'none',
    suppliers: 'none',
    catalog_items: 'none',
    labor_contractors: 'none',
    user_management: 'none',
    // 'edit', not 'none' -- src/pages/Settings.jsx itself now filters what
    // a WORKER sees on this page down to just the password-change card,
    // so the page-level gate here only needs to let them land on it at
    // all. This tri-state can't express "edit some cards, view others" on
    // a single shared page anyway; the real per-card restriction lives in
    // Settings.jsx's own isAtLeast() checks, not here.
    settings: 'edit',
  },
  ADMIN: {
    dashboard: 'edit',
    assign: 'edit',
    hr: 'edit',
    sites: 'edit',
    expenses: 'edit',
    purchase_orders: 'edit',
    cheques: 'edit',
    quotations: 'edit',
    invoices: 'edit',
    sales_report: 'edit',
    income: 'edit',
    categories: 'edit',
    clients: 'edit',
    suppliers: 'edit',
    catalog_items: 'edit',
    labor_contractors: 'edit',
    user_management: 'none',
    // Same reasoning as WORKER above -- Settings.jsx narrows ADMIN down to
    // the password + signature cards; this just needs to let them reach
    // the page.
    settings: 'edit',
  },
  OWNER: {
    dashboard: 'edit',
    assign: 'edit',
    hr: 'edit',
    sites: 'edit',
    expenses: 'edit',
    purchase_orders: 'edit',
    cheques: 'edit',
    quotations: 'edit',
    invoices: 'edit',
    sales_report: 'edit',
    income: 'edit',
    categories: 'edit',
    clients: 'edit',
    suppliers: 'edit',
    catalog_items: 'edit',
    labor_contractors: 'edit',
    user_management: 'edit',
    settings: 'edit',
  },
}

const STORAGE_KEY = 'role_permissions'
const LEVELS = ['none', 'view', 'edit']

/**
 * Reads role_permissions from localStorage, merged over DEFAULT_PERMISSIONS
 * so newly-added pages (e.g. purchase_orders) always have a value even in
 * browsers with an older saved blob. Also upgrades the pre-tri-state format
 * (plain booleans: true/false) transparently so existing saved settings
 * keep working instead of silently reverting to defaults.
 */
export function loadPermissions() {
  let raw = null
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    raw = saved ? JSON.parse(saved) : null
  } catch (e) {
    raw = null
  }

  const result = {}
  for (const role of Object.keys(DEFAULT_PERMISSIONS)) {
    result[role] = { ...DEFAULT_PERMISSIONS[role] }
    const savedRole = raw?.[role]
    if (savedRole) {
      for (const [page, val] of Object.entries(savedRole)) {
        if (typeof val === 'boolean') {
          result[role][page] = val ? 'edit' : 'none'
        } else if (LEVELS.includes(val)) {
          result[role][page] = val
        }
      }
    }
  }
  return result
}

export function savePermissions(permissions) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(permissions))
}

export function getPageLevel(role, pageKey) {
  if (!role) return 'edit'
  const perms = loadPermissions()
  return perms[role]?.[pageKey] ?? 'edit'
}

export function canViewPage(role, pageKey) {
  return getPageLevel(role, pageKey) !== 'none'
}

export function canEditPage(role, pageKey) {
  return getPageLevel(role, pageKey) === 'edit'
}
