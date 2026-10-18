// Pure helpers for the LINE payslip link (field-form 'payslip' token). No I/O,
// so vitest can import this file directly.

// The link shows the current Bangkok month and the 11 before it.
export function payslipWindow(todayIso: string) {
  const [y, m] = todayIso.split('-').map(Number)
  const fromKey = y * 12 + (m - 1) - 11
  return {
    from: { year: Math.floor(fromKey / 12), month: (fromKey % 12) + 1 },
    to: { year: y, month: m },
  }
}

export function inPayslipWindow(win: ReturnType<typeof payslipWindow>, year: number, month: number): boolean {
  const k = year * 12 + month
  return k >= win.from.year * 12 + win.from.month && k <= win.to.year * 12 + win.to.month
}

// Same rule as useYearToDate on the web: earnings = every earning line,
// sso = pay item method 'sso', contrib = pay item system_key 'contribution_deduct'.
// Each line carries its pay item as `pay_items: {method, system_key}`.
export function pickYtd(lines: Array<{ side: string; amount: number | string; pay_items?: { method?: string | null; system_key?: string | null } | null }>) {
  const sum = (ls: typeof lines) => ls.reduce((s, l) => s + Number(l.amount), 0)
  return {
    earnings: sum(lines.filter(l => l.side === 'earning')),
    sso: sum(lines.filter(l => l.pay_items?.method === 'sso')),
    contrib: sum(lines.filter(l => l.pay_items?.system_key === 'contribution_deduct')),
  }
}
