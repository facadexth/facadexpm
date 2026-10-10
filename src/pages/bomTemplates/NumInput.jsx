// src/pages/bomTemplates/NumInput.jsx
// A number input that keeps what the user is typing (e.g. "" or "1.") while the field has focus and hands the
// model only a real Number or null (partModel.numOrNull) — never a string.
import { useState } from 'react'
import { numOrNull } from '../../lib/partModel.js'

const show = v => (v == null || !Number.isFinite(Number(v)) ? '' : String(Math.round(Number(v) * 1e6) / 1e6))

export default function NumInput({ value, onChange, className, disabled, min = 0, step = 'any', ...rest }) {
  const [draft, setDraft] = useState(null)   // text while focused, null otherwise
  return (
    <input {...rest} type="number" min={min} step={step} className={className} disabled={disabled}
      value={draft !== null ? draft : show(value)}
      onFocus={e => setDraft(e.target.value)}
      onBlur={() => setDraft(null)}
      onChange={e => { setDraft(e.target.value); onChange(numOrNull(e.target.value)) }} />
  )
}
