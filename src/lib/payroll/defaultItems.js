// JS mirror of seed_default_pay_items() (migration 2026-10-17-01). ids are the
// system_key so tests can reference items by key; the DB uses uuids and stores
// percent_of_item references as params.of_item_id = <uuid>.
export const DEFAULT_PAY_ITEMS = [
  { id: 'salary', system_key: 'salary', name: 'เงินเดือน', side: 'earning', method: 'base_pay', params: {}, sso_base: true, rounding: 'none', applies_to: 'all', sort_order: 10, active: true },
  { id: 'contribution', system_key: 'contribution', name: 'สมทบ', side: 'earning', method: 'percent_of_item', params: { percent: 5, of_item_id: 'salary' }, sso_base: true, rounding: 'none', applies_to: 'monthly', sort_order: 20, active: true },
  { id: 'phone', system_key: 'phone', name: 'โทรศัพท์', side: 'earning', method: 'fixed_per_worker', params: {}, sso_base: true, rounding: 'none', applies_to: 'all', sort_order: 30, active: true },
  { id: 'ot', system_key: 'ot', name: 'OT', side: 'earning', method: 'ot', params: { multiplier: 1.5 }, sso_base: false, rounding: 'ceil', applies_to: 'all', sort_order: 40, active: true },
  { id: 'parking', system_key: 'parking', name: 'เงินพิเศษค่าจอดรถ', side: 'earning', method: 'fixed_per_worker', params: {}, sso_base: false, rounding: 'none', applies_to: 'all', sort_order: 50, active: true },
  { id: 'sso', system_key: 'sso', name: 'ประกันสังคม', side: 'deduction', method: 'sso', params: { rate: 0.05, cap: 875 }, sso_base: false, rounding: 'round', applies_to: 'all', sort_order: 110, active: true },
  { id: 'house', system_key: 'house', name: 'ค่าบ้าน', side: 'deduction', method: 'fixed_per_worker', params: {}, sso_base: false, rounding: 'none', applies_to: 'all', sort_order: 120, active: true },
  { id: 'advances', system_key: 'advances', name: 'เบิกล่วงหน้า', side: 'deduction', method: 'advances', params: {}, sso_base: false, rounding: 'none', applies_to: 'all', sort_order: 130, active: true },
  { id: 'student_loan', system_key: 'student_loan', name: 'กยศ', side: 'deduction', method: 'manual_monthly', params: {}, sso_base: false, rounding: 'none', applies_to: 'all', sort_order: 140, active: true },
  { id: 'unpaid_leave', system_key: 'unpaid_leave', name: 'ลาไม่รับค่าจ้าง', side: 'deduction', method: 'unpaid_leave', params: { daily_rate_rounding: 'ceil' }, sso_base: false, rounding: 'none', applies_to: 'monthly', sort_order: 150, active: true },
  { id: 'contribution_deduct', system_key: 'contribution_deduct', name: 'หักเงินสมทบ', side: 'deduction', method: 'percent_of_item', params: { percent: 100, of_item_id: 'contribution' }, sso_base: false, rounding: 'none', applies_to: 'monthly', sort_order: 160, active: true },
]
