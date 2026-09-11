// ============================================================
// ManualModal -- pops the self-hosted user manual (public/manual/index.html,
// see src/lib/manualLinks.js) open inside the app instead of a new browser
// tab. Just an iframe in a wide/tall Modal -- the manual is a fully
// self-contained static document (own CSS/JS/TOC/scrollspy), so no attempt
// is made to reimplement any of it in React.
// ============================================================
import { Modal } from './Modal.jsx'

export default function ManualModal({ url, onClose }) {
  return (
    <Modal title="คู่มือใช้งาน" onClose={onClose} maxWidth={1100}>
      <div className="modal-body" style={{ padding: 0, height: '85vh' }}>
        <iframe src={url} title="คู่มือใช้งาน FacadeX" style={{ width: '100%', height: '100%', border: 'none', display: 'block' }} />
      </div>
    </Modal>
  )
}
