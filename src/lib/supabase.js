// ============================================================
// Supabase client — ใส่ credentials ใน .env
// ============================================================
import { createClient } from '@supabase/supabase-js'

const URL = import.meta.env.VITE_SUPABASE_URL
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!URL || !KEY) {
  console.error('❌ Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env')
}

export const supabase = createClient(URL, KEY)

// ── Helpers ──────────────────────────────────────────────────

/** Format number เป็น Thai locale */
export const fmt = (n, decimals = 0) => {
  if (n == null || isNaN(n)) return '—'
  return Number(n).toLocaleString('th-TH', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

/** Format ตัวย่อ เช่น 1,500,000 → 1.5M */
export const fmtShort = (n) => {
  if (n == null) return '—'
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return fmt(n)
}

/** Format วันที่ */
export const fmtDate = (d) => {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('th-TH', {
    year: 'numeric', month: 'short', day: 'numeric'
  })
}

/** Countdown จากวันนี้ถึง targetDate */
export const countdown = (targetDate) => {
  if (!targetDate) return null
  const diff = Math.ceil((new Date(targetDate) - new Date()) / 86400000)
  return diff
}
