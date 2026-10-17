// Phone layout gate. ONE breakpoint for the whole app; src/mobile.css uses the same query and
// src/mobile.css.test.js keeps every phone rule inside it. Desktop (> 900px) renders the original
// JSX untouched, so laptop and landscape-tablet rendering never change (spec 2026-10-15 §2).
import { useEffect, useState } from 'react'

export const PHONE_QUERY = '(max-width: 900px)'

/** Non-hook helper for effects and event handlers. */
export function isPhoneNow() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && !!window.matchMedia(PHONE_QUERY).matches
}

export function useIsPhone() {
  const [phone, setPhone] = useState(isPhoneNow)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(PHONE_QUERY)
    const onChange = e => setPhone(!!e.matches)
    setPhone(!!mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return phone
}
