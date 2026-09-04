// Thai number-to-words (บาทถ้วน style) -- used on the withholding-tax
// certificate's "เงินภาษีที่นำส่ง (ตัวอักษร)" line, which the Revenue
// Department form requires spelled out, not just numeric.
const DIGIT_WORDS = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า']
// Index = position within a 6-digit group, counting from the right
// (0=units, 1=tens, 2=hundreds, 3=thousands, 4=ten-thousands, 5=hundred-thousands).
// Every 6 digits, the pattern repeats with a "ล้าน" (million) multiplier.
const POSITION_WORDS = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน']

// digitStr must be a plain non-negative integer string with no leading
// zeros (except "0" itself) and no separators.
function thaiIntegerWords(digitStr) {
  if (digitStr === '0') return DIGIT_WORDS[0]
  const digits = digitStr.split('').map(Number)
  const len = digits.length
  let result = ''
  for (let i = 0; i < len; i++) {
    const digit = digits[i]
    const posFromRight = len - i - 1
    const posInGroup = posFromRight % 6
    if (digit !== 0) {
      if (posInGroup === 0) {
        // เอ็ด replaces หนึ่ง ONLY at the true last digit of the whole
        // number (posFromRight === 0) when there's anything before it --
        // NOT at the units digit of a higher ล้าน-group (e.g. the "1" in
        // 1,000,000 stays "หนึ่ง" -- "หนึ่งล้าน", never "เอ็ดล้าน").
        result += (posFromRight === 0 && digit === 1 && len > 1) ? 'เอ็ด' : DIGIT_WORDS[digit]
      } else if (posInGroup === 1) {
        // ยี่สิบ replaces สองสิบ; a bare "สิบ" drops the leading หนึ่ง.
        result += digit === 1 ? 'สิบ' : digit === 2 ? 'ยี่สิบ' : DIGIT_WORDS[digit] + 'สิบ'
      } else {
        result += DIGIT_WORDS[digit] + POSITION_WORDS[posInGroup]
      }
    }
    if (posInGroup === 0 && posFromRight > 0) result += 'ล้าน'
  }
  return result
}

/** e.g. thaiBahtText(1234.5) -> "หนึ่งพันสองร้อยสามสิบสี่บาทห้าสิบสตางค์" */
export function thaiBahtText(amount) {
  const rounded = Math.round((Number(amount) || 0) * 100) / 100
  const baht = Math.floor(rounded)
  const satang = Math.round((rounded - baht) * 100)
  const bahtWords = thaiIntegerWords(String(baht)) + 'บาท'
  return satang === 0 ? bahtWords + 'ถ้วน' : bahtWords + thaiIntegerWords(String(satang)) + 'สตางค์'
}
