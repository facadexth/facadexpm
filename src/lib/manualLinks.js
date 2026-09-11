// ============================================================
// คู่มือ FacadeX -- self-hosted at public/manual/index.html (moved off
// the external Claude artifact so it's served from FacadeX's own domain
// and can carry the viewer's role for in-manual filtering). ปุ่ม 📖 ใน
// เฮดเดอร์ (App.jsx) เปิดหัวข้อที่ตรงกับหน้าที่ผู้ใช้กำลังดูอยู่ (activeTab)
// โดยตรง แทนที่จะเปิดหน้าแรกทุกครั้ง -- อัปเดต MANUAL_ANCHORS ตามหัวข้อ
// id ในตัวคู่มือเอง (id="..." ของแต่ละ section/article) ถ้าโครงสร้างคู่มือ
// เปลี่ยน. Role filtering itself lives in public/manual/index.html's own
// script (ANCHOR_ACCESS table there) -- keep it in sync with TABS'
// minRole/platformAdminOnly in App.jsx by hand if either changes.
// ============================================================
export const MANUAL_URL = '/manual/index.html'

export const MANUAL_ANCHORS = {
  dashboard:          'page-dashboard',
  assign:              'ch-hr-step2',
  sites:               'page-sites',
  deposits:            'page-deposits',
  retention:           'page-retention',
  expenses:            'ch-expense-step1',
  purchase_orders:     'ch-expense-step1',
  inventory:           'ch-expense-step2',
  cheques:             'page-cheques',
  income:              'ch-income-step2',
  sales_report:        'page-salesreport',
  quotations:          'ch-income-step1',
  invoices:            'ch-income-step2',
  labor_contractors:   'ch-labor-step1',
  settings:            'page-settings',
  hr:                  'ch-hr-step1',
  categories:          'page-categories-etc',
  clients:             'page-categories-etc',
  suppliers:           'page-categories-etc',
  catalog_items:       'page-categories-etc',
  user_management:     'page-users',
  tenant_management:   'page-tenant',
}

// role/isPlatformAdmin/theme are all optional -- omitted (e.g. a plain
// share link), the manual's own script fails open (shows everything) and
// just follows the visitor's own OS light/dark preference, same as before
// any of this existed.
export function manualUrlFor(pageKey, role, isPlatformAdmin, theme) {
  const anchor = MANUAL_ANCHORS[pageKey]
  const params = new URLSearchParams()
  if (role) params.set('role', role)
  if (isPlatformAdmin) params.set('platformAdmin', '1')
  if (theme === 'light' || theme === 'dark') params.set('theme', theme)
  const query = params.toString() ? `?${params.toString()}` : ''
  return anchor ? `${MANUAL_URL}${query}#${anchor}` : `${MANUAL_URL}${query}`
}
