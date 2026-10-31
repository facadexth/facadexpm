// Colours/fonts that differ between quotation layouts. The classic values are
// exactly what QuotationPaper hardcoded before templates existed, so the
// classic layout renders unchanged.
import { supabase } from '../../lib/supabase.js'
import { tintHex } from '../../lib/documentTemplates.js'

export function quotationTheme(layout, style) {
  const accent = style.accent
  if (layout === 'modern') {
    return {
      layout, fontFamily: 'Sarabun,sans-serif', paperBg: '#fff', text: '#17181f', muted: '#6a6f85',
      rowBorder: '#e3e3e3', noteBg: '#FFFDF7', notesBoxBg: '#f4f6fa', totalBoxBg: accent, totalBoxBorder: accent, totalBoxText: '#fff',
      thBg: accent, thColor: '#fff', thBorder: 'none', sigLine: '#999',
    }
  }
  if (layout === 'premium') {
    return {
      layout, fontFamily: "'Noto Serif Thai','Sarabun',serif", paperBg: tintHex(accent, 0.93), text: '#3a342b', muted: '#8a7b66',
      rowBorder: tintHex(accent, 0.72), noteBg: tintHex(accent, 0.96), notesBoxBg: tintHex(accent, 0.88), totalBoxBg: accent, totalBoxBorder: accent, totalBoxText: '#fff',
      thBg: tintHex(accent, 0.75), thColor: accent, thBorder: 'none', sigLine: accent,
    }
  }
  return {
    layout: 'classic', fontFamily: 'Sarabun,sans-serif', paperBg: '#fff', text: '#17181f', muted: '#6a6f85',
    rowBorder: '#eee', noteBg: '#FFFDF7', notesBoxBg: '#f9f9fc', totalBoxBg: `${accent}14`, totalBoxBorder: `${accent}55`, totalBoxText: accent,
    thBg: style.tableHeaderBg, thColor: style.tableHeaderColor, thBorder: `${style.tableHeaderBorder}px solid ${accent}`, sigLine: '#999',
  }
}

// Public URL for a tenant/default image. Absolute URLs and data: URLs pass
// through (used by the screenshot harness and previews).
export function docImageUrl(bucket, path) {
  if (!path) return ''
  if (/^(https?:|data:|blob:)/.test(path)) return path
  return supabase.storage.from(bucket).getPublicUrl(path)?.data?.publicUrl || ''
}
