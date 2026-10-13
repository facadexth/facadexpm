// src/pages/estimation/ItemLayoutInputs.jsx
// The layout inputs of a layout_kind item (Task 10), under the width / height fields: m.layoutInputs
// (itemForm.itemLayoutInputs) = the estimator inputs the type does not fix, shown with the template's value until the
// item sets its own. A change writes the item's layout_params (saved on estimation_openings); curtain-wall cells are
// cycled on the preview instead. Refused params (folding 0 + 0) and clamped counts show their Thai hints.
import { LayoutInput } from '../bomTemplates/PartInputs.jsx'
import { CLAMP_TEXT, PARAMS_HINT } from '../bomTemplates/partEditorView.js'

export default function ItemLayoutInputs({ li, form, update, dis }) {
  if (!li) return null
  const set = (key, v) => update({ layout_params: { ...(form.layout_params || {}), [key]: v } })
  return (
    <fieldset role="group" aria-label="ค่าของแบบชิ้นส่วน" className="pe-item-inputs" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px', margin: 0, display: 'flex', flexWrap: 'wrap', gap: '6px 14px', alignItems: 'center' }}>
      <legend style={{ fontSize: 12, color: 'var(--text3)', padding: '0 6px' }}>ค่าของแบบชิ้นส่วน (รายการนี้)</legend>
      {li.inputs.map(inp => <LayoutInput key={inp.key} inp={inp} value={li.values[inp.key]} disabled={dis} onChange={v => set(inp.key, v)} />)}
      {li.cells && <span style={{ fontSize: 12, color: 'var(--text3)' }}>คลิกช่องในภาพตัวอย่างเพื่อวนรอบ กระจก → บานกระทุ้ง → แผงทึบ</span>}
      {li.invalid && <div style={{ flexBasis: '100%', fontSize: 12, color: 'var(--red)' }}>⚠ {PARAMS_HINT}</div>}
      {li.clamped.map(c => <div key={c.key} style={{ flexBasis: '100%', fontSize: 12, color: 'var(--red)' }}>⚠ {CLAMP_TEXT}</div>)}
    </fieldset>
  )
}
