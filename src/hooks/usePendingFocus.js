// A page arrives with navState.pending = <key from src/lib/pendingItems.js> when the user
// tapped that item in the header bell or a Web Push notification. The page then shows only
// the rows that notification counted (the same rule that gives a row its 🔔 mark) and a chip
// saying so; ✕ on the chip, or touching the page's own filters, ends the focus.
import { useState, useEffect } from 'react'

export function usePendingFocus(navState, key) {
  const wanted = navState?.pending === key
  const [active, setActive] = useState(wanted)
  // A new navState object = a new tap, so re-arm even if the user cleared the last one.
  useEffect(() => { if (wanted) setActive(true) }, [navState]) // eslint-disable-line react-hooks/exhaustive-deps
  return { active, count: active && wanted ? navState?.pendingCount : undefined, clear: () => setActive(false) }
}
