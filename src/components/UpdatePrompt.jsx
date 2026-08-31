import { useRegisterSW } from 'virtual:pwa-register/react'

// ============================================================
// UpdatePrompt — registerType:'prompt' (vite.config.js) means the service
// worker never auto-reloads the page on its own; it just sits ready until
// the user confirms here. Previously registerType:'autoUpdate' would
// silently reload the tab the moment a new deploy's SW activated,
// including mid-form -- surprising and occasionally lossy.
// ============================================================
export default function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW()

  if (!needRefresh) return null

  return (
    <div style={{
      background: 'rgba(74,158,255,0.12)', borderBottom: '1px solid rgba(74,158,255,0.3)',
      padding: '8px 24px', fontSize: 13, color: 'var(--accent)', textAlign: 'center',
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
    }}>
      🔄 มีเวอร์ชันใหม่พร้อมใช้งาน
      <button className="btn btn-sm btn-primary" onClick={() => updateServiceWorker(true)}>รีเฟรชเพื่ออัปเดต</button>
      <button className="btn btn-sm btn-ghost" onClick={() => setNeedRefresh(false)}>ไว้ทีหลัง</button>
    </div>
  )
}
