// ============================================================
// Thai juristic/tax ID helpers (the text-paste parser was removed; only these remain).
// Browser copy of the same functions in supabase/functions/_shared/company-lookup.ts;
// src/lib/companyLookup.test.js keeps the two in sync.
// ============================================================

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙'

export function normalizeDigits(s) {
  return String(s ?? '').replace(/[๐-๙]/g, ch => String(THAI_DIGITS.indexOf(ch)))
}

// เลขประจำตัว 13 หลักตามสูตร: sum(d_i * (14-i)) i=1..12, check = (11 - sum%11) % 10
export function isValidThaiId13(raw) {
  const s = normalizeDigits(raw).replace(/[\s-]/g, '')
  if (!/^\d{13}$/.test(s)) return false
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (13 - i)
  return (11 - (sum % 11)) % 10 === Number(s[12])
}
