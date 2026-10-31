// Phone-only list of quotations (mobile-view round 1b, owner comment: "info กำลังดี แต่ที่ว่างเยอะ"): three compact
// lines per quotation. Quotations.jsx renders this ONLY when useIsPhone() is true; the desktop table is untouched.
// The action buttons are the SAME JSX as the table row (renderActions from the page).
import { quotationNote } from '../../lib/phoneFormat.js'

const SORTS = [
  { key: 'date', label: 'วันที่' }, { key: 'quotation_number', label: 'เลขที่' }, { key: 'total', label: 'ยอดรวม' },
  { key: 'client', label: 'ลูกค้า' }, { key: 'status', label: 'สถานะ' },
]

export default function QuotationPhoneCards({ rows, todayIso, toggleSort, sortIcon, statusLabels, fmt, fmtDate, renderActions, onOpen, PendingMark }) {
  return (
    <div className="pc-list">
      <div className="pc-sorts" data-phone="chips">
        {SORTS.map(s => <button key={s.key} type="button" className="pc-chip" onClick={() => toggleSort(s.key)}>{s.label}{sortIcon(s.key)}</button>)}
      </div>
      {rows.map(({ qt, total, items, expiring }) => {
        const note = quotationNote(qt, total, todayIso)
        const where = qt.sites?.name || qt.site_name
        return (
          <div key={qt.id} className="pc-card pc-compact" role="button" tabIndex={0} onClick={() => onOpen(qt)} onKeyDown={e => { if (e.key === 'Enter') onOpen(qt) }}>
            <div className="pc-row1">
              <div className="pc-no">{expiring && <PendingMark label="ใกล้หมดวันยืนราคา" />}{qt.quotation_number}</div>
              <span className={`badge badge-${qt.status}`}>{statusLabels[qt.status] || qt.status}</span>
              <div className="pc-amt">{fmt(total)}</div>
            </div>
            <div className="pc-client">{qt.clients?.name || '—'}{where ? <span className="pc-where"> · {where}</span> : null}</div>
            <div className="pc-row3">
              <span className="pc-meta">
                {fmtDate(qt.date)} · {items} รายการ{note.text && <> · <b className={note.tone === 'bad' ? 'pc-bad' : note.tone === 'warn' ? 'pc-warn' : ''}>{note.text}</b></>}
              </span>
              <span className="pc-acts" onClick={e => e.stopPropagation()}>{renderActions(qt)}</span>
            </div>
          </div>
        )
      })}
      {!rows.length && <div className="pc-empty">ไม่พบใบเสนอราคาในช่วงเวลานี้</div>}
    </div>
  )
}
