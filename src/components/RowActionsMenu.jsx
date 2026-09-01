// ============================================================
// RowActionsMenu — a "⋮" button that opens a small dropdown of
// secondary row actions, so a table row doesn't need one visible
// button per action (which stops scaling once a row has more than
// ~2-3 actions). Keep the most common action as its own visible
// button next to this menu; put the rest here.
//
// Reuses SearchableSelect's portal-to-document.body + viewport-rect
// positioning + click-outside-close pattern (same reason: opened
// inside a scrollable table/modal, position:absolute gets clipped by
// the ancestor's overflow boundary).
//
// items: [{ label, onClick, danger? }]
// ============================================================
import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'

const MENU_MARGIN = 4

export default function RowActionsMenu({ items = [] }) {
  const [open, setOpen] = useState(false)
  const [menuStyle, setMenuStyle] = useState(null)
  const triggerRef = useRef(null)
  const menuRef = useRef(null)

  const reposition = () => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const estHeight = items.length * 34 + 8
    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top
    const openUp = spaceBelow < estHeight && spaceAbove > spaceBelow
    setMenuStyle({
      position: 'fixed',
      right: window.innerWidth - rect.right,
      ...(openUp
        ? { bottom: window.innerHeight - rect.top + MENU_MARGIN }
        : { top: rect.bottom + MENU_MARGIN }),
    })
  }

  useLayoutEffect(() => {
    if (!open) return
    reposition()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const onScrollOrResize = () => reposition()
    window.addEventListener('resize', onScrollOrResize)
    window.addEventListener('scroll', onScrollOrResize, true)
    return () => {
      window.removeEventListener('resize', onScrollOrResize)
      window.removeEventListener('scroll', onScrollOrResize, true)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return
    const onDocClick = (e) => {
      if (
        triggerRef.current && !triggerRef.current.contains(e.target) &&
        menuRef.current && !menuRef.current.contains(e.target)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  if (!items.length) return null

  return (
    <div ref={triggerRef} style={{ display: 'inline-block' }}>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(o => !o)} title="เพิ่มเติม">⋮</button>
      {open && menuStyle && createPortal(
        <div
          ref={menuRef}
          style={{
            ...menuStyle,
            zIndex: 9999, minWidth: 170,
            background: 'var(--bg2, #1a1a1a)', border: '1px solid var(--border, #333)',
            borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,.4)', overflow: 'hidden',
          }}
        >
          {items.map((it, i) => (
            <div
              key={i}
              onClick={() => { setOpen(false); it.onClick() }}
              style={{
                padding: '9px 14px', cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap',
                color: it.danger ? 'var(--red)' : 'var(--text)',
                borderBottom: i < items.length - 1 ? '1px solid var(--border, #333)' : 'none',
              }}
            >
              {it.label}
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}
