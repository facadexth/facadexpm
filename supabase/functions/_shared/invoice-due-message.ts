// _shared/invoice-due-message.ts -- ONE LINE message listing every site whose
// next invoice is due this month, instead of one message per site.
//
// A tenant with 26 sites used to cost 26 push messages every month on the 1st
// (per recipient), most of a free-plan quota. Now it is one. LINE text messages
// are capped at 5000 characters, so the list is cut off with a count of the rest.

export type DueSite = { name: string; site_number: string; billing_pct: number | null }

export const MAX_SITES_LISTED = 30
const MAX_CHARS = 4500

export function formatInvoiceDueDigest(sites: DueSite[]): string {
  const head = `🧾 ถึงกำหนดออกใบแจ้งหนี้งวดถัดไปเดือนนี้ ${sites.length} ไซท์`
  const lines = sites.slice(0, MAX_SITES_LISTED).map((s) => `• ${s.name} (${s.site_number}) เบิกแล้ว ${s.billing_pct ?? 0}%`)
  let shown = lines.length
  const build = () => {
    const rest = sites.length - shown
    return [head, ...lines.slice(0, shown), ...(rest > 0 ? [`…และอีก ${rest} ไซท์`] : [])].join('\n')
  }
  let text = build()
  while (text.length > MAX_CHARS && shown > 1) {
    shown -= 1
    text = build()
  }
  return text
}
