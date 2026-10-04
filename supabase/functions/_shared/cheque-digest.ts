// _shared/cheque-digest.ts -- one daily cheque reminder per person instead of one message per
// cheque. Pure (no network) so it can be unit-tested.

export type DueCheque = { cheque_no: string; bank: string; check_date: string }

export const MAX_CHEQUES_LISTED = 25
const LINE_TEXT_LIMIT = 4800

export function formatChequeDigest(cheques: DueCheque[]): string {
  const sorted = [...cheques].sort((a, b) => a.check_date.localeCompare(b.check_date))
  const lines = [`🏦 เช็คใกล้ครบกำหนด ${sorted.length} ใบ`]
  let length = lines[0].length
  let listed = 0
  for (const c of sorted.slice(0, MAX_CHEQUES_LISTED)) {
    const line = `• ${c.cheque_no} (${c.bank}) ครบ ${c.check_date}`.slice(0, 120)
    if (length + line.length + 1 > LINE_TEXT_LIMIT - 40) break
    lines.push(line)
    length += line.length + 1
    listed++
  }
  if (sorted.length > listed) lines.push(`…และอีก ${sorted.length - listed} ใบ ดูทั้งหมดที่หน้าเช็ค`)
  return lines.join('\n')
}

// Who gets which cheques: every owner gets all of them; the person who created a cheque
// also gets their own (unless they are an owner already). Returns recipient -> cheques.
export function groupChequesByRecipient<T extends { created_by: string | null }>(
  cheques: T[],
  ownerLineIds: string[],
  creatorLineId: (createdBy: string) => string | undefined,
): Map<string, T[]> {
  const out = new Map<string, T[]>()
  const add = (id: string, c: T) => { const list = out.get(id) ?? []; list.push(c); out.set(id, list) }
  for (const c of cheques) {
    const recipients = new Set<string>(ownerLineIds)
    const creator = c.created_by ? creatorLineId(c.created_by) : undefined
    if (creator) recipients.add(creator)
    for (const r of recipients) add(r, c)
  }
  return out
}
