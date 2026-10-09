// Pure view-model helpers for the price structure screen (no React/Supabase).
export const COLUMN_KEYS = ['alu', 'hardware', 'glass', 'labour', 'fireBarrier', 'bracket', 'bendAlu', 'bendGlass', 'other']
const EXTRA = new Set(['fireBarrier', 'bracket', 'bendAlu', 'bendGlass'])

export const COLUMN_LABELS = {
  alu: 'อลูมิเนียม', hardware: 'อุปกรณ์', glass: 'กระจก', labour: 'ค่าแรง',
  fireBarrier: 'Fire Barrier', bracket: 'Bracket', bendAlu: 'ดัดโค้ง ALU', bendGlass: 'ดัดโค้ง GL',
  other: 'วัสดุเสริม ซิลิโคน สักหลาด',
}
export const PRICE_LABELS = { v: 'รวมต้นทุน', w: 'เผื่อเสียเศษ', x: 'กำไร', z: 'ค่าขนส่ง', pm: 'PM' }

const n = x => { const v = Number(x); return Number.isFinite(v) ? v : 0 }
const r2 = x => Math.round(n(x) * 100) / 100

export function columnValue(row, key) {
  if (!row) return 0
  return n(EXTRA.has(key) ? row.extraCosts && row.extraCosts[key] : row.breakdown && row.breakdown[key])
}

export function visibleColumns(rows) {
  const ok = (rows || []).filter(r => r && r.resolved)
  return COLUMN_KEYS.filter(k => ok.some(r => columnValue(r, k) !== 0))
}

export function sumproductRow(rows, keys) {
  const ok = (rows || []).filter(r => r && r.resolved)
  const sum = f => ok.reduce((s, r) => s + f(r) * n(r.quantity), 0)
  const out = {}
  for (const k of new Set([...COLUMN_KEYS, ...(keys || [])])) out[k] = sum(r => columnValue(r, k))
  for (const k of ['v', 'w', 'x', 'y', 'z', 'pm', 'lineTotal']) out[k] = k === 'lineTotal' ? ok.reduce((s, r) => s + n(r.lineTotal), 0) : sum(r => n(r[k]))
  return out
}

export function costPieData(rows) {
  const sp = sumproductRow(rows, COLUMN_KEYS)
  return visibleColumns(rows).map(key => ({ key, label: COLUMN_LABELS[key], value: sp[key] })).filter(s => s.value !== 0)
}

export function pricePieData(totals) {
  const t = totals || {}
  return [['v', t.sumV], ['w', t.sumW], ['x', t.sumX], ['z', t.sumZ], ['pm', t.sumPm]]
    .map(([key, val]) => ({ key, label: PRICE_LABELS[key], value: n(val) })).filter(s => s.value !== 0)
}

export function glassHover(infillType) {
  if (!infillType) return null
  const perSqm = n(infillType.price_per_sqm)
  return { code: infillType.code || '', name: infillType.name || '', perSqm, perSqft: r2(perSqm * 0.09290304) }
}

export function weightSummary(totals) {
  const t = totals || {}
  return { net: r2(t.aluWeightNet), withWaste: r2(t.aluWeightWithWaste) }
}
