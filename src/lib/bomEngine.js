// ============================================================
// Pure computation of a per-unit BOM and cost for one estimation_opening,
// given its bom_template and the reference catalogs it needs. No I/O --
// callers (BomTemplates.jsx's preview, Estimation.jsx) load every input
// once and call this on every keystroke. Mirrors the house style already
// used by inventoryCost.js.
//
// See docs/superpowers/specs/2026-09-10-bom-template-engine-design.md's
// "Business logic" section -- this is a direct implementation of it.
// ============================================================

function resolveGrid(template, opening) {
  const rowWeights = template.grid_row_weights.length ? template.grid_row_weights : [1]
  const rowCount = rowWeights.length
  const columnCount = Math.max(1, opening.panel_count || 1)
  const rowWeightSum = rowWeights.reduce((s, w) => s + w, 0)
  const rowFractions = rowWeights.map(w => w / rowWeightSum)
  const cellWidth_m = opening.width_m / columnCount
  const cells = rowFractions.map(frac => ({ width_m: cellWidth_m, height_m: opening.height_m * frac }))
  return { rowCount, columnCount, cells }
}

function resolveProfile(profiles, family, series, thicknessMm) {
  return profiles.find(p => p.family === family && p.series === series && p.thickness_mm === thicknessMm) || null
}

function computeComponentLength(rule, deductionMm, widthM, heightM) {
  const deductionM = deductionMm / 1000
  if (rule === 'width') return widthM
  if (rule === 'height') return heightM
  if (rule === 'width_minus') return widthM - deductionM
  if (rule === 'height_minus') return heightM - deductionM
  if (rule === 'perimeter') return 2 * (widthM + heightM)
  throw new Error(`Unknown length_rule_type: ${rule}`)
}

function priceProfileLine({ role_name, family, length_m, quantity, profiles, opening, finish }) {
  const profile = resolveProfile(profiles, family, opening.series, opening.thickness_mm)
  const resolved = !!profile
  const weight_kg = resolved ? length_m * quantity * profile.linear_weight_kg_per_m : 0
  const cost = resolved ? weight_kg * finish.price_per_kg : 0
  return { role_name, family, series: opening.series, thickness_mm: opening.thickness_mm, length_m, quantity, weight_kg, cost, resolved }
}

export function computeBomForOpening(opening, template, components, hardware, profiles, finish, glassType) {
  const { rowCount, columnCount, cells } = resolveGrid(template, opening)

  // Grid-derived internal members (Business logic Step 2).
  const gridLines = []
  if (rowCount > 1 && template.grid_horizontal_rail_family) {
    for (let i = 0; i < rowCount - 1; i++) {
      gridLines.push({
        orientation: 'horizontal',
        ...priceProfileLine({
          role_name: 'Horizontal rail', family: template.grid_horizontal_rail_family,
          length_m: opening.width_m, quantity: 1, profiles, opening, finish,
        }),
      })
    }
  }
  if (columnCount > 1 && template.grid_vertical_mullion_family) {
    for (let i = 0; i < columnCount - 1; i++) {
      gridLines.push({
        orientation: 'vertical',
        ...priceProfileLine({
          role_name: 'Vertical mullion', family: template.grid_vertical_mullion_family,
          length_m: opening.height_m, quantity: 1, profiles, opening, finish,
        }),
      })
    }
  }

  // Explicit components (Business logic Step 3).
  const profileLines = (components || []).map(c => {
    const length_m = computeComponentLength(c.length_rule_type, c.length_deduction_mm, opening.width_m, opening.height_m)
    const quantity = c.quantity_basis === 'per_cell' ? c.quantity_value * rowCount * columnCount : c.quantity_value
    return priceProfileLine({ role_name: c.role_name, family: c.profile_family, length_m, quantity, profiles, opening, finish })
  })

  const unresolvedComponents = [...profileLines, ...gridLines].filter(l => !l.resolved).map(l => l.role_name)

  const aluminumSubtotal = [...profileLines, ...gridLines].reduce((s, l) => s + l.cost, 0)
  const wasteCost = aluminumSubtotal * (template.waste_pct / 100)

  const perimeter_m = 2 * (opening.width_m + opening.height_m)
  const hardwareLines = (hardware || []).map(h => {
    const quantity =
      h.quantity_basis === 'per_cell' ? h.quantity_value * rowCount * columnCount :
      h.quantity_basis === 'per_perimeter_m' ? h.quantity_value * perimeter_m :
      h.quantity_value
    return { name: h.name, quantity, cost: quantity * h.reference_unit_price }
  })

  let glassArea_sqm = 0
  if (glassType) {
    const wDed = template.glass_width_deduction_mm / 1000
    const hDed = template.glass_height_deduction_mm / 1000
    // Each entry in `cells` already represents one column's width (cellWidth_m
    // = width_m / columnCount) for that row -- so one row's total glass area
    // is columnCount identical cells, not a second loop over columns.
    for (const cell of cells) {
      glassArea_sqm += columnCount * Math.max(0, cell.width_m - wDed) * Math.max(0, cell.height_m - hDed)
    }
  }
  const glassCost = glassType ? glassArea_sqm * glassType.price_per_sqm : 0

  const extraLinesCost = (opening.extra_lines || []).reduce((s, l) => s + l.amount, 0)

  const totalCost = aluminumSubtotal + wasteCost + hardwareLines.reduce((s, l) => s + l.cost, 0) + glassCost + extraLinesCost

  return { profileLines, gridLines, hardwareLines, glassArea_sqm, glassCost, wasteCost, extraLinesCost, totalCost, unresolvedComponents }
}
