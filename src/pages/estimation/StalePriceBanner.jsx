// src/pages/estimation/StalePriceBanner.jsx
// "มีราคาใหม่ N รายการ" (mockup screen 4): lines whose price row would differ if the project's price date were today.
// Read-only; the refresh button arrives with Task 17.
import { useState } from 'react'
import { priceRowLabel } from './projectDefaults.js'

export default function StalePriceBanner({ changes, itemsById, index, priceAsOf }) {
  const [open, setOpen] = useState(false)
  if (!changes.length) return null
  const itemCount = new Set(changes.map(c => c.opening_id)).size
  return (
    <div style={{ padding: 12, background: 'var(--blue-bg, #e8f1ff)', border: '1px solid var(--blue, #4a90e2)', borderRadius: 8, fontSize: 13 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
        <span>💡 <b>มีราคาใหม่ {itemCount} รายการ</b> (โปรเจกต์ล็อกราคา ณ {priceAsOf})</span>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(o => !o)}>{open ? 'ซ่อน' : 'ดูรายการ'}</button>
      </div>
      {open && (
        <table style={{ marginTop: 8, width: '100%' }}>
          <thead><tr><th>รายการ</th><th>ชิ้นส่วน</th><th>ราคาเดิม</th><th>ราคาใหม่</th></tr></thead>
          <tbody>
            {changes.map((c, i) => {
              const it = itemsById[c.opening_id]
              return (
                <tr key={i}>
                  <td>{it ? `${it.opening_no}${it.item_name ? ` · ${it.item_name}` : ''}` : c.opening_id}</td>
                  <td>{c.name}</td>
                  <td>{priceRowLabel(index, c.before)}</td>
                  <td>{priceRowLabel(index, c.after)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
