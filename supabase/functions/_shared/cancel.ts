// _shared/cancel.ts -- the "ยกเลิก" way out of a LINE menu or a half-finished request.
//
// LINE has no close button on the tappable chips the bot shows, and some requests
// leave the bot waiting for the worker's next message (e.g. after แจ้งปัญหา, the next
// text they send is taken as the problem report for 30 minutes). A "ยกเลิก" chip under
// every such prompt lets the worker back out; sending it also clears whatever the bot
// was waiting for, and the bot's short reply (free: replies do not use the monthly
// message quota) makes the chips disappear.

export const CANCEL_PHRASE = 'ยกเลิก'
export const CANCEL_CHIP = { label: 'ยกเลิก', text: CANCEL_PHRASE }
export const CANCEL_REPLY = 'ยกเลิกแล้วครับ'

// Exact match on purpose: a sentence that merely contains the word (for example
// "ขอยกเลิกวันลา") must keep going through the normal command matching.
export function isCancel(text: string | undefined | null): boolean {
  return (text ?? '').trim() === CANCEL_PHRASE
}
