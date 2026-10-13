// ผนังกระจกเปลือย (D3) — aluminium only in the 4-sided frame; the wall is `cols` glass panes side by side joined with
// silicone (`jointCount(model)` in layoutCells.js = cols - 1). Panes have no positions (`glass: true`; partModel.glassParts).
// Schema: see layoutRegistry.js.
import fixed_grid from './fixed_grid.js'

export default {
  kind: 'frameless_wall',
  inputs: [
    { key: 'cols', label: 'จำนวนช่อง', type: 'number', min: 1, max: 12, integer: true, default: 3, estimator: true },
  ],
  parts: [
    fixed_grid.parts[0],
    { key: 'pane', name: 'กระจก', count: 'cols', overlap_mode: 'manual', overlap_mm: 0, corner: 'butt', track: null, fixed: true, glass: true },
  ],
  positions: {
    frame_top: fixed_grid.positions.frame_top,
    frame_bottom: fixed_grid.positions.frame_bottom,
    frame_side: fixed_grid.positions.frame_side,
  },
  joints: [fixed_grid.joints[0], fixed_grid.joints[1]],
  order: ['frame_top', 'frame_bottom', 'frame_side'],
  hardware: [],
  symbol: {},
}
