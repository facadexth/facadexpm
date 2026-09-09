import { Modal } from './Modal.jsx'
import changelog from '../changelog.json'

// ============================================================
// ChangelogModal — ประวัติการอัปเดต เขียนแบบกว้างๆ ให้ลูกค้าอ่านเข้าใจ
// (ไม่ลงรายละเอียดระดับโค้ด) เก็บไว้ที่ src/changelog.json ทุกครั้งที่ขึ้น
// เวอร์ชันใหม่ (package.json "version") ให้เพิ่มรายการใหม่ไว้บนสุดของไฟล์นั้น
// ✅ เปิดได้จาก 2 ที่ ใช้ modal เดียวกัน: Settings (กดที่เลขเวอร์ชัน) และ
//    UpdatePrompt (กด "รีเฟรชเพื่ออัปเดต") -- onRefresh มีให้เฉพาะทางหลัง
// ============================================================
export default function ChangelogModal({ onClose, onRefresh }) {
  return (
    <Modal title="ประวัติการอัปเดต" onClose={onClose} maxWidth={480}>
      <div className="modal-body" style={{ display: 'grid', gap: 20 }}>
        {changelog.map(entry => (
          <div key={entry.version}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>
              v{entry.version}
              <span style={{ fontWeight: 400, color: 'var(--text3)', fontSize: 12, marginLeft: 8 }}>
                {new Date(entry.date).toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' })}
              </span>
            </div>
            <ul style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4, fontSize: 13, color: 'var(--text2)' }}>
              {entry.notes.map((note, i) => <li key={i}>{note}</li>)}
            </ul>
          </div>
        ))}
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
        {onRefresh && <button className="btn btn-primary" onClick={onRefresh}>🔄 รีเฟรชเพื่ออัปเดต</button>}
      </div>
    </Modal>
  )
}
