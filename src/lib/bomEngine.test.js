import { describe, it, expect } from 'vitest'
import { computeBomForOpening, combineOpeningBoms } from './bomEngine.js'
import { buildCatalogIndex, makeCatalogPricing } from './aluCatalogPricing.js'

// Tiny inline pricing stub: matches a profile by (family, series text, thickness) and costs it as kg x the colour price.
function stubPricing(profiles, finish) {
  return {
    kind: 'catalog',
    profileLine({ role_name, family, length_m, quantity, thickness_mm, opening }) {
      const profile = (profiles || []).find(p => p.family === family && p.series === opening.series && p.thickness_mm === thickness_mm) || null
      const resolved = !!profile
      const weight_kg = resolved ? length_m * quantity * profile.linear_weight_kg_per_m : 0
      const cost = resolved ? weight_kg * finish.price_per_kg : 0
      return { role_name, family, series: opening.series, thickness_mm, length_m, quantity, weight_kg, cost, resolved, reason: resolved ? null : 'no_profile', price_row_id: null }
    },
    hardwarePrice(h) { return { unit_price: h.reference_unit_price, source: 'reference', price_row_id: null } },
    setLines() { return [] },
  }
}


const PROFILE = { family: 'Frame-General', series: 'General', thickness_mm: 1.2, linear_weight_kg_per_m: 1.5 }
const FINISH = { price_per_kg: 170 }
const GLASS = { price_per_sqm: 500 }

function baseTemplate(overrides = {}) {
  return {
    waste_pct: 10,
    infill_width_deduction_mm: 80,
    infill_height_deduction_mm: 80,
    labor_price_per_sqm: 0,
    silicone_price_per_m: 0,
    felt_price_per_m: 0,
    grid_row_weights: [1],
    grid_horizontal_rail_family: null,
    grid_vertical_mullion_family: null,
    ...overrides,
  }
}

function baseOpening(overrides = {}) {
  return {
    width_m: 2, height_m: 2, panel_count: 1, series: 'General', thickness_mm: 1.2,
    quantity: 1, extra_lines: [],
    ...overrides,
  }
}

describe('computeBomForOpening -- length_rule_type presets', () => {
  it('width: uses opening width directly', () => {
    const components = [{ role_name: 'Top rail', profile_family: 'Frame-General', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1 }]
    const result = computeBomForOpening(baseOpening(), baseTemplate(), components, [], stubPricing([PROFILE], FINISH), GLASS)
    expect(result.profileLines[0].length_m).toBe(2)
  })

  it('height: uses opening height directly', () => {
    const components = [{ role_name: 'Side jamb', profile_family: 'Frame-General', length_rule_type: 'height', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1 }]
    const result = computeBomForOpening(baseOpening({ width_m: 2, height_m: 3 }), baseTemplate(), components, [], stubPricing([PROFILE], FINISH), GLASS)
    expect(result.profileLines[0].length_m).toBe(3)
  })

  it('width_minus: subtracts the deduction in meters', () => {
    const components = [{ role_name: 'Lock rail', profile_family: 'Frame-General', length_rule_type: 'width_minus', length_deduction_mm: 400, quantity_basis: 'fixed', quantity_value: 1 }]
    const result = computeBomForOpening(baseOpening({ width_m: 2 }), baseTemplate(), components, [], stubPricing([PROFILE], FINISH), GLASS)
    expect(result.profileLines[0].length_m).toBeCloseTo(1.6)
  })

  it('height_minus: subtracts the deduction in meters', () => {
    const components = [{ role_name: 'Stile', profile_family: 'Frame-General', length_rule_type: 'height_minus', length_deduction_mm: 40, quantity_basis: 'fixed', quantity_value: 2 }]
    const result = computeBomForOpening(baseOpening({ height_m: 2 }), baseTemplate(), components, [], stubPricing([PROFILE], FINISH), GLASS)
    expect(result.profileLines[0].length_m).toBeCloseTo(1.96)
  })

  it('perimeter: 2 x (width + height)', () => {
    const components = [{ role_name: 'Weatherstrip frame', profile_family: 'Frame-General', length_rule_type: 'perimeter', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1 }]
    const result = computeBomForOpening(baseOpening({ width_m: 2, height_m: 3 }), baseTemplate(), components, [], stubPricing([PROFILE], FINISH), GLASS)
    expect(result.profileLines[0].length_m).toBe(10)
  })
})

describe('computeBomForOpening -- quantity_basis', () => {
  it('fixed: uses quantity_value as-is', () => {
    const components = [{ role_name: 'Side jamb', profile_family: 'Frame-General', length_rule_type: 'height', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 2 }]
    const result = computeBomForOpening(baseOpening(), baseTemplate(), components, [], stubPricing([PROFILE], FINISH), GLASS)
    expect(result.profileLines[0].quantity).toBe(2)
  })

  it('per_cell: multiplies by rowCount x columnCount', () => {
    const components = [{ role_name: 'Corner block', profile_family: 'Frame-General', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'per_cell', quantity_value: 1 }]
    const template = baseTemplate({ grid_row_weights: [0.25, 0.75] })
    const result = computeBomForOpening(baseOpening({ panel_count: 2 }), template, components, [], stubPricing([PROFILE], FINISH), GLASS)
    expect(result.profileLines[0].quantity).toBe(4) // 2 rows x 2 columns
  })
})

describe('computeBomForOpening -- waste_pct', () => {
  it('applies only to the aluminum subtotal (components + grid lines)', () => {
    const components = [{ role_name: 'Top rail', profile_family: 'Frame-General', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1 }]
    const template = baseTemplate({ waste_pct: 20, infill_width_deduction_mm: 0, infill_height_deduction_mm: 0 })
    const result = computeBomForOpening(baseOpening({ width_m: 2, height_m: 2 }), template, components, [], stubPricing([PROFILE], FINISH), null)
    // length 2m x qty 1 x 1.5 kg/m = 3kg x 170 = 510
    expect(result.profileLines[0].cost).toBeCloseTo(510)
    expect(result.wasteCost).toBeCloseTo(102) // 510 x 20%
  })
})

describe('computeBomForOpening -- grid-derived members', () => {
  it('adds no horizontal rail when grid_row_weights has length 1', () => {
    const template = baseTemplate({ grid_row_weights: [1], grid_horizontal_rail_family: 'Frame-General' })
    const result = computeBomForOpening(baseOpening(), template, [], [], stubPricing([PROFILE], FINISH), GLASS)
    expect(result.gridLines.filter(l => l.orientation === 'horizontal')).toHaveLength(0)
  })

  it('adds rowCount - 1 horizontal rails, full opening width, when weighted rows are set', () => {
    const template = baseTemplate({ grid_row_weights: [0.25, 0.75], grid_horizontal_rail_family: 'Frame-General' })
    const result = computeBomForOpening(baseOpening({ width_m: 2.5, height_m: 2 }), template, [], [], stubPricing([PROFILE], FINISH), GLASS)
    const rails = result.gridLines.filter(l => l.orientation === 'horizontal')
    expect(rails).toHaveLength(1)
    expect(rails[0].length_m).toBe(2.5)
  })

  it('adds columnCount - 1 vertical mullions, full opening height, when panel_count > 1', () => {
    const template = baseTemplate({ grid_vertical_mullion_family: 'Frame-General' })
    const result = computeBomForOpening(baseOpening({ width_m: 2, height_m: 2.2, panel_count: 3 }), template, [], [], stubPricing([PROFILE], FINISH), GLASS)
    const mullions = result.gridLines.filter(l => l.orientation === 'vertical')
    expect(mullions).toHaveLength(2)
    expect(mullions[0].length_m).toBe(2.2)
  })

  it('adds no vertical mullion when panel_count is 1, even if a family is set', () => {
    const template = baseTemplate({ grid_vertical_mullion_family: 'Frame-General' })
    const result = computeBomForOpening(baseOpening({ panel_count: 1 }), template, [], [], stubPricing([PROFILE], FINISH), GLASS)
    expect(result.gridLines.filter(l => l.orientation === 'vertical')).toHaveLength(0)
  })
})

describe('computeBomForOpening -- infill area, per cell', () => {
  it('single-cell opening: (width - deduction) x (height - deduction)', () => {
    const template = baseTemplate({ infill_width_deduction_mm: 80, infill_height_deduction_mm: 80 })
    const result = computeBomForOpening(baseOpening({ width_m: 1, height_m: 1 }), template, [], [], stubPricing([PROFILE], FINISH), GLASS)
    expect(result.infillArea_sqm).toBeCloseTo(0.92 * 0.92)
    expect(result.infillCost).toBeCloseTo(0.92 * 0.92 * 500)
  })

  it('sums across every cell of a weighted-row, multi-column grid', () => {
    const template = baseTemplate({ grid_row_weights: [0.25, 0.75], infill_width_deduction_mm: 80, infill_height_deduction_mm: 80 })
    const result = computeBomForOpening(baseOpening({ width_m: 2, height_m: 2, panel_count: 2 }), template, [], [], stubPricing([PROFILE], FINISH), GLASS)
    // 2 rows x 2 columns = 4 cells. columns: 1m wide each. rows: 0.5m and 1.5m tall.
    const cell1 = (1 - 0.08) * (0.5 - 0.08)
    const cell2 = (1 - 0.08) * (1.5 - 0.08)
    const expectedArea = 2 * cell1 + 2 * cell2
    expect(result.infillArea_sqm).toBeCloseTo(expectedArea)
  })

  it('is zero when no infillType is supplied', () => {
    const result = computeBomForOpening(baseOpening(), baseTemplate(), [], [], stubPricing([PROFILE], FINISH), null)
    expect(result.infillArea_sqm).toBe(0)
    expect(result.infillCost).toBe(0)
  })
})

describe('computeBomForOpening -- hardware', () => {
  it('fixed basis uses quantity_value as-is', () => {
    const hardware = [{ name: 'Handle', reference_unit_price: 200, quantity_basis: 'fixed', quantity_value: 1 }]
    const result = computeBomForOpening(baseOpening(), baseTemplate(), [], hardware, stubPricing([PROFILE], FINISH), GLASS)
    expect(result.hardwareLines[0].quantity).toBe(1)
    expect(result.hardwareLines[0].cost).toBe(200)
  })

  it('per_cell multiplies by rowCount x columnCount', () => {
    const hardware = [{ name: 'Hinge', reference_unit_price: 150, quantity_basis: 'per_cell', quantity_value: 3 }]
    const result = computeBomForOpening(baseOpening({ panel_count: 2 }), baseTemplate(), [], hardware, stubPricing([PROFILE], FINISH), GLASS)
    expect(result.hardwareLines[0].quantity).toBe(6)
    expect(result.hardwareLines[0].cost).toBe(900)
  })

  it('per_perimeter_m multiplies by 2 x (width + height)', () => {
    const hardware = [{ name: 'Weatherstrip', reference_unit_price: 10, quantity_basis: 'per_perimeter_m', quantity_value: 1 }]
    const result = computeBomForOpening(baseOpening({ width_m: 2, height_m: 3 }), baseTemplate(), [], hardware, stubPricing([PROFILE], FINISH), GLASS)
    expect(result.hardwareLines[0].quantity).toBe(10)
    expect(result.hardwareLines[0].cost).toBe(100)
  })
})

describe('computeBomForOpening -- unresolved components', () => {
  it('flags a component with no matching profile, contributes zero cost, never guesses', () => {
    const components = [{ role_name: 'Top rail', profile_family: 'Nonexistent', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1 }]
    const result = computeBomForOpening(baseOpening(), baseTemplate(), components, [], stubPricing([PROFILE], FINISH), GLASS)
    expect(result.unresolvedComponents).toContain('Top rail')
    expect(result.profileLines[0].resolved).toBe(false)
    expect(result.profileLines[0].cost).toBe(0)
  })

  it('flags a grid-derived member with no matching profile', () => {
    const template = baseTemplate({ grid_vertical_mullion_family: 'Nonexistent' })
    const result = computeBomForOpening(baseOpening({ panel_count: 2 }), template, [], [], stubPricing([PROFILE], FINISH), GLASS)
    expect(result.gridLines[0].resolved).toBe(false)
    expect(result.unresolvedComponents.length).toBeGreaterThan(0)
  })
})

describe('computeBomForOpening -- extra_lines and totalCost', () => {
  it('sums extra_lines amounts into extraLinesCost and the total', () => {
    const opening = baseOpening({ extra_lines: [{ description: 'Curved bending', amount: 500 }, { description: 'Bracket', amount: 300 }] })
    const result = computeBomForOpening(opening, baseTemplate(), [], [], stubPricing([PROFILE], FINISH), null)
    expect(result.extraLinesCost).toBe(800)
    expect(result.totalCost).toBeCloseTo(result.wasteCost + 800) // no components/hardware/glass in this fixture
  })

  it('totalCost is a per-unit figure -- does not multiply by opening.quantity', () => {
    const opening = baseOpening({ quantity: 5, extra_lines: [{ description: 'x', amount: 100 }] })
    const result = computeBomForOpening(opening, baseTemplate(), [], [], stubPricing([PROFILE], FINISH), null)
    expect(result.totalCost).toBeCloseTo(result.wasteCost + 100)
  })
})

describe('computeBomForOpening -- labor/silicone/felt cost lines', () => {
  it('labor = width x height x labor_price_per_sqm', () => {
    const template = baseTemplate({ labor_price_per_sqm: 500 })
    const result = computeBomForOpening(baseOpening({ width_m: 2, height_m: 3 }), template, [], [], stubPricing([PROFILE], FINISH), null)
    expect(result.laborCost).toBeCloseTo(2 * 3 * 500)
  })

  it('silicone = perimeter x silicone_price_per_m', () => {
    const template = baseTemplate({ silicone_price_per_m: 40 })
    const result = computeBomForOpening(baseOpening({ width_m: 2, height_m: 3 }), template, [], [], stubPricing([PROFILE], FINISH), null)
    expect(result.siliconeCost).toBeCloseTo(2 * (2 + 3) * 40)
  })

  it('felt = perimeter x felt_price_per_m', () => {
    const template = baseTemplate({ felt_price_per_m: 15 })
    const result = computeBomForOpening(baseOpening({ width_m: 2, height_m: 3 }), template, [], [], stubPricing([PROFILE], FINISH), null)
    expect(result.feltCost).toBeCloseTo(2 * (2 + 3) * 15)
  })

  it('all three are zero at the default rate, and totalCost is unchanged from before this spec', () => {
    const result = computeBomForOpening(baseOpening(), baseTemplate(), [], [], stubPricing([PROFILE], FINISH), null)
    expect(result.laborCost).toBe(0)
    expect(result.siliconeCost).toBe(0)
    expect(result.feltCost).toBe(0)
    expect(result.totalCost).toBeCloseTo(result.wasteCost) // no components/hardware/infill/extra_lines in this fixture
  })

  it('all three sum into totalCost alongside the existing factors', () => {
    const template = baseTemplate({ labor_price_per_sqm: 500, silicone_price_per_m: 40, felt_price_per_m: 15 })
    const result = computeBomForOpening(baseOpening({ width_m: 2, height_m: 3 }), template, [], [], stubPricing([PROFILE], FINISH), null)
    expect(result.totalCost).toBeCloseTo(result.wasteCost + result.laborCost + result.siliconeCost + result.feltCost)
  })
})

describe('computeBomForOpening -- infill material kinds', () => {
  it('uses the same area x price formula regardless of material_kind', () => {
    const meshInfill = { price_per_sqm: 300, material_kind: 'mesh' }
    const template = baseTemplate({ infill_width_deduction_mm: 80, infill_height_deduction_mm: 80 })
    const result = computeBomForOpening(baseOpening({ width_m: 1, height_m: 1 }), template, [], [], stubPricing([PROFILE], FINISH), meshInfill)
    expect(result.infillArea_sqm).toBeCloseTo(0.92 * 0.92)
    expect(result.infillCost).toBeCloseTo(0.92 * 0.92 * 300)
  })

  it('acp and solid_panel infill kinds compute identically to glass at the same price', () => {
    const template = baseTemplate({ infill_width_deduction_mm: 0, infill_height_deduction_mm: 0 })
    const acpResult = computeBomForOpening(baseOpening({ width_m: 1, height_m: 1 }), template, [], [], stubPricing([PROFILE], FINISH), { price_per_sqm: 500, material_kind: 'acp' })
    const glassResult = computeBomForOpening(baseOpening({ width_m: 1, height_m: 1 }), template, [], [], stubPricing([PROFILE], FINISH), { price_per_sqm: 500, material_kind: 'glass' })
    expect(acpResult.infillCost).toBeCloseTo(glassResult.infillCost)
  })
})

describe('combineOpeningBoms -- add-on unit aggregation (spec Testing section)', () => {
  it('main-only total is unchanged when there is no add-on', () => {
    const mainBom = computeBomForOpening(baseOpening({ width_m: 2, height_m: 2 }), baseTemplate(), [], [], stubPricing([PROFILE], FINISH), GLASS)
    const combined = combineOpeningBoms(mainBom, null)
    expect(combined.totalCost).toBeCloseTo(mainBom.totalCost)
    expect(combined.addonBom).toBeNull()
  })

  it('sums main and add-on totals correctly when an add-on is present', () => {
    const mainBom = computeBomForOpening(baseOpening({ width_m: 2, height_m: 2 }), baseTemplate(), [], [], stubPricing([PROFILE], FINISH), GLASS)
    const addonBom = computeBomForOpening(baseOpening({ width_m: 1, height_m: 0.5 }), baseTemplate(), [], [], stubPricing([PROFILE], FINISH), GLASS)
    const combined = combineOpeningBoms(mainBom, addonBom)
    expect(combined.totalCost).toBeCloseTo(mainBom.totalCost + addonBom.totalCost)
  })

  it('keeps each unit\'s unresolvedComponents reporting separate', () => {
    const mainComponents = [{ role_name: 'Top rail', profile_family: 'Nonexistent-Main', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1 }]
    const addonComponents = [{ role_name: 'Transom rail', profile_family: 'Nonexistent-Addon', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1 }]
    const mainBom = computeBomForOpening(baseOpening(), baseTemplate(), mainComponents, [], stubPricing([PROFILE], FINISH), GLASS)
    const addonBom = computeBomForOpening(baseOpening({ width_m: 1, height_m: 0.5 }), baseTemplate(), addonComponents, [], stubPricing([PROFILE], FINISH), GLASS)
    const combined = combineOpeningBoms(mainBom, addonBom)
    expect(combined.mainBom.unresolvedComponents).toEqual(['Top rail'])
    expect(combined.addonBom.unresolvedComponents).toEqual(['Transom rail'])
  })

  it('returns null when there is no main BOM yet', () => {
    expect(combineOpeningBoms(null, null)).toBeNull()
  })
})

describe('computeBomForOpening -- catalog pricing', () => {
  const rows = {
    providers: [{ id: 'p1', price_basis: 'per_kg' }],
    series: [{ id: 's1', provider_id: 'p1' }],
    profiles: [{ id: 'pr1', provider_id: 'p1', thickness_mm: 1.2, linear_weight_kg_per_m: 1.5, default_length_m: 6.4, active: true }],
    seriesProfiles: [{ id: 'l1', series_id: 's1', profile_id: 'pr1', family: 'Frame' }],
    finishes: [{ id: 'f1', provider_id: 'p1' }],
    parts: [
      { id: 'set1', name: 'Set', code: 'P-0001', kind: 'hardware_set' },
      { id: 'pt1', name: 'Lock', code: 'P-0002', kind: 'hardware' },
      { id: 'pt2', name: 'Hinge', code: 'P-0003', kind: 'hardware' },
    ],
    setItems: [{ id: 'i1', set_id: 'set1', part_id: 'pt1', quantity: 2 }, { id: 'i2', set_id: 'set1', part_id: 'pt2', quantity: 1 }],
    kgPrices: [{ id: 'k1', provider_id: 'p1', finish_id: 'f1', series_id: null, profile_id: null, price_per_kg: 100, effective_from: '2026-01-01' }],
    partPrices: [{ id: 'pp1', part_id: 'pt1', list_price: 100, discount_pct: 10, effective_from: '2026-01-01' }],
  }
  const pricing = (asOf = '2026-06-01') => makeCatalogPricing({ index: buildCatalogIndex(rows), seriesId: 's1', finishId: 'f1', asOf })
  const rail = { role_name: 'Top rail', profile_family: 'Frame', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1 }
  const opening = (o = {}) => baseOpening({ thickness_mm: 1.2, ...o })

  it('prices aluminium from the catalog and adds waste', () => {
    const r = computeBomForOpening(opening(), baseTemplate(), [rail], [], pricing(), null)
    expect(r.profileLines[0].cost).toBeCloseTo(300)   // 2 m x 1.5 kg/m x 100
    expect(r.wasteCost).toBeCloseTo(30)
    expect(r.totalCost).toBeCloseTo(330)
    expect(r.unresolvedComponents).toEqual([])
  })

  it('an unresolved profile is listed with its reason and costs 0', () => {
    const r = computeBomForOpening(opening(), baseTemplate(), [{ ...rail, profile_family: 'Nope' }], [], pricing(), null)
    expect(r.unresolvedComponents).toEqual(['Top rail'])
    expect(r.unresolvedDetails).toEqual([{ name: 'Top rail', reason: 'no_profile' }])
    expect(r.totalCost).toBe(0)
  })

  it('labour: the opening rate (even 0) beats the template rate; null falls back to the template', () => {
    const tpl = baseTemplate({ labor_price_per_sqm: 100 })
    expect(computeBomForOpening(opening({ labour_per_sqm: 500 }), tpl, [], [], pricing(), null).laborCost).toBeCloseTo(2000)
    expect(computeBomForOpening(opening({ labour_per_sqm: 0 }), tpl, [], [], pricing(), null).laborCost).toBe(0)
    expect(computeBomForOpening(opening({ labour_per_sqm: null }), tpl, [], [], pricing(), null).laborCost).toBeCloseTo(400)
    expect(computeBomForOpening(opening(), tpl, [], [], pricing(), null).laborCost).toBeCloseTo(400)
  })

  it('template hardware linked to a priced part uses the part price, else the reference price', () => {
    const hw = [
      { name: 'Lock', part_id: 'pt1', reference_unit_price: 50, quantity_basis: 'fixed', quantity_value: 2 },
      { name: 'Hinge', part_id: null, reference_unit_price: 30, quantity_basis: 'fixed', quantity_value: 1 },
    ]
    const r = computeBomForOpening(opening(), baseTemplate(), [], hw, pricing(), null)
    expect(r.hardwareLines[0]).toMatchObject({ cost: 180, price_source: 'part', price_row_id: 'pp1' })
    expect(r.hardwareLines[1]).toMatchObject({ cost: 30, price_source: 'reference' })
  })

  it('catalog hardware with no part price and no reference price is listed unresolved, not silently 0', () => {
    const hw = [{ name: 'Mystery', part_id: null, reference_unit_price: 0, quantity_basis: 'fixed', quantity_value: 1 }]
    const r = computeBomForOpening(opening(), baseTemplate(), [], hw, pricing(), null)
    expect(r.unresolvedComponents).toEqual(['Mystery'])
    expect(r.unresolvedDetails).toEqual([{ name: 'Mystery', reason: 'no_hardware_price' }])
  })

  it('a hardware set adds its priced parts; an unpriced part is listed unresolved, not silently free (Review Focus 5)', () => {
    const r = computeBomForOpening(opening({ hardware_set_id: 'set1' }), baseTemplate(), [], [], pricing(), null)
    expect(r.hardwareSetLines).toHaveLength(2)
    expect(r.hardwareSetLines.find(l => l.name === 'Lock').cost).toBe(180)
    expect(r.unresolvedComponents).toEqual(['Hinge'])
    expect(r.unresolvedDetails).toEqual([{ name: 'Hinge', reason: 'no_part_price' }])
    expect(r.totalCost).toBeCloseTo(180)
  })

  it('an unknown hardware set id is listed unresolved and adds no cost (never silently empty)', () => {
    const known = computeBomForOpening(opening({ hardware_set_id: null }), baseTemplate(), [], [], pricing(), null)
    const r = computeBomForOpening(opening({ hardware_set_id: 'ghost' }), baseTemplate(), [], [], pricing(), null)
    expect(r.unresolvedComponents).toEqual(['ชุดอุปกรณ์'])
    expect(r.unresolvedDetails).toHaveLength(1)
    expect(r.unresolvedDetails[0].name).toBe('ชุดอุปกรณ์')
    expect(r.totalCost).toBe(known.totalCost)
  })

  it('no hardware_set_id means no set lines (legacy pricing never has sets)', () => {
    const r = computeBomForOpening(opening(), baseTemplate(), [], [], pricing(), null)
    expect(r.hardwareSetLines).toEqual([])
    const legacy = computeBomForOpening(baseOpening({ hardware_set_id: 'set1' }), baseTemplate(), [], [], stubPricing([PROFILE], FINISH), null)
    expect(legacy.hardwareSetLines).toEqual([])
  })

  it('price rows used are reported so a later "as of today" run can be compared', () => {
    const r = computeBomForOpening(opening({ hardware_set_id: 'set1' }), baseTemplate(), [rail], [], pricing(), null)
    expect(r.profileLines[0].price_row_id).toBe('k1')
    expect(r.hardwareSetLines.find(l => l.name === 'Lock').price_row_id).toBe('pp1')
  })
})

describe('computeBomForOpening -- length_factor and end_deduction_mm', () => {
  const lenOf = (extra, widthM = 1.8) => {
    const components = [{ role_name: 'Rail', profile_family: 'Frame-General', length_rule_type: 'width_minus', length_deduction_mm: 51.2, quantity_basis: 'fixed', quantity_value: 1, ...extra }]
    return computeBomForOpening(baseOpening({ width_m: widthM }), baseTemplate(), components, [], stubPricing([PROFILE], FINISH), GLASS).profileLines[0].length_m
  }
  const OLD = 1.8 - 0.0512

  it('(a) factor 0.5 and end deduction 50 mm: (1.8 - 0.0512) x 0.5 - 0.05 = 0.8244', () => {
    expect(lenOf({ length_factor: 0.5, end_deduction_mm: 50 })).toBeCloseTo(0.8244, 6)
  })
  it('(b) neither field gives exactly the old length', () => {
    expect(lenOf({})).toBe(OLD)
  })
  it('(c) DB numeric strings behave as numbers', () => {
    expect(lenOf({ length_factor: '0.5', end_deduction_mm: '25' })).toBeCloseTo(OLD * 0.5 - 0.025, 9)
  })
  it('(d) null, empty, NaN, zero factor and negative end deduction fall back to 1 / 0', () => {
    expect(lenOf({ length_factor: null, end_deduction_mm: null })).toBe(OLD)
    expect(lenOf({ length_factor: '', end_deduction_mm: '' })).toBe(OLD)
    expect(lenOf({ length_factor: NaN, end_deduction_mm: NaN })).toBe(OLD)
    expect(lenOf({ length_factor: 0 })).toBe(OLD)
    expect(lenOf({ length_factor: -2 })).toBe(OLD)
    expect(lenOf({ end_deduction_mm: -10 })).toBe(OLD)
    expect(lenOf({ end_deduction_mm: 0 })).toBe(OLD)
  })
  it('(e) explicit factor 1 and end deduction 0 equals absent', () => {
    expect(lenOf({ length_factor: 1, end_deduction_mm: 0 })).toBe(lenOf({}))
  })
})
