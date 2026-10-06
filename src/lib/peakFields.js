export const isPeakAccountCode = s => /^\d{6}$/.test(String(s || '').trim())
export const isTaxId13 = s => /^\d{13}$/.test(String(s || '').trim())
export const isBranch5 = s => /^\d{5}$/.test(String(s || '').trim())

// Build the PEAK part of a save payload. A key is included only when the form
// value is non-blank, or when the record being edited already had a non-null
// value (so clearing it saves null). Otherwise it is omitted, so saves still
// work before the PEAK columns exist in the database.
export function pickPeakFields(form, original, keys) {
  const out = {}
  for (const k of keys) {
    const v = String(form?.[k] ?? '').trim()
    if (v) out[k] = v
    else if (original && original[k] != null) out[k] = null
  }
  return out
}
