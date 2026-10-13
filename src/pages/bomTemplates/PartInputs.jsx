// src/pages/bomTemplates/PartInputs.jsx
// Inputs panel of the part editor (spec §6, mockup v5 card inputs): the layout's inputs (inputsOf) for the template's
// defaults. Inputs the type pins (model.fixedKeys, R-F2) are shown read-only (their value comes from the type); `cells` is not a field (it is the cell
// click cycling on the preview); only_when inputs follow the params (R-4a). Changes go up as a patch; the editor runs
// setParams and shows PARAMS_HINT instead of the drawing when the layout refuses them (folding 0 + 0); `invalid` then
// hides the clamp warning. Also the clamp warning (CLAMP_TEXT).
import NumInput from './NumInput.jsx'
import { visibleInputs, clampedParts, CLAMP_TEXT } from './partEditorView.js'

export function LayoutInput({ inp, value, disabled, fixed = false, onChange }) {
  const label = inp.label + (fixed ? ' (ตามประเภท)' : '')
  if (inp.type === 'boolean') {
    return (
      <label className="pin chk">
        <input type="checkbox" disabled={disabled || fixed} checked={!!value} onChange={e => onChange(e.target.checked)} /> {label}
      </label>
    )
  }
  if (inp.type === 'select') {
    return (
      <label className="pin">{label}{' '}
        <select disabled={disabled || fixed} value={value == null ? '' : String(value)}
          onChange={e => { const o = inp.options.find(x => String(x.value) === e.target.value); if (o) onChange(o.value) }}>
          {inp.options.map(o => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
        </select>
      </label>
    )
  }
  return (
    <label className="pin">{label}{' '}
      <NumInput disabled={disabled || fixed} min={inp.min ?? 0} max={inp.max} step={inp.integer ? 1 : 'any'} value={value}
        onChange={v => { if (v != null) onChange(v) }} />
    </label>
  )
}

export default function PartInputs({ model, params, invalid, canEdit, onChange }) {
  const inputs = visibleInputs(model.layout_kind, params)
  const clamped = invalid ? [] : clampedParts(model)
  if (!inputs.length) return null
  return (
    <fieldset className="pinputs" aria-label="ค่าของแบบชิ้นส่วน">
      <legend>ค่าของแบบชิ้นส่วน (ค่าเริ่มต้นของเทมเพลต)</legend>
      {inputs.map(inp => (
        <LayoutInput key={inp.key} inp={inp} value={params[inp.key]} disabled={!canEdit} fixed={(model.fixedKeys || []).includes(inp.key)} onChange={v => onChange({ [inp.key]: v })} />
      ))}
      {clamped.map(c => <div key={c.key} className="warnline" title={`${c.name} ${c.raw} บาน`}>{CLAMP_TEXT}</div>)}
    </fieldset>
  )
}
