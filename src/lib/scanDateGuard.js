// Decides whether a scanned document date may fill the PO form's date.
// The model misreads handwritten Thai years (19/09/2026 became 2018, other
// POs became 2021), so the scan only fills an EMPTY date with a plausible
// value and never overwrites what the user chose.

export const SCAN_DATE_PAST_DAYS = 120
export const SCAN_DATE_FUTURE_DAYS = 14

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** true only for a real calendar date written YYYY-MM-DD. */
export function isValidIsoDate(s) {
  if (typeof s !== 'string') return false
  const m = ISO_RE.exec(s)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

const dayNumber = iso => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000)

/** YYYY-MM-DD -> dd/mm/yyyy (Gregorian, as the date input shows it); anything else is returned unchanged. */
export function formatIsoDmy(s) {
  const m = ISO_RE.exec(s || '')
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(s || '')
}

/**
 * @returns {{apply:boolean, date:string, reason:string, showNote:boolean}}
 * date = the value the form should hold afterwards.
 */
export function decideScanDate({ guess, currentDate, today }) {
  const current = currentDate || ''
  if (!guess) return { apply: false, date: current, reason: 'no_guess', showNote: false }
  if (current && guess === current) return { apply: false, date: current, reason: 'same', showNote: false }
  if (!isValidIsoDate(guess)) return { apply: false, date: current, reason: 'invalid', showNote: true }
  if (current) return { apply: false, date: current, reason: 'user_date', showNote: true }
  const plausible = isValidIsoDate(today)
    && dayNumber(guess) >= dayNumber(today) - SCAN_DATE_PAST_DAYS
    && dayNumber(guess) <= dayNumber(today) + SCAN_DATE_FUTURE_DAYS
  if (!plausible) return { apply: false, date: current, reason: 'implausible', showNote: true }
  return { apply: true, date: guess, reason: 'ok', showNote: false }
}
