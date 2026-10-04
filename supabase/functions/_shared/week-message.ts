// _shared/week-message.ts -- wording of the "งานอาทิตย์นี้/งานอาทิตย์หน้า" chat messages.
// Pure formatting (no network) so it can be unit-tested.
//
// One block per day: a date header, then each site with who works there, split by
// shift. A day with nothing assigned says so on one line. The whole message stays
// under LINE's 5000-character text limit; days that do not fit are cut with a note.

export type WeekSite = { siteName: string; siteNumber?: string; morning: string[]; evening: string[] }
export type WeekDay = { dateLabel: string; sites: WeekSite[] }

const LINE_TEXT_LIMIT = 4800

const names = (list: string[]) => [...new Set(list)].join(', ')

function dayBlock(day: WeekDay, showWorkers: boolean): string {
  const lines = [`📆 ${day.dateLabel}`]
  if (!day.sites.length) {
    lines.push('   💤 ว่าง')
    return lines.join('\n')
  }
  for (const s of day.sites) {
    lines.push(`📍 ${s.siteNumber ? `${s.siteNumber} ` : ''}${s.siteName}`.trim())
    if (!showWorkers) continue
    if (s.morning.length) lines.push(`   🌅 เช้า: ${names(s.morning)}`)
    if (s.evening.length) lines.push(`   🌆 บ่าย: ${names(s.evening)}`)
  }
  return lines.join('\n')
}

export function formatWeekMessage(weekLabel: string, days: WeekDay[], showWorkers = true): string {
  const header = `📅 ${weekLabel}\n━━━━━━━━━━━━`
  const out = [header]
  let length = header.length
  for (let i = 0; i < days.length; i++) {
    const block = dayBlock(days[i], showWorkers)
    if (length + block.length + 2 > LINE_TEXT_LIMIT) {
      out.push(`… (ยังมีอีก ${days.length - i} วัน ข้อความยาวเกินไป ดูทั้งหมดในแอป)`)
      break
    }
    out.push(block)
    length += block.length + 2
  }
  return out.join('\n\n')
}
