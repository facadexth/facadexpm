// src/pages/aluCatalog/ProviderLogoCard.jsx
// The picked extruder's logo with replace / remove. Remove is confirmed inline.
import { useRef, useState } from 'react'
import { replaceProviderLogo, removeProviderLogo } from '../../lib/providerLogos.js'
import InlineError from '../estimation/InlineError.jsx'

export default function ProviderLogoCard({ provider, url, tenantId, canEdit, onChanged }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const input = useRef(null)
  const has = !!provider.logo_path

  const run = async fn => {
    setBusy(true); setError(null)
    try { await fn(); await onChanged?.() } catch (e) { setError(e?.message || String(e)) } finally { setBusy(false); setConfirming(false) }
  }
  const onFile = e => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) run(() => replaceProviderLogo({ tenantId, provider, file }))
  }

  return (
    <div className="card" style={{ padding: 14, display: 'grid', gap: 8 }}>
      <div style={{ fontWeight: 600 }}>โลโก้ · {provider.name}</div>
      {error && <InlineError title="บันทึกโลโก้ไม่สำเร็จ" onClose={() => setError(null)}>{error}</InlineError>}
      {url ? (
        <div style={{ background: '#ffffff', border: '1px solid var(--border)', borderRadius: 8, padding: 10, width: 240, maxWidth: '100%', height: 110, display: 'grid', placeItems: 'center', boxSizing: 'border-box' }}>
          <img src={url} alt={`โลโก้ ${provider.name}`} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        </div>
      ) : (
        <div style={{ color: 'var(--text3)', fontSize: 13 }}>{has ? 'กำลังโหลดโลโก้…' : 'ยังไม่มีโลโก้'}</div>
      )}
      {canEdit && tenantId ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={onFile} />
          <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? 'กำลังบันทึก…' : has ? 'เปลี่ยนโลโก้' : 'อัปโหลดโลโก้'}
          </button>
          {has && !confirming && <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setConfirming(true)}>ลบโลโก้</button>}
          {has && confirming && (
            <>
              <span style={{ fontSize: 13 }}>ลบโลโก้นี้?</span>
              <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => run(() => removeProviderLogo({ provider }))}>ยืนยันลบ</button>
              <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setConfirming(false)}>ยกเลิก</button>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
