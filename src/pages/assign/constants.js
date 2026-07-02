// ============================================================
// Assign — shared type colors / labels / options
// ============================================================

export const TYPE_COLOR = {
  site:        { bg: 'rgba(108,99,255,0.25)', color: 'var(--accent)' },
  factory:     { bg: 'rgba(0,212,170,0.25)',  color: 'var(--green)' },
  office:      { bg: 'rgba(78,205,196,0.25)',  color: 'var(--blue)' },
  leave:       { bg: 'rgba(255,107,107,0.25)', color: 'var(--red)' },
  holiday:     { bg: 'rgba(94,97,128,0.25)',   color: 'var(--text3)' },
  subcontract: { bg: 'rgba(255,209,102,0.25)', color: 'var(--yellow)' },
}

// short badge label shown in a cell (site/factory show the site number instead)
export const TYPE_LABEL = { site: '', factory: 'รง', office: 'OF', leave: 'LA', holiday: 'HO', subcontract: 'SC' }

export const TYPE_LEGEND = [
  { type: 'site',        label: '🏗️ ไซท์' },
  { type: 'factory',     label: '🏭 โรงงาน' },
  { type: 'subcontract', label: '🔧 Sub' },
  { type: 'office',      label: '🏢 ออฟฟิศ' },
  { type: 'leave',       label: '🏖️ ลา' },
  { type: 'holiday',     label: '🎌 หยุด' },
]

// types that attribute labor cost to a site (and therefore need a site chosen)
export const SITE_TYPES = ['site', 'factory']

export const SHIFTS = [
  { key: 'morning', label: 'เช้า', emoji: '🌅' },
  { key: 'evening', label: 'เย็น', emoji: '🌆' },
]

export const DOW_TH = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส']  // index by getDay() (0=Sun)
