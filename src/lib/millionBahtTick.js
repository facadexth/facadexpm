// Short value-axis label in ล้านบาท (ลบ.) for narrow charts: 12,480,000 -> "12.5 ลบ.", 250,000 -> "0.25 ลบ.".
// Owner 2026-10-17: the phone S-curve axis showed "000,000.00" cut off.
export function millionBahtTick(v) {
  const n = Number(v) || 0
  if (n === 0) return '0'
  const m = n / 1e6
  const abs = Math.abs(m)
  const digits = abs >= 10 ? 0 : abs >= 1 ? 1 : 2
  return `${Number(m.toFixed(digits)).toLocaleString('en-US')} ลบ.`
}
