// ============================================================
// Modal component — ใช้ทั้ง add / edit / confirm ทุกหน้า
// ============================================================
import { useEffect } from 'react'

export function Modal({ title, onClose, children, maxWidth = 600 }) {
  // ปิดด้วย Escape key
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth }}>
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

/** Confirm dialog พร้อม danger styling */
export function ConfirmDialog({ title, message, onConfirm, onCancel, danger = false }) {
  return (
    <Modal title={title} onClose={onCancel} maxWidth={400}>
      <div className="modal-body">
        <p style={{ color: 'var(--text2)', lineHeight: 1.6 }}>{message}</p>
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
        <button
          className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
          onClick={onConfirm}
        >
          ยืนยัน
        </button>
      </div>
    </Modal>
  )
}
