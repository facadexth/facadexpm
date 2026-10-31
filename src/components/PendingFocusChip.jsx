// "Filtered from the notification you tapped" chip; same badge style as the 🔍 site chip on
// the income page. Renders nothing unless the focus is active.
import { pendingItemByKey } from '../lib/pendingItems.js'

export default function PendingFocusChip({ focus, pendingKey, hint, style }) {
  const item = pendingItemByKey(pendingKey)
  if (!focus?.active || !item) return null
  return (
    <span className="badge" style={{ background: 'rgba(229,72,77,0.12)', color: 'var(--red, #e5484d)', display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'normal', ...style }}>
      🔔 กรองจากการแจ้งเตือน: {item.label}{focus.count ? ` (${focus.count})` : ''}
      {hint && <span style={{ color: 'var(--text3)', fontWeight: 400 }}>— {hint}</span>}
      <button title="เลิกกรอง" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', marginLeft: 2 }} onClick={focus.clear}>✕</button>
    </span>
  )
}
