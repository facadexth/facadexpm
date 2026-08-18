// ============================================================
// SearchableSelect — combobox ที่พิมพ์ค้นหาได้
// ✅ พิมพ์กรองรายการแบบ real-time (ตาม label + keywords)
// ✅ คลิกเลือก → ส่งค่า value กลับผ่าน onChange
// ✅ ปุ่มล้าง (×) + ปิด dropdown เมื่อคลิกนอกช่อง
// ✅ dropdown menu renders via portal to document.body, positioned by the
//    trigger's viewport rect — otherwise, opened inside a scrollable modal
//    (position: absolute + the modal's own overflow:auto/max-height:90vh),
//    a long list gets silently clipped by the modal's boundary with no way
//    to scroll it into view (reported live: categories were all there, just
//    clipped — see SearchableSelect commit on 2026-08-18)
// options: [{ value, label, keywords? }]
// ============================================================
import { useState, useRef, useEffect, useMemo, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'

const MENU_MAX_HEIGHT = 320
const MENU_MARGIN = 4

export default function SearchableSelect({
  value,
  onChange,
  options = [],
  placeholder = '— เลือก —',
  emptyLabel = 'ไม่พบรายการ',
  disabled = false,
  required = false,
}) {
  const [open, setOpen]   = useState(false)
  const [query, setQuery] = useState('')
  const [menuStyle, setMenuStyle] = useState(null)
  const triggerRef = useRef(null)
  const menuRef = useRef(null)

  const selected = useMemo(
    () => options.find(o => String(o.value) === String(value)) || null,
    [options, value]
  )

  // กรองรายการตามคำค้น (label + keywords)
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter(o =>
      (`${o.label} ${o.keywords || ''}`).toLowerCase().includes(q)
    )
  }, [options, query])

  // คำนวณตำแหน่ง menu จาก viewport rect ของ trigger — ให้พอดีจอ ไม่ล้นขอบล่าง
  const reposition = () => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top
    const openUp = spaceBelow < MENU_MAX_HEIGHT && spaceAbove > spaceBelow
    const maxHeight = Math.min(MENU_MAX_HEIGHT, (openUp ? spaceAbove : spaceBelow) - MENU_MARGIN * 2)

    setMenuStyle({
      position: 'fixed',
      left: rect.left,
      width: rect.width,
      maxHeight: Math.max(maxHeight, 120),
      ...(openUp
        ? { bottom: window.innerHeight - rect.top + MENU_MARGIN }
        : { top: rect.bottom + MENU_MARGIN }),
    })
  }

  useLayoutEffect(() => {
    if (!open) return
    reposition()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filtered.length])

  useEffect(() => {
    if (!open) return
    const onScrollOrResize = () => reposition()
    window.addEventListener('resize', onScrollOrResize)
    window.addEventListener('scroll', onScrollOrResize, true) // capture — catches scroll on modal/any ancestor
    return () => {
      window.removeEventListener('resize', onScrollOrResize)
      window.removeEventListener('scroll', onScrollOrResize, true)
    }
  }, [open])

  // ปิด dropdown เมื่อคลิกนอกช่อง (ทั้ง trigger และ menu ที่ portal ออกไป)
  useEffect(() => {
    if (!open) return
    const onDocClick = (e) => {
      if (
        triggerRef.current && !triggerRef.current.contains(e.target) &&
        menuRef.current && !menuRef.current.contains(e.target)
      ) {
        setOpen(false); setQuery('')
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  const pick = (opt) => {
    onChange(opt ? opt.value : '')
    setOpen(false); setQuery('')
  }

  return (
    <div ref={triggerRef} style={{ position: 'relative' }}>
      {/* hidden field so native "required" form validation ยังทำงาน */}
      {required && (
        <input
          tabIndex={-1}
          aria-hidden="true"
          required
          value={value || ''}
          onChange={() => {}}
          onFocus={() => setOpen(true)}
          style={{ opacity: 0, position: 'absolute', bottom: 0, left: '50%', width: 1, height: 1, padding: 0, border: 0, pointerEvents: 'none' }}
        />
      )}
      {open ? (
        <input
          className="input"
          autoFocus
          value={query}
          placeholder={selected ? selected.label : 'พิมพ์เพื่อค้นหา...'}
          onChange={e => setQuery(e.target.value)}
          disabled={disabled}
        />
      ) : (
        <button
          type="button"
          className="input"
          disabled={disabled}
          onClick={() => setOpen(true)}
          style={{ textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
        >
          <span style={{ color: selected ? 'var(--text)' : 'var(--text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selected ? selected.label : placeholder}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {selected && (
              <span
                role="button"
                title="ล้าง"
                onClick={e => { e.stopPropagation(); pick(null) }}
                style={{ color: 'var(--text3)', fontSize: 16, lineHeight: 1 }}
              >×</span>
            )}
            <span style={{ color: 'var(--text3)', fontSize: 11 }}>▾</span>
          </span>
        </button>
      )}

      {open && menuStyle && createPortal(
        <div
          ref={menuRef}
          style={{
            ...menuStyle,
            zIndex: 9999, overflowY: 'auto',
            background: 'var(--bg2, #1a1a1a)', border: '1px solid var(--border, #333)',
            borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,.4)',
          }}
        >
          <div
            onClick={() => pick(null)}
            style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, color: 'var(--text3)', borderBottom: '1px solid var(--border, #333)' }}
          >
            {placeholder}
          </div>
          {filtered.map(o => (
            <div
              key={o.value}
              onClick={() => pick(o)}
              style={{
                padding: '8px 12px', cursor: 'pointer', fontSize: 13,
                color: String(o.value) === String(value) ? 'var(--accent)' : 'var(--text)',
                background: String(o.value) === String(value) ? 'var(--bg3, rgba(255,255,255,.05))' : 'transparent',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg3, rgba(255,255,255,.06))' }}
              onMouseLeave={e => { e.currentTarget.style.background = String(o.value) === String(value) ? 'var(--bg3, rgba(255,255,255,.05))' : 'transparent' }}
            >
              {o.label}
            </div>
          ))}
          {!filtered.length && (
            <div style={{ padding: '10px 12px', fontSize: 13, color: 'var(--text3)', textAlign: 'center' }}>
              {emptyLabel}
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}
