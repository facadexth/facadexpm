// LandscapeView — desktop: returns the children untouched. Phone: a "ดูแนวนอน" button above the content and a
// full-screen stage. iPhone cannot be forced to rotate, so on a portrait phone the stage is rotated 90deg by CSS
// (.is-rotated). Turning the phone sideways (viewport height < 500) opens it by itself; a roomy landscape screen
// (unfolded foldable) does not. Only the X button, Escape or the back button close it.
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useIsPhone } from '../hooks/useIsPhone.js'
import { useBackToClose } from '../hooks/useBackToClose.js'

const PORTRAIT = '(orientation: portrait)'
const LANDSCAPE = '(orientation: landscape)'
const AUTO_OPEN_MAX_HEIGHT = 500

function mq(q) {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(q) : null
}

function Stage({ title, onClose, children }) {
  useBackToClose(onClose)
  const [portrait, setPortrait] = useState(() => !!mq(PORTRAIT)?.matches)
  useEffect(() => {
    const m = mq(PORTRAIT)
    if (!m) return
    const on = e => setPortrait(!!e.matches)
    setPortrait(!!m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  // best effort only: fullscreen + orientation lock are refused on many browsers (iOS), the CSS rotation covers that
  useEffect(() => {
    try { Promise.resolve(document.documentElement.requestFullscreen?.()).then(() => screen.orientation?.lock?.('landscape')).catch(() => {}) } catch { /* ignore */ }
    return () => {
      try { screen.orientation?.unlock?.() } catch { /* ignore */ }
      try { if (document.fullscreenElement) Promise.resolve(document.exitFullscreen?.()).catch(() => {}) } catch { /* ignore */ }
    }
  }, [])
  return createPortal(
    <div className="phone-landscape-overlay">
      <div className={'phone-landscape-stage' + (portrait ? ' is-rotated' : '')}>
        <div className="phone-landscape-head">
          <b>{title}</b>
          <button type="button" className="btn btn-ghost btn-sm" aria-label="ปิดมุมมองแนวนอน" onClick={onClose}>✕</button>
        </div>
        <div className="phone-landscape-body">{children}</div>
      </div>
    </div>,
    document.body
  )
}

export default function LandscapeView({ title, children }) {
  const isPhone = useIsPhone()
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!isPhone) return
    const m = mq(LANDSCAPE)
    if (!m) return
    const on = e => { if (e.matches && window.innerHeight < AUTO_OPEN_MAX_HEIGHT) setOpen(true) }
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [isPhone])

  if (!isPhone) return children
  return (
    <>
      <div className="phone-landscape-bar">
        <button type="button" className="btn btn-ghost btn-sm phone-landscape-btn" onClick={() => setOpen(true)}>⤢ ดูแนวนอน</button>
      </div>
      {open ? <div className="phone-landscape-placeholder">กำลังดูแนวนอน</div> : children}
      {open && <Stage title={title} onClose={close}>{children}</Stage>}
    </>
  )
}
