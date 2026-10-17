// Payroll dates are calendar strings ('YYYY-MM-DD'). Never go through
// toISOString() (UTC) — under UTC+7 that dropped the last day of every month.
export const MONTHS_TH = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.']

const pad = n => String(n).padStart(2, '0')

export function monthRange(year, month) {
  const lastDay = new Date(year, month, 0).getDate()
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(lastDay)}`, lastDay }
}

export function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).getDay()
}

export function periodLabel(year, month) {
  const { lastDay } = monthRange(year, month)
  return `1–${lastDay} ${MONTHS_TH[month - 1]} ${year + 543}`
}

export function comparePeriod(a, b) {
  return (a.year * 12 + a.month) - (b.year * 12 + b.month)
}
