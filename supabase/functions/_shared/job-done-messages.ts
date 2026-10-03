// _shared/job-done-messages.ts -- wording for the LINE "งานเสร็จ" flow.
//
// Photos are optional: a worker has often already posted them in the crew group
// (or sent them to the bot, where they are filed automatically), so making them
// send the same photos again just creates duplicates. "เสร็จแล้ว" closes the task
// with or without photos; the reply shows a photo count only when there was one.

export const JOB_DONE_CONFIRM_CHIP = { label: 'เสร็จแล้ว', text: 'เสร็จแล้ว' }

export function jobDonePrompt(taskName: string): string {
  return `"${taskName}" เสร็จแล้วใช่ไหมครับ กด "เสร็จแล้ว" ได้เลย หรือส่งรูปงานก่อนก็ได้ (ไม่ต้องส่งซ้ำถ้าส่งในกลุ่มแล้ว)`
}

export function jobDoneConfirmation(taskName: string, photoCount: number): string {
  const photos = photoCount > 0 ? ` (${photoCount} รูป)` : ''
  return `✅ บันทึกงานเสร็จแล้ว "${taskName}"${photos} อัปเดตบอร์ดเรียบร้อยครับ`
}
