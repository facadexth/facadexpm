// Per-tenant document header style. NULL/missing fields on a tenant's
// document_style fall back to these defaults -- a tenant who never opens
// the Settings customizer is unaffected by this file ever changing its
// defaults (their documents track DEFAULT_DOCUMENT_STYLE going forward,
// not a frozen copy), while a tenant who saved a customization keeps
// exactly the fields they touched and nothing else.
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
}

// Flat shallow merge -- every DEFAULT_DOCUMENT_STYLE value is a primitive
// (number/string/boolean), so a sparse per-field override object (as
// stored in tenants.document_style, or as built up by the Settings
// customizer's slider state) is always sufficient; no nested/deep merge
// needed.
export function resolveDocumentStyle(overrides) {
  return { ...DEFAULT_DOCUMENT_STYLE, ...(overrides || {}) }
}
