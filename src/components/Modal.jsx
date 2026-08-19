// ============================================================
// Modal component — ใช้ทั้ง add / edit / confirm ทุกหน้า
// ✅ ปิดได้แค่ปุ่ม X / Escape / ปุ่มยกเลิกในฟอร์ม -- คลิกนอก modal ไม่ปิด
//    (กันปิดโดยไม่ตั้งใจ)
// ✅ ปุ่ม back บนมือถือปิด modal แทนที่จะออกจากหน้าเว็บทั้งหมด
// ============================================================
import { useEffect, useRef } from 'react'

// popstate เป็น event ระดับ window ไม่ scope ต่อ modal instance -- ถ้า modal
// ที่ซ้อนอยู่ (เช่น confirm dialog เปิดทับ modal แก้ไข) ปิดตัวเองผ่าน X/Escape
// แล้วเรียก history.back() เพื่อเก็บกวาด entry ของตัวเอง popstate ที่เกิดขึ้น
// จะไปเข้า listener ของ modal ที่ซ้อนอยู่ข้างใต้ด้วย ทำให้ปิดผิดตัว. counter นี้
// กันปัญหานั้น: ก่อนเรียก history.back() แบบ "เก็บกวาดของตัวเอง" (ไม่ใช่ผู้ใช้
// กด back จริง) ให้ increment ไว้ แล้ว listener ตัวถัดไปที่เจอ count > 0 จะข้าม
// ไปเฉยๆ (ไม่ปิดตัวเอง) แล้ว decrement กลับ -- ใช้ counter ไม่ใช่ boolean เพราะ
// ถ้ามี modal เหลืออยู่ตัวอื่นที่ listener ยังไม่ถูกถอด นับหลายชั้นถูกต้องกว่า
// boolean เดี่ยว (ซึ่งถูก consume ได้แค่ครั้งเดียวแล้วพลาดชั้นที่เหลือ)
// ⚠️ กรณี edge case ที่ยังไม่มีทางแก้สมบูรณ์: ถ้า modal ที่ซ้อนกันปิดพร้อมกันใน
// React batch เดียวกันจนไม่เหลือ modal ใดเปิดอยู่เลย ทั้งคู่จะ increment ก่อนที่
// popstate จะยิงมา แต่ listener ทั้งคู่ก็ถูกถอดไปแล้วตอนนั้นเหมือนกัน -- ไม่มีใคร
// เหลือ decrement ให้ ทำให้ count ค้างและไปกลืน back-press จริงของผู้ใช้ใน
// modal ถัดไปที่ไม่เกี่ยวข้องกัน (จำนวนครั้งเท่ากับ count ที่ค้าง). ยังไม่พบ
// จุดในโค้ดปัจจุบันที่ modal ซ้อนกันแบบนี้จริง (ไม่มี Modal ซ้อน Modal ที่ไหน
// เลย ณ ตอนที่เขียน) จึงไม่แก้ตอนนี้ -- ถ้าจะเพิ่ม modal ซ้อน modal ในอนาคต
// ต้องกลับมาดูจุดนี้ใหม่
let suppressPopstateCount = 0

export function Modal({ title, onClose, children, maxWidth = 600 }) {
  // ปุ่ม back มือถือ: push history entry ตอนเปิด modal แล้วฟัง popstate --
  // กด back = ปิด modal เฉยๆ ไม่ back ออกจากหน้าเว็บ. ถ้า modal ถูกปิดด้วยวิธีอื่น
  // (ปุ่ม X, Escape, ปุ่มยกเลิกในฟอร์มลูก) ต้อง pop entry ที่ push ไว้ทิ้งเองตอน
  // unmount ไม่งั้นผู้ใช้ต้องกด back 2 ครั้งกว่าจะออกจากหน้าเว็บจริง (ครั้งแรกไป
  // เจอ entry ค้างของ modal ที่ปิดไปแล้ว)
  const closedByBackRef = useRef(false)

  // React StrictMode (เปิดใช้ใน main.jsx) รัน effect ซ้ำตอน dev: mount →
  // cleanup → mount ทันทีแบบ synchronous, แต่ pushState/history.state อัปเดต
  // แบบ synchronous เช่นกัน ในขณะที่ history.back() ที่ cleanup#1 เรียกไว้เป็น
  // async task ที่จะ resolve โดยอ้างอิงตำแหน่ง current ณ ตอนที่มัน "ทำงานจริง"
  // (ไม่ใช่ตำแหน่ง current ตอนที่ถูกเรียก) -- ดังนั้น mount#2 ต้อง pushState
  // ซ้ำตามปกติเสมอ (ห้าม skip): มันจะกลายเป็น entry ใหม่ที่ current ชี้ไปตอนนั้น
  // แล้ว back() ของ cleanup#1 จะไปเจาะ entry ใหม่นี้ (ไม่ใช่ entry ก่อนเปิด
  // modal) พา current กลับมาที่ entry ของ mount#1 พอดี -- คงค่า "มี modal-entry
  // เดียวอยู่ที่ current" ไว้ถูกต้อง. ถ้า mount#2 skip push (ลองมาแล้ว พังกว่าเดิม)
  // back() ที่ค้างอยู่จะไปเจาะ entry ก่อนเปิด modal แทน ทำให้กด back จริงครั้ง
  // ถัดไปหลุดออกจากหน้าเว็บเกินจุดที่ควรหยุด -- ตรงข้ามกับที่ mechanism นี้มีไว้กัน
  useEffect(() => {
    window.history.pushState({ modalOpen: true }, '')
    const handlePopState = () => {
      if (suppressPopstateCount > 0) { suppressPopstateCount -= 1; return }
      closedByBackRef.current = true
      onClose()
    }
    window.addEventListener('popstate', handlePopState)
    return () => {
      window.removeEventListener('popstate', handlePopState)
      if (!closedByBackRef.current && window.history.state?.modalOpen) {
        suppressPopstateCount += 1
        window.history.back()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ปิดด้วย Escape key
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: `min(${maxWidth}px, 94vw)` }}>
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
