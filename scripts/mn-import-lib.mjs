// MN (บจก. แม่น้ำเมทอลซัพพลาย) catalogue import: pure normalisation + model building + SQL/report rendering.
// Used by scripts/gen-mn-import.mjs; tested by scripts/mn-import-lib.test.mjs. No I/O here, so the output is
// deterministic for the same inputs (no random ids, no dates from the clock, stable sort orders everywhere).

export const PROVIDER = { name: 'บจก. แม่น้ำเมทอลซัพพลาย', short_name: 'MN', price_basis: 'per_piece' }
export const EFFECTIVE_FROM = '2024-06-17' // price book file name "PriceList2024 (2567-06-17)"; the book prints no other date
export const PRICE_SOURCE = 'MN price list 2024 เล่ม 14'
export const CATALOGUE_SOURCE = 'MN catalogue 2021'
export const DEFAULT_LENGTH_M = 6.4
export const TENANT_ID = '1b9affc4-2136-4ed1-b168-a36e6624e743' // FacadeX tenant (the NOTICE prints its company_name)
export const FINISH_ORDER = ['ขาว', 'ชาอ่อน', 'ชาเข้ม', 'ชาดำ', 'สีพ่น', 'ลายไม้', 'ชุบขาว', 'สีชุบดำ']

// ---------- normalisation helpers ----------

// Die numbers: the price book and the guides print "MN-U2515", "MN U2515" or "U2515"; the 2021 catalogue drops the
// "MN-" prefix. Only a prefix followed by "-" or a space is removed ("MN30435" is left alone: dropping "MN" there
// would guess a die). Inner spaces are removed, letters upper-cased. Empty -> null.
export function normDie(raw) {
  if (raw === null || raw === undefined) return null
  let s = String(raw).trim().toUpperCase()
  if (!s) return null
  s = s.replace(/^MN[-\s]+/, '')
  s = s.replace(/\s+/g, '')
  return s || null
}

// A price-book thickness cell: a number, null (not printed), or text. Text that is a plain decimal is accepted;
// anything else ("Mill", '5/8"') is invalid and the row is excluded.
export function parseThickness(v) {
  if (v === null || v === undefined || v === '') return { ok: true, value: null }
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? { ok: true, value: v } : { ok: false, value: null }
  const s = String(v).trim()
  if (/^\d+(\.\d+)?$/.test(s) && Number(s) > 0) return { ok: true, value: Number(s) }
  return { ok: false, value: null }
}

// Finish column names are imported exactly as printed; 'N/A' is not a finish.
export function normFinish(name) {
  if (name === null || name === undefined) return null
  const s = String(name).trim()
  if (!s || /^n\/?a$/i.test(s)) return null
  return s
}

// Most common printed length; a tie prefers 6.4, then the longer bar. No length printed -> 6.4 (assumed).
export function pickDefaultLength(lengths) {
  const counts = new Map()
  for (const l of lengths || []) if (l !== null && l !== undefined && Number(l) > 0) counts.set(Number(l), (counts.get(Number(l)) || 0) + 1)
  if (!counts.size) return { length_m: DEFAULT_LENGTH_M, assumed: true }
  const best = [...counts].sort((a, b) => b[1] - a[1] || (b[0] === DEFAULT_LENGTH_M) - (a[0] === DEFAULT_LENGTH_M) || b[0] - a[0])[0]
  return { length_m: best[0], assumed: false }
}

export function q(v) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('non-finite number'); return String(v) }
  if (typeof v === 'boolean') return String(v)
  return `'${String(v).replace(/'/g, "''")}'`
}

const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

// ---------- hand-written mapping (owner-visible in the report) ----------

// Catalogue groups (index in mn-aluminium-profile-2021.json series[]) -> series name (heading as printed, die-range
// remarks dropped) + door/window types that are unambiguous.
export const CATALOGUE_SERIES = [
  { idx: 0, name: 'GROUP 01 ท่อ/ฉาก/ตัว U/เส้นแบน มาตรฐาน', types: [] },
  { idx: 1, name: 'SHOPFRONT 4" กล่อง 101.6x44.45', types: ['บานติดตาย'] },
  { idx: 2, name: 'SHOPFRONT 4"x2" กล่อง 101.6x50.8', types: ['บานติดตาย'] },
  { idx: 3, name: 'SF20 SHOPFRONT', types: ['บานติดตาย'] },
  { idx: 4, name: 'SHOPFRONT 4"x1" 101.6x25.4', types: ['บานติดตาย'] },
  { idx: 5, name: 'SHOPFRONT 101.6x20', types: ['บานติดตาย'] },
  { idx: 6, name: 'T-SLOT SOLID BARS', types: [] },
  { idx: 7, name: 'SHOPFRONT 3" 76.2x38.1', types: ['บานติดตาย'] },
  { idx: 8, name: 'SHOPFRONT 5" / 6"', types: ['บานติดตาย'] },
  { idx: 9, name: 'GLAZING BEAD คิ้วใส่กระจก', types: [] },
  { idx: 10, name: 'SWING DOOR ประตูบานสวิง', types: ['บานสวิงเดี่ยว', 'บานสวิงคู่'] },
  { idx: 11, name: 'SW20 SWING DOOR', types: ['บานสวิงเดี่ยว', 'บานสวิงคู่'] },
  { idx: 12, name: 'FLY SCREEN (CASEMENT) มุ้งบานเปิด', types: [] },
  { idx: 13, name: 'HANGING SLIDING RAIL บานเลื่อนรางแขวน', types: ['บานเลื่อนรางแขวน'] },
  { idx: 14, name: 'FRAMELESS DOOR ประตูบานเปลือย', types: ['บานสวิงเปลือยเดี่ยว', 'บานสวิงเปลือยคู่'] },
  { idx: 15, name: 'AUTOMATIC SLIDING DOOR ฝาครอบประตูอัตโนมัติ', types: [] },
  { idx: 16, name: 'FOLDING DOOR ประตูบานเฟี้ยม', types: ['บานเฟี้ยม'] },
  { idx: 17, name: 'SLIDING WINDOW 2 ราง 71.5 + 1 ราง 36.35', types: [] },
  { idx: 18, name: 'SLIDING 95 มม. ชุดบานเลื่อนมาตรฐาน', types: ['บานเลื่อนสวน 2 บาน'] },
  { idx: 19, name: 'BOX-FRAME SLIDING 4" กล่อง 4" มีรางในตัว', types: ['บานเลื่อนสวน 2 บาน'] },
  { idx: 20, name: 'BOX-FRAME SLIDING 4"x1.75" (ร่องบาน 29.5)', types: ['บานเลื่อนสวน 2 บาน'] },
  { idx: 21, name: 'SLIDING 105.5 มม.', types: ['บานเลื่อนสวน 2 บาน'] },
  { idx: 22, name: 'SLIDING DOOR 101.6-103 มม.', types: [] },
  { idx: 23, name: 'SLIDING 3 ราง 109.8', types: ['บานเลื่อน 3 บาน'] },
  { idx: 24, name: 'SLIDING FRAMES 101.6 / 130 / 151.9', types: [] },
  { idx: 25, name: 'SLIDING DOOR SASH หนา 38 มม. ร่อง 12', types: [] },
  { idx: 26, name: 'EURO SERIES SLIDING DOOR ประตูบานเลื่อนยูโร', types: [] },
  { idx: 27, name: 'FLY SCREEN (SLIDING) มุ้งบานเลื่อน', types: [] },
  { idx: 28, name: 'LIFTING WINDOW หน้าต่างบานยก', types: [] },
  { idx: 29, name: 'AWNING-CASEMENT 36.63', types: ['บานกระทุ้ง'] },
  { idx: 30, name: 'AWNING กรอบนอก 4" ในตัว', types: ['บานกระทุ้ง'] },
  { idx: 31, name: 'AWNING 36.5 / 48.5', types: ['บานกระทุ้ง'] },
  { idx: 32, name: 'AWNING 56.3', types: ['บานกระทุ้ง'] },
  { idx: 33, name: 'AWNING 3"', types: ['บานกระทุ้ง'] },
  { idx: 34, name: 'CASEMENT 45/52', types: ['บานเปิดข้าง'] },
  { idx: 35, name: 'CASEMENT 4" (วงกบ 101.6x44.45)', types: ['บานเปิดข้าง'] },
  { idx: 36, name: 'PIVOT WINDOW หน้าต่างบานหมุน', types: [] },
  { idx: 37, name: 'CURTAIN WALL ผนังกระจก (stick)', types: ['STICK WALL'] },
  { idx: 38, name: 'CURTAIN WALL (CASEMENT) บานเปิดในผนังกระจก', types: [] },
  { idx: 39, name: 'LOUVER - SUNSHADE เกล็ดระบายอากาศ-แผงบังแดด', types: [] },
  { idx: 40, name: 'SPANDREL ลูกฟูก', types: [] },
  { idx: 41, name: 'CLADDING / ROOFING / T-CEILING / BALUSTRADE / MISC (GROUP 07)', types: [] },
]

// Installation-guide systems (file slug + series index) -> series name as printed on the guide.
// skipDies: dies printed in a conflicting way (not linked, listed in the report). skipPages: an alternative list.
export const SYSTEM_SERIES = [
  { file: 'mn01', idx: 0, name: 'ชุดบานเลื่อน MN-4173B', types: ['บานเลื่อนสวน 2 บาน'] },
  { file: 'mn01', idx: 1, name: 'ชุดบานเลื่อน MINI EURO', types: ['บานเลื่อนสวน 2 บาน'] },
  { file: 'mn01', idx: 2, name: 'ชุดบานเลื่อน MN-4075 (3 ราง)', types: ['บานเลื่อน 3 บาน'], skipDies: ['U4775A', 'U4457A'] },
  { file: 'mn02', idx: 0, name: 'ชุดบานเลื่อนชุดใหญ่ MN-40303 / MN-42943', types: [] },
  { file: 'mn02', idx: 1, name: 'ชุดบานเลื่อนชุดใหญ่ MN-42500 (130)', types: [] },
  { file: 'mn02', idx: 2, name: 'ชุดบานเลื่อนชุดใหญ่ MN-41479 (3 ราง)', types: ['บานเลื่อน 3 บาน'] },
  { file: 'mn02', idx: 3, name: 'ชุดบานเลื่อน EURO THAI', types: [] },
  { file: 'mn03', idx: 0, name: 'ชุดบานเลื่อน MN-7464 EURO 4" (2 ราง)', types: ['บานเลื่อนสวน 2 บาน'] },
  { file: 'mn03', idx: 1, name: 'ชุดบานเลื่อน MN-7463 EURO 4" (3 ราง)', types: ['บานเลื่อน 3 บาน'] },
  { file: 'mn04', idx: 0, name: 'ชุดบานเลื่อน MN-U7125 EURO2021 (2 ราง)', types: ['บานเลื่อนสวน 2 บาน'] },
  { file: 'mn04', idx: 1, name: 'ชุดบานเลื่อน MN-U7126 EURO2021 (3 ราง)', types: ['บานเลื่อน 3 บาน'] },
  { file: 'mn05', idx: 0, name: 'ชุดบานเลื่อน MN-TS148 HEAVY DUTY', types: ['บานเลื่อนสวน 2 บาน'] },
  { file: 'mn06', idx: 0, name: 'ชุดบานกระทุ้ง UNION (UN)', types: ['บานกระทุ้ง'] },
  { file: 'mn06', idx: 1, name: 'ชุดบานกระทุ้ง 2" MN-50662 / MN-50690', types: ['บานกระทุ้ง'] },
  { file: 'mn07', idx: 0, name: 'ชุดหน้าต่างบานเปิดยูโร MN-50624', types: ['บานเปิดข้าง'] },
  { file: 'mn07', idx: 1, name: 'ชุดหน้าต่างบานเปิดยูโร MN-7601 (มุ้ง + ช่องแสง)', types: ['บานเปิดข้าง'] },
  { file: 'mn08', idx: 0, name: 'ชุดประตูบานเปิดวงกบไม้ MN-1778', types: ['บานเปิด'] },
  { file: 'mn09', idx: 0, name: 'ชุดประตูบานเปิดเดี่ยว + ช่องแสง MN-50166', types: ['บานเปิด'] },
  { file: 'mn10', idx: 0, name: 'ชุดประตูบานเปิด HEAVY DUTY MN-7855', types: ['บานเปิด'] },
  { file: 'mn11', idx: 0, name: 'ชุดบานเฟี้ยม (101.6)', types: ['บานเฟี้ยม'] },
  { file: 'mn11', idx: 1, name: 'ชุดบานเฟี้ยมนอก FQ', types: ['บานเฟี้ยม'] },
  { file: 'mn12', idx: 0, name: 'ชุดคานผลักประตูหนีไฟ MN-30457 / MN-30458', types: [] },
  { file: 'mn13', idx: 0, name: 'ชุด ULTRA SLIM MN-7112', types: [] },
  { file: 'mn13', idx: 1, name: 'ชุดประตูบานเปิด + ช่องแสงสลิม MN-30457', types: ['บานเปิด'] },
  { file: 'mn13', idx: 2, name: 'ชุดประตูบานเปิด MN-3513 / MN-30083 (วงกบบาง)', types: ['บานเปิด'] },
  { file: 'mn14', idx: 0, name: 'ชุดประตูรางแขวน MN-U6359', types: ['บานเลื่อนรางแขวน'], skipPages: [5] },
  { file: 'mn14', idx: 1, name: 'ชุดประตูบานเลื่อน AUTOMATIC MN-U3393', types: [] },
  { file: 'mn15', idx: 0, name: 'ราวกันตก ลูกกรง MN-BH035', types: [] },
  { file: 'mn15', idx: 1, name: 'ราวกันตก กระจก MN-BH034', types: [] },
]

// Types the source names but that are not linked, with the reason (report only).
export const AMBIGUOUS_TYPES = [
  ['SLIDING WINDOW 2 ราง 71.5 + 1 ราง 36.35', 'บานเลื่อนสวน 2 บาน / บานเลื่อนรางล่าง', 'กลุ่มนี้มีทั้งชุด 2 ราง และ 1 ราง ปนกัน'],
  ['SLIDING 95 มม. ชุดบานเลื่อนมาตรฐาน', 'บานเลื่อน 2 ตาย 2, บานเลื่อนรางล่าง', 'แคตตาล็อกไม่บอกว่าใช้กับ 2 ตาย 2 / รางล่าง ได้; ผูกแค่ บานเลื่อนสวน 2 บาน'],
  ['SLIDING DOOR 101.6-103 มม.', 'บานเลื่อนสวน 2 บาน (ประตู)', 'เป็นชุดประตู แต่แอปมี type บานเลื่อนสวน 2 บาน ตัวเดียว ไม่แยกประตู/หน้าต่าง'],
  ['SLIDING FRAMES 101.6 / 130 / 151.9', 'ประตูบานเลื่อน (Big Frame)', 'ไม่มี type ประตูบานเลื่อนแยก; 2 ราง และ 3 ราง ปนกัน'],
  ['SLIDING DOOR SASH หนา 38 มม. ร่อง 12', 'ประตูบานเลื่อน (Big Frame)', 'มีแต่บาน ไม่มีวงกบ'],
  ['EURO SERIES SLIDING DOOR ประตูบานเลื่อนยูโร', 'ประตูบานเลื่อนยูโร', 'ไม่มี type นี้ในแอป'],
  ['AWNING-CASEMENT 36.63 / AWNING 36.5 / 48.5', 'บานเปิด', 'ผูกแค่ บานกระทุ้ง; บานเปิด (ประตู) ไม่ชัด'],
  ['CASEMENT 4" (วงกบ 101.6x44.45)', 'บานกระทุ้ง', 'ผูกแค่ บานเปิดข้าง'],
  ['ชุดบานเลื่อน MN-4173B', 'บานเลื่อน 4 บาน (คู่กลาง), ประตูบานเลื่อน', 'ไม่มี type 4 บานคู่กลาง; ประตู/หน้าต่าง ไม่แยก'],
  ['ชุดบานเลื่อนชุดใหญ่ MN-40303 / MN-42943, MN-42500 (130), EURO THAI', 'ประตูบานเลื่อนสวน 2 บาน (+ มุ้ง)', 'เป็นชุดประตู; แอปไม่มี type ประตูบานเลื่อนแยก'],
  ['ชุดบานเลื่อน MN-7463 EURO 4" (3 ราง)', 'บานเลื่อนสวน 2 บาน + มุ้ง, บานเลื่อน 6 บาน', 'ผูกแค่ บานเลื่อน 3 บาน'],
  ['ชุดบานกระทุ้ง 2" MN-50662 / MN-50690', 'บานเปิดข้าง (หน้าต่าง)', 'คู่มือเรียก SWING DOOR CASEMENT 2" — ไม่ชัดว่าใช้เป็นบานเปิดข้าง'],
  ['ชุดคานผลักประตูหนีไฟ MN-30457 / MN-30458', 'ประตูหนีไฟ / บานเปิด', 'ไม่มี type ประตูหนีไฟ'],
  ['ชุด ULTRA SLIM MN-7112', 'บานเปิด, บานเลื่อนรางแขวน, ผนังกระจกภายใน', 'ชุดเดียวใช้ได้หลายแบบ'],
  ['ชุดประตูบานเลื่อน AUTOMATIC MN-U3393', 'ประตูบานเลื่อนอัตโนมัติ', 'ไม่มี type นี้ในแอป'],
  ['ราวกันตก MN-BH035 / MN-BH034', 'ราวกันตก', 'ไม่มี type นี้ในแอป'],
  ['FLY SCREEN, LIFTING WINDOW, PIVOT WINDOW, LOUVER, SPANDREL, CLADDING, GLAZING BEAD, T-SLOT, GROUP 01', '-', 'ไม่มี type ที่ตรง หรือเป็นชิ้นประกอบของทุกแบบ'],
]

// MN family (role) -> the family the existing BOM templates use (provider "ไฟล์ Aluminium calculation"). Report only.
export const FAMILY_MAP = [
  ['เฟรมบน 2 ราง', 'เฟรมบน (สวน 2 บาน ทั่วไป) / รางบนบิ๊กเฟรม (Big Frame)'],
  ['เฟรมล่าง 2 ราง', 'เฟรมล่าง / รางล่างบิ๊กเฟรม2ราง'],
  ['เฟรมข้าง 2 ราง', 'เฟรมข้าง / รางข้างบานเลื่อน'],
  ['ขวางบน (บานเลื่อน)', 'บานเลื่อนบน / ขวางบนบานเลื่อน'],
  ['ขวางล่าง (บานเลื่อน)', 'บานเลื่อนล่าง / ขวางล่างบานเลื่อน'],
  ['เสากุญแจ', 'เสากุญแจ / เสากุญแจบานเลื่อน'],
  ['เสาเกี่ยว', 'เสาเกี่ยว / เสาเกี่ยวบานเลื่อน'],
  ['ตบธรณี', 'ตบธรณี'],
  ['กล่องร่อง', 'กล่องร่อง'],
  ['กล่องเรียบ', 'กล่องเรียบ'],
  ['กล่องเปิด', 'กล่องเปิดปิด'],
  ['ฝาเปิดปิด', 'ฝาเปิดปิด'],
  ['ฝาตบร่อง', 'ตบร่อง'],
  ['ฝาปิด', 'ตบเรียบ (ไม่แน่ใจ: ฝาปิดของ MN มีหลายแบบ)'],
  ['กรอบนอกบานกระทุ้ง', 'กรอบนอกกระทุ้ง'],
  ['กรอบในบานกระทุ้ง', 'กรอบในกระทุ้ง+คิ้ว (ของเดิมรวมคิ้ว; MN แยกคิ้วเป็นอีกเส้น)'],
  ['เสาบานประตู', 'เสาประตูสวิง'],
  ['ขวางบน (ประตู)', 'เสาบนสวิง'],
  ['ขวางล่าง (ประตู)', 'เสาล่างสวิง'],
  ['ธรณี', 'ธรณีสวิง'],
  ['คิ้ว', 'คิ้วประตู / คิ้วบาน 3" / คิ้วยูโร (ตามชุด)'],
  ['รางแขวน', 'รางแขวนใหญ่'],
  ['รางบน / รางล่าง / รางข้าง (บานเฟี้ยม)', 'รางบน / รางล่าง / รางข้าง'],
  ['กรอบบาน', 'กรอบบาน 3" (บานเฟี้ยม) / บานหน้าต่างยูโร (ยูโร)'],
  ['บังใบนอก / บังใบใน', 'บังใบนอก 3" / บังใบใน 3"'],
  ['กรอบมุ้ง', 'กรอบมุ้งบานเลื่อน'],
  ['เสาผนังกระจก / ขวางผนังกระจก / แผ่นกดกระจก', 'NO.9010 / NO.9023 / NO.9019 ... (ของเดิมใช้เลข die เป็นชื่อ family)'],
]

// ---------- model building ----------

function roleIsGuess(p) { return /role \(family\) is a guess/i.test(p.note || '') }
function kgIsSuspect(p) { return /misprint/i.test(p.note || '') }
const clean1 = (s) => String(s).replace(/\s+/g, ' ').trim()

// Guide role vs catalogue role for one die. 'same'; 'compatible' when one names the other more precisely
// (กรอบบานยูโร starts with กรอบบาน, "ขวางบน/ขวางล่าง" lists ขวางล่าง, เฟรมยูโร 2 ราง ~ เฟรมบน 2 ราง); otherwise 'conflict'
// (e.g. เสากุญแจ vs เสาเกี่ยว). A missing role on either side is 'compatible'.
export function roleVerdict(setRole, catRole) {
  const a = clean1(setRole || ''), b = clean1(catRole || '')
  if (!a || !b) return a === b ? 'same' : 'compatible'
  if (a === b) return 'same'
  if (a.split('/').map(x => x.trim()).includes(b)) return 'compatible'
  if (a.startsWith(b) || b.startsWith(a)) return 'compatible'
  const tracks = (x) => (/(\d) ราง/.exec(x) || [])[1]
  if (/^เฟรม/.test(a) && /^เฟรม/.test(b) && tracks(a) && tracks(a) === tracks(b) && /ยูโร/.test(a)) return 'compatible'
  return 'conflict'
}

function assertUnique(list, keyOf, what) {
  const seen = new Set()
  for (const x of list) { const k = keyOf(x); if (seen.has(k)) throw new Error(`duplicate ${what}: ${k}`); seen.add(k) }
}

export function buildImport({ catalog, pricebook, sets }) {
  const excludedProfiles = []   // { key, die, name, reason }
  const familyNulled = []       // { die, name, role }
  const profiles = new Map()    // key -> profile
  const catIndexByDie = new Map()

  // 1. profiles from the 2021 catalogue
  catalog.series.forEach((s, si) => {
    for (const p of s.profiles) {
      const die = normDie(p.die_no)
      const thickness = p.wall_mm === null || p.wall_mm === undefined ? null : Number(p.wall_mm)
      const key = die || `NODIE|${clean1(p.name)}|${thickness ?? ''}`
      const base = { key, die, name: clean1(p.name), page: p.page }
      if (p.confidence !== 'read') { excludedProfiles.push({ ...base, reason: `catalogue confidence "${p.confidence}"` }); continue }
      if (kgIsSuspect(p)) { excludedProfiles.push({ ...base, reason: `kg/m ${p.kg_per_m} น่าจะพิมพ์ผิด (${p.note})` }); if (die) catIndexByDie.set(die, { excluded: true }); continue }
      if (!(Number(p.kg_per_m) >= 0) || p.kg_per_m === null) { excludedProfiles.push({ ...base, reason: 'no kg/m' }); continue }
      if (profiles.has(key)) { excludedProfiles.push({ ...base, reason: `duplicate key ${key} (first kept, page ${profiles.get(key).page})` }); continue }
      let family = clean1(p.role_family || '') || null
      if (family && roleIsGuess(p)) { familyNulled.push({ die, name: base.name, role: family }); family = null }
      const prof = {
        ...base, family, thickness_mm: thickness, kg: Number(p.kg_per_m),
        width_mm: p.width_mm > 0 ? Number(p.width_mm) : null, depth_mm: p.depth_mm > 0 ? Number(p.depth_mm) : null,
        catSeries: si, lengths: [],
      }
      profiles.set(key, prof)
      if (die) catIndexByDie.set(die, prof)
    }
  })

  // 2. prices (บาท/เส้น) from the price book
  const priceExcl = []  // { die, item, set, page, reason, n }
  const cand = new Map() // die|finish|length -> { prices:Set, rows:[] }
  for (const s of pricebook.series) {
    for (const r of s.prices || []) {
      const die = normDie(r.die_no)
      const ex = (reason) => priceExcl.push({ die, item: r.item === null || r.item === undefined ? null : clean1(r.item), set: s.name, page: r.page, finish: r.finish, reason })
      if (r.confidence !== 'read') { ex('estimated (OCR อ่านไม่ชัด)'); continue }
      if (!die) { ex('ไม่มีเลข die (มีแต่ชื่อรายการ)'); continue }
      const prof = catIndexByDie.get(die)
      if (!prof) { ex('die ไม่มีในแคตตาล็อก 2021 (ไม่มี กก./ม.)'); continue }
      if (prof.excluded) { ex('หน้าตัดถูกตัดออก (kg/m น่าจะพิมพ์ผิด)'); continue }
      const finish = normFinish(r.finish)
      if (!finish) { ex('สีผิว N/A'); continue }
      const th = parseThickness(r.thickness_mm)
      if (!th.ok) { ex(`ความหนาไม่ใช่ตัวเลข ("${r.thickness_mm}")`); continue }
      if (th.value !== null && prof.thickness_mm !== null && th.value !== prof.thickness_mm) { ex(`ความหนาขัดกัน: ใบราคา ${th.value} / แคตตาล็อก ${prof.thickness_mm}`); continue }
      if (r.length_m === null || r.length_m === undefined || !(Number(r.length_m) > 0)) { ex('ไม่ได้พิมพ์ความยาวเส้น'); continue }
      if (!(typeof r.price === 'number' && r.price >= 0)) { ex('ราคาไม่ใช่ตัวเลข'); continue }
      const k = `${die}|${finish}|${Number(r.length_m)}`
      if (!cand.has(k)) cand.set(k, { die, finish, length_m: Number(r.length_m), prices: new Set(), rows: [] })
      const c = cand.get(k); c.prices.add(r.price); c.rows.push({ price: r.price, page: r.page, set: s.name, item: r.item })
    }
  }
  const prices = []
  const priceConflicts = []
  for (const c of [...cand.values()].sort((a, b) => byStr(a.die, b.die) || FINISH_ORDER.indexOf(a.finish) - FINISH_ORDER.indexOf(b.finish) || a.length_m - b.length_m)) {
    if (c.prices.size > 1) {
      priceConflicts.push({ die: c.die, finish: c.finish, length_m: c.length_m, values: [...c.prices].sort((a, b) => a - b), pages: [...new Set(c.rows.map(r => r.page))].sort((a, b) => a - b), sets: [...new Set(c.rows.map(r => r.set))] })
      for (const r of c.rows) priceExcl.push({ die: c.die, item: r.item, set: r.set, page: r.page, finish: c.finish, reason: `ราคาขัดกัน ${[...c.prices].sort((a, b) => a - b).join(' / ')}` })
      continue
    }
    const page = Math.min(...c.rows.map(r => r.page))
    prices.push({ key: c.die, finish: c.finish, length_m: c.length_m, price: [...c.prices][0], page, dupCells: c.rows.length })
    profiles.get(catIndexByDie.get(c.die).key).lengths.push(c.length_m)
  }
  let assumedLength = 0
  for (const p of profiles.values()) {
    const d = pickDefaultLength(p.lengths)
    p.default_length_m = d.length_m
    if (d.assumed) assumedLength++
  }
  const finishes = FINISH_ORDER.filter(f => prices.some(p => p.finish === f))
  const unknownFinish = [...new Set(prices.map(p => p.finish))].filter(f => !FINISH_ORDER.includes(f))
  if (unknownFinish.length) throw new Error('finish not in FINISH_ORDER: ' + unknownFinish.join(', '))

  // 3. series + links
  const series = []
  const links = []
  const typeLinks = []
  const seriesNotCreated = []
  const systemCoverage = []
  const roleDiffs = []
  const setSkipped = []
  const names = new Set()
  const addSeries = (name, src) => { if (names.has(name)) throw new Error('duplicate series name ' + name); names.add(name); series.push({ name, src }) }

  for (const cs of CATALOGUE_SERIES) {
    const members = [...profiles.values()].filter(p => p.catSeries === cs.idx)
    if (!members.length) { seriesNotCreated.push({ name: cs.name, reason: 'no imported profile' }); continue }
    addSeries(cs.name, `${CATALOGUE_SOURCE} group ${cs.idx}: ${clean1(catalog.series[cs.idx].name)}`)
    for (const p of members) links.push({ series: cs.name, key: p.key, family: p.family })
    for (const t of cs.types) typeLinks.push({ series: cs.name, type_name: t })
  }

  for (const ss of SYSTEM_SERIES) {
    const file = sets[ss.file]
    if (!file) throw new Error('missing set file ' + ss.file)
    const src = file.series[ss.idx]
    if (!src) throw new Error(`missing series ${ss.file}#${ss.idx}`)
    const seen = new Set()
    const ok = []
    const missing = []
    for (const p of src.profiles) {
      const die = normDie(p.die_no)
      if (!die || seen.has(die)) continue
      seen.add(die)
      if ((ss.skipDies || []).includes(die)) { setSkipped.push({ series: ss.name, die, reason: 'เลข die ขัดกันในคู่มือ (ไม่ผูก)' }); missing.push(die); continue }
      if ((ss.skipPages || []).includes(p.page)) { setSkipped.push({ series: ss.name, die, reason: `อยู่ในรายการหน้า ${p.page} ที่ขัดกับรายการหน้า 4 (ไม่ผูก)` }); missing.push(die); continue }
      const prof = catIndexByDie.get(die)
      if (!prof || prof.excluded) { missing.push(die); continue }
      const setRole = clean1(p.role_family || '')
      const verdict = roleVerdict(setRole, prof.family)
      if (verdict !== 'same') roleDiffs.push({ series: ss.name, die, set: setRole, catalogue: prof.family, verdict })
      if (verdict === 'conflict') { setSkipped.push({ series: ss.name, die, reason: `ชื่อหน้าที่ขัดกัน: คู่มือ "${setRole}" / แคตตาล็อก "${prof.family}" (ไม่ผูก)` }); missing.push(die); continue }
      ok.push(prof)
    }
    systemCoverage.push({ name: ss.name, total: seen.size, linked: ok.length, missing })
    if (!ok.length) { seriesNotCreated.push({ name: ss.name, reason: `ไม่มี die ในแคตตาล็อก 2021 เลย (${missing.join(', ')})` }); continue }
    addSeries(ss.name, `MN installation guide ${ss.file} #${ss.idx}: ${clean1(src.name)}`)
    for (const p of ok) links.push({ series: ss.name, key: p.key, family: p.family })
    if (missing.length === 0) for (const t of ss.types) typeLinks.push({ series: ss.name, type_name: t })
    else for (const t of ss.types) seriesNotCreated.push({ name: `${ss.name} -> ${t}`, reason: `type ไม่ผูก: die ไม่ครบ ${ok.length}/${seen.size} (ขาด ${missing.join(', ')})`, typeOnly: true })
  }

  // ambiguous (series, family, thickness) tuples: the estimator would pick the lowest id and flag "ambiguous"
  const ambiguous = []
  const bySeries = new Map()
  for (const l of links) { if (!bySeries.has(l.series)) bySeries.set(l.series, []); bySeries.get(l.series).push(l) }
  for (const [s, ls] of bySeries) {
    const g = new Map()
    for (const l of ls) {
      if (!l.family) continue
      const p = profiles.get(l.key)
      const k = `${l.family}|${p.thickness_mm ?? ''}`
      if (!g.has(k)) g.set(k, [])
      g.get(k).push(p.die || p.name)
    }
    for (const [k, dies] of g) if (dies.length > 1) { const [family, th] = k.split('|'); ambiguous.push({ series: s, family, thickness_mm: th === '' ? null : Number(th), dies: dies.sort(byStr) }) }
  }

  assertUnique(links, l => `${l.series}|${l.key}`, 'series-profile link')
  assertUnique(typeLinks, t => `${t.series}|${t.type_name}`, 'series-type link')
  assertUnique(prices, x => `${x.key}|${x.finish}|${x.length_m}`, 'price')
  const profileList = [...profiles.values()].sort((a, b) => byStr(a.key, b.key))
  return {
    profiles: profileList, excludedProfiles, familyNulled, prices, priceExcl, priceConflicts, finishes, series, links, typeLinks,
    seriesNotCreated, systemCoverage, roleDiffs, setSkipped, ambiguous, assumedLength,
    totals: { priceCells: pricebook.series.reduce((n, s) => n + (s.prices || []).length, 0), catalogueRows: catalog.series.reduce((n, s) => n + s.profiles.length, 0) },
  }
}

export function expectedCounts(m) {
  return {
    providers: 1,
    series: m.series.length,
    profiles: m.profiles.length,
    series_profiles: m.links.length,
    finishes: m.finishes.length,
    variants: m.prices.length, // one variant per (die, finish, length) and one price per variant
    piece_prices: m.prices.length,
    series_types: m.typeLinks.length,
  }
}

// ---------- SQL ----------

const rows = (list, f) => list.map(x => '  (' + f(x).map(q).join(', ') + ')').join(',\n')

export function renderSql(m) {
  const e = expectedCounts(m)
  const out = []
  out.push(`-- ============================================================
-- ONE-OFF DATA IMPORT — MN (${PROVIDER.name}) aluminium catalogue. GENERATED by scripts/gen-mn-import.mjs; do not edit by hand.
-- NOT part of the code release. Owner decision 2026-10-17 "MN first". Report: docs/catalogs/mn/IMPORT-REPORT.md.
-- Sources: ${CATALOGUE_SOURCE} (docs/catalogs/mn/mn-aluminium-profile-2021.json: die, name, role, kg/m, wall, width, depth),
--          ${PRICE_SOURCE} (docs/catalogs/sms/mn-pricelist-2024.json: บาท/เส้น per die x finish x length, pages 3-58),
--          MN installation guides 1-15 (docs/catalogs/mn-sets/*.json: which dies make up each system).
-- Adds under the FacadeX tenant: provider '${PROVIDER.name}' (short_name ${PROVIDER.short_name}, price_basis ${PROVIDER.price_basis});
--   ${e.series} series (42 catalogue groups that have profiles + installation-guide systems with at least one catalogue die);
--   ${e.profiles} profiles (drawing_no = die no.; NULL for the GROUP 01 standard tubes/angles which print no die);
--   ${e.series_profiles} series-profile links (family = the profile's role); ${e.finishes} finishes (price-book columns as printed);
--   ${e.variants} profile variants (profile x finish x bar length) each with one alu_piece_prices row effective ${EFFECTIVE_FROM};
--   ${e.series_types} series-type links (only unambiguous ones; see the report for the rest).
-- NOT set: butt_distance_mm (separate step), hardware / parts (the price book's hardware pages are not extracted), kg prices.
-- default_length_m = the bar length the price book prints for that die (most common), else ${DEFAULT_LENGTH_M} (assumed, ${m.assumedLength} profiles).
-- Excluded rows (estimated / conflicting / no die / die not in the 2021 catalogue ...) are listed in the report, not here.
-- Guarded: aborts unless the tenant is the one holding provider 'ไฟล์ Aluminium calculation', the 2026-10-12-01 and 2026-10-15-01
--   migrations are applied, every door/window type named below exists, and the final row counts equal the generator's numbers.
-- Idempotent: natural keys (provider+name, provider+die / provider+name+thickness for no-die rows, series+profile,
--   profile+finish+length, variant+effective_from, series+type) are skipped when present. A second run inserts 0 rows.
-- Run: dry run first with .superpowers/sdd/2026-10-17-mn-import/run-mn-import-dryrun.sh (COMMIT -> ROLLBACK), then
--   npx supabase db query --project-ref kntspldhvcjeaubtqtkn --linked=false -f <absolute path of this file>
--   (CHANG only. NEVER the retired Tokyo project yyzbgdmgyvvypfcjuhtr.)
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';
`)
  out.push(`CREATE TEMP TABLE _mn_series (name TEXT PRIMARY KEY, src TEXT NOT NULL) ON COMMIT DROP;
INSERT INTO _mn_series VALUES
${rows(m.series, s => [s.name, s.src])};
`)
  out.push(`CREATE TEMP TABLE _mn_profiles (pkey TEXT PRIMARY KEY, die TEXT, name TEXT NOT NULL, family TEXT, thickness_mm NUMERIC, kg_per_m NUMERIC NOT NULL, width_mm NUMERIC, depth_mm NUMERIC, length_m NUMERIC NOT NULL, page INT) ON COMMIT DROP;
INSERT INTO _mn_profiles VALUES
${rows(m.profiles, p => [p.key, p.die, p.name, p.family, p.thickness_mm, p.kg, p.width_mm, p.depth_mm, p.default_length_m, p.page])};
`)
  const links = [...m.links].sort((a, b) => byStr(a.series, b.series) || byStr(a.key, b.key))
  out.push(`CREATE TEMP TABLE _mn_links (series TEXT NOT NULL, pkey TEXT NOT NULL, family TEXT, PRIMARY KEY (series, pkey)) ON COMMIT DROP;
INSERT INTO _mn_links VALUES
${rows(links, l => [l.series, l.key, l.family])};
`)
  out.push(`CREATE TEMP TABLE _mn_finishes (name TEXT PRIMARY KEY, sort INT NOT NULL) ON COMMIT DROP;
INSERT INTO _mn_finishes VALUES
${rows(m.finishes.map((f, i) => ({ f, i })), x => [x.f, x.i + 1])};
`)
  out.push(`CREATE TEMP TABLE _mn_prices (pkey TEXT NOT NULL, finish TEXT NOT NULL, length_m NUMERIC NOT NULL, price NUMERIC NOT NULL, page INT NOT NULL, PRIMARY KEY (pkey, finish, length_m)) ON COMMIT DROP;
INSERT INTO _mn_prices VALUES
${rows(m.prices, p => [p.key, p.finish, p.length_m, p.price, p.page])};
`)
  const tl = [...m.typeLinks].sort((a, b) => byStr(a.series, b.series) || byStr(a.type_name, b.type_name))
  out.push(`CREATE TEMP TABLE _mn_types (series TEXT NOT NULL, type_name TEXT NOT NULL, PRIMARY KEY (series, type_name)) ON COMMIT DROP;
INSERT INTO _mn_types VALUES
${rows(tl, t => [t.series, t.type_name])};
`)
  out.push(`DO $$
DECLARE
  c_tenant        CONSTANT UUID := '${TENANT_ID}';   -- FacadeX tenant (NOTICE prints its company_name)
  c_provider_name CONSTANT TEXT := ${q(PROVIDER.name)};
  c_short_name    CONSTANT TEXT := ${q(PROVIDER.short_name)};
  c_from          CONSTANT DATE := '${EFFECTIVE_FROM}';
  c_src           CONSTANT TEXT := ${q(PRICE_SOURCE)};
  e_series        CONSTANT INT := ${e.series};
  e_profiles      CONSTANT INT := ${e.profiles};
  e_links         CONSTANT INT := ${e.series_profiles};
  e_finishes      CONSTANT INT := ${e.finishes};
  e_variants      CONSTANT INT := ${e.variants};
  e_prices        CONSTANT INT := ${e.piece_prices};
  e_types         CONSTANT INT := ${e.series_types};
  v_tenant_name TEXT; v_provider UUID; v_n INT; v_txt TEXT;
BEGIN
  SELECT company_name INTO v_tenant_name FROM tenants WHERE id = c_tenant;
  IF v_tenant_name IS NULL THEN RAISE EXCEPTION 'ABORT: tenant % not found', c_tenant; END IF;
  RAISE NOTICE 'tenant = % (%)', v_tenant_name, c_tenant;
  IF NOT EXISTS (SELECT 1 FROM alu_providers WHERE tenant_id = c_tenant AND name = 'ไฟล์ Aluminium calculation') THEN
    RAISE EXCEPTION 'ABORT: tenant % has no provider ''ไฟล์ Aluminium calculation'' — wrong tenant or wrong database', v_tenant_name;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'alu_profiles' AND column_name = 'width_mm')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'alu_profiles' AND column_name = 'butt_distance_mm') THEN
    RAISE EXCEPTION 'ABORT: apply migrations 2026-10-12-01 and 2026-10-15-01 first';
  END IF;

  -- the file itself is complete
  IF (SELECT count(*) FROM _mn_series) <> e_series OR (SELECT count(*) FROM _mn_profiles) <> e_profiles
     OR (SELECT count(*) FROM _mn_links) <> e_links OR (SELECT count(*) FROM _mn_finishes) <> e_finishes
     OR (SELECT count(*) FROM _mn_prices) <> e_prices OR (SELECT count(*) FROM _mn_types) <> e_types THEN
    RAISE EXCEPTION 'ABORT: temp table counts differ from the generator''s expected counts (file truncated or edited?)';
  END IF;

  -- every type named must exist (by exact name)
  SELECT string_agg(DISTINCT t.type_name, ', ') INTO v_txt FROM _mn_types t
    WHERE NOT EXISTS (SELECT 1 FROM door_window_types d WHERE d.tenant_id = c_tenant AND d.name = t.type_name);
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'ABORT: door_window_types not found: %', v_txt; END IF;

  -- 1. provider
  SELECT string_agg(name, ', ') INTO v_txt FROM alu_providers WHERE tenant_id = c_tenant AND short_name = c_short_name AND name <> c_provider_name;
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'ABORT: another provider already uses short_name %: % (set c_provider_name to it, or rename)', c_short_name, v_txt; END IF;
  SELECT id INTO v_provider FROM alu_providers WHERE tenant_id = c_tenant AND name = c_provider_name;
  IF v_provider IS NULL THEN
    INSERT INTO alu_providers (tenant_id, name, short_name, price_basis) VALUES (c_tenant, c_provider_name, c_short_name, ${q(PROVIDER.price_basis)}) RETURNING id INTO v_provider;
    RAISE NOTICE 'provider created: % (%)', c_provider_name, v_provider;
  ELSE
    RAISE NOTICE 'provider exists: % (%), price_basis %', c_provider_name, v_provider, (SELECT price_basis FROM alu_providers WHERE id = v_provider);
  END IF;
  IF EXISTS (SELECT 1 FROM alu_profiles WHERE provider_id = v_provider AND drawing_no IS NOT NULL GROUP BY drawing_no HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'ABORT: provider % already has two profiles with one die no. — clean that up first', c_provider_name;
  END IF;

  -- 2. series
  INSERT INTO alu_series (tenant_id, provider_id, name, is_base)
    SELECT c_tenant, v_provider, s.name, false FROM _mn_series s ORDER BY s.name
    ON CONFLICT (provider_id, name) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; RAISE NOTICE 'series inserted: % of %', v_n, e_series;

  -- 3. profiles (natural key: die; no-die rows: name + thickness)
  INSERT INTO alu_profiles (tenant_id, provider_id, name, drawing_no, family, thickness_mm, linear_weight_kg_per_m, default_length_m, width_mm, depth_mm)
    SELECT c_tenant, v_provider, t.name, t.die, t.family, t.thickness_mm, t.kg_per_m, t.length_m, t.width_mm, t.depth_mm
      FROM _mn_profiles t
     WHERE NOT EXISTS (SELECT 1 FROM alu_profiles p WHERE p.provider_id = v_provider
             AND ((t.die IS NOT NULL AND p.drawing_no = t.die)
               OR (t.die IS NULL AND p.drawing_no IS NULL AND p.name = t.name AND p.thickness_mm IS NOT DISTINCT FROM t.thickness_mm)))
     ORDER BY t.pkey;
  GET DIAGNOSTICS v_n = ROW_COUNT; RAISE NOTICE 'profiles inserted: % of %', v_n, e_profiles;
  CREATE TEMP TABLE _mn_pid ON COMMIT DROP AS
    SELECT t.pkey, (SELECT p.id FROM alu_profiles p WHERE p.provider_id = v_provider
             AND ((t.die IS NOT NULL AND p.drawing_no = t.die)
               OR (t.die IS NULL AND p.drawing_no IS NULL AND p.name = t.name AND p.thickness_mm IS NOT DISTINCT FROM t.thickness_mm))
             ORDER BY p.created_at, p.id LIMIT 1) AS profile_id
      FROM _mn_profiles t;
  SELECT count(profile_id) INTO v_n FROM _mn_pid;
  IF v_n <> e_profiles THEN RAISE EXCEPTION 'ABORT: % of % profiles resolved', v_n, e_profiles; END IF;

  -- 4. series <-> profile links
  INSERT INTO alu_series_profiles (tenant_id, series_id, profile_id, family)
    SELECT c_tenant, s.id, m.profile_id, l.family FROM _mn_links l
      JOIN alu_series s ON s.provider_id = v_provider AND s.name = l.series
      JOIN _mn_pid m ON m.pkey = l.pkey
     ORDER BY l.series, l.pkey
    ON CONFLICT (series_id, profile_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; RAISE NOTICE 'series-profile links inserted: % of %', v_n, e_links;

  -- 5. finishes
  INSERT INTO alu_finishes (tenant_id, provider_id, name)
    SELECT c_tenant, v_provider, f.name FROM _mn_finishes f ORDER BY f.sort
    ON CONFLICT (provider_id, name) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; RAISE NOTICE 'finishes inserted: % of %', v_n, e_finishes;

  -- 6. variants (profile x finish x bar length) + per-piece prices
  INSERT INTO alu_profile_variants (tenant_id, profile_id, finish_id, length_m)
    SELECT c_tenant, m.profile_id, f.id, pr.length_m FROM _mn_prices pr
      JOIN _mn_pid m ON m.pkey = pr.pkey
      JOIN alu_finishes f ON f.provider_id = v_provider AND f.name = pr.finish
     ORDER BY pr.pkey, pr.finish, pr.length_m
    ON CONFLICT (profile_id, finish_id, length_m) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; RAISE NOTICE 'variants inserted: % of %', v_n, e_variants;
  INSERT INTO alu_piece_prices (tenant_id, variant_id, price_per_piece, effective_from, source)
    SELECT c_tenant, pv.id, pr.price, c_from, c_src || ' p.' || pr.page FROM _mn_prices pr
      JOIN _mn_pid m ON m.pkey = pr.pkey
      JOIN alu_finishes f ON f.provider_id = v_provider AND f.name = pr.finish
      JOIN alu_profile_variants pv ON pv.profile_id = m.profile_id AND pv.finish_id = f.id AND pv.length_m = pr.length_m
     ORDER BY pr.pkey, pr.finish, pr.length_m
    ON CONFLICT (variant_id, effective_from) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; RAISE NOTICE 'piece prices inserted: % of %', v_n, e_prices;

  -- 7. series <-> door/window type links (unambiguous only)
  INSERT INTO alu_series_types (tenant_id, series_id, type_id)
    SELECT c_tenant, s.id, d.id FROM _mn_types t
      JOIN alu_series s ON s.provider_id = v_provider AND s.name = t.series
      JOIN door_window_types d ON d.tenant_id = c_tenant AND d.name = t.type_name
     ORDER BY t.series, t.type_name
    ON CONFLICT (series_id, type_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; RAISE NOTICE 'series-type links inserted: % of %', v_n, e_types;

  -- 8. final guard: what is now in the DB for these natural keys equals the generator's numbers
  SELECT count(*) INTO v_n FROM _mn_series t JOIN alu_series s ON s.provider_id = v_provider AND s.name = t.name;
  IF v_n <> e_series THEN RAISE EXCEPTION 'ABORT: series present % <> expected %', v_n, e_series; END IF;
  SELECT count(*) INTO v_n FROM _mn_links l JOIN alu_series s ON s.provider_id = v_provider AND s.name = l.series
    JOIN _mn_pid m ON m.pkey = l.pkey JOIN alu_series_profiles sp ON sp.series_id = s.id AND sp.profile_id = m.profile_id;
  IF v_n <> e_links THEN RAISE EXCEPTION 'ABORT: series-profile links present % <> expected %', v_n, e_links; END IF;
  SELECT count(*) INTO v_n FROM _mn_finishes t JOIN alu_finishes f ON f.provider_id = v_provider AND f.name = t.name;
  IF v_n <> e_finishes THEN RAISE EXCEPTION 'ABORT: finishes present % <> expected %', v_n, e_finishes; END IF;
  SELECT count(*) INTO v_n FROM _mn_prices pr JOIN _mn_pid m ON m.pkey = pr.pkey
    JOIN alu_finishes f ON f.provider_id = v_provider AND f.name = pr.finish
    JOIN alu_profile_variants pv ON pv.profile_id = m.profile_id AND pv.finish_id = f.id AND pv.length_m = pr.length_m;
  IF v_n <> e_variants THEN RAISE EXCEPTION 'ABORT: variants present % <> expected %', v_n, e_variants; END IF;
  SELECT count(*) INTO v_n FROM _mn_prices pr JOIN _mn_pid m ON m.pkey = pr.pkey
    JOIN alu_finishes f ON f.provider_id = v_provider AND f.name = pr.finish
    JOIN alu_profile_variants pv ON pv.profile_id = m.profile_id AND pv.finish_id = f.id AND pv.length_m = pr.length_m
    JOIN alu_piece_prices pp ON pp.variant_id = pv.id AND pp.effective_from = c_from AND pp.price_per_piece = pr.price;
  IF v_n <> e_prices THEN RAISE EXCEPTION 'ABORT: piece prices present (same price) % <> expected % — an existing row on % has another price', v_n, e_prices, c_from; END IF;
  SELECT count(*) INTO v_n FROM _mn_types t JOIN alu_series s ON s.provider_id = v_provider AND s.name = t.series
    JOIN door_window_types d ON d.tenant_id = c_tenant AND d.name = t.type_name
    JOIN alu_series_types st ON st.series_id = s.id AND st.type_id = d.id;
  IF v_n <> e_types THEN RAISE EXCEPTION 'ABORT: series-type links present % <> expected %', v_n, e_types; END IF;
  RAISE NOTICE 'MN IMPORT OK: series %, profiles %, links %, finishes %, variants %, piece prices %, type links %', e_series, e_profiles, e_links, e_finishes, e_variants, e_prices, e_types;
END $$;

-- Dry run: replace COMMIT with ROLLBACK (the wrapper script does that), read the NOTICE / result lines.
COMMIT;
`)
  return out.join('\n')
}

// ---------- report ----------

const md = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
const pages = (ps) => { const u = [...new Set(ps)].sort((a, b) => a - b); return u.join(', ') }

// The die-number conflicts the owner asked about, with what this import does for each (report only).
export const DIE_CONFLICTS = [
  ['4713B / 4173B', 'MN-4173B guide: page headers print MN-4713B, the profile page and the 2021 catalogue print U4173B (เฟรมบน 103x31.75, p.112).', 'Imported as U4173B. No die 4713B exists anywhere, so the header is taken as a typo.'],
  ['U4457A / U4775A', 'MN-4075 guide: the installation drawing prints U4457A, the profile list prints U4775A. U4457A is in the 2021 catalogue as เสาเกี่ยว 60.15x26 of the 103 sliding door; U4775A is not in the catalogue.', 'Neither is linked to ชุดบานเลื่อน MN-4075. U4457A is still imported as a profile (from its catalogue group).'],
  ['U7550 / U7552', 'MN-7463/7464 EURO 4" guide: drawing U7550, list U7552 (stainless track).', 'Neither die is in the 2021 catalogue, so nothing is imported.'],
  ['U7465 / U7536', 'MN-7463 EURO 4" guide: drawing U7465, list U7536 (กล่องเรียบ).', 'Neither die is in the 2021 catalogue, so nothing is imported.'],
  ['U276 / U7216', 'Railing guide: the drawing labels the baluster MN-U276, the section table says MN-U7216 30x15. The 2021 catalogue has U7216 (กล่อง 30x15, printed MN-7216, p.243).', 'U7216 is linked to ราวกันตก ลูกกรง MN-BH035 (it is the catalogue die; U276 exists nowhere).'],
  ['M40301 / M30087', 'Hanging-door guide (ชุดประตูรางแขวน): the page-4 profile list uses M40301 / M42879 / U6359, the page-5 drawing uses M30087-M30090 / M4031.', 'Only the page-4 list is linked to ชุดประตูรางแขวน MN-U6359; M30087, M30088, M30089, M30090, M4031 are not linked to it (they are still imported as profiles in their own groups, except M4031 which is not in the catalogue). The type link to บานเลื่อนรางแขวน is therefore NOT made.'],
  ['Big Frame M4056 / M4058', 'The app\'s provisional provider "ไฟล์ Aluminium calculation" has รางบนบิ๊กเฟรม 2.0 mm 1.309 kg/m and รางข้างบานเลื่อน 2.0 mm 1.371 kg/m. In the MN catalogue 1.309 = M4056 "เฟรมข้าง 101.6x35 มีร่องรับบาน" and 1.371 = M4058 "เฟรมบน 2 ราง 101.6x36" — the names look swapped in the provisional file.', 'MN rows are imported with MN\'s own names and roles (M4056 เฟรมข้าง 2 ราง, M4058 เฟรมบน 2 ราง). Nothing on the provisional provider is changed.'],
]

export function renderReport(m) {
  const e = expectedCounts(m)
  const L = []
  const p = (s = '') => L.push(s)
  p('# MN catalogue import report (generated)')
  p()
  p(`Generated by \`scripts/gen-mn-import.mjs\` — do not edit by hand; re-run the generator. SQL: \`supabase/datafix/2026-10-17-import-mn-catalogue.sql\`. Dry run: \`.superpowers/sdd/2026-10-17-mn-import/run-mn-import-dryrun.sh\`.`)
  p()
  p(`Provider **${PROVIDER.name}** (short_name \`${PROVIDER.short_name}\`, price_basis \`${PROVIDER.price_basis}\` — the price book is บาท/เส้น). Prices effective **${EFFECTIVE_FROM}** (file name "PriceList2024 (2567-06-17)"; the book prints no other date), source \`${PRICE_SOURCE} p.<page>\`. Profiles come from the ${CATALOGUE_SOURCE} (the table has no source column; this report and the SQL header carry it). \`butt_distance_mm\` is not set.`)
  p()
  p('## Row counts (what the SQL guarantees after it runs)')
  p()
  p('| table | rows |')
  p('|---|---|')
  p(`| alu_providers | ${e.providers} |`)
  p(`| alu_series | ${e.series} |`)
  p(`| alu_profiles | ${e.profiles} |`)
  p(`| alu_series_profiles | ${e.series_profiles} |`)
  p(`| alu_finishes | ${e.finishes} |`)
  p(`| alu_profile_variants | ${e.variants} |`)
  p(`| alu_piece_prices | ${e.piece_prices} |`)
  p(`| alu_series_types | ${e.series_types} |`)
  p()
  const withDie = m.profiles.filter(x => x.die).length
  const priced = new Set(m.prices.map(x => x.key)).size
  p(`- Profiles: ${withDie} with a die no., ${m.profiles.length - withDie} GROUP 01 standard sections without one (drawing_no NULL; key = name + thickness). ${priced} profiles have at least one price; ${m.assumedLength} have no price and take default_length_m ${DEFAULT_LENGTH_M} (assumed, not printed).`)
  p(`- Input: ${m.totals.catalogueRows} catalogue rows, ${m.totals.priceCells} price cells. Imported price cells: ${m.prices.reduce((n, x) => n + x.dupCells, 0)} (deduplicated to ${m.prices.length} prices: the same die is printed in several sets at the same price). Excluded price cells: ${m.priceExcl.length}.`)
  p(`- Bar lengths used: ${[...new Set(m.prices.map(x => x.length_m))].sort((a, b) => a - b).join(' / ')} m (as printed per page).`)
  p()

  p('## Exclusions')
  p()
  p('### Profiles not imported')
  p()
  p('| die | name | page | reason |')
  p('|---|---|---|---|')
  for (const x of m.excludedProfiles) p(`| ${md(x.die || '-')} | ${md(x.name)} | ${x.page} | ${md(x.reason)} |`)
  p()
  p('### Profiles imported with family = NULL (the catalogue role is a guess from the shape)')
  p()
  p('Kg/m and sizes are read; only the role is uncertain, so these rows never match a template family until the owner names them.')
  p()
  p('| die | name | guessed role |')
  p('|---|---|---|')
  for (const x of m.familyNulled) p(`| ${md(x.die)} | ${md(x.name)} | ${md(x.role)} |`)
  p()
  p('### Price cells not imported — totals by reason')
  p()
  const byReason = new Map()
  for (const x of m.priceExcl) { const k = x.reason.replace(/:.*$/, '').replace(/ \d[\d./ ]*$/, ''); byReason.set(k, (byReason.get(k) || 0) + 1) }
  p('| reason | cells |')
  p('|---|---|')
  for (const [k, v] of [...byReason].sort((a, b) => b[1] - a[1])) p(`| ${md(k)} | ${v} |`)
  p()
  p('### Price cells not imported — every row (grouped by reason, die or item label, and set)')
  p()
  const groups = new Map()
  for (const x of m.priceExcl) {
    const k = `${x.reason}\u0000${x.die || ''}\u0000${x.die ? '' : (x.item || '(ไม่มีชื่อ)')}\u0000${x.set}`
    if (!groups.has(k)) groups.set(k, { ...x, n: 0, pages: [] })
    const g = groups.get(k); g.n++; g.pages.push(x.page)
  }
  p('| reason | die | item (no die) | set | pages | cells |')
  p('|---|---|---|---|---|---|')
  for (const g of [...groups.values()].sort((a, b) => byStr(a.reason, b.reason) || byStr(a.die || '', b.die || '') || byStr(a.item || '', b.item || '') || byStr(a.set, b.set))) {
    p(`| ${md(g.reason)} | ${md(g.die || '')} | ${md(g.die ? '' : (g.item || '(ไม่มีชื่อ)').slice(0, 80))} | ${md(g.set)} | ${pages(g.pages)} | ${g.n} |`)
  }
  p()
  p('### Price conflicts (same die, finish and bar length printed with different prices — all values excluded)')
  p()
  p('| die | finish | length m | prices | pages | sets |')
  p('|---|---|---|---|---|---|')
  for (const c of m.priceConflicts) p(`| ${c.die} | ${c.finish} | ${c.length_m} | ${c.values.join(' / ')} | ${c.pages.join(', ')} | ${md(c.sets.join('; '))} |`)
  p()

  p('## Series')
  p()
  p(`${m.series.length} series: the 42 catalogue groups that have profiles (every catalogue profile is linked to its group) and the installation-guide systems that have at least one die in the 2021 catalogue. The price book's 75 set headings are not made into series: most of their rows have no die no., and the dies they do print are already in the catalogue groups (prices attach to the profile, not to a series).`)
  p()
  p('### Installation-guide systems: dies linked')
  p()
  p('| system (series name) | dies linked / printed | not linked |')
  p('|---|---|---|')
  for (const c of m.systemCoverage) p(`| ${md(c.name)} | ${c.linked} / ${c.total} | ${md(c.missing.join(', '))} |`)
  p()
  p('A die is "not linked" when it is not in the 2021 catalogue (no kg/m, so no profile row), when the guide prints it in two conflicting ways, or when the guide\'s role for it conflicts with the catalogue role (below).')
  p()
  p('### Series not created / type links held back')
  p()
  for (const x of m.seriesNotCreated) p(`- ${md(x.name)}: ${md(x.reason)}`)
  p()
  p('### Dies held back from a system (conflict)')
  p()
  p('| system | die | reason |')
  p('|---|---|---|')
  for (const x of m.setSkipped) p(`| ${md(x.series)} | ${x.die} | ${md(x.reason)} |`)
  p()
  p('### Guide role vs catalogue role (compatible ones are linked with the catalogue role)')
  p()
  p('| system | die | guide role | catalogue role | verdict |')
  p('|---|---|---|---|---|')
  for (const x of m.roleDiffs) p(`| ${md(x.series)} | ${x.die} | ${md(x.set)} | ${md(x.catalogue ?? 'NULL')} | ${x.verdict} |`)
  p()
  p('### Ambiguous (series, family, thickness) — the estimator would pick the lowest id and flag "ambiguous"')
  p()
  p('Expected for catalogue groups (one role, many sizes: e.g. 4" boxes with grooves 12.7 / 16.5 / 22 / 25 / 30). A template should only be pointed at a series where its families are unique, or the family names must be refined first.')
  p()
  p('| series | family | thickness | dies / names |')
  p('|---|---|---|---|')
  for (const a of m.ambiguous) p(`| ${md(a.series)} | ${md(a.family)} | ${a.thickness_mm ?? '-'} | ${md(a.dies.join(', ').slice(0, 300))}${a.dies.join(', ').length > 300 ? ' …' : ''} (${a.dies.length}) |`)
  p()

  p('## Door/window type links')
  p()
  p('Made (series → type, exact live names; the SQL aborts if a name is missing). Installation-guide systems are linked only when every die they print was linked.')
  p()
  p('| series | type |')
  p('|---|---|')
  for (const t of [...m.typeLinks].sort((a, b) => byStr(a.series, b.series) || byStr(a.type_name, b.type_name))) p(`| ${md(t.series)} | ${md(t.type_name)} |`)
  p()
  p('Ambiguous — NOT linked:')
  p()
  p('| series | type the source names | why not |')
  p('|---|---|---|')
  for (const [s, t, w] of AMBIGUOUS_TYPES) p(`| ${md(s)} | ${md(t)} | ${md(w)} |`)
  p()

  p('## Die-number conflicts')
  p()
  p('| dies | what the sources say | what this import does |')
  p('|---|---|---|')
  for (const [d, s, a] of DIE_CONFLICTS) p(`| ${md(d)} | ${md(s)} | ${md(a)} |`)
  p()

  p('## Finishes (price-book columns, names as printed)')
  p()
  p(`Imported: ${m.finishes.join(', ')}. Column "N/A" is not imported (its cells are excluded above). No price per kg and no colour code is set.`)
  p()
  p('Mapping questions for the owner (the provisional provider uses ANODIZED NA / 512 / 517, POWDER COATING WHITE / BLACK / SAHARA / WOOD GRAIN):')
  p()
  p('- ขาว — อะโนไดซ์ขาว (NA) หรือ พ่นสีขาว? (มีคอลัมน์ ชุบขาว แยกในบางหน้า)')
  p('- ชาอ่อน / ชาเข้ม / ชาดำ — ตรงกับ ANODIZED 512 / 517 / ดำ ใช่ไหม')
  p('- สีพ่น (ตัวแดง) — POWDER COATING สีไหน (ขาว / ดำ / SAHARA) หรือทุกสีราคาเดียว')
  p('- ลายไม้ — POWDER COATING WOOD GRAIN ใช่ไหม')
  p('- ชุบขาว / สีชุบดำ — ต่างจาก ขาว / ชาดำ อย่างไร')
  p()

  p('## MN families vs the existing BOM templates')
  p()
  p('The 22 live templates were built on provider "ไฟล์ Aluminium calculation" and name families such as เฟรมบน, บานเลื่อนบน, กรอบนอกกระทุ้ง. MN profiles carry the app\'s role vocabulary (from the extraction brief), so an item that picks an MN series will NOT resolve those template families until either (a) MN-specific templates are made, or (b) the MN series links get the template family names (alu_series_profiles.family, one per series — a profile can carry only one family per series, so a die used as both head and jamb, e.g. U4173B, needs a second template position, not a second link). Closest matches:')
  p()
  p('| MN family (role) | existing template family |')
  p('|---|---|')
  for (const [a, b] of FAMILY_MAP) p(`| ${md(a)} | ${md(b)} |`)
  p()

  p('## Open questions (owner)')
  p()
  p(`1. ราคา ${m.priceExcl.filter(x => x.reason.startsWith('ไม่มีเลข die')).length} ช่องในใบราคาไม่มีเลข die (เช่น ชุดช่องแสง-บานสวิง กล่องร่อง 1.0-2.5, ชุดบานเลื่อน รางบน/รางล่าง) จึงยังไม่ได้นำเข้า — ขอเลข die ของรายการเหล่านี้ หรือให้ผูกตามชื่อ+ความหนาเองได้ไหม`)
  p('2. die ที่มีราคาแต่ไม่มีในแคตตาล็อก 2021 (เช่น TS148xx, U74xx, U76xx, FQ, D001-D005, M30457-9) ไม่มี กก./ม. — ขอแคตตาล็อกเล่มใหม่ หรือยอมให้ใส่ กก./ม. = 0 (ราคาเป็นต่อเส้นอยู่แล้ว)?')
  p('3. สีผิว: ขาว / ชาอ่อน / ชาเข้ม / ชาดำ / สีพ่น / ลายไม้ / ชุบขาว / สีชุบดำ ตรงกับสีไหนในระบบ (ดูหัวข้อ Finishes)')
  p('4. เสากุญแจ / เสาเกี่ยว ในคู่มือขัดกับแคตตาล็อก (U4282, U4283A, U5779, M42880, U6561 ...) — ร้านเรียกตัวไหนว่าอะไร')
  p('5. ราคาขัดกันในเล่มเดียวกัน (U5311, M50625, M30088-M30090, M30409 ...) — ราคาไหนถูก')
  p('6. ราคาในเล่ม 14 รวม VAT หรือยัง และเป็นราคาก่อนส่วนลดใช่ไหม')
  p()
  return L.join('\n') + '\n'
}
