// Message for a failed save in User Management.
//
// A "row-level security policy" error is the database refusing the write. It
// only means "too many admins for the package" when the package really is
// full; any other refusal (stale page, missing permission) used to be
// reported as a quota problem too, sending people to buy an upgrade they
// did not need.

export function friendlyUserError(e, { adminsFull = false } = {}) {
  const msg = e?.message || ''
  if (msg.includes('row-level security policy')) {
    return adminsFull
      ? 'บันทึกไม่สำเร็จ: เกินจำนวน Admin ที่แพ็กเกจปัจจุบันอนุญาต กรุณาติดต่อผู้ดูแลระบบเพื่ออัปเกรดแพ็กเกจ'
      : 'บันทึกไม่สำเร็จ: ระบบไม่อนุญาตให้ทำรายการนี้ กรุณารีเฟรชหน้าแล้วลองใหม่ ถ้ายังไม่ได้ให้ติดต่อ support@changpm.app หรือ LINE @changpm'
  }
  return 'Error: ' + msg
}
