// Short value-axis label for narrow charts: a million and up in ล้านบาท (12,480,000 -> "12 ลบ.", 2,500,000 ->
// "2.5 ลบ."); below a million the plain amount without decimals (250,000 -> "250,000").
// Owner 2026-10-17: the phone S-curve axis showed "000,000.00" cut off; tens/hundreds of thousands stay unabbreviated.
export function millionBahtTick(v) {
  const n = Number(v) || 0
  if (n === 0) return '0'
  if (Math.abs(n) < 1e6) return Math.round(n).toLocaleString('en-US')
  const m = n / 1e6
  const digits = Math.abs(m) >= 10 ? 0 : 1
  return `${Number(m.toFixed(digits)).toLocaleString('en-US')} ลบ.`
}
