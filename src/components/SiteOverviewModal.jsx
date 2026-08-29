// ============================================================
// SiteOverviewModal -- popup summary for one site: contract/financials +
// มัดจำ (deposit) + retention, opened by clicking a site name anywhere in
// the app. Read-only; no edit actions. ADMIN+ only -- see App.jsx, this
// is never wired into WORKER-visible site-name displays.
// ============================================================
import { useMemo, useState } from 'react'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts'
import { useSiteOverview, useSiteExpensesByCategory, useQuotations } from '../hooks/useSupabase.js'
import { calcQuotationTotals } from '../lib/quotationCalc.js'
import { fmt, fmtDate } from '../lib/supabase.js'
import { depositStatusFor } from '../lib/depositCalc.js'
import { retentionStatusFor } from '../lib/retentionStatus.js'
import { Modal } from './Modal.jsx'
import { useUserRole } from '../hooks/useUserRole.js'
import { CATEGORY_PALETTE, OTHER_LABEL, OTHER_COLOR, categoryBreakdown, groupSmallSlices } from '../lib/expenseChart.js'
import CategoryPieTooltip from './CategoryPieTooltip.jsx'

export default function SiteOverviewModal({ siteId, onClose }) {
  const { isAtLeast } = useUserRole()
  const isAdmin = isAtLeast('ADMIN')
  const { data: site, error } = useSiteOverview(isAdmin ? siteId : null)
  const { data: siteExpenses } = useSiteExpensesByCategory(isAdmin ? siteId : null)
  const categoryData = useMemo(() => groupSmallSlices(categoryBreakdown(siteExpenses)), [siteExpenses])

  // Only a real query once the site is actually loaded -- '__none__' is not
  // a real status, so it cheaply returns nothing while site is still
  // loading rather than briefly fetching every accepted quotation tenant-wide.
  const [showContractBreakdown, setShowContractBreakdown] = useState(false)
  const { data: siteQuotations } = useQuotations(
    isAdmin && site?.id ? { siteId: site.id, status: 'accepted' } : { status: '__none__' }
  )
  const contractBreakdown = useMemo(() => (siteQuotations || [])
    .map(q => ({
      id: q.id, quotation_number: q.quotation_number, date: q.date,
      total: calcQuotationTotals(q.quotation_items, {
        hasVat: q.has_vat, priceIncludesVat: q.price_includes_vat,
        discountAmount: q.discount_amount, discountPct: q.discount_pct,
      }).total,
    }))
    .sort((a, b) => (a.date || '').localeCompare(b.date || '')), [siteQuotations])

  if (!isAdmin) return null

  return (
    <Modal title={site ? `${site.site_number} · ${site.name}` : 'ไซท์งาน'} onClose={onClose} maxWidth={560}>
      <div className="modal-body" style={{ display: 'grid', gap: 16 }}>
        {error ? (
          <div style={{ color: 'var(--red)', fontSize: 13 }}>โหลดข้อมูลไม่สำเร็จ: {error}</div>
        ) : !site ? (
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
                {contractBreakdown.length > 1 && (
                  <>
                    <button type="button" onClick={() => setShowContractBreakdown(v => !v)}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, color: 'var(--accent)', cursor: 'pointer', background: 'none', border: 'none', padding: 0, marginTop: 5, fontFamily: 'inherit' }}>
                      ดูรายละเอียด ({contractBreakdown.length} ใบเสนอราคา)
                      <span style={{ display: 'inline-block', transition: 'transform .15s', transform: showContractBreakdown ? 'rotate(180deg)' : 'none' }}>▾</span>
                    </button>
                    {showContractBreakdown && (
                      <div style={{ marginTop: 8, display: 'grid', gap: 5 }}>
                        {contractBreakdown.map(q => (
                          <div key={q.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center', background: 'var(--bg3)', borderRadius: 7, padding: '7px 10px', fontSize: 12 }}>
                            <div>
                              <div style={{ fontWeight: 600 }}>{q.quotation_number}</div>
                              <div style={{ fontSize: 10, color: 'var(--text3)' }}>รับเข้าไซท์งาน {fmtDate(q.date)}</div>
                            </div>
                            <div className="font-mono" style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{fmt(q.total)}</div>
                          </div>
                        ))}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, borderTop: '1px dashed var(--border)', paddingTop: 8, marginTop: 2 }}>
                          <div style={{ color: 'var(--accent)', fontWeight: 800, fontSize: 12.5 }}>รวม</div>
                          <div className="font-mono" style={{ color: 'var(--accent)', fontWeight: 800, fontSize: 13.5 }}>{fmt(site.contract_value)}</div>
                        </div>
                      </div>
                    )}
                  </>
                )}
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
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>ค่าแรงพนักงาน</div>
                <div className="font-mono" style={{ fontWeight: 700 }}>{fmt(site.worker_labor_cost)}</div>
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

            {categoryData.length > 0 && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text3)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
                  📊 ค่าใช้จ่ายตามหมวด
                </div>
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie data={categoryData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={75} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                      {categoryData.map((d, i) => <Cell key={i} fill={d.name === OTHER_LABEL ? OTHER_COLOR : CATEGORY_PALETTE[i % CATEGORY_PALETTE.length]} />)}
                    </Pie>
                    <Tooltip content={<CategoryPieTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
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
