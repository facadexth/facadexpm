import { describe, it, expect } from 'vitest'
import { computeBomForOpening } from './bomEngine.js'

const PROFILE = { family: 'Frame-General', series: 'General', thickness_mm: 1.2, linear_weight_kg_per_m: 1.5 }
const FINISH = { price_per_kg: 170 }
const GLASS = { price_per_sqm: 500 }

function baseTemplate(overrides = {}) {
  return {
    waste_pct: 10,
    glass_width_deduction_mm: 80,
    glass_height_deduction_mm: 80,
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
    const result = computeBomForOpening(baseOpening(), baseTemplate(), components, [], [PROFILE], FINISH, GLASS)
    expect(result.profileLines[0].length_m).toBe(2)
  })

  it('height: uses opening height directly', () => {
    const components = [{ role_name: 'Side jamb', profile_family: 'Frame-General', length_rule_type: 'height', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1 }]
    const result = computeBomForOpening(baseOpening({ width_m: 2, height_m: 3 }), baseTemplate(), components, [], [PROFILE], FINISH, GLASS)
    expect(result.profileLines[0].length_m).toBe(3)
  })

  it('width_minus: subtracts the deduction in meters', () => {
    const components = [{ role_name: 'Lock rail', profile_family: 'Frame-General', length_rule_type: 'width_minus', length_deduction_mm: 400, quantity_basis: 'fixed', quantity_value: 1 }]
    const result = computeBomForOpening(baseOpening({ width_m: 2 }), baseTemplate(), components, [], [PROFILE], FINISH, GLASS)
    expect(result.profileLines[0].length_m).toBeCloseTo(1.6)
  })

  it('height_minus: subtracts the deduction in meters', () => {
    const components = [{ role_name: 'Stile', profile_family: 'Frame-General', length_rule_type: 'height_minus', length_deduction_mm: 40, quantity_basis: 'fixed', quantity_value: 2 }]
    const result = computeBomForOpening(baseOpening({ height_m: 2 }), baseTemplate(), components, [], [PROFILE], FINISH, GLASS)
    expect(result.profileLines[0].length_m).toBeCloseTo(1.96)
  })

  it('perimeter: 2 x (width + height)', () => {
    const components = [{ role_name: 'Weatherstrip frame', profile_family: 'Frame-General', length_rule_type: 'perimeter', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1 }]
    const result = computeBomForOpening(baseOpening({ width_m: 2, height_m: 3 }), baseTemplate(), components, [], [PROFILE], FINISH, GLASS)
    expect(result.profileLines[0].length_m).toBe(10)
  })
})

describe('computeBomForOpening -- quantity_basis', () => {
  it('fixed: uses quantity_value as-is', () => {
    const components = [{ role_name: 'Side jamb', profile_family: 'Frame-General', length_rule_type: 'height', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 2 }]
    const result = computeBomForOpening(baseOpening(), baseTemplate(), components, [], [PROFILE], FINISH, GLASS)
    expect(result.profileLines[0].quantity).toBe(2)
  })

  it('per_cell: multiplies by rowCount x columnCount', () => {
    const components = [{ role_name: 'Corner block', profile_family: 'Frame-General', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'per_cell', quantity_value: 1 }]
    const template = baseTemplate({ grid_row_weights: [0.25, 0.75] })
    const result = computeBomForOpening(baseOpening({ panel_count: 2 }), template, components, [], [PROFILE], FINISH, GLASS)
    expect(result.profileLines[0].quantity).toBe(4) // 2 rows x 2 columns
  })
})

describe('computeBomForOpening -- waste_pct', () => {
  it('applies only to the aluminum subtotal (components + grid lines)', () => {
    const components = [{ role_name: 'Top rail', profile_family: 'Frame-General', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1 }]
    const template = baseTemplate({ waste_pct: 20, glass_width_deduction_mm: 0, glass_height_deduction_mm: 0 })
    const result = computeBomForOpening(baseOpening({ width_m: 2, height_m: 2 }), template, components, [], [PROFILE], FINISH, null)
    // length 2m x qty 1 x 1.5 kg/m = 3kg x 170 = 510
    expect(result.profileLines[0].cost).toBeCloseTo(510)
    expect(result.wasteCost).toBeCloseTo(102) // 510 x 20%
  })
})

describe('computeBomForOpening -- grid-derived members', () => {
  it('adds no horizontal rail when grid_row_weights has length 1', () => {
    const template = baseTemplate({ grid_row_weights: [1], grid_horizontal_rail_family: 'Frame-General' })
    const result = computeBomForOpening(baseOpening(), template, [], [], [PROFILE], FINISH, GLASS)
    expect(result.gridLines.filter(l => l.orientation === 'horizontal')).toHaveLength(0)
  })

  it('adds rowCount - 1 horizontal rails, full opening width, when weighted rows are set', () => {
    const template = baseTemplate({ grid_row_weights: [0.25, 0.75], grid_horizontal_rail_family: 'Frame-General' })
    const result = computeBomForOpening(baseOpening({ width_m: 2.5, height_m: 2 }), template, [], [], [PROFILE], FINISH, GLASS)
    const rails = result.gridLines.filter(l => l.orientation === 'horizontal')
    expect(rails).toHaveLength(1)
    expect(rails[0].length_m).toBe(2.5)
  })

  it('adds columnCount - 1 vertical mullions, full opening height, when panel_count > 1', () => {
    const template = baseTemplate({ grid_vertical_mullion_family: 'Frame-General' })
    const result = computeBomForOpening(baseOpening({ width_m: 2, height_m: 2.2, panel_count: 3 }), template, [], [], [PROFILE], FINISH, GLASS)
    const mullions = result.gridLines.filter(l => l.orientation === 'vertical')
    expect(mullions).toHaveLength(2)
    expect(mullions[0].length_m).toBe(2.2)
  })

  it('adds no vertical mullion when panel_count is 1, even if a family is set', () => {
    const template = baseTemplate({ grid_vertical_mullion_family: 'Frame-General' })
    const result = computeBomForOpening(baseOpening({ panel_count: 1 }), template, [], [], [PROFILE], FINISH, GLASS)
    expect(result.gridLines.filter(l => l.orientation === 'vertical')).toHaveLength(0)
  })
})

describe('computeBomForOpening -- glass area, per cell', () => {
  it('single-cell opening: (width - deduction) x (height - deduction)', () => {
    const template = baseTemplate({ glass_width_deduction_mm: 80, glass_height_deduction_mm: 80 })
    const result = computeBomForOpening(baseOpening({ width_m: 1, height_m: 1 }), template, [], [], [PROFILE], FINISH, GLASS)
    expect(result.glassArea_sqm).toBeCloseTo(0.92 * 0.92)
    expect(result.glassCost).toBeCloseTo(0.92 * 0.92 * 500)
  })

  it('sums across every cell of a weighted-row, multi-column grid', () => {
    const template = baseTemplate({ grid_row_weights: [0.25, 0.75], glass_width_deduction_mm: 80, glass_height_deduction_mm: 80 })
    const result = computeBomForOpening(baseOpening({ width_m: 2, height_m: 2, panel_count: 2 }), template, [], [], [PROFILE], FINISH, GLASS)
    // 2 rows x 2 columns = 4 cells. columns: 1m wide each. rows: 0.5m and 1.5m tall.
    const cell1 = (1 - 0.08) * (0.5 - 0.08)
    const cell2 = (1 - 0.08) * (1.5 - 0.08)
    const expectedArea = 2 * cell1 + 2 * cell2
    expect(result.glassArea_sqm).toBeCloseTo(expectedArea)
  })

  it('is zero when no glassType is supplied', () => {
    const result = computeBomForOpening(baseOpening(), baseTemplate(), [], [], [PROFILE], FINISH, null)
    expect(result.glassArea_sqm).toBe(0)
    expect(result.glassCost).toBe(0)
  })
})

describe('computeBomForOpening -- hardware', () => {
  it('fixed basis uses quantity_value as-is', () => {
    const hardware = [{ name: 'Handle', reference_unit_price: 200, quantity_basis: 'fixed', quantity_value: 1 }]
    const result = computeBomForOpening(baseOpening(), baseTemplate(), [], hardware, [PROFILE], FINISH, GLASS)
    expect(result.hardwareLines[0].quantity).toBe(1)
    expect(result.hardwareLines[0].cost).toBe(200)
  })

  it('per_cell multiplies by rowCount x columnCount', () => {
    const hardware = [{ name: 'Hinge', reference_unit_price: 150, quantity_basis: 'per_cell', quantity_value: 3 }]
    const result = computeBomForOpening(baseOpening({ panel_count: 2 }), baseTemplate(), [], hardware, [PROFILE], FINISH, GLASS)
    expect(result.hardwareLines[0].quantity).toBe(6)
    expect(result.hardwareLines[0].cost).toBe(900)
  })

  it('per_perimeter_m multiplies by 2 x (width + height)', () => {
    const hardware = [{ name: 'Weatherstrip', reference_unit_price: 10, quantity_basis: 'per_perimeter_m', quantity_value: 1 }]
    const result = computeBomForOpening(baseOpening({ width_m: 2, height_m: 3 }), baseTemplate(), [], hardware, [PROFILE], FINISH, GLASS)
    expect(result.hardwareLines[0].quantity).toBe(10)
    expect(result.hardwareLines[0].cost).toBe(100)
  })
})

describe('computeBomForOpening -- unresolved components', () => {
  it('flags a component with no matching profile, contributes zero cost, never guesses', () => {
    const components = [{ role_name: 'Top rail', profile_family: 'Nonexistent', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1 }]
    const result = computeBomForOpening(baseOpening(), baseTemplate(), components, [], [PROFILE], FINISH, GLASS)
    expect(result.unresolvedComponents).toContain('Top rail')
    expect(result.profileLines[0].resolved).toBe(false)
    expect(result.profileLines[0].cost).toBe(0)
  })

  it('flags a grid-derived member with no matching profile', () => {
    const template = baseTemplate({ grid_vertical_mullion_family: 'Nonexistent' })
    const result = computeBomForOpening(baseOpening({ panel_count: 2 }), template, [], [], [PROFILE], FINISH, GLASS)
    expect(result.gridLines[0].resolved).toBe(false)
    expect(result.unresolvedComponents.length).toBeGreaterThan(0)
  })
})

describe('computeBomForOpening -- extra_lines and totalCost', () => {
  it('sums extra_lines amounts into extraLinesCost and the total', () => {
    const opening = baseOpening({ extra_lines: [{ description: 'Curved bending', amount: 500 }, { description: 'Bracket', amount: 300 }] })
    const result = computeBomForOpening(opening, baseTemplate(), [], [], [PROFILE], FINISH, null)
    expect(result.extraLinesCost).toBe(800)
    expect(result.totalCost).toBeCloseTo(result.wasteCost + 800) // no components/hardware/glass in this fixture
  })

  it('totalCost is a per-unit figure -- does not multiply by opening.quantity', () => {
    const opening = baseOpening({ quantity: 5, extra_lines: [{ description: 'x', amount: 100 }] })
    const result = computeBomForOpening(opening, baseTemplate(), [], [], [PROFILE], FINISH, null)
    expect(result.totalCost).toBeCloseTo(result.wasteCost + 100)
  })
})
