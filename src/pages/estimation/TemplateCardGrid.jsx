// src/pages/estimation/TemplateCardGrid.jsx
// BOM templates as picture cards (owner 2026-10-31, mockup "BOM Templates เลือกจากรูป"): a search box, filter chips by
// top-level type (from the type tree) and a responsive grid of cards; each card is a real button with the template's
// drawing (templateCards.templateThumb, no dimensions), its name and its type. Used by the BOM Templates page and the
// item form. chips={false} hides the chips (the item form filters with its type cascade instead).
// Inactive templates are drawn faded with 🚫 before the name, like the page's old text list.
import { useMemo, useState } from 'react'
import PreviewSvg from './PreviewSvg.jsx'
import { templateThumb, typeChips, filterTemplates, templateMeta } from './templateCards.js'

const THUMB_H = 76

export function TemplateThumb({ thumb, label, height = THUMB_H }) {
  if (thumb.kind === 'part') return <img src={thumb.src} alt={label} style={{ display: 'block', width: '100%', height, objectFit: 'contain' }} />
  if (thumb.kind === 'frame') {
    const { width, height: h } = thumb.preview.viewBox
    return (
      <div style={{ height, width: '100%', display: 'flex', alignItems: 'center' }}>
        <PreviewSvg preview={thumb.preview} maxWidth={Math.min(220, (height * width) / h)} label={label} />
      </div>
    )
  }
  return (
    <div aria-label={label} role="img" style={{ height, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed var(--border)', borderRadius: 6, color: 'var(--text3)', fontSize: 20, fontWeight: 700 }}>
      {thumb.initials}
    </div>
  )
}

const cardStyle = on => ({
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '8px 8px 10px', minHeight: 44, minWidth: 0,
  borderRadius: 10, cursor: 'pointer', color: 'var(--text)', textAlign: 'center', font: 'inherit',
  background: on ? 'var(--bg3)' : 'transparent', border: on ? '2px solid var(--accent)' : '1px solid var(--border)',
})
const chipStyle = on => ({
  minHeight: 36, padding: '4px 12px', borderRadius: 999, cursor: 'pointer', font: 'inherit', fontSize: 13,
  border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, background: on ? 'var(--accent-fill)' : 'transparent', color: on ? 'var(--on-accent)' : 'var(--text)',
})

export default function TemplateCardGrid({ templates, typesById, partModelByTemplate, selectedId, onPick, chips = true, disabled = false, maxHeight = null, emptyText = 'ยังไม่มี Template' }) {
  const [query, setQuery] = useState('')
  const [rootId, setRootId] = useState('')
  const list = templates || []
  const chipList = useMemo(() => (chips ? typeChips(list, typesById) : []), [chips, list, typesById])
  // a chip that no longer exists (its last template was removed) falls back to all
  const root = chipList.some(c => c.id === rootId) ? rootId : ''
  const shown = useMemo(() => filterTemplates(list, { query, rootId: root, typesById }), [list, query, root, typesById])
  const thumbs = useMemo(() => Object.fromEntries(list.map(t => [t.id, templateThumb({ template: t, typesById, partModelByTemplate })])), [list, typesById, partModelByTemplate])

  return (
    <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
      {list.length > 0 && (
        <input type="search" className="input" aria-label="ค้นหาเทมเพลต" placeholder="ค้นหา เช่น กระทุ้ง, เลื่อน, 3 บาน" value={query} onChange={e => setQuery(e.target.value)} />
      )}
      {chipList.length > 2 && (
        <div role="group" aria-label="กรองตามประเภท" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {chipList.map(c => (
            <button key={c.id || 'all'} type="button" aria-pressed={root === c.id} style={chipStyle(root === c.id)} onClick={() => setRootId(c.id)}>
              {c.label} <span style={{ opacity: 0.7 }}>{c.count}</span>
            </button>
          ))}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))', gap: 10, ...(maxHeight ? { maxHeight, overflowY: 'auto', paddingRight: 2 } : {}) }}>
        {shown.map(t => {
          const on = selectedId === t.id
          const off = t.active === false
          const meta = templateMeta(t, typesById)
          return (
            <button key={t.id} type="button" aria-pressed={on} disabled={disabled} title={t.name} style={{ ...cardStyle(on), opacity: off ? 0.6 : 1 }} onClick={() => onPick(t)}>
              <TemplateThumb thumb={thumbs[t.id]} label={t.name} />
              <span style={{ fontSize: 13, lineHeight: 1.35, fontWeight: 600, overflowWrap: 'anywhere' }}>{off ? '🚫 ' : ''}{t.name}</span>
              {meta && <span style={{ fontSize: 11.5, color: 'var(--text3)', overflowWrap: 'anywhere' }}>{meta}</span>}
            </button>
          )
        })}
      </div>
      {!list.length && <div style={{ fontSize: 12, color: 'var(--text3)', padding: 8 }}>{emptyText}</div>}
      {list.length > 0 && !shown.length && <div style={{ padding: 16, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>ไม่พบเทมเพลตที่ตรงกับคำค้น</div>}
    </div>
  )
}
