// ============================================================
// ViewToggle + date navigation (‹ today ›)
// ============================================================
import { addDays, addWeeks, addMonths, format } from 'date-fns'

const VIEWS = [
  { key: 'day',   label: 'วัน' },
  { key: 'week',  label: 'สัปดาห์' },
  { key: 'month', label: 'เดือน' },
]

const TH_MONTHS = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.']

function labelFor(view, anchor) {
  if (view === 'day')  return `${anchor.getDate()} ${TH_MONTHS[anchor.getMonth()]} ${anchor.getFullYear() + 543}`
  if (view === 'week') return `สัปดาห์ที่มี ${anchor.getDate()} ${TH_MONTHS[anchor.getMonth()]}`
  return `${TH_MONTHS[anchor.getMonth()]} ${anchor.getFullYear() + 543}`
}

export default function ViewToggle({ view, onView, anchor, onAnchor, holidayDates }) {
  const step = (dir) => {
    if (view === 'day')  onAnchor(addDays(anchor, dir))
    else if (view === 'week') onAnchor(addWeeks(anchor, dir))
    else onAnchor(addMonths(anchor, dir))
  }
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', gap: 4 }}>
        {VIEWS.map(v => (
          <button key={v.key}
            className={`btn btn-sm ${view === v.key ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => onView(v.key)}>{v.label}</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <button className="btn btn-sm btn-ghost" onClick={() => step(-1)}>‹</button>
        <button className="btn btn-sm btn-ghost" onClick={() => onAnchor(new Date())}>วันนี้</button>
        <button className="btn btn-sm btn-ghost" onClick={() => step(1)}>›</button>
      </div>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text2)' }}>
        {labelFor(view, anchor)}
        {view === 'day' && holidayDates?.get(format(anchor, 'yyyy-MM-dd')) && (
          <span style={{ color: 'var(--red)', fontWeight: 400 }}> — {holidayDates.get(format(anchor, 'yyyy-MM-dd'))}</span>
        )}
      </div>
    </div>
  )
}
