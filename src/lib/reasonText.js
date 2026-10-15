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
  // part-model templates (partExpand)
  no_butt_distance: 'โปรไฟล์ที่ชนไม่มีระยะชน (ตั้งที่แคตตาล็อก)', no_butt_target: 'ปลายชนยังไม่ได้เลือกว่าชนโปรไฟล์ไหน',
  no_profile_family: 'ตำแหน่งนี้ยังไม่ได้เลือกโปรไฟล์', corner_violation: 'มุมต่อไม่ถูกต้อง (ต้องวิ่งสุด 1 ชิ้น ชน 1 ชิ้น)',
  no_model: 'ยังไม่มีแบบชิ้นส่วนของเทมเพลต',
  no_profile_width: 'ไม่มีความกว้างโปรไฟล์ของซอยกลาง/mullion (ใส่ width_mm ที่แคตตาล็อก)',
  layout_mismatch: 'แบบชิ้นส่วนของเทมเพลตไม่ตรงกับแบบชิ้นส่วนของประเภทบาน', unknown_layout: 'ไม่รู้จักแบบชิ้นส่วนของเทมเพลตนี้',
  layout_params_invalid: 'ค่าของแบบชิ้นส่วนใช้ไม่ได้ (เช่น จำนวนบานรวมเป็น 0)',
  // inline add-ons ช่องแสง (openingCost.addonPlan / addonExpand)
  addon_conflict: 'มีชุดต่อเติมแบบเดิมอยู่แล้ว ลบหรือแปลงก่อนจึงใช้ช่องแสงแบบใหม่',
  addon_not_loaded: 'โหลดข้อมูลช่องแสงไม่สำเร็จ ยังไม่ได้คิดราคาช่องแสง',
  addon_needs_layout: 'template นี้ไม่ได้ใช้ part editor จึงใส่ช่องแสงไม่ได้',
  addon_out_of_range: 'ช่องแสงยาวหรือเยื้องเกินขอบบานหลัก',
  addon_piece_too_small: 'ชิ้นส่วนช่องแสงสั้นกว่าระยะหัก',
}
export const reasonText = code => REASON_TEXT[code] || String(code || '')

// One entry of costOpening().unresolved ({ name, reason, source }) as Thai text. 'no_dimension' means two things:
// a size the owner has not typed (main / add-on) or a joint's main profile that has no catalog dimension.
export function unresolvedText(u) {
  const e = u || {}
  if (e.reason === 'no_dimension' && e.source === 'joint') return 'ไม่มีมิติของหน้าตัดเส้นหลัก'
  return reasonText(e.reason)
}
