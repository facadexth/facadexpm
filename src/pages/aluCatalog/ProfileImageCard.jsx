// src/pages/aluCatalog/ProfileImageCard.jsx
// The picked profile's cross-section picture with replace / remove. A new picture gets the profile's
// "t = <thickness> mm" band before upload, like the imported catalogue pictures. Remove is confirmed inline.
import { useRef, useState } from 'react'
import { replaceProfileImage, removeProfileImage, thicknessLabel } from '../../lib/profileImages.js'
import InlineError from '../estimation/InlineError.jsx'

export default function ProfileImageCard({ profile, label, url, tenantId, canEdit, onChanged }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const input = useRef(null)
  const has = !!profile.image_path

  const run = async fn => {
    setBusy(true); setError(null)
    try { await fn(); await onChanged?.() } catch (e) { setError(e?.message || String(e)) } finally { setBusy(false); setConfirming(false) }
  }
  const onFile = e => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) run(() => replaceProfileImage({ tenantId, profile, file }))
  }

  return (
    <div className="card" style={{ padding: 14, marginBottom: 16, display: 'grid', gap: 8 }}>
      <div style={{ fontWeight: 600 }}>รูปหน้าตัด · {label}</div>
      {error && <InlineError title="บันทึกรูปไม่สำเร็จ" onClose={() => setError(null)}>{error}</InlineError>}
      {url ? (
        <div style={{ background: '#ffffff', border: '1px solid var(--border)', borderRadius: 6, padding: 6, maxWidth: 320 }}>
          <img src={url} alt={profile.drawing_no || profile.name} style={{ width: '100%', height: 'auto', display: 'block' }} />
        </div>
      ) : (
        <div style={{ color: 'var(--text3)', fontSize: 13 }}>{has ? 'กำลังโหลดรูป…' : 'ยังไม่มีรูป'}</div>
      )}
      {canEdit && tenantId ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={onFile} />
          <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? 'กำลังบันทึก…' : has ? 'เปลี่ยนรูป' : 'อัปโหลดรูป'}
          </button>
          {has && !confirming && <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setConfirming(true)}>ลบรูป</button>}
          {has && confirming && (
            <>
              <span style={{ fontSize: 13 }}>ลบรูปนี้?</span>
              <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => run(() => removeProfileImage({ profile }))}>ยืนยันลบ</button>
              <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setConfirming(false)}>ยกเลิก</button>
            </>
          )}
        </div>
      ) : null}
      <div style={{ fontSize: 12, color: 'var(--text3)' }}>
        รูปใหม่จะมี “{thicknessLabel(profile.thickness_mm)}” พิมพ์ใต้รูปให้อัตโนมัติ (ตามความหนาของแถวนี้)
      </div>
    </div>
  )
}
