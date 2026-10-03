// 🔔 in the header: total waiting, and a list of what is waiting with a link to
// each page. Rendered in a portal because the header can clip overflow.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatBadge, totalPending } from '../lib/pendingItems.js'

export default function NotificationBell({ items, onOpenItem, onRefresh }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const btnRef = useRef(null)
  const panelRef = useRef(null)
  const total = totalPending(items)

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target)) return
      if (panelRef.current?.contains(e.target)) return
      setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const toggle = () => {
    if (!open) {
      const r = btnRef.current?.getBoundingClientRect()
      if (r) setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) })
      onRefresh?.()
    }
    setOpen(o => !o)
  }

  return (
    <>
      <button
        ref={btnRef}
        className="btn btn-ghost btn-sm"
        style={{ fontSize: 12, position: 'relative' }}
        onClick={toggle}
        title={total ? `มี ${total} เรื่องรอดำเนินการ` : 'ไม่มีเรื่องรอดำเนินการ'}
        aria-label="การแจ้งเตือน"
      >
        🔔
        {total > 0 && (
          <span style={{
            position: 'absolute', top: -4, right: -4, minWidth: 16, height: 16, padding: '0 4px', boxSizing: 'border-box',
            borderRadius: 8, background: 'var(--red, #e5484d)', color: '#fff', fontSize: 10, fontWeight: 700,
            lineHeight: '16px', textAlign: 'center',
          }}>{formatBadge(total)}</span>
        )}
      </button>
      {open && pos && createPortal(
        <div
          ref={panelRef}
          style={{
            position: 'fixed', top: pos.top, right: pos.right, zIndex: 300, width: 300, maxWidth: 'calc(100vw - 16px)',
            background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,0.25)', overflow: 'hidden',
          }}
        >
          <div style={{ padding: '10px 14px', fontWeight: 700, fontSize: 13, borderBottom: '1px solid var(--border)' }}>
            🔔 เรื่องที่รอดำเนินการ
          </div>
          {items.length === 0 ? (
            <div style={{ padding: '18px 14px', fontSize: 13, color: 'var(--text3)', textAlign: 'center' }}>
              ไม่มีเรื่องค้าง 🎉
            </div>
          ) : (
            items.map(item => (
              <button
                key={item.key}
                onClick={() => { setOpen(false); onOpenItem(item) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
                  padding: '10px 14px', background: 'none', border: 'none', borderBottom: '1px solid var(--border)',
                  cursor: 'pointer', color: 'var(--text)', fontSize: 13,
                }}
              >
                <span style={{ fontSize: 16 }}>{item.icon}</span>
                <span style={{ flex: 1 }}>{item.label}</span>
                <span style={{
                  minWidth: 22, padding: '1px 7px', borderRadius: 10, background: 'rgba(229,72,77,0.15)',
                  color: 'var(--red, #e5484d)', fontWeight: 700, fontSize: 12, textAlign: 'center',
                }}>{formatBadge(item.count)}</span>
              </button>
            ))
          )}
        </div>,
        document.body
      )}
    </>
  )
}
