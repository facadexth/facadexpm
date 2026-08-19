// ============================================================
// SiteOverviewModal -- popup summary for one site: contract/financials +
// มัดจำ (deposit) + retention, opened by clicking a site name anywhere in
// the app. Read-only; no edit actions. ADMIN+ only -- see App.jsx, this
// is never wired into WORKER-visible site-name displays.
// ============================================================
import { useSiteOverview } from '../hooks/useSupabase.js'
import { fmt, fmtDate } from '../lib/supabase.js'
import { depositStatusFor } from '../lib/depositCalc.js'
import { retentionStatusFor } from '../lib/retentionStatus.js'
import { Modal } from './Modal.jsx'

export default function SiteOverviewModal({ siteId, onClose }) {
  const { data: site } = useSiteOverview(siteId)

  return (
    <Modal title={site ? `${site.site_number} · ${site.name}` : 'ไซท์งาน'} onClose={onClose} maxWidth={560}>
      <div className="modal-body" style={{ display: 'grid', gap: 16 }}>
        {!site ? (
          <div style={{ color: 'var(--text3)', fontSize: 13 }}>กำลังโหลด...</div>
        ) : (
          <>
            <div>
              <span className={`badge badge-status-${site.status?.toLowerCase().replace(' ', '-')}`}>{site.status}</span>
            </div>

            <div className="form-grid-3">
              <div>
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>มูลค่าสัญญา</div>
                <div className="font-mono" style={{ fontWeight: 700 }}>{fmt(site.contract_value)}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>รายรับ</div>
                <div className="font-mono" style={{ fontWeight: 700, color: 'var(--green)' }}>{fmt(site.total_income)}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>รายจ่าย</div>
                <div className="font-mono" style={{ fontWeight: 700, color: 'var(--red)' }}>{fmt(site.total_expense)}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>กำไร</div>
                <div className="font-mono" style={{ fontWeight: 700, color: (site.gross_profit || 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmt(site.gross_profit)}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>% เบิก</div>
                <div className="font-mono" style={{ fontWeight: 700 }}>{site.billing_pct != null ? `${site.billing_pct.toFixed(1)}%` : '—'}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>วันจบงาน</div>
                <div style={{ fontSize: 12 }}>{site.end_date ? fmtDate(site.end_date) : '—'}</div>
              </div>
            </div>

            {site.deposit?.total_deposit > 0 && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text3)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
                  💰 มัดจำ
                </div>
                <div className="form-grid-3">
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text3)' }}>เก็บมัดจำ</div>
                    <div className="font-mono" style={{ fontWeight: 700 }}>{fmt(site.deposit.total_deposit)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text3)' }}>หักไปแล้ว</div>
                    <div className="font-mono" style={{ color: 'var(--yellow)' }}>{fmt(site.deposit.total_deducted)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text3)' }}>คงเหลือ</div>
                    <div className="font-mono" style={{ fontWeight: 700, color: 'var(--green)' }}>{fmt(site.deposit.remaining_balance)}</div>
                  </div>
                </div>
                <div style={{ marginTop: 6 }}>
                  <span className={`badge ${depositStatusFor(site.deposit).cls}`}>{depositStatusFor(site.deposit).label}</span>
                </div>
              </div>
            )}

            {site.retention?.total_retention > 0 && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text3)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
                  🔒 Retention
                </div>
                <div className="form-grid-3">
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text3)' }}>ยอด Retention</div>
                    <div className="font-mono" style={{ fontWeight: 700 }}>{fmt(site.retention.total_retention)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text3)' }}>วันครบกำหนด</div>
                    <div style={{ fontSize: 12 }}>{!site.retention.end_date ? 'รอจบงาน' : (site.retention.due_date ? fmtDate(site.retention.due_date) : '—')}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text3)' }}>สถานะ</div>
                    <span className={`badge ${retentionStatusFor(site.retention).cls}`}>{retentionStatusFor(site.retention).label}</span>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
      </div>
    </Modal>
  )
}
