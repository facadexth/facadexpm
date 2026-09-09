// ============================================================
// คู่มือ FacadeX (Artifact ภายนอก) -- ปุ่ม 📖 ในเฮดเดอร์ (App.jsx) เปิดหัวข้อ
// ที่ตรงกับหน้าที่ผู้ใช้กำลังดูอยู่ (activeTab) โดยตรง แทนที่จะเปิดหน้าแรกทุกครั้ง
// -- อัปเดต MANUAL_ANCHORS ตามหัวข้อ id ในตัวคู่มือเอง (id="..." ของแต่ละ
// section/article) ถ้าโครงสร้างคู่มือเปลี่ยน
// ============================================================
export const MANUAL_URL = 'https://claude.ai/code/artifact/f6b3d1c0-2d49-4d9c-b793-fa1645a5b883'

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

export function manualUrlFor(pageKey) {
  const anchor = MANUAL_ANCHORS[pageKey]
  return anchor ? `${MANUAL_URL}#${anchor}` : MANUAL_URL
}
