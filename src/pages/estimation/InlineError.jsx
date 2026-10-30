// src/pages/estimation/InlineError.jsx
// The cut-sheet screens' error message: shown inside the card it belongs to (never the browser's alert()), with
// "ปิด" to close it when onClose is given.
const icon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ flex: '0 0 auto', marginTop: 2 }}>
    <circle cx="12" cy="12" r="10" /><path d="M12 7v6M12 17h.01" />
  </svg>
)

export default function InlineError({ title, children, onClose }) {
  return (
    <div role="alert" className="alert alert-error" style={{ display: 'flex', gap: 12, alignItems: 'flex-start', margin: 0 }}>
      {icon}
      <div style={{ flex: 1, minWidth: 0 }}>{title && <b>{title}</b>}{title && children ? <br /> : null}{children}</div>
      {onClose && <button type="button" className="btn btn-ghost btn-sm" aria-label="ปิดข้อความ" onClick={onClose}>ปิด</button>}
    </div>
  )
}
