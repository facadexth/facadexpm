// _shared/today-menu.ts -- the tappable chips under the "งานวันนี้" reply (the sub-menu).
//
// The Rich Menu stays three buttons (งานวันนี้ / ขอเบิกของ / ขอลา). Tapping งานวันนี้
// answers with today's site and tasks plus these chips, built from the worker's
// own state so only what makes sense right now is offered:
//   - เช็คอิน until they have checked in, then เช็คเอาท์ until they have checked
//     out, then neither (the day is done)
//   - งานเสร็จ only while they have an open task assigned
//   - แจ้งปัญหา always
//   - the "tomorrow's work" phrase, unless the company has turned that command off
// There is no photo chip: a photo sent to the bot is filed automatically.
// Each chip's text is the exact phrase the bot already understands, so tapping
// one runs the normal command.

export type TodayMenuState = {
  hasCheckedIn: boolean
  hasCheckedOut: boolean
  hasOpenTasks: boolean
  // The phrase that triggers tomorrow's schedule for this company, or null when
  // that command is disabled in direct chat.
  tomorrowPhrase: string | null
}

export function todayMenuOptions(s: TodayMenuState): string[] {
  const options: string[] = []
  if (!s.hasCheckedIn) options.push('เช็คอิน')
  else if (!s.hasCheckedOut) options.push('เช็คเอาท์')
  if (s.hasOpenTasks) options.push('งานเสร็จ')
  options.push('แจ้งปัญหา')
  if (s.tomorrowPhrase) options.push(s.tomorrowPhrase)
  return options
}
