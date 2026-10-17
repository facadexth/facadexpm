// LandscapeView — desktop: returns the children untouched. Phone: a "ดูแนวนอน" button above the content and a
// full-screen stage. iPhone cannot be forced to rotate, so on a portrait phone the stage is rotated 90deg by CSS
// (.is-rotated). Turning the phone sideways (viewport height < 500) opens it by itself; a roomy landscape screen
// (unfolded foldable) does not. Only the X button, Escape or the back button close it.
// Big phones are wider than the 900px phone breakpoint when sideways (Pixel 412x915, iPhone Pro Max 932): the page
// behind switches to the desktop layout then, so this component also counts a touch screen under 500px tall as a
// phone -- otherwise turning such a phone would unmount the overlay it is meant to open. No orientation lock: on
// those phones the lock itself pushed the width past 900 and closed the overlay; the CSS rotation covers portrait.
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useIsPhone } from '../hooks/useIsPhone.js'
import { useBackToClose } from '../hooks/useBackToClose.js'

const PORTRAIT = '(orientation: portrait)'
const LANDSCAPE = '(orientation: landscape)'
const AUTO_OPEN_MAX_HEIGHT = 500
const SIDEWAYS_PHONE = '(pointer: coarse) and (orientation: landscape) and (max-height: 499px)'

// The overlay's own layout is inline, not in src/mobile.css: that file only applies up to 900px wide, and a big
// phone held sideways is wider than that while this overlay is open. Inline styles only exist on phones (desktop
// never renders this markup), so desktop is unaffected.
const DVH = typeof CSS !== 'undefined' && CSS.supports?.('height', '100dvh')
const ST = {
  overlay: { position: 'fixed', inset: 0, zIndex: 400, background: 'var(--bg)', overflow: 'hidden' },
  stage: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg)' },
  rotated: { width: DVH ? '100dvh' : '100vh', height: DVH ? '100dvw' : '100vw', transform: 'rotate(90deg) translateY(-100%)', transformOrigin: 'top left' },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 12px', background: 'var(--bg2)', borderBottom: '1px solid var(--border)', flex: 'none' },
  title: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  body: { flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 12px', WebkitOverflowScrolling: 'touch' },
  bar: { display: 'flex', justifyContent: 'flex-end', margin: '0 0 6px' },
  placeholder: { textAlign: 'center', color: 'var(--text3)', padding: '24px 0', fontSize: 13 },
}

// How many landscape stages are open right now. Turning the phone while one is open (e.g. the S-curve opened by its
// button, then the user turns the phone to read it) must not pop another LandscapeView (the Gantt) on top of it.
let openStages = 0

function mq(q) {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(q) : null
}

function Stage({ title, onClose, children }) {
  useBackToClose(onClose)
  useEffect(() => { openStages += 1; return () => { openStages -= 1 } }, [])
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
    try { Promise.resolve(document.documentElement.requestFullscreen?.()).catch(() => {}) } catch { /* ignore */ }
    return () => {
      try { if (document.fullscreenElement) Promise.resolve(document.exitFullscreen?.()).catch(() => {}) } catch { /* ignore */ }
    }
  }, [])
  return createPortal(
    <div className="phone-landscape-overlay" style={ST.overlay}>
      <div className={'phone-landscape-stage' + (portrait ? ' is-rotated' : '')} style={portrait ? { ...ST.stage, ...ST.rotated } : ST.stage}>
        <div className="phone-landscape-head" style={ST.head}>
          <b style={ST.title}>{title}</b>
          <button type="button" className="btn btn-ghost btn-sm" aria-label="ปิดมุมมองแนวนอน" onClick={onClose}>✕</button>
        </div>
        <div className="phone-landscape-body" style={ST.body}>{children}</div>
      </div>
    </div>,
    document.body
  )
}

function useMatches(query) {
  const [matches, setMatches] = useState(() => !!mq(query)?.matches)
  useEffect(() => {
    const m = mq(query)
    if (!m) return
    const on = e => setMatches(!!e.matches)
    setMatches(!!m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [query])
  return matches
}

// autoOpen=false: only the button opens it. Use it for a second LandscapeView on the same screen (e.g. the S-curve
// under the Gantt) so turning the phone opens just one overlay.
export default function LandscapeView({ title, autoOpen = true, children }) {
  const narrow = useIsPhone()
  const sideways = useMatches(SIDEWAYS_PHONE)
  const isPhone = narrow || sideways
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!isPhone || !autoOpen) return
    const m = mq(LANDSCAPE)
    if (!m) return
    const on = e => { if (e.matches && window.innerHeight < AUTO_OPEN_MAX_HEIGHT && openStages === 0) setOpen(true) }
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [isPhone, autoOpen])

  if (!isPhone) return children
  return (
    <>
      <div className="phone-landscape-bar" style={ST.bar}>
        <button type="button" className="btn btn-ghost btn-sm phone-landscape-btn" onClick={() => setOpen(true)}>⤢ ดูแนวนอน</button>
      </div>
      {open ? <div className="phone-landscape-placeholder" style={ST.placeholder}>กำลังดูแนวนอน</div> : children}
      {open && <Stage title={title} onClose={close}>{children}</Stage>}
    </>
  )
}
