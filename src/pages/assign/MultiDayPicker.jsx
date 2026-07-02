// ============================================================
// MultiDayPicker — pick multiple days (Monday-start, Sundays disabled)
// value: Set<'yyyy-MM-dd'> ; onChange(nextSet)
// ============================================================
import { useState } from 'react'
import { startOfMonth, startOfWeek, addDays, addMonths, format, isSameMonth } from 'date-fns'
import { DOW_TH } from './constants.js'

export default function MultiDayPicker({ value, onChange }) {
  const [month, setMonth] = useState(startOfMonth(new Date()))
  const gridStart = startOfWeek(startOfMonth(month), { weekStartsOn: 1 })
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))

  const toggle = (iso) => {
    const next = new Set(value)
    next.has(iso) ? next.delete(iso) : next.add(iso)
    onChange(next)
  }

  const th = ['จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส', 'อา']
  const monthLabel = `${['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'][month.getMonth()]} ${month.getFullYear() + 543}`

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMonth(addMonths(month, -1))}>‹</button>
        <div style={{ fontWeight: 700, fontSize: 13 }}>{monthLabel}</div>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMonth(addMonths(month, 1))}>›</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
        {th.map(d => <div key={d} style={{ textAlign: 'center', fontSize: 10, color: 'var(--text3)' }}>{d}</div>)}
        {cells.map((d, i) => {
          const iso = format(d, 'yyyy-MM-dd')
          const sunday = d.getDay() === 0
          const dim = !isSameMonth(d, month)
          const sel = value.has(iso)
          return (
            <button key={i} type="button" disabled={sunday}
              onClick={() => toggle(iso)}
              style={{
                padding: '6px 0', borderRadius: 6, border: 'none', fontSize: 12,
                cursor: sunday ? 'not-allowed' : 'pointer',
                background: sel ? 'var(--accent)' : sunday ? 'rgba(255,80,80,.06)' : 'rgba(255,255,255,.05)',
                color: sel ? '#fff' : sunday ? 'var(--text3)' : dim ? 'var(--text3)' : 'var(--text)',
                opacity: dim && !sel ? 0.4 : 1, fontWeight: sel ? 700 : 400,
              }}>
              {d.getDate()}
            </button>
          )
        })}
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text3)' }}>
        เลือกแล้ว <strong style={{ color: 'var(--accent)' }}>{value.size}</strong> วัน (คลิกวันเพื่อเพิ่ม/เอาออก · วันอาทิตย์เลือกไม่ได้)
      </div>
    </div>
  )
}
