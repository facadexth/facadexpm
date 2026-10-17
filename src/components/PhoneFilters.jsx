// PhoneFilters — desktop: returns the children untouched (no wrapper element, so desktop layout is identical).
// Phone (mobile-view spec §5): a "ตัวกรอง" button with the number of active filters, chips for the active ones,
// and a bottom sheet that holds the page's own filter controls. The page passes `count` and `summary`
// (label + onRemove per active filter); the sheet reuses useBackToClose so the phone back button closes it.
import { useState } from 'react'
import { useIsPhone } from '../hooks/useIsPhone.js'
import { useBackToClose } from '../hooks/useBackToClose.js'

function Sheet({ onClose, onClear, title, children }) {
  useBackToClose(onClose)
  return (
    <div className="phone-sheet-overlay" data-testid="phone-sheet-overlay" onClick={onClose}>
      <div className="phone-sheet" role="dialog" aria-label={title} onClick={e => e.stopPropagation()}>
        <div className="phone-sheet-grab" />
        <div className="phone-sheet-head">
          <b>{title}</b>
          {onClear && <button type="button" className="btn btn-ghost btn-sm" onClick={onClear}>ล้างทั้งหมด</button>}
        </div>
        <div className="phone-sheet-body">{children}</div>
        <div className="phone-sheet-foot">
          <button type="button" className="btn btn-primary" onClick={onClose}>ปิด</button>
        </div>
      </div>
    </div>
  )
}

export default function PhoneFilters({ count = 0, summary = [], onClear, title = 'ตัวกรอง', children }) {
  const isPhone = useIsPhone()
  const [open, setOpen] = useState(false)
  if (!isPhone) return children
  return (
    <div className="phone-filters">
      <button type="button" className="btn btn-ghost phone-filters-btn" onClick={() => setOpen(true)}>
        {title}{count > 0 && <span className="phone-badge">{count}</span>}
      </button>
      {summary.length > 0 && (
        <div className="phone-chips">
          {summary.map((s, i) => (
            <span key={i} className="phone-chip">
              {s.label}
              {s.onRemove && <button type="button" aria-label={`เอา ${s.label} ออก`} onClick={s.onRemove}>✕</button>}
            </span>
          ))}
        </div>
      )}
      {open && <Sheet onClose={() => setOpen(false)} onClear={onClear} title={title}>{children}</Sheet>}
    </div>
  )
}
