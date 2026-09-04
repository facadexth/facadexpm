// Per-tenant document header style. NULL/missing fields on a tenant's
// document_style fall back to these defaults -- a tenant who never opens
// the Settings customizer (document_style stays NULL) is unaffected by
// this file ever changing its defaults, since their documents keep
// tracking DEFAULT_DOCUMENT_STYLE going forward, not a frozen copy.
//
// Note: resolveDocumentStyle() below supports a sparse overrides object
// just fine, but nothing in this codebase currently WRITES a sparse one --
// the Settings customizer's Save button persists a complete resolved
// snapshot (every field, not a diff). So a tenant who has saved once will
// NOT automatically pick up a later change to a field they never touched;
// only a tenant who has never saved (still NULL) tracks future default
// changes. Only Reset (which writes actual NULL, not a copy of today's
// defaults) gets a tenant back onto the always-current defaults.
//
// logoMaxHeight is new -- the previously-shipped header had no cap on the
// logo's stretch-to-match-text-height sizing, which looks disproportionate
// for a portrait-oriented logo file next to a short text block. Every
// other value here equals what QuotationHeader/DocumentHeader/
// QuotationPaper/DocumentPaper hardcoded before this file existed.
export const DEFAULT_DOCUMENT_STYLE = {
  accent: '#6c63ff',
  pagePaddingV: 40, pagePaddingH: 44,
  logoWidth: 110, logoMaxHeight: 64, logoGap: 20,
  nameSize: 18, addressSize: 12, contactSize: 12, titleSize: 28,
  headerRowGap: 25, contactLineGap: 6,
  clientInfoOffset: 17, docInfoBoxOffset: 17,
  splitRatioClient: 66,
  infoSize: 12,
  tableMarginTop: 18,
  tableHeaderBg: '#f4f4f6', tableHeaderColor: '#4a4d63', tableHeaderSize: 12,
  tableHeaderPadding: 11, tableHeaderBorder: 2, tableHeaderBold: true,
  showContactIcons: true, showRevisionSuffix: true,
  // Footer notes/payment-terms/bank-account block. footerBankFirst only
  // affects QuotationPaper (the only document with payment terms/notes
  // text alongside a bank account) -- false matches the order this block
  // always rendered in before this field existed: payment terms, then
  // notes, then bank account. Invoices/receipts only ever show a bank
  // account there (no payment-terms/notes concept), so footerBankFirst is
  // a no-op for them; footerTextSize still applies to keep the block's
  // size consistent across all three document types.
  footerTextSize: 11.5, footerBankFirst: false,
}

// Flat shallow merge -- every DEFAULT_DOCUMENT_STYLE value is a primitive
// (number/string/boolean), so a sparse per-field override object (as
// stored in tenants.document_style, or as built up by the Settings
// customizer's slider state) is always sufficient; no nested/deep merge
// needed.
export function resolveDocumentStyle(overrides) {
  return { ...DEFAULT_DOCUMENT_STYLE, ...(overrides || {}) }
}
