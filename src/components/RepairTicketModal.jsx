// Detail modal of one repair ticket (งานซ่อม). PLACEHOLDER: Task 6 of the repair-tickets plan replaces
// this body (schedule, crew, before/after photos, close-with-after-photo, report). Keep the props:
//   ticketId  -- repair_tickets.id
//   onClose() -- close without changes
//   onChanged() -- something was saved; the board reloads
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { Modal } from './Modal.jsx'

export default function RepairTicketModal({ ticketId, onClose, onChanged }) {
  const [number, setNumber] = useState('')
  useEffect(() => {
    let alive = true
    supabase.from('repair_tickets').select('ticket_number').eq('id', ticketId).maybeSingle()
      .then(({ data }) => { if (alive) setNumber(data?.ticket_number || '') })
    return () => { alive = false }
  }, [ticketId])
  return (
    <Modal title={`🔧 งานซ่อม ${number}`} onClose={onClose} maxWidth={480}>
      <div className="modal-body" style={{ color: 'var(--text2)' }}>
        หน้ารายละเอียดงานซ่อม (นัดวัน, ทีมช่าง, รูปก่อน/หลัง, ปิดงาน) กำลังจะมาในรอบถัดไป
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onClose}>ปิด</button>
      </div>
    </Modal>
  )
}
