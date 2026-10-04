import { useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import ChangelogModal from './ChangelogModal.jsx'

// ============================================================
// UpdatePrompt — registerType:'prompt' (vite.config.js) means the service
// worker never auto-reloads the page on its own; it just sits ready until
// the user confirms here. Previously registerType:'autoUpdate' would
// silently reload the tab the moment a new deploy's SW activated,
// including mid-form -- surprising and occasionally lossy.
//
// ✅ "รีเฟรชเพื่ออัปเดต" opens the changelog popup first (what's actually new
//    in this update) instead of refreshing immediately -- the popup's own
//    button is what calls updateServiceWorker.
// ============================================================
export default function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW()
  const [showChangelog, setShowChangelog] = useState(false)

  // updateServiceWorker(true) reloads the page once the new worker takes control, but that
  // signal never arrives for a page that was not controlled by any worker (it was loaded
  // with Shift-reload, or right after the first install). Reload ourselves a moment later
  // as a fallback: by then the new worker is active and a plain reload runs the new
  // version. In the normal case the page has already reloaded and this never fires.
  const handleRefresh = () => {
    updateServiceWorker(true)
    setTimeout(() => window.location.reload(), 1500)
  }

  if (!needRefresh) return null

  return (
    <>
      <div style={{
        background: 'rgba(74,158,255,0.12)', borderBottom: '1px solid rgba(74,158,255,0.3)',
        padding: '8px 24px', fontSize: 13, color: 'var(--accent)', textAlign: 'center',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
      }}>
        🔄 มีเวอร์ชันใหม่พร้อมใช้งาน
        <button className="btn btn-sm btn-primary" onClick={() => setShowChangelog(true)}>รีเฟรชเพื่ออัปเดต</button>
        <button className="btn btn-sm btn-ghost" onClick={() => setNeedRefresh(false)}>ไว้ทีหลัง</button>
      </div>
      {showChangelog && (
        <ChangelogModal onClose={() => setShowChangelog(false)} onRefresh={handleRefresh} />
      )}
    </>
  )
}
