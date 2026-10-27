// ============================================================
// Pure computation of a per-unit BOM and cost for one estimation_opening,
// given its bom_template and the reference catalogs it needs. No I/O --
// callers (BomTemplates.jsx's preview, Estimation.jsx) load every input
// once and call this on every keystroke. Mirrors the house style already
// used by inventoryCost.js.
//
// See docs/superpowers/specs/2026-09-10-bom-template-engine-design.md's
// "Business logic" section for the original engine, and
// docs/superpowers/specs/2026-09-29-bom-cost-factors-design.md for the
// infill generalization + labor/silicone/felt cost lines added here.
// Add-on unit aggregation happens at the CALLER (Estimation.jsx), not in
// this function -- this stays "one opening in, one BOM out."
// ============================================================

export function resolveGrid(template, opening) {
  const rowWeights = template.grid_row_weights.length ? template.grid_row_weights : [1]
  const rowCount = rowWeights.length
  const columnCount = Math.max(1, opening.panel_count || 1)
  const rowWeightSum = rowWeights.reduce((s, w) => s + w, 0)
  const rowFractions = rowWeights.map(w => w / rowWeightSum)
  const cellWidth_m = opening.width_m / columnCount
  const cells = rowFractions.map(frac => ({ width_m: cellWidth_m, height_m: opening.height_m * frac }))
  return { rowCount, columnCount, cells }
}

const factorOf = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 1)
const endOf = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0)
const isFixedLength = v => v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0

export function computeComponentLength(rule, deductionMm, widthM, heightM, factor = 1, endDeductionMm = 0) {
  const deductionM = deductionMm / 1000
  let base
  if (rule === 'width') base = widthM
  else if (rule === 'height') base = heightM
  else if (rule === 'width_minus') base = widthM - deductionM
  else if (rule === 'height_minus') base = heightM - deductionM
  else if (rule === 'perimeter') base = 2 * (widthM + heightM)
  else throw new Error(`Unknown length_rule_type: ${rule}`)
  return base * factor - endDeductionMm / 1000
}

// A component may carry its own thickness (frame vs sash, only where the type allows it; see assembly.applyRoleThickness);
// otherwise the opening's single thickness applies.
// Every line (component or grid) carries the same end shape for the cut sheet: cut_style, cut_ends (0|1|2 ends cut that
// way, the rest square), the notch size and the joint name. A grid line has none of these, so it reads square / 0 / null.
function priceProfileLine({ role_name, family, length_m, quantity, pricing, opening, thickness_mm, cut_style, cut_ends, notch_width_mm, notch_depth_mm, joint_name }) {
  const line = pricing.profileLine({ role_name, family, length_m, quantity, thickness_mm: thickness_mm != null ? thickness_mm : opening.thickness_mm, opening })
  const style = cut_style || 'square'
  return { ...line, cut_style: style, cut_ends: style === 'square' ? 0 : (Number(cut_ends) === 1 ? 1 : 2),
    notch_width_mm: notch_width_mm ?? null, notch_depth_mm: notch_depth_mm ?? null, joint_name: joint_name ?? null }
}

// `pricing` comes from aluCatalogPricing.makeCatalogPricing(); callers must pass a real asOf date (a null asOf lets future-dated price rows through).
export function computeBomForOpening(opening, template, components, hardware, pricing, infillType) {
  const { rowCount, columnCount, cells } = resolveGrid(template, opening)

  // Grid-derived internal members (Business logic Step 2).
  const gridLines = []
  if (rowCount > 1 && template.grid_horizontal_rail_family) {
    for (let i = 0; i < rowCount - 1; i++) {
      gridLines.push({
        orientation: 'horizontal',
        ...priceProfileLine({ role_name: 'Horizontal rail', family: template.grid_horizontal_rail_family, length_m: opening.width_m, quantity: 1, pricing, opening }),
      })
    }
  }
  if (columnCount > 1 && template.grid_vertical_mullion_family) {
    for (let i = 0; i < columnCount - 1; i++) {
      gridLines.push({
        orientation: 'vertical',
        ...priceProfileLine({ role_name: 'Vertical mullion', family: template.grid_vertical_mullion_family, length_m: opening.height_m, quantity: 1, pricing, opening }),
      })
    }
  }

  // Explicit components (Business logic Step 3).
  const profileLines = (components || []).map(c => {
    // fixed_length_mm (add-on pieces, overridden main members): a length in mm that replaces the opening's rule.
    const length_m = isFixedLength(c.fixed_length_mm)
      ? (Number(c.fixed_length_mm) / 1000) * factorOf(c.length_factor) - endOf(c.end_deduction_mm) / 1000
      : computeComponentLength(c.length_rule_type, c.length_deduction_mm, opening.width_m, opening.height_m, factorOf(c.length_factor), endOf(c.end_deduction_mm))
    const quantity = c.quantity_basis === 'per_cell' ? c.quantity_value * rowCount * columnCount : c.quantity_value
    return priceProfileLine({ role_name: c.role_name, family: c.profile_family, length_m, quantity, pricing, opening, thickness_mm: c.thickness_mm, cut_style: c.cut_style,
      cut_ends: c.cut_ends, notch_width_mm: c.notch_width_mm, notch_depth_mm: c.notch_depth_mm, joint_name: c.joint_name })
  })

  const unresolvedProfileLines = [...profileLines, ...gridLines].filter(l => !l.resolved)
  const aluminumSubtotal = [...profileLines, ...gridLines].reduce((s, l) => s + l.cost, 0)
  const wasteCost = aluminumSubtotal * (template.waste_pct / 100)

  const perimeter_m = 2 * (opening.width_m + opening.height_m)
  const hardwareLines = (hardware || []).map(h => {
    const quantity =
      h.quantity_basis === 'per_cell' ? h.quantity_value * rowCount * columnCount :
      h.quantity_basis === 'per_perimeter_m' ? h.quantity_value * perimeter_m :
      h.quantity_value
    const hp = pricing.hardwarePrice(h)
    // Catalog pricing falls back to a 0 reference price when nothing is priced: surface that, never hide it.
    // (Legacy pricing is left alone so the old Estimation screen behaves exactly as before.)
    const unresolved = hp.source === 'reference' && !(hp.unit_price > 0)
    return { name: h.name, part_id: h.part_id || null, quantity, cost: quantity * hp.unit_price, price_source: hp.source, price_row_id: hp.price_row_id, unresolved }
  })
  const unresolvedHardwareLines = hardwareLines.filter(l => l.unresolved)

  // One hardware set per opening unit (Ruling: not scaled per cell). An unpriced part is listed, never hidden.
  const hardwareSetLines = opening.hardware_set_id && pricing.setLines ? pricing.setLines(opening.hardware_set_id) : []
  const unresolvedSetLines = hardwareSetLines.filter(l => !l.resolved)

  let infillArea_sqm = 0
  if (infillType) {
    const wDed = template.infill_width_deduction_mm / 1000
    const hDed = template.infill_height_deduction_mm / 1000
    // Each entry in `cells` already represents one column's width (cellWidth_m
    // = width_m / columnCount) for that row -- so one row's total infill area
    // is columnCount identical cells, not a second loop over columns.
    for (const cell of cells) {
      infillArea_sqm += columnCount * Math.max(0, cell.width_m - wDed) * Math.max(0, cell.height_m - hDed)
    }
  }
  const infillCost = infillType ? infillArea_sqm * infillType.price_per_sqm : 0

  // Labour: the opening's effective rate (resolved by the caller: item -> project -> type default; 0 is a
  // real value) wins; null/undefined falls back to the template's own rate.
  // Merge add-ons (owner 2026-10-16, Q11, D6): the caller may widen the labour area and the silicone / felt perimeter to
  // the main unit plus its ร่วมวงกบ add-ons (opening.labour_area_sqm, opening.seal_perimeter_m); W × H and 2(W + H)
  // otherwise. Member lengths and per-perimeter hardware stay on the opening's own W × H.
  const labourRate = Number.isFinite(opening.labour_per_sqm) ? opening.labour_per_sqm : template.labor_price_per_sqm
  const labourArea = Number.isFinite(opening.labour_area_sqm) ? opening.labour_area_sqm : opening.width_m * opening.height_m
  const sealPerimeter = Number.isFinite(opening.seal_perimeter_m) ? opening.seal_perimeter_m : perimeter_m
  const laborCost = labourArea * labourRate
  const siliconeCost = sealPerimeter * template.silicone_price_per_m
  const feltCost = sealPerimeter * template.felt_price_per_m

  const extraLinesCost = (opening.extra_lines || []).reduce((s, l) => s + l.amount, 0)

  const totalCost = aluminumSubtotal + wasteCost + hardwareLines.reduce((s, l) => s + l.cost, 0)
    + hardwareSetLines.reduce((s, l) => s + l.cost, 0) + infillCost
    + laborCost + siliconeCost + feltCost + extraLinesCost

  return {
    profileLines, gridLines, hardwareLines, hardwareSetLines, infillArea_sqm, infillCost, wasteCost,
    laborCost, siliconeCost, feltCost, extraLinesCost, totalCost,
    unresolvedComponents: [
      ...unresolvedProfileLines.map(l => l.role_name),
      ...unresolvedHardwareLines.map(l => l.name),
      ...unresolvedSetLines.map(l => l.name),
    ],
    unresolvedDetails: [
      ...unresolvedProfileLines.map(l => ({ name: l.role_name, reason: l.reason })),
      ...unresolvedHardwareLines.map(l => ({ name: l.name, reason: 'no_hardware_price' })),
      ...unresolvedSetLines.map(l => ({ name: l.name, reason: l.reason || 'no_part_price' })),
    ],
  }
}

// Combines a main unit's BOM with an optional add-on unit's BOM (spec
// Decision 5). A sibling to computeBomForOpening, not a second code path
// inside it -- the Global Constraint only forbids the latter. Each
// result's unresolvedComponents stays on its own object so the caller
// can attribute an unresolved profile to the main unit or the add-on.
export function combineOpeningBoms(mainBom, addonBom) {
  if (!mainBom) return null
  return {
    mainBom,
    addonBom: addonBom || null,
    totalCost: mainBom.totalCost + (addonBom ? addonBom.totalCost : 0),
  }
}
