// src/lib/descriptionFormat.js
// The quotation description of an item is a configurable combination of parts (owner: item name, type, size,
// aluminium, colour ...). The project stores the ordered token list; this builds the text. Pure.
export const DESCRIPTION_TOKENS = [
  { key: 'item_name', label: 'ชื่อรายการ' },
  { key: 'type', label: 'ประเภท' },
  { key: 'size', label: 'ขนาด' },
  { key: 'series', label: 'ซีรีส์' },
  { key: 'alu_color', label: 'สีอลูมิเนียม' },
  { key: 'thickness', label: 'ความหนา' },
  { key: 'infill', label: 'วัสดุอุดช่อง' },
  { key: 'hardware_set', label: 'ชุดอุปกรณ์' },
]
export const DEFAULT_DESCRIPTION_FORMAT = ['item_name', 'type', 'size', 'alu_color']

// sizes are metres in; the quotation reads millimetres (Ruling 23)
const mm = n => String(Math.round(Number(n) * 1e4) / 10)

// ctx: { item_name, type_name, width_m, height_m, series_label, finish_name, thickness_mm, infill_name, hardware_set_name }
export function descriptionParts(ctx, tokens) {
  const c = ctx || {}
  const text = {
    item_name: c.item_name,
    type: c.type_name,
    size: c.width_m > 0 && c.height_m > 0 ? `ขนาด ${mm(c.width_m)} × ${mm(c.height_m)} มม.` : '',
    series: c.series_label,
    alu_color: c.finish_name ? `สี${c.finish_name}` : '',
    thickness: c.thickness_mm > 0 ? `หนา ${Number(c.thickness_mm)} มม.` : '',
    infill: c.infill_name,
    hardware_set: c.hardware_set_name,
  }
  const known = new Set(DESCRIPTION_TOKENS.map(t => t.key))
  const list = Array.isArray(tokens) ? tokens : DEFAULT_DESCRIPTION_FORMAT
  return list.filter(k => known.has(k)).map(k => String(text[k] ?? '').trim()).filter(Boolean)
}

export const buildItemDescription = (ctx, tokens, separator = ' ') => descriptionParts(ctx, tokens).join(separator)
