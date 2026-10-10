// Picks how a tenant's QUOTATION is drawn. Pure, no I/O. Spec:
// docs/superpowers/specs/2026-10-10-document-templates-design.md section 4.
// Anything unexpected falls back to the classic layout, never a broken page.
import { resolveDocumentStyle } from './documentStyle'

export const MAX_GALLERY = 4
export const MAX_FEATURES = 3

const HEX = /^#[0-9a-fA-F]{6}$/

// Lighten a hex colour toward white by `amount` (0..1). Plain hex out,
// because html2canvas does not reliably support color-mix().
export function tintHex(hex, amount) {
  if (!HEX.test(hex || '')) return '#f4f4f6'
  const n = parseInt(hex.slice(1), 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map((c) => Math.round(c + (255 - c) * amount))
  return '#' + ch.map((c) => c.toString(16).padStart(2, '0')).join('')
}

function cleanText(v) {
  return typeof v === 'string' ? v.trim() : ''
}

function resolveContent(raw, pack) {
  const own = raw && typeof raw === 'object' ? raw : {}
  const ownGallery = (Array.isArray(own.gallery) ? own.gallery : [])
    .filter((g) => g && cleanText(g.path))
    .map((g) => ({ path: g.path, caption: cleanText(g.caption) }))
  const packGallery = (pack && Array.isArray(pack.gallery) ? pack.gallery : [])
    .filter((g) => g && cleanText(g.path))
    .map((g) => ({ path: g.path, caption: cleanText(g.caption_th) }))
  const ownFeatures = (Array.isArray(own.features) ? own.features : []).map(cleanText).filter(Boolean)
  const packFeatures = ((pack && pack.features_th) || []).map(cleanText).filter(Boolean)
  return {
    heroPath: cleanText(own.hero_path) || (pack ? pack.hero_path : '') || '',
    gallery: (ownGallery.length ? ownGallery : packGallery).slice(0, MAX_GALLERY),
    features: (ownFeatures.length ? ownFeatures : packFeatures).slice(0, MAX_FEATURES),
    tagline: cleanText(own.tagline) || (pack ? cleanText(pack.tagline_th) : ''),
    thanks: cleanText(own.thanks),
    // true only when the cover comes from our sample pack
    usingDefaultImages: !cleanText(own.hero_path) && !!(pack && pack.hero_path),
  }
}

function classic(tenant, template) {
  // no template chosen: the tenant's own legacy document_style, unchanged
  const base = template ? { ...(template.style || {}), ...(tenant.document_style || {}) } : tenant.document_style
  const style = resolveDocumentStyle(base)
  const accent = HEX.test(tenant.document_accent || '') ? tenant.document_accent : style.accent
  return {
    layout: 'classic',
    style: { ...style, accent },
    accent,
    content: null,
    usingDefaultImages: false,
  }
}

export function resolveDocumentTemplate({ tenant, templates, packs }) {
  const t = tenant || {}
  const key = t.document_template_key
  if (!key || key === 'classic') {
    const row = (templates || []).find((x) => x.key === 'classic' && x.status === 'published')
    return classic(t, key ? row : null)
  }

  const template = (templates || []).find((x) => x.key === key)
  if (!template || template.status !== 'published' || !['modern', 'premium'].includes(template.layout)) {
    return classic(t, null)
  }

  const content = t.document_content && typeof t.document_content === 'object' ? t.document_content : {}
  const pack = content.pack_id
    ? (packs || []).find((p) => p.id === content.pack_id && p.status === 'published') || null
    : null
  const resolved = resolveContent(content, pack)
  if (!resolved.heroPath) return classic(t, null) // needs a cover image

  const base = resolveDocumentStyle(template.style)
  const accent = HEX.test(t.document_accent || '') ? t.document_accent : base.accent
  return {
    layout: template.layout,
    style: { ...base, accent, accentTint: tintHex(accent, 0.9), accentSoft: tintHex(accent, 0.75) },
    accent,
    content: {
      heroPath: resolved.heroPath,
      gallery: resolved.gallery,
      features: resolved.features,
      tagline: resolved.tagline,
      thanks: resolved.thanks,
    },
    usingDefaultImages: resolved.usingDefaultImages,
  }
}
