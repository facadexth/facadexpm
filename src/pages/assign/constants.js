// ============================================================
// Assign — shared type colors / labels / options
// ============================================================

export const TYPE_COLOR = {
  site:            { bg: 'rgba(108,99,255,0.25)', color: 'var(--accent)' },
  factory:         { bg: 'rgba(0,212,170,0.25)',  color: 'var(--green)' },
  office:          { bg: 'rgba(78,205,196,0.25)',  color: 'var(--blue)' },
  leave:           { bg: 'rgba(255,107,107,0.25)', color: 'var(--red)' },
  leave_sick:      { bg: 'rgba(255,159,67,0.25)',  color: '#ff9f43' },
  leave_personal:  { bg: 'rgba(255,71,87,0.25)',   color: '#ff4757' },
  holiday:         { bg: 'rgba(94,97,128,0.25)',   color: 'var(--text3)' },
  subcontract:     { bg: 'rgba(255,209,102,0.25)', color: 'var(--yellow)' },
}

// short badge label shown in a cell (site/factory show the site number instead)
export const TYPE_LABEL = { site: '', factory: 'รง', office: 'OF', leave: 'LA', leave_sick: 'ลาป่วย', leave_personal: 'ลากิจ', holiday: 'HO', subcontract: 'SC' }

export const TYPE_LEGEND = [
  { type: 'site',            label: '🏗️ ไซท์' },
  { type: 'factory',         label: '🏭 โรงงาน' },
  { type: 'subcontract',     label: '🔧 Sub' },
  { type: 'office',          label: '🏢 ออฟฟิศ' },
  { type: 'leave_sick',      label: '🤒 ลาป่วย' },
  { type: 'leave_personal',  label: '🏖️ ลากิจ' },
  { type: 'holiday',         label: '🎌 หยุด' },
]

// types that attribute labor cost to a site (and therefore need a site chosen)
export const SITE_TYPES = ['site', 'factory']

export const SHIFTS = [
  { key: 'morning', label: 'เช้า', emoji: '🌅' },
  { key: 'evening', label: 'บ่าย', emoji: '🌆' },
]

export const DOW_TH = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส']  // index by getDay() (0=Sun)

// ── per-site colours (so different sites are visually distinct in the grid) ──
const SITE_PALETTE = [
  { bg: 'rgba(108,99,255,0.30)',  color: '#c2bdff' },
  { bg: 'rgba(0,212,170,0.30)',   color: '#5fe6ca' },
  { bg: 'rgba(255,209,102,0.30)', color: '#ffd980' },
  { bg: 'rgba(78,205,196,0.30)',  color: '#6fd8d0' },
  { bg: 'rgba(255,107,107,0.30)', color: '#ff9d9d' },
  { bg: 'rgba(186,104,255,0.30)', color: '#d8b0ff' },
  { bg: 'rgba(120,190,255,0.30)', color: '#9dd2ff' },
  { bg: 'rgba(255,159,67,0.30)',  color: '#ffbd80' },
  { bg: 'rgba(150,220,120,0.30)', color: '#b6e89a' },
  { bg: 'rgba(255,140,190,0.30)', color: '#ffb3d4' },
]

export function siteColor(siteId) {
  if (!siteId) return SITE_PALETTE[0]
  let h = 0
  for (let i = 0; i < siteId.length; i++) h = (h * 31 + siteId.charCodeAt(i)) >>> 0
  return SITE_PALETTE[h % SITE_PALETTE.length]
}

/** ตัวย่อชื่อไซท์สำหรับ month view (หลายคำ = อักษรแรกของแต่ละคำ, คำเดียว = 4 ตัวแรก) */
export function siteAbbrev(name) {
  if (!name) return '—'
  const words = name.trim().split(/\s+/)
  if (words.length >= 2) return words.slice(0, 3).map(w => w[0]).join('').toUpperCase()
  return name.trim().slice(0, 4)
}
