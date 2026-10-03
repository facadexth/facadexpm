// _shared/schedule-menu.ts -- logic for two Rich Menu buttons.
//
// The Rich Menu (set up in LINE Official Account Manager) is 2 rows x 3:
//   เช็คอิน/เช็คเอาท์ | ตารางงาน | งานเสร็จ
//   แจ้งปัญหา         | ขอเบิกของ | ขอลา
// A button sends its label as text, and the bot reads it like typed text.
// Two of them need decisions the bot makes itself:
//   - "เช็คอิน/เช็คเอาท์" is ONE button for two actions, so the bot looks at the
//     worker's day and sends the right link (or says they are done).
//   - "ตารางงาน" answers with tappable chips for the four schedule views.

export const TIME_CLOCK_PHRASE = 'เช็คอิน/เช็คเอาท์'
export const SCHEDULE_MENU_PHRASE = 'ตารางงาน'
export const SCHEDULE_MENU_PROMPT = '📅 อยากดูงานช่วงไหนครับ? กดเลือกได้เลย'
export const TIME_CLOCK_DONE_MESSAGE = '✅ วันนี้เช็คเอาท์เรียบร้อยแล้วครับ พบกันพรุ่งนี้'

export type TimeClockStep = 'no_site' | 'check_in' | 'check_out' | 'done'

export function timeClockStep(s: { hasSite: boolean; hasCheckedIn: boolean; hasCheckedOut: boolean }): TimeClockStep {
  if (!s.hasSite) return 'no_site'
  if (!s.hasCheckedIn) return 'check_in'
  if (!s.hasCheckedOut) return 'check_out'
  return 'done'
}

// One entry per schedule view, in the order they should appear. A view the company
// turned off for direct chat is left out; the phrase is the company's own (they may
// have renamed it), so tapping the chip sends exactly what the bot listens for.
export function scheduleMenuChips(choices: Array<{ phrase: string | undefined; enabled: boolean }>): string[] {
  return choices.filter((c) => c.enabled && !!c.phrase).map((c) => c.phrase as string)
}
