// _shared/pending-flow.ts -- rules for when the bot is "waiting for the worker's next message".
//
// After แจ้งปัญหา the bot waits, and the next message the worker sends becomes the problem
// report. Two guards keep that from catching things it should not:
//   1. A tap on a menu button is not a report. The Rich Menu buttons send plain text, so
//      without this the text "เช็คอิน/เช็คเอาท์" or "ขอลา" would be filed as a problem report
//      (and the button would do nothing). An EXACT match on a menu phrase interrupts the wait;
//      a real report that merely contains such a word ("ท่อรั่ว ต้องเบิกปูน") is still a report.
//   2. The wait is short for free text: an accidental tap should not turn the worker's chat
//      into reports for half an hour. Photo steps keep the longer window.

// The exact text each Rich Menu button / sub-menu chip sends.
export const MENU_BUTTON_PHRASES = [
  'เช็คอิน/เช็คเอาท์', 'เช็คอิน', 'เช็คเอาท์',
  'ตารางงาน', 'งานเสร็จ', 'แจ้งปัญหา', 'ขอเบิกของ', 'ขอลา',
]

// `schedulePhrases` = the company's current phrases for the four schedule views (they can rename them).
export function isMenuButtonText(text: string | undefined | null, schedulePhrases: string[] = []): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  return MENU_BUTTON_PHRASES.includes(t) || schedulePhrases.includes(t)
}

export const FREE_TEXT_WAIT_MINUTES = 10
export const DEFAULT_WAIT_MINUTES = 30

export function pendingWaitMinutes(action: string): number {
  return action === 'issue_report' ? FREE_TEXT_WAIT_MINUTES : DEFAULT_WAIT_MINUTES
}
