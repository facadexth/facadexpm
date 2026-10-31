// ============================================================
// SiteOverviewContent -- presentational body for one site's financial
// overview (contract/deposit/retention/expense breakdown). Extracted from
// SiteOverviewModal so both the popup (10 other call sites, unchanged)
// and the SiteDetail page can render identical content without
// duplicating fetch/compute logic in two places that could drift.
// Money parts render only for roles that can see money (OWNER/ADMIN); a PM
// gets the status and dates only. Other roles get nothing (defense-in-depth,
// on top of whatever gate the caller itself has).
// ============================================================
import { useMemo } from 'react'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts'
import { useSiteOverview, useSiteExpensesByCategory, useQuotations, useInvoices } from '../hooks/useSupabase.js'
import { calcQuotationTotals } from '../lib/quotationCalc.js'
import { summarizeQuotationBilling } from '../lib/quotationBilling.js'
import { fmt, fmtDate } from '../lib/supabase.js'
import { depositStatusFor } from '../lib/depositCalc.js'
import { retentionStatusFor, retentionDueText } from '../lib/retentionStatus.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { canSeeMoney, canManageSites } from '../lib/roles.js'
import { CATEGORY_PALETTE, OTHER_LABEL, OTHER_COLOR, categoryBreakdown, groupSmallSlices } from '../lib/expenseChart.js'
import CategoryPieTooltip from './CategoryPieTooltip.jsx'
import PhoneSection from './PhoneSection.jsx'
import { useIsPhone } from '../hooks/useIsPhone.js'

export default function SiteOverviewContent({ siteId }) {
  const { role } = useUserRole()
  const showMoney = canSeeMoney(role)
  const canView = canManageSites(role)
  const isPhone = useIsPhone()
  const { data: site, error } = useSiteOverview(canView ? siteId : null)
  const { data: siteExpenses } = useSiteExpensesByCategory(showMoney ? siteId : null)
  const categoryData = useMemo(() => groupSmallSlices(categoryBreakdown(siteExpenses)), [siteExpenses])

  const { data: siteQuotations } = useQuotations(
    showMoney && site?.id ? { siteId: site.id, status: 'accepted' } : { status: '__none__' }
  )
  const { data: siteInvoices } = useInvoices(showMoney && site?.id ? { siteId: site.id } : { status: '__none__' })
  // one row per accepted quotation of this site (original job + any extra-work quotations) with how much is billed
  const quotationBilling = useMemo(() => summarizeQuotationBilling(
    (siteQuotations || []).map(q => {
      const tot = calcQuotationTotals(q.quotation_items, {
        hasVat: q.has_vat, priceIncludesVat: q.price_includes_vat,
        discountAmount: q.discount_amount, discountPct: q.discount_pct,
      })
      return { id: q.id, quotation_number: q.quotation_number, date: q.date, subtotal: tot.subtotal, total: tot.total }
    }),
    siteInvoices,
  ), [siteQuotations, siteInvoices])

  if (!canView) return null

  // shared bodies: desktop wraps them in its titled block, phone in a collapsible PhoneSection
  const quotationTable = (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ color: 'var(--text3)', textAlign: 'right' }}>
            <th style={{ textAlign: 'left', fontWeight: 600, padding: '4px 6px' }}>ใบเสนอราคา</th>
            <th style={{ fontWeight: 600, padding: '4px 6px' }}>มูลค่า</th>
            <th style={{ fontWeight: 600, padding: '4px 6px' }}>เบิกแล้ว</th>
            <th style={{ fontWeight: 600, padding: '4px 6px' }}>คงเหลือ</th>
            <th style={{ fontWeight: 600, padding: '4px 6px' }}>% เบิก</th>
          </tr>
        </thead>
        <tbody>
          {quotationBilling.rows.map(q => (
            <tr key={q.id} style={{ borderTop: '1px solid var(--border)' }}>
              <td style={{ padding: '6px' }}>
                <div style={{ fontWeight: 600 }}>{q.quotation_number}</div>
                <div style={{ fontSize: 10, color: 'var(--text3)' }}>รับเข้าไซท์งาน {fmtDate(q.date)}</div>
              </td>
              <td className="font-mono" style={{ textAlign: 'right', padding: '6px', whiteSpace: 'nowrap' }}>{fmt(q.total)}</td>
              <td className="font-mono" style={{ textAlign: 'right', padding: '6px', whiteSpace: 'nowrap' }}>{fmt(q.billedTotal)}</td>
              <td className="font-mono" style={{ textAlign: 'right', padding: '6px', whiteSpace: 'nowrap' }}>{fmt(q.remainingTotal)}</td>
              <td className="font-mono" style={{ textAlign: 'right', padding: '6px', whiteSpace: 'nowrap' }}>{q.pct.toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
        {quotationBilling.rows.length > 1 && (
          <tfoot>
            <tr style={{ borderTop: '1px dashed var(--border)', color: 'var(--accent)', fontWeight: 800 }}>
              <td style={{ padding: '6px' }}>รวม</td>
              <td className="font-mono" style={{ textAlign: 'right', padding: '6px', whiteSpace: 'nowrap' }}>{fmt(quotationBilling.sum.total)}</td>
              <td className="font-mono" style={{ textAlign: 'right', padding: '6px', whiteSpace: 'nowrap' }}>{fmt(quotationBilling.sum.billedTotal)}</td>
              <td className="font-mono" style={{ textAlign: 'right', padding: '6px', whiteSpace: 'nowrap' }}>{fmt(quotationBilling.sum.remainingTotal)}</td>
              <td className="font-mono" style={{ textAlign: 'right', padding: '6px', whiteSpace: 'nowrap' }}>{quotationBilling.sum.pct.toFixed(1)}%</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
  // phone: one small card per quotation (+ a totals card) instead of a 5-column table that needs sideways scrolling
  const quotationCards = (row, label, extra) => (
    <div key={row.id ?? 'sum'} data-phone="qt-card" className={extra}>
      <div className="qt-head">
        <b>{label}</b>
        <span className="font-mono">{row.pct.toFixed(1)}%</span>
      </div>
      {row.date && <div className="qt-sub">รับเข้าไซท์งาน {fmtDate(row.date)}</div>}
      <div className="qt-grid">
        <div><small>มูลค่า</small><span className="font-mono">{fmt(row.total)}</span></div>
        <div><small>เบิกแล้ว</small><span className="font-mono">{fmt(row.billedTotal)}</span></div>
        <div><small>คงเหลือ</small><span className="font-mono">{fmt(row.remainingTotal)}</span></div>
      </div>
    </div>
  )
  const quotationBody = (
    <>
      {isPhone ? (
        <div>
          {quotationBilling.rows.map(q => quotationCards(q, q.quotation_number))}
          {quotationBilling.rows.length > 1 && quotationCards(quotationBilling.sum, 'รวม', 'qt-total')}
        </div>
      ) : quotationTable}
      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
        เบิกแล้ว = ใบแจ้งหนี้ที่ออกแล้วและไม่ void (ไม่รวมใบมัดจำ) คิดเป็นสัดส่วนของมูลค่าใบเสนอราคา · มูลค่ารวม VAT
      </div>
    </>
  )
  const depositBody = site?.deposit?.total_deposit > 0 && (
    <>
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
    </>
  )
  const retentionBody = site?.retention?.total_retention > 0 && (
    <div className="form-grid-3">
      <div>
        <div style={{ fontSize: 11, color: 'var(--text3)' }}>ยอด Retention</div>
        <div className="font-mono" style={{ fontWeight: 700 }}>{fmt(site.retention.total_retention)}</div>
      </div>
      <div>
        <div style={{ fontSize: 11, color: 'var(--text3)' }}>วันครบกำหนด</div>
        <div style={{ fontSize: 12 }}>{retentionDueText(site.retention, fmtDate)}</div>
      </div>
      <div>
        <div style={{ fontSize: 11, color: 'var(--text3)' }}>สถานะ</div>
        <span className={`badge ${retentionStatusFor(site.retention).cls}`}>{retentionStatusFor(site.retention).label}</span>
      </div>
    </div>
  )
  const chartBody = (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie data={categoryData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={75} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
          {categoryData.map((d, i) => <Cell key={i} fill={d.name === OTHER_LABEL ? OTHER_COLOR : CATEGORY_PALETTE[i % CATEGORY_PALETTE.length]} />)}
        </Pie>
        <Tooltip content={<CategoryPieTooltip />} />
      </PieChart>
    </ResponsiveContainer>
  )

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {error ? (
        <div style={{ color: 'var(--red)', fontSize: 13 }}>โหลดข้อมูลไม่สำเร็จ: {error}</div>
      ) : !site ? (
        <div style={{ color: 'var(--text3)', fontSize: 13 }}>กำลังโหลด...</div>
      ) : !showMoney ? (
        <>
          <div>
            <span className={`badge badge-status-${site.status?.toLowerCase().replace(' ', '-')}`}>{site.status}</span>
          </div>
          <div className="form-grid-3">
            <div>
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>วันเริ่มต้น</div>
              <div style={{ fontSize: 12 }}>{site.start_date ? fmtDate(site.start_date) : '—'}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>วันจบงาน</div>
              <div style={{ fontSize: 12 }}>{site.end_date ? fmtDate(site.end_date) : '—'}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>ลูกค้า</div>
              <div style={{ fontSize: 12 }}>{site.client_name || '—'}</div>
            </div>
          </div>
          {site.location && (
            <div>
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>ที่ตั้งโครงการ</div>
              <div style={{ fontSize: 12 }}>{site.location}</div>
            </div>
          )}
        </>
      ) : (
        <>
          <div>
            <span className={`badge badge-status-${site.status?.toLowerCase().replace(' ', '-')}`}>{site.status}</span>
          </div>

          <div className="form-grid-3" data-phone="kpis">
            <div data-phone-order="1">
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>มูลค่าสัญญา</div>
              <div className="font-mono" style={{ fontWeight: 700 }}>{fmt(site.contract_value)}</div>
            </div>
            <div data-phone-order="3">
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>รายรับ</div>
              <div className="font-mono" style={{ fontWeight: 700, color: 'var(--green)' }}>{fmt(site.total_income)}</div>
            </div>
            <div data-phone-order="4">
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>รายจ่าย</div>
              <div className="font-mono" style={{ fontWeight: 700, color: 'var(--red)' }}>{fmt(site.total_expense)}</div>
            </div>
            <div data-phone-order="5">
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>กำไร</div>
              <div className="font-mono" style={{ fontWeight: 700, color: (site.gross_profit || 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmt(site.gross_profit)}</div>
            </div>
            <div data-phone-order="6">
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>ค่าแรงพนักงาน</div>
              <div className="font-mono" style={{ fontWeight: 700 }}>{fmt(site.worker_labor_cost)}</div>
            </div>
            <div data-phone-order="2">
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>% เบิก</div>
              <div className="font-mono" style={{ fontWeight: 700 }}>{site.billing_pct != null ? `${site.billing_pct.toFixed(1)}%` : '—'}</div>
            </div>
            <div data-phone-order="7">
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>วันจบงาน</div>
              <div style={{ fontSize: 12 }}>{site.end_date ? fmtDate(site.end_date) : '—'}</div>
            </div>
          </div>

          {quotationBilling.rows.length > 0 && (isPhone ? (
            <PhoneSection title={`ใบเสนอราคาของไซท์นี้ (${quotationBilling.rows.length})`} summary={`เหลือเบิก ${fmt(quotationBilling.sum.remainingTotal)}`} defaultOpen>
              {quotationBody}
            </PhoneSection>
          ) : (
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text3)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
                ใบเสนอราคาของไซท์นี้ ({quotationBilling.rows.length})
              </div>
              {quotationBody}
            </div>
          ))}

          {site.deposit?.total_deposit > 0 && (isPhone ? (
            <PhoneSection title="💰 มัดจำ" summary={`คงเหลือ ${fmt(site.deposit.remaining_balance)}`}>
              {depositBody}
            </PhoneSection>
          ) : (
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text3)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
                💰 มัดจำ
              </div>
              {depositBody}
            </div>
          ))}

          {site.retention?.total_retention > 0 && (isPhone ? (
            <PhoneSection title="🔒 Retention" summary={retentionStatusFor(site.retention).label}>
              {retentionBody}
            </PhoneSection>
          ) : (
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text3)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
                🔒 Retention
              </div>
              {retentionBody}
            </div>
          ))}

          {categoryData.length > 0 && (isPhone ? (
            <PhoneSection title="📊 ค่าใช้จ่ายตามหมวด" summary="กราฟ">
              {chartBody}
            </PhoneSection>
          ) : (
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text3)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
                📊 ค่าใช้จ่ายตามหมวด
              </div>
              {chartBody}
            </div>
          ))}
        </>
      )}
    </div>
  )
}
