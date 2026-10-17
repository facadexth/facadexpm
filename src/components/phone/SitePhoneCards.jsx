// Phone-only list of sites (mobile-view round 1b, owner comment 2026-10-15: "เพิ่ม info graphic ที่เหมาะกับพื้นที่
// ไม่ต้องเรียงตาม PC"). Sites.jsx renders this ONLY when useIsPhone() is true; the desktop table is untouched.
// Same data and handlers as the table row: tap = open site detail, ✎ = edit, ⋯ = the row menu.
import RowActionsMenu from '../RowActionsMenu.jsx'
import { fmtCompact, spendRatio } from '../../lib/phoneFormat.js'

const SORTS = [
  { key: 'name', label: 'ชื่อ' }, { key: 'contract_value', label: 'มูลค่าสัญญา' }, { key: 'billing_pct', label: '% เบิก' },
  { key: 'gross_profit', label: 'กำไร' }, { key: 'end_date', label: 'วันจบงาน' }, { key: 'site_number', label: 'รหัส' },
]

export default function SitePhoneCards({ sites, toggleSort, sortIcon, onOpen, onEdit, menuItems, canEdit, countdown, fmtDate, PencilIcon }) {
  return (
    <div className="pc-list">
      <div className="pc-sorts" data-phone="chips">
        {SORTS.map(s => <button key={s.key} type="button" className="pc-chip" onClick={() => toggleSort(s.key)}>{s.label}{sortIcon(s.key)}</button>)}
      </div>
      {sites.map(s => {
        const pct = s.billing_pct
        const days = s.end_date ? countdown(s.end_date) : null
        const ratio = spendRatio(s.total_income, s.total_expense)
        const hasIncome = (Number(s.total_income) || 0) > 0
        const profit = Number(s.gross_profit) || 0
        return (
          <div key={s.id} className="pc-card" role="button" tabIndex={0} onClick={() => onOpen(s)} onKeyDown={e => { if (e.key === 'Enter') onOpen(s) }}>
            <div className="pc-row1">
              <div className="pc-name">{s.name}</div>
              <span className={`badge badge-status-${s.status?.toLowerCase().replace(' ', '-')}`}>{s.status}</span>
            </div>
            <div className="pc-sub">
              {s.site_number}{(s.client_display_name || s.client_name) ? ` · ${s.client_display_name || s.client_name}` : ''}
              {s.map_url && <a href={s.map_url} target="_blank" rel="noreferrer" className="pc-map" onClick={e => e.stopPropagation()} aria-label="แผนที่">📍</a>}
            </div>
            <div className="pc-stats">
              <div className="pc-stat"><small>สัญญา</small><b>{s.contract_value > 0 ? fmtCompact(s.contract_value) : '—'}</b></div>
              <div className="pc-stat"><small>เบิกแล้ว</small><b className="pc-good">{hasIncome ? fmtCompact(s.total_income) : '—'}</b></div>
              <div className="pc-stat"><small>กำไรตอนนี้</small><b className={profit >= 0 ? 'pc-good' : 'pc-bad'}>{hasIncome ? fmtCompact(profit, { sign: true }) : '—'}</b></div>
            </div>
            {pct != null ? (
              <>
                <div className="pc-lbl"><span>% เบิก</span><span className={pct > 100 ? 'pc-bad' : ''}>{pct.toFixed(1)}%</span></div>
                <div className="pc-bar"><i style={{ width: `${Math.min(100, pct)}%` }} /></div>
              </>
            ) : <div className="pc-lbl"><span>% เบิก</span><span>ใส่มูลค่าสัญญา</span></div>}
            {ratio && (
              <>
                <div className="pc-lbl">
                  <span>รายจ่าย {fmtCompact(s.total_expense)} เทียบรายรับ {fmtCompact(s.total_income)}</span>
                  <span className={ratio.over ? 'pc-bad' : 'pc-good'}>{ratio.label}</span>
                </div>
                <div className="pc-bar"><i className={ratio.over ? 'pc-bar-bad' : 'pc-bar-good'} style={{ width: `${Math.min(100, ratio.pct)}%` }} /></div>
              </>
            )}
            <div className="pc-foot">
              <span>
                {s.end_date ? <>จบงาน {fmtDate(s.end_date)}{days !== null && <> · <b className={days < 0 ? 'pc-bad' : days < 14 ? 'pc-warn' : ''}>{days < 0 ? `เกิน ${Math.abs(days)} วัน` : `เหลือ ${days} วัน`}</b></>}</> : 'ยังไม่กำหนดวันจบงาน'}
                {s.last_activity_date && <> · ล่าสุด {fmtDate(s.last_activity_date)}</>}
              </span>
              {canEdit && (
                <span className="pc-acts" onClick={e => e.stopPropagation()}>
                  <button className="btn btn-sm btn-edit" aria-label="แก้ไข" onClick={() => onEdit(s)}><PencilIcon /></button>
                  <RowActionsMenu items={menuItems(s)} />
                </span>
              )}
            </div>
          </div>
        )
      })}
      {!sites.length && <div className="pc-empty">ไม่พบข้อมูลไซท์งาน</div>}
    </div>
  )
}
