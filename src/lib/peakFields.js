export const isPeakAccountCode = s => /^\d{6}$/.test(String(s || '').trim())
export const isTaxId13 = s => /^\d{13}$/.test(String(s || '').trim())
export const isBranch5 = s => /^\d{5}$/.test(String(s || '').trim())
