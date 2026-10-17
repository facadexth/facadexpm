// Receiving banks for SCB SPN/SPS payroll (reference doc §2.7) with account
// lengths and branch-derivation rules (§1.6, read from the KBank template).
// F3 = first 3 digits; zero-padded to 4 here because SCB wants exactly 4.
export const BANKS = [
  { code: '002', name: 'กรุงเทพ', lengths: [10], branch: ['F3'] },
  { code: '004', name: 'กสิกรไทย', lengths: [10], branch: ['F3'] },
  { code: '006', name: 'กรุงไทย', lengths: [10], branch: ['F3'] },
  { code: '011', name: 'ทหารไทยธนชาต (ttb)', lengths: [10], branch: ['F3'] },
  { code: '014', name: 'ไทยพาณิชย์', lengths: [10], branch: ['F3'] },
  { code: '017', name: 'ซิตี้แบงก์', lengths: [10], branch: ['0001'] },
  { code: '020', name: 'สแตนดาร์ดชาร์เตอร์ด', lengths: [10, 11], branch: ['F3', 'F3'] },
  { code: '022', name: 'ซีไอเอ็มบี ไทย', lengths: [10], branch: ['F3'] },
  { code: '024', name: 'ยูโอบี', lengths: [10], branch: ['F3'] },
  { code: '025', name: 'กรุงศรีอยุธยา', lengths: [10], branch: ['F3'] },
  { code: '030', name: 'ออมสิน', lengths: [12, 15], branch: ['999F', 'F4'] },
  { code: '031', name: 'HSBC', lengths: [11, 12], branch: ['0001', '0001'] },
  { code: '033', name: 'อาคารสงเคราะห์', lengths: [12], branch: ['F3'] },
  { code: '034', name: 'ธ.ก.ส.', lengths: [10, 12], branch: ['0000', '0000'] },
  { code: '066', name: 'อิสลามแห่งประเทศไทย', lengths: [10, 12], branch: ['F3', 'M3,3'] },
  { code: '067', name: 'ทิสโก้', lengths: [14], branch: ['F4'] },
  { code: '069', name: 'เกียรตินาคินภัทร', lengths: [10, 14], branch: ['F4', 'F4'] },
  { code: '070', name: 'ไอซีบีซี (ไทย)', lengths: [10, 14, 16], branch: ['F3', 'F3', 'F3'] },
  { code: '071', name: 'ไทยเครดิต', lengths: [10], branch: ['F3'] },
  { code: '073', name: 'แลนด์ แอนด์ เฮ้าส์', lengths: [10], branch: ['F4'] },
]

export const bankByCode = code => BANKS.find(b => b.code === code) || null

export function scbCheckDigitOk(acct) {
  const s = String(acct || '').replace(/-/g, '').trim()
  if (!/^\d{10}$/.test(s)) return false
  const w = [4, 3, 2, 7, 6, 5, 4, 3, 2]
  const sum = w.reduce((t, wi, i) => t + ((Number(s[i]) * wi) % 10), 0)
  return (10 - (sum % 10)) % 10 === Number(s[9])
}

export function suggestBranch(code, acct) {
  const b = bankByCode(code)
  const s = String(acct || '')
  if (!b || !/^\d+$/.test(s)) return null
  const i = b.lengths.indexOf(s.length)
  if (i < 0) return null
  const rule = b.branch[i]
  if (rule === 'F3') return '0' + s.slice(0, 3)
  if (rule === 'F4') return s.slice(0, 4)
  if (rule === '999F') return '999' + s[0]
  if (rule === 'M3,3') return '0' + s.slice(2, 5)
  return rule
}

export function validateAccount(code, acct) {
  const s = String(acct || '')
  if (!/^\d+$/.test(s)) return 'กรอกเลขบัญชีเป็นตัวเลข'
  const b = bankByCode(code)
  if (b && !b.lengths.includes(s.length)) return `เลขบัญชี${b.name}ต้องมี ${b.lengths.join(' หรือ ')} หลัก`
  if (code === '014' && !scbCheckDigitOk(s)) return 'เลขบัญชีไทยพาณิชย์ไม่ถูกต้อง (เลขตรวจสอบไม่ตรง)'
  return null
}
