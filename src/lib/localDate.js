// src/lib/localDate.js
// 'YYYY-MM-DD' in the viewer's LOCAL time zone. A Postgres DEFAULT current_date is the UTC date, which is the
// wrong day for a Thai user before 07:00, so price_as_of is always set from here at project creation.
export function localDateString(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
