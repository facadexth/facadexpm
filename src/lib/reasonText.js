// src/lib/reasonText.js
// Reason code (from the pricing / assembly engines) -> Thai text. One map for every estimation screen.
export const REASON_TEXT = {
  no_as_of: 'ไม่มีวันที่ราคา', no_series: 'ยังไม่เลือกซีรีส์', no_finish: 'ยังไม่เลือกสี', no_profile: 'ไม่พบหน้าตัดความหนานี้',
  no_provider: 'ไม่พบโรงรีด', finish_other_provider: 'สีเป็นของโรงรีดอื่น', no_kg_price: 'ยังไม่มีราคา', no_price: 'ยังไม่มีราคา',
  no_variant: 'ยังไม่มีราคาต่อเส้น', no_piece_price: 'ยังไม่มีราคาต่อเส้น', no_weight: 'ไม่มีน้ำหนักต่อเมตร',
  no_dimension: 'ยังไม่ได้กรอกขนาด', unknown_infill: 'ไม่พบวัสดุอุดช่อง', unknown_addon_template: 'ไม่พบเทมเพลตชุดต่อเติม',
  no_hardware_price: 'อุปกรณ์ไม่มีราคา', no_part_price: 'ชิ้นส่วนไม่มีราคา', unknown_set: 'ไม่พบชุดอุปกรณ์', not_hardware_set: 'ไม่ใช่ชุดอุปกรณ์',
  empty_set: 'ชุดอุปกรณ์ว่าง', unknown_joint: 'ไม่พบข้อต่อ', bad_manual_deduction: 'ค่าหักข้อต่อไม่ถูกต้อง', no_main_profile: 'ไม่พบหน้าตัดหลักของข้อต่อ',
  rule_not_cuttable: 'ตัดมุมไม่ได้',
}
export const reasonText = code => REASON_TEXT[code] || String(code || '')

// One entry of costOpening().unresolved ({ name, reason, source }) as Thai text. 'no_dimension' means two things:
// a size the owner has not typed (main / add-on) or a joint's main profile that has no catalog dimension.
export function unresolvedText(u) {
  const e = u || {}
  if (e.reason === 'no_dimension' && e.source === 'joint') return 'ไม่มีมิติของหน้าตัดเส้นหลัก'
  return reasonText(e.reason)
}
