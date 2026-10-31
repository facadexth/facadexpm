// Money rounding for payroll. round2 = satang; roundAmount applies a pay item's
// rounding mode on top of round2 so float noise (562.5000001) never ceils up.
export function round2(x) {
  return Math.round((Number(x) + Number.EPSILON) * 100) / 100
}

export function roundAmount(x, mode = 'none') {
  const v = round2(x)
  if (mode === 'ceil') return Math.ceil(v)
  if (mode === 'round') return Math.round(v)
  return v
}
