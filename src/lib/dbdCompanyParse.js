// ============================================================
// dbdCompanyParse — แยกชื่อ/ที่อยู่/เลขนิติบุคคล จากข้อความที่คัดลอกจากหน้า DBD
// ไม่เคยเห็นข้อความจริงของ DBD: อิง label ก่อน, heuristic รองลงมา, ไม่ throw, ไม่เจอ = null
// ============================================================

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙'

export function normalizeDigits(s) {
  return String(s ?? '').replace(/[๐-๙]/g, ch => String(THAI_DIGITS.indexOf(ch)))
}

// เลขประจำตัว 13 หลักตามสูตร: sum(d_i * (14-i)) i=1..12, check = (11 - sum%11) % 10
export function isValidThaiId13(raw) {
  const s = normalizeDigits(raw).replace(/[\s-]/g, '')
  if (!/^\d{13}$/.test(s)) return false
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (13 - i)
  return (11 - (sum % 11)) % 10 === Number(s[12])
}

const NAME_KEYWORDS = 'บริษัท|ห้างหุ้นส่วนจำกัด|ห้างหุ้นส่วนสามัญ|หจก\\.?|บจก\\.?'
const NAME_START = new RegExp('^(?:' + NAME_KEYWORDS + ')')
const NAME_ANY = new RegExp('(?:' + NAME_KEYWORDS + ')')
const NAME_LABEL = /^ชื่อ(?:นิติบุคคล|บริษัท|ห้างหุ้นส่วน)?(?:\s*\(ภาษาไทย\))?\s*[:：]?\s*/
const ADDR_LABEL = /^(?:ที่ตั้งสำนักงานแห่งใหญ่|ที่อยู่สำนักงานแห่งใหญ่|ที่ตั้ง|ที่อยู่)\s*[:：]?\s*(.*)$/
const KNOWN_LABELS = /^(?:ชื่อ(?:นิติบุคคล|บริษัท)?|เลขทะเบียน|เลขที่ทะเบียน|เลขประจำตัว|สถานะ|ทุนจดทะเบียน|ทุน|วันที่จดทะเบียน|วันที่|ประเภท|หมวด|วัตถุประสงค์|กรรมการ|ผู้มีอำนาจ|งบการเงิน|เบอร์|โทร|อีเมล|เว็บไซต์|ขนาดธุรกิจ|ปีที่)/
const GENERIC_LABEL = /^[^\s:：][^:：]{0,40}[:：]/
// 13 หลักติดกัน หรือจัดกลุ่มแบบไทย 1-4-5-2-1 (คั่นด้วยช่องว่างหรือ - เดียว); ห้ามขึ้นต้นกลางเลขที่ยาวกว่า/ต่อท้ายด้วยตัวเลข
const ID_RE = /(?<!\d-?)(\d{13}|\d[ -]\d{4}[ -]\d{5}[ -]\d{2}[ -]\d)(?!-?\d)/g

const ID_LINE = new RegExp(ID_RE.source)

function cleanLines(text) {
  return normalizeDigits(text)
    .replace(/\r/g, '')
    .replace(/[​ ]/g, ' ')
    .split('\n')
    .map(l => l.replace(/[ \t]+/g, ' ').trim())
}

function extractName(line) {
  let t = line.replace(NAME_LABEL, '').trim()
  const m = t.match(NAME_ANY)
  if (!m) return null
  t = t.slice(m.index)
  if (/^(?:บริษัท|บจก)/.test(t)) {
    const end = t.match(/จำกัด(?:\s*\(มหาชน\))?/)
    if (end) t = t.slice(0, end.index + end[0].length)
  }
  t = t.replace(/\s+/g, ' ').trim()
  if (t.length < 4 || t.length > 200) return null
  return t
}

function findNames(lines) {
  const names = []
  const push = n => { if (n && !names.includes(n)) names.push(n) }
  // 1) label based
  lines.forEach((l, i) => {
    if (/^ชื่อ(?:นิติบุคคล|บริษัท|ห้างหุ้นส่วน)/.test(l)) {
      let rest = l.replace(NAME_LABEL, '').trim()
      if (!rest) rest = lines.slice(i + 1).find(x => x) || ''
      push(extractName(rest))
    }
  })
  if (names.length) return names
  // 2) lines that begin with a company-type keyword
  lines.forEach(l => { if (NAME_START.test(l)) push(extractName(l)) })
  if (names.length) return names
  // 3) any line containing one (skip address lines)
  lines.forEach(l => { if (NAME_ANY.test(l) && !ADDR_LABEL.test(l)) push(extractName(l)) })
  return names
}

function findIds(lines) {
  const labeled = []
  const all = []
  lines.forEach((l, i) => {
    const isLabel = /เลขทะเบียน|เลขที่ทะเบียน|เลขประจำตัว|นิติบุคคลเลขที่/.test(l)
    const scan = isLabel && !ID_LINE.test(l) ? l + ' ' + (lines[i + 1] || '') : l
    for (const m of scan.matchAll(ID_RE)) {
      const id = m[1].replace(/[\s-]/g, '')
      if (!all.includes(id)) all.push(id)
      if (isLabel && !labeled.includes(id)) labeled.push(id)
    }
  })
  return { labeled, all }
}

const MAX_ADDR = 400
const ADDR_HEURISTIC = /(?:ตำบล|แขวง|ต\.)[\s\S]*(?:อำเภอ|เขต|อ\.)[\s\S]*(?:จังหวัด|จ\.|กรุงเทพ)[\s\S]*(?<!\d)\d{5}(?!\d)/

function findAddress(lines) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ADDR_LABEL)
    if (!m) continue
    const parts = []
    if (m[1]) parts.push(m[1])
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]
      if (!l) { if (parts.length) break; else continue }
      if (ADDR_LABEL.test(l) || KNOWN_LABELS.test(l) || GENERIC_LABEL.test(l) || NAME_START.test(l) || ID_LINE.test(l)) break
      parts.push(l)
    }
    const addr = parts.join(' ').replace(/\s+/g, ' ').trim()
    if (addr) return addr.slice(0, MAX_ADDR)
  }
  const h = lines.find(l => l.length <= 300 && ADDR_HEURISTIC.test(l))
  return h ? h.replace(ADDR_LABEL, '$1').trim().slice(0, MAX_ADDR) : null
}

// คืน { name, address, taxId, taxIdValid, multiple } — ค่าที่หาไม่เจอเป็น null
export function parseDbdText(text) {
  const out = { name: null, address: null, taxId: null, taxIdValid: null, multiple: false }
  try {
    if (!text || typeof text !== 'string') return out
    const lines = cleanLines(text.slice(0, 50000))
    const names = findNames(lines)
    const { labeled, all } = findIds(lines)
    out.name = names[0] || null
    const valid = all.filter(isValidThaiId13)
    const ids = [...labeled.filter(isValidThaiId13), ...valid, ...labeled, ...all]
    out.taxId = ids[0] || null
    out.taxIdValid = out.taxId ? isValidThaiId13(out.taxId) : null
    out.address = findAddress(lines)
    out.multiple = names.length > 1 || valid.length > 1
  } catch {
    // never throw
  }
  return out
}
