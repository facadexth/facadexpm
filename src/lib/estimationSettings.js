// src/lib/estimationSettings.js
// Tenant-wide estimation constants (one row in estimation_settings; every value is universal, not per project).
// The kerf numbers are PLACEHOLDERS until the owner measures his saw: a 45 degree cut wastes more (owner estimate ~10 mm).
// A mitred piece's length must always be its OUTER (long-point) length; mixing inner and outer lengths causes large errors.
export const DEFAULT_SETTINGS = {
  stock_length_m: 6.4,
  kerf_square_mm: 3,
  kerf_miter_mm: 10,
  min_keep_offcut_m: 0.5,
  sealant_m_per_tube: 10,
  fixing_pitch_m: 0.6,
  fixing_min_per_side: 2,
  default_waste_pct: 10,
  default_profit_pct: 45,
  default_pm_pct: 2,
  default_round_step: 100,
  sealant_part_id: null,
  shim_part_id: null,
  screw_part_id: null,
  plug_part_id: null,
}

const num = (v, fallback, ok) => { const n = Number(v); return v !== null && v !== undefined && v !== '' && Number.isFinite(n) && ok(n) ? n : fallback }

// Fills every missing / invalid field from DEFAULT_SETTINGS so callers never see NaN or undefined.
export function mergeSettings(row) {
  const r = row || {}
  const d = DEFAULT_SETTINGS
  return {
    stock_length_m: num(r.stock_length_m, d.stock_length_m, n => n > 0),
    kerf_square_mm: num(r.kerf_square_mm, d.kerf_square_mm, n => n >= 0),
    kerf_miter_mm: num(r.kerf_miter_mm, d.kerf_miter_mm, n => n >= 0),
    min_keep_offcut_m: num(r.min_keep_offcut_m, d.min_keep_offcut_m, n => n >= 0),
    sealant_m_per_tube: num(r.sealant_m_per_tube, d.sealant_m_per_tube, n => n > 0),
    fixing_pitch_m: num(r.fixing_pitch_m, d.fixing_pitch_m, n => n > 0),
    fixing_min_per_side: Math.floor(num(r.fixing_min_per_side, d.fixing_min_per_side, n => n >= 1)),
    default_waste_pct: num(r.default_waste_pct, d.default_waste_pct, n => n >= 0 && n <= 1000),
    default_profit_pct: num(r.default_profit_pct, d.default_profit_pct, n => n >= 0 && n <= 1000),
    default_pm_pct: num(r.default_pm_pct, d.default_pm_pct, n => n >= 0 && n <= 1000),
    default_round_step: num(r.default_round_step, d.default_round_step, n => n > 0),
    sealant_part_id: r.sealant_part_id || null,
    shim_part_id: r.shim_part_id || null,
    screw_part_id: r.screw_part_id || null,
    plug_part_id: r.plug_part_id || null,
  }
}
