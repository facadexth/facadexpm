// ============================================================
// Modal component — ใช้ทั้ง add / edit / confirm ทุกหน้า
// ✅ ปิดได้แค่ปุ่ม X / Escape / ปุ่มยกเลิกในฟอร์ม -- คลิกนอก modal ไม่ปิด
//    (กันปิดโดยไม่ตั้งใจ)
// ✅ onClose() คืน false = "ปฏิเสธการปิดตอนนี้" (กำลังบันทึก / มี overlay ลูกเปิดอยู่)
//    สัญญานี้ใช้เฉพาะปุ่ม back ของเบราว์เซอร์ (modal จะ push history entry กลับให้)
//    -- Escape และปุ่ม X ไม่สนค่าที่คืน: handler ต้องกันเองถ้าไม่อยากให้ปิด
// ✅ ปุ่ม back บนมือถือปิด modal แทนที่จะออกจากหน้าเว็บทั้งหมด
// ============================================================
import { useEffect } from 'react'
import { useBackToClose } from '../hooks/useBackToClose.js'

/**
 * @param {() => (void|false)} onClose  Called by X / Escape / browser back. Returning `false` is honoured ONLY for the
 *   browser back button (modal stays open and its history entry is re-pushed); X and Escape ignore the return value.
 */
export function Modal({ title, onClose, children, maxWidth = 600, className = '' }) {
  // ปุ่ม back มือถือปิด modal แทนที่จะออกจากหน้าเว็บ: กลไกอยู่ใน src/hooks/useBackToClose.js (ย้ายออกไป
  // 2026-10-15 เพื่อให้ลิ้นชักเมนูและแผ่นตัวกรองบนมือถือใช้ร่วมกัน พฤติกรรมเดิมทุกประการ)
  useBackToClose(onClose)

  // ปิดด้วย Escape key
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className="modal-overlay">
      <div className={className ? `modal ${className}` : 'modal'} style={{ maxWidth: `min(${maxWidth}px, 94vw)` }}>
        <div className="modal-header">
          <span className="modal-title" title={typeof title === 'string' ? title : undefined}>{title}</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

/** Confirm dialog พร้อม danger styling */
export function ConfirmDialog({ title, message, onConfirm, onCancel, danger = false, confirmDisabled = false, maxWidth = 400 }) {
  return (
    <Modal title={title} onClose={onCancel} maxWidth={maxWidth} className="modal-confirm">
      <div className="modal-body">
        <div style={{ color: 'var(--text2)', lineHeight: 1.6 }}>{message}</div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
        <button
          className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
          onClick={onConfirm}
          disabled={confirmDisabled}
        >
          ยืนยัน
        </button>
      </div>
    </Modal>
  )
}
