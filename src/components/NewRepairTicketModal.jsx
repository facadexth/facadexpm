// Staff-created repair ticket (+ เปิดงานซ่อมเอง). PLACEHOLDER: Task 6 of the repair-tickets plan replaces
// this body (site picker, description, media upload). Keep the props:
//   onClose()          -- close without creating
//   onCreated(ticket)  -- a ticket was created; the board reloads
import { Modal } from './Modal.jsx'

export default function NewRepairTicketModal({ onClose, onCreated }) {
  return (
    <Modal title="+ เปิดงานซ่อมเอง" onClose={onClose} maxWidth={480}>
      <div className="modal-body" style={{ color: 'var(--text2)' }}>
        ฟอร์มเปิดงานซ่อมเองกำลังจะมาในรอบถัดไป
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onClose}>ปิด</button>
      </div>
    </Modal>
  )
}
