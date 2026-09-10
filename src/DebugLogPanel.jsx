// TEMPORARY diagnostic panel for the Android document-scan crash
// investigation (2026-09-10) -- remove once resolved. Shows whatever
// setupDebugCapture() (main.jsx) persisted to localStorage, so an error
// survives even a hard page reload/crash right after it fires -- no USB
// debugging or devtools needed, visible directly on the phone.
import { useState } from 'react'

const KEY = '__fx_debug_log'

export default function DebugLogPanel() {
  const [log, setLog] = useState(() => {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]') } catch { return [] }
  })
  const [open, setOpen] = useState(true)
  if (!log.length) return null

  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 999999,
      background: '#1a1a1a', color: '#7CFC7C', fontFamily: 'monospace', fontSize: 11,
      maxHeight: open ? '55vh' : 34, overflow: 'auto', borderTop: '3px solid #e33',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 10px', background: '#330000', position: 'sticky', top: 0 }}>
        <span onClick={() => setOpen(o => !o)} style={{ cursor: 'pointer', fontWeight: 'bold' }}>
          🐛 DEBUG LOG ({log.length}) {open ? '▼ tap to collapse' : '▲ tap to expand'}
        </span>
        <span onClick={() => { localStorage.removeItem(KEY); setLog([]) }} style={{ cursor: 'pointer', color: '#ffb84d', fontWeight: 'bold' }}>
          CLEAR ✕
        </span>
      </div>
      {open && log.map((e, i) => (
        <div key={i} style={{ padding: '8px 10px', borderBottom: '1px solid #333', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          <b style={{ color: e.type === 'console.error' ? '#ffd84d' : '#ff6666' }}>[{e.type}]</b> {e.time}
          {'\n'}{e.message}
          {e.filename ? `\n${e.filename}:${e.lineno}` : ''}
          {e.stack ? `\n${e.stack}` : ''}
        </div>
      ))}
    </div>
  )
}
