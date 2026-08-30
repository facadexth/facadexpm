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
    assign: 'edit',
    hr: 'edit',
    sites: 'none',
    expenses: 'none',
    purchase_orders: 'none',
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
    settings: 'none',
  },
  ADMIN: {
    dashboard: 'edit',
    assign: 'edit',
    hr: 'edit',
    sites: 'edit',
    expenses: 'edit',
    purchase_orders: 'edit',
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
    settings: 'none',
  },
  OWNER: {
    dashboard: 'edit',
    assign: 'edit',
    hr: 'edit',
    sites: 'edit',
    expenses: 'edit',
    purchase_orders: 'edit',
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
