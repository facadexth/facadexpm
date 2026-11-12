// ============================================================
// PageErrorBoundary — a page that crashes while rendering shows what went wrong instead of a blank white screen.
// Owner 2026-11-12: "กดปุ่มเอกสารแล้วขึ้นหน้าขาวล้วน" (IN2611-002 / -005, some users only). ChunkErrorBoundary
// re-throws every error that is not a stale-chunk load, and with nothing above it React unmounted the whole app.
// This boundary sits around it: it shows the message with ลองใหม่ / รีเฟรช, and records the crash in client_errors
// (insert only, best effort: a failed insert never hides the message). Navigating to another tab clears it.
// ============================================================
import { Component } from 'react'
import { supabase } from '../lib/supabase.js'

const cut = (s, n) => (s == null ? null : String(s).slice(0, n))

export function errorRow(error, info, { page, tenantId } = {}) {
  const w = typeof window !== 'undefined' ? window : null
  return {
    tenant_id: tenantId || null,
    page: cut(page, 100),
    message: cut(error?.message || String(error), 2000),
    stack: cut([error?.stack, info?.componentStack].filter(Boolean).join('\n--- component ---\n'), 8000),
    url: cut(w?.location?.href, 500),
    user_agent: cut(w?.navigator?.userAgent, 500),
    app_version: cut(typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null, 50),
    viewport: w ? `${w.innerWidth}x${w.innerHeight}@${w.devicePixelRatio || 1}` : null,
  }
}

export default class PageErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    try {
      supabase.from('client_errors').insert(errorRow(error, info, { page: this.props.page, tenantId: this.props.tenantId }))
        .then(({ error: e }) => { if (e) console.error('client_errors insert failed', e) }, () => {})
    } catch { /* never let logging break the fallback */ }
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.page !== this.props.page) this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div role="alert" className="card" style={{ maxWidth: 640, margin: '40px auto', padding: 24 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 17 }}>หน้านี้แสดงผลไม่ได้</h3>
        <p style={{ margin: '0 0 12px', color: 'var(--text-muted, #6a6f85)', fontSize: 13.5 }}>
          ระบบบันทึกข้อผิดพลาดนี้ส่งให้ผู้ดูแลแล้ว ลองกด "ลองใหม่" หรือ "รีเฟรช" ถ้ายังเป็นอยู่ แคปหน้าจอนี้ส่งให้ผู้ดูแลได้เลย
        </p>
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, background: 'var(--bg-subtle, #f4f5f8)', padding: 10, borderRadius: 6, margin: '0 0 14px' }}>
          {String(error?.message || error)}
        </pre>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-primary" onClick={() => this.setState({ error: null })}>ลองใหม่</button>
          <button type="button" className="btn btn-ghost" onClick={() => window.location.reload()}>รีเฟรช</button>
        </div>
      </div>
    )
  }
}
