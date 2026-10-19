// Pure date formatter, shared by the web app (src/lib/thaiDate.js) and the LINE bots.
// Owner decision 2026-10-20: dates show as dd/mm/yyyy with the Buddhist year (พ.ศ. = ค.ศ. + 543).

// 'YYYY-MM-DD' (or a longer ISO string starting with it) -> 'dd/mm/yyyy' in พ.ศ., e.g. '2026-10-19' -> '19/10/2569'.
// Slices the string, never parses it with Date, so no timezone can shift the day. null/invalid -> '—'.
export function formatThaiDate(ymd: string | null | undefined): string {
  if (!ymd) return '—'
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd))
  if (!m) return '—'
  return `${m[3]}/${m[2]}/${Number(m[1]) + 543}`
}
