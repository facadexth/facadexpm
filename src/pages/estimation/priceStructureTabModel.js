// Pure helpers for the price structure tab (no React/Supabase).

// What the profit cell shows and what a commit does. item.profit_pct null/blank = follows the project.
export const isOwnProfit = v => !(v === null || v === undefined || (typeof v === 'string' && v.trim() === ''))

// Text shown in the untick input: the draft while the user is typing, else the saved value.
export function profitInputValue(itemProfit, draft) {
  if (draft !== null && draft !== undefined) return draft
  return isOwnProfit(itemProfit) ? String(itemProfit) : ''
}

// Commit of the typed text. Returns { action: 'noop' | 'write' | 'error', value?, message? }.
export const MAX_PCT = 1000
export const MAX_PCT_MESSAGE = 'เปอร์เซ็นต์ต้องไม่เกิน 1,000'

export function nextProfitCellState(raw, itemProfit) {
  const text = String(raw ?? '').trim()
  if (text === '') return { action: 'error', message: 'กรอกกำไร (%) เป็นตัวเลข หรือติ๊ก "ตามโปรเจกต์"' }
  const x = Number(text)
  if (!Number.isFinite(x) || x < 0) return { action: 'error', message: 'กำไร (%) ต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป' }
  if (x > MAX_PCT) return { action: 'error', message: MAX_PCT_MESSAGE }
  if (isOwnProfit(itemProfit) && Number(itemProfit) === x) return { action: 'noop' }
  return { action: 'write', value: x }
}

// Average aluminium cost per kg, '—'-safe: null when there is no weight.
export const avgAluPerKg = (aluCost, kg) => (Number(kg) > 0 && Number.isFinite(Number(aluCost)) ? Number(aluCost) / Number(kg) : null)

export const SQFT_PER_SQM = 10.7639
