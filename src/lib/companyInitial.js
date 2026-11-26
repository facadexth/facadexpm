// One-letter logo stand-in shared by the A4 sheets (ใบงานซ่อม, ใบงานประจำวัน).
// Legal-form prefixes dropped before taking the initial (longest first).
const COMPANY_PREFIX = /^\s*(?:ห้างหุ้นส่วนจำกัด|บริษัท|บจก\.|หจก\.|บมจ\.)\s*/
// Thai leading vowels (เ แ โ ใ ไ) are written before the consonant: never show one alone.
const LEADING_VOWEL = /^[\u0E40-\u0E44]+/
// Combining marks: Thai above/below vowels and tone marks, plus generic combining diacritics.
const COMBINING = /[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E\u0300-\u036F]/

// One-letter stand-in for a missing logo: 'บริษัท เฟซาด เอ็กซ์ จำกัด' -> 'ฟ'. The first grapheme
// cluster only (a consonant with its marks), never a lone vowel or tone mark.
export function companyInitial(name) {
  const raw = typeof name === 'string' ? name.trim() : ''
  let rest = raw.replace(COMPANY_PREFIX, '').trim() || raw
  rest = rest.replace(LEADING_VOWEL, '') || rest
  if (!rest) return ''
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const first = new Intl.Segmenter('th', { granularity: 'grapheme' }).segment(rest)[Symbol.iterator]().next().value
    return first ? first.segment : ''
  }
  const chars = Array.from(rest)
  let out = chars[0]
  for (let i = 1; i < chars.length && COMBINING.test(chars[i]); i++) out += chars[i]
  return out
}
