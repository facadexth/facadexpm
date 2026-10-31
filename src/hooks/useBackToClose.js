// ปุ่ม back บนมือถือปิด overlay (modal / ลิ้นชักเมนู / แผ่นตัวกรอง) แทนที่จะออกจากหน้าเว็บ
// ย้ายมาจาก src/components/Modal.jsx เมื่อ 2026-10-15 ทั้งก้อน พฤติกรรมเดิมทุกประการ
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

// 2026-10-15 (review of the mobile shell): history.back() is ASYNC in real browsers, so the popstate it causes
// arrives after the closing overlay's listener is gone -- and, when another overlay opened in the same commit
// (StrictMode double-mount in dev, "save closes the form and opens a preview" in prod), that stale popstate
// used to close the NEW overlay. One module-level listener now consumes every suppressed popstate whether or
// not an overlay is open, and a stack decides which overlay a real back press closes (the top one only).
const stack = []
let listening = false
function ensureListener() {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('popstate', () => {
    if (suppressPopstateCount > 0) { suppressPopstateCount -= 1; return }
    const top = stack[stack.length - 1]
    if (!top) return
    // set the flag BEFORE onClose(): if the handler unmounts the overlay synchronously, its cleanup must not
    // call history.back() a second time (the back press already consumed our entry)
    top.closedByBack = true
    if (top.onCloseRef.current() === false) { top.closedByBack = false; window.history.pushState({ modalOpen: true }, '') }
  })
}

/**
 * Push one history entry while the overlay is open; the phone back button then closes it instead of leaving
 * the page. `onClose() === false` is honoured ONLY for the back button (the overlay stays open and its entry is
 * re-pushed). When the overlay is closed another way (X, Escape, a button) the entry is popped on unmount.
 * @param {() => (void|false)} onClose
 */
export function useBackToClose(onClose) {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  // ปุ่ม back มือถือ: push history entry ตอนเปิด overlay แล้วให้ listener กลางฟัง popstate --
  // กด back = ปิด overlay บนสุดเฉยๆ ไม่ back ออกจากหน้าเว็บ. ถ้า overlay ถูกปิดด้วยวิธีอื่น
  // (ปุ่ม X, Escape, ปุ่มยกเลิกในฟอร์มลูก) ต้อง pop entry ที่ push ไว้ทิ้งเองตอน unmount
  // ไม่งั้นผู้ใช้ต้องกด back 2 ครั้งกว่าจะออกจากหน้าเว็บจริง -- popstate ที่ back() นั้นทำให้เกิด
  // ถูกนับไว้ใน suppressPopstateCount และ listener กลางจะกลืนมันไม่ว่าจะมาถึงเมื่อไหร่
  useEffect(() => {
    ensureListener()
    const entry = { onCloseRef, closedByBack: false }
    stack.push(entry)
    window.history.pushState({ modalOpen: true }, '')
    return () => {
      const i = stack.indexOf(entry)
      if (i >= 0) stack.splice(i, 1)
      if (!entry.closedByBack && window.history.state?.modalOpen) {
        suppressPopstateCount += 1
        window.history.back()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
