// src/lib/reasonText.js
// Reason code (from the pricing / assembly engines) -> Thai text. One map for every estimation screen.
export const REASON_TEXT = {
  no_as_of: 'ไม่มีวันที่ราคา', no_series: 'ยังไม่ได้เลือกซีรีส์', no_finish: 'ยังไม่ได้เลือกสี', no_profile: 'ไม่พบหน้าตัดที่ซีรีส์/ความหนานี้',
  no_provider: 'ไม่พบโรงรีด', finish_other_provider: 'สีเป็นของโรงรีดอื่น', no_kg_price: 'ไม่มีราคาต่อ กก.', no_weight: 'ไม่มีน้ำหนักต่อเมตร',
  no_dimension: 'ยังไม่ระบุขนาด', unknown_infill: 'ไม่พบวัสดุอุดช่อง', unknown_addon_template: 'ไม่พบแบบชุดต่อเติม',
  no_hardware_price: 'อุปกรณ์ไม่มีราคา', no_part_price: 'ชิ้นส่วนไม่มีราคา', unknown_set: 'ไม่พบชุดอุปกรณ์', not_hardware_set: 'ไม่ใช่ชุดอุปกรณ์',
  empty_set: 'ชุดอุปกรณ์ว่าง', unknown_joint: 'ไม่พบข้อต่อ', bad_manual_deduction: 'ค่าหักข้อต่อไม่ถูกต้อง', no_main_profile: 'ไม่พบหน้าตัดหลักของข้อต่อ',
  rule_not_cuttable: 'ตัดมุมไม่ได้',
}
export const reasonText = code => REASON_TEXT[code] || String(code || '')
