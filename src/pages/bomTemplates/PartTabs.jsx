// src/pages/bomTemplates/PartTabs.jsx
// Part tabs of the drawing (D13, mockup v5 .ptabs): ทั้งชุด, then one tab per part instance (partEditorView.partTabs).
// A part ticked "เสร็จแล้ว" shows ✓ on its tabs (model.done); the tick box belongs to the chosen part.
import { partTabs, isDone } from './partEditorView.js'

export default function PartTabs({ model, tab, canEdit, onTab, onToggleDone }) {
  const tabs = partTabs(model)
  const cur = tabs.find(t => t.id === tab) || tabs[0]
  return (
    <div className="ptabs">
      <div role="tablist" aria-label="ส่วนของชุด">
        {tabs.map(t => {
          const done = t.partKey && isDone(model, t.partKey)
          return (
            <button key={t.id} type="button" role="tab" aria-selected={t.id === cur.id} className={(t.id === cur.id ? 'on' : '') + (done ? ' done' : '')}
              onClick={() => onTab(t.id)}>{t.label}{done ? ' ✓' : ''}</button>
          )
        })}
      </div>
      {cur.partKey && (
        <label className="donechk">
          <input type="checkbox" disabled={!canEdit} checked={isDone(model, cur.partKey)} onChange={() => onToggleDone(cur.partKey)} />เสร็จแล้ว
        </label>
      )}
    </div>
  )
}
