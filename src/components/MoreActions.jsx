// MoreActions — desktop: returns the children untouched. Phone (mobile-view spec §5): one "⋯" button that
// opens the children (secondary toolbar buttons such as Import Excel / Template / Export) in a small menu, so the
// toolbar keeps only the search box and the primary button on a 390px screen.
import { useEffect, useRef, useState } from 'react'
import { useIsPhone } from '../hooks/useIsPhone.js'

export default function MoreActions({ label = 'เพิ่มเติม', children }) {
  const isPhone = useIsPhone()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onOutside = e => { if (!ref.current?.contains(e.target)) setOpen(false) }
    const onKey = e => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onOutside)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onOutside); document.removeEventListener('keydown', onKey) }
  }, [open])
  if (!isPhone) return children
  return (
    <div className="phone-more" ref={ref}>
      <button type="button" className="btn btn-ghost phone-more-btn" aria-label={label} aria-expanded={open} onClick={() => setOpen(o => !o)}>⋯</button>
      {open && <div className="phone-more-menu" role="menu" onClick={() => setOpen(false)}>{children}</div>}
    </div>
  )
}
