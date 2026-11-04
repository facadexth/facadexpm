// src/components/ProfileImage.jsx
// A profile cross-section picture: a small thumbnail that opens the full picture, or a fixed-size picture.
// No URL (no picture, or no access to the bucket) shows a dash in the same box, so rows stay aligned.
import { useState } from 'react'
import { Modal } from './Modal.jsx'

const box = (w, h) => ({
  width: w, height: h, background: '#ffffff', border: '1px solid var(--border)', borderRadius: 6, flex: 'none',
  display: 'grid', placeItems: 'center', overflow: 'hidden',
})

export function ProfileThumb({ url, alt = '', title, width = 72, height = 40 }) {
  const [open, setOpen] = useState(false)
  if (!url) return <span style={{ ...box(width, height), color: 'var(--text3)', background: 'transparent' }} aria-label="ไม่มีรูป">—</span>
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title="ดูรูปใหญ่" aria-label={`ดูรูป ${alt}`}
        style={{ ...box(width, height), padding: 2, cursor: 'zoom-in' }}>
        <img src={url} alt={alt} loading="lazy" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
      </button>
      {open && (
        <Modal title={title || alt || 'รูปหน้าตัด'} onClose={() => setOpen(false)} maxWidth={720}>
          <div style={{ background: '#ffffff', borderRadius: 6, padding: 8 }}>
            <img src={url} alt={alt} style={{ width: '100%', height: 'auto', display: 'block' }} />
          </div>
        </Modal>
      )}
    </>
  )
}

export function ProfilePicture({ url, alt = '', width = 150 }) {
  if (!url) return null
  return (
    <span style={{ ...box(width, 'auto'), padding: 2 }}>
      <img src={url} alt={alt} loading="lazy" style={{ width: '100%', height: 'auto', display: 'block' }} />
    </span>
  )
}
