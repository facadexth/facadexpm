// Settings reorganisation (2026-10-18): 16 sections became 7, and the
// Communication Center tab moved inside Settings. These maps keep every old
// id working.

// Old Settings section id -> the section that holds that card now.
// null = the part left Settings (payroll setup -> บุคคล tab, doc style ->
// platform-admin แบบเอกสาร tab): open the first section.
export const LEGACY_SECTION = {
  signature: 'account',
  bank_accounts: 'company_profile',
  travel: 'location',
  checkin_location: 'location',
  line_push: 'communication',
  web_push: 'communication',
  cheque_reminder: 'communication',
  sign_method: 'communication',
  doc_style: null,
  payroll_items: null,
  payroll_bank: null,
}

// Section id to open for a requested id (old or new). undefined = nothing requested.
export function resolveSettingsSection(id) {
  if (!id) return undefined
  return Object.prototype.hasOwnProperty.call(LEGACY_SECTION, id) ? LEGACY_SECTION[id] : id
}

// Tabs that no longer have a page of their own. The tab id itself stays a
// gated route (src/App.jsx HIDDEN_TAB_ENTRIES) so "can this user open it"
// still answers for the bell/push fallbacks, but opening it lands here.
// Web Push payloads already sent (and the edge function) still name
// 'communication_center'.
export const TAB_REDIRECTS = {
  communication_center: { tab: 'settings', section: 'communication' },
}

// -> { tab, state } actually navigated to.
export function redirectTab(tab, state = {}) {
  const r = TAB_REDIRECTS[tab]
  if (!r) return { tab, state }
  return { tab: r.tab, state: { ...state, section: r.section } }
}
