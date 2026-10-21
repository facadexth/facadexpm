// ============================================================
// Dashboard — ภาพรวม (หน้าแรก) แยกตามบทบาท
//   OWNER  : การ์ดเงินเดิม 8 ใบ + ตัวเลือกช่วงเวลา + การ์ดใหม่ "วันนี้ / หน้างาน"
//            ทั้งหมดปรับแต่ง (ซ่อน/เรียง) ได้ที่ "ปรับแต่งการ์ด" -- ต่อผู้ใช้ (localStorage)
//   ADMIN  : เหมือน OWNER ทุกอย่าง (owner เลือกแบบ B)
//   PM     : หน้างานล้วน ไม่มีเงิน และไม่โหลด query เงินเลย (ดู useDashboardData.js)
//   WORKER : เหมือนเดิม
// ตรรกะการจัดกลุ่ม/นับทั้งหมดอยู่ใน src/lib/dashboardCards.js (มีเทสต์)
// วันที่ทั้งหมดเป็นปฏิทินกรุงเทพ (bangkokDate)
// ============================================================
import { useState, useEffect, useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { useSites, useExpenses, useIncomes, usePaymentForecast, useSitesProgress, useSiteRetentionSummary, useCheques, useAppSetting, useQuery } from '../hooks/useSupabase.js'
import { useOwnerDashboard, usePmDashboard } from '../hooks/useDashboardData.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { isPm } from '../lib/roles.js'
import { useTenant } from '../hooks/useTenant.js'
import { supabase, fmt, fmtShort, fmtDate } from '../lib/supabase.js'
import { Modal } from '../components/Modal.jsx'
import { GuideProgressCard } from '../components/GuideProgressCard.jsx'
import { startOfYear, endOfYear, startOfMonth, endOfMonth, addMonths, format, parseISO } from 'date-fns'
import { th } from 'date-fns/locale'
import { getEffectiveTheme } from '../lib/theme.js'
import {
  bangkokDate, addDaysIso, dueByMonth, overdueExpenses, lateSites, todayCrewSummary, quotationCounts,
  pendingSummary, zeroProgressSites, repairsThisWeek, mergeCardPrefs, weekRange,
} from '../lib/dashboardCards.js'

// การ์ดทั้งหมดที่ OWNER เลือกซ่อน/แสดง/จัดลำดับเองได้ (ต่อผู้ใช้แต่ละคน ไม่ใช่ต่อ
// tenant -- เก็บใน localStorage คีย์ตามอีเมล คีย์เดิม ไม่ต้องมี schema/RLS ใหม่)
// group 'money' = 8 ใบเดิม (คำนวณเหมือนเดิมทุกอย่าง), 'today' = การ์ดใหม่
const CARD_DEFS = [
  { id: 'income', label: 'รายรับรวม', group: 'money' },
  { id: 'non_vat_income', label: 'รายรับไม่มี VAT', group: 'money' },
  { id: 'expense', label: 'รายจ่ายรวม', group: 'money' },
  { id: 'profit', label: 'กำไรเบื้องต้น', group: 'money' },
  { id: 'due_this_month', label: 'ต้องชำระเดือนนี้', group: 'money' },
  { id: 'due_next_month', label: 'ต้องชำระเดือนหน้า', group: 'money' },
  { id: 'retention', label: 'Retention ใกล้ครบกำหนด', group: 'money' },
  { id: 'cheque_reminder', label: 'เตรียมเงินจ่ายเช็ค', group: 'money' },
  { id: 'monthly_chart', label: 'รายรับ vs รายจ่าย รายเดือน', group: 'today' },
  { id: 'due_ahead', label: 'ต้องชำระ 1–3 เดือนข้างหน้า', group: 'today' },
  { id: 'crew_today', label: 'คนงานวันนี้ + เช็คอิน', group: 'today' },
  { id: 'sites_today', label: 'ไซท์ที่ทำงานวันนี้', group: 'today' },
  { id: 'pending', label: 'เรื่องรอคุณ', group: 'today' },
  { id: 'overdue_expenses', label: 'ค่าใช้จ่ายเกินกำหนด', group: 'today' },
  { id: 'late_sites', label: 'เลยกำหนดส่งมอบ', group: 'today' },
  { id: 'quotations_month', label: 'ใบเสนอราคาเดือนนี้', group: 'today' },
]
const CARD_IDS = CARD_DEFS.map(d => d.id)
const GROUPS = [
  { id: 'money', label: 'เงิน (เดิม)' },
  { id: 'today', label: 'วันนี้ / หน้างาน (ใหม่)' },
]
const groupOf = Object.fromEntries(CARD_DEFS.map(d => [d.id, d.group]))

function kpiPrefsKey(email) { return `dashboard-kpi-prefs:${email}` }

function loadKpiPrefs(email) {
  let raw = null
  try { raw = localStorage.getItem(kpiPrefsKey(email)) } catch { /* private mode */ }
  return mergeCardPrefs(raw, CARD_IDS)
}

function saveKpiPrefs(email, prefs) {
  try { localStorage.setItem(kpiPrefsKey(email), JSON.stringify(prefs)) } catch { /* private mode */ }
}

const PERIOD_OPTIONS = [
  { label: 'ปีนี้ (ทั้งปี)',    value: 'ytd' },
  { label: 'เดือนนี้',          value: 'month' },
  { label: 'ไตรมาสนี้',        value: 'quarter' },
  { label: 'ทั้งหมด',          value: 'all' },
]

function getPeriodRange(period) {
  const now = new Date()
  if (period === 'ytd')     return { from: format(startOfYear(now), 'yyyy-MM-dd'),  to: format(endOfYear(now), 'yyyy-MM-dd') }
  if (period === 'month')   return { from: format(startOfMonth(now), 'yyyy-MM-dd'), to: format(endOfMonth(now), 'yyyy-MM-dd') }
  if (period === 'quarter') {
    const q = Math.floor(now.getMonth() / 3)
    const start = new Date(now.getFullYear(), q * 3, 1)
    const end   = new Date(now.getFullYear(), q * 3 + 3, 0)
    return { from: format(start, 'yyyy-MM-dd'), to: format(end, 'yyyy-MM-dd') }
  }
  return {}
}

function Kpi({ label, value, sub, color = 'var(--accent)', cls = '', onClick }) {
  return (
    <div
      className={`kpi-card ${cls}`}
      onClick={onClick}
      style={onClick ? { cursor: 'pointer' } : undefined}
    >
      <div className="kpi-label">{label}</div>
      <div className="kpi-value" style={{ color }}>{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  )
}

// ── shared bits for the new cards ──
const CARD_GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))', gap: 14, marginBottom: 20 }
const muted = { color: 'var(--text3)', fontSize: 12 }
const rowStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 13 }
const num = { fontWeight: 700, fontVariantNumeric: 'tabular-nums' }

function DashCard({ title, onOpen, wide = false, children }) {
  return (
    <div className="card card-body" style={{ padding: '14px 16px', gridColumn: wide ? '1 / -1' : undefined, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8 }}>
        <div className="card-title" style={{ fontSize: 13.5 }}>{title}</div>
        {onOpen && <button type="button" className="btn btn-ghost btn-sm" onClick={onOpen} aria-label={`เปิด ${title}`}>เปิด →</button>}
      </div>
      {children}
    </div>
  )
}

function ClickRow({ onClick, children, style }) {
  return (
    <div role="button" tabIndex={0} onClick={onClick} onKeyDown={e => { if (e.key === 'Enter') onClick() }}
      style={{ ...rowStyle, cursor: 'pointer', padding: '4px 0', ...style }}>
      {children}
    </div>
  )
}

function Empty({ children = 'ไม่มีรายการ' }) {
  return <div style={muted}>{children}</div>
}

const openSite = (navigateTo, s) => navigateTo('site_detail', { siteId: s.siteId ?? s.id, siteName: s.name })

// คนงานวันนี้ -- total, checked in / not, names (not-checked-in first)
function CrewTodayCard({ crew, navigateTo, showNames = true }) {
  return (
    <DashCard title="คนงานวันนี้" onOpen={() => navigateTo('assign')}>
      {crew ? (
        <>
          <div style={{ display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 8 }}>
            <span style={{ ...num, fontSize: 22 }}>{crew.total} คน</span>
            <span style={{ color: 'var(--green)', fontSize: 13 }}>เช็คอินแล้ว {crew.checkedIn}</span>
            <span style={{ color: crew.notCheckedIn ? 'var(--red)' : 'var(--text3)', fontSize: 13 }}>ยังไม่เช็คอิน {crew.notCheckedIn}</span>
          </div>
          {showNames && crew.workers.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {crew.workers.map(w => (
                <span key={w.id} className={`badge ${w.checkedIn ? 'badge-paid' : 'badge-pending'}`} title={w.checkedIn ? 'เช็คอินแล้ว' : 'ยังไม่เช็คอิน'}>
                  {w.checkedIn ? '✓' : '•'} {w.name}
                </span>
              ))}
            </div>
          )}
          {!crew.total && <Empty>ไม่มีคนงานลงงานวันนี้</Empty>}
        </>
      ) : <Empty>กำลังโหลด…</Empty>}
    </DashCard>
  )
}

function SitesTodayCard({ crew, navigateTo, showNotCheckedIn = false, title = 'ไซท์ที่ทำงานวันนี้' }) {
  return (
    <DashCard title={title} onOpen={() => navigateTo('assign')}>
      {(crew?.bySite || []).map(s => (
        <ClickRow key={s.siteId} onClick={() => openSite(navigateTo, s)}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
          <span style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
            {showNotCheckedIn && s.notCheckedIn > 0 && <span style={{ color: 'var(--red)', fontSize: 12 }}>ยังไม่เช็คอิน {s.notCheckedIn}</span>}
            <span style={num}>{s.count} คน</span>
          </span>
        </ClickRow>
      ))}
      {crew && !crew.bySite.length && <Empty>ไม่มีไซท์ที่มีคนทำงานวันนี้</Empty>}
    </DashCard>
  )
}

function PendingCard({ items, navigateTo, title = 'เรื่องรอคุณ', extra = null }) {
  return (
    <DashCard title={title}>
      {items.map(i => (
        <ClickRow key={i.key} onClick={() => navigateTo(i.tab, { pending: i.key })}>
          <span>{i.icon} {i.label}</span>
          <span style={{ ...num, color: i.count ? 'var(--yellow)' : 'var(--text3)' }}>{i.count}</span>
        </ClickRow>
      ))}
      {extra}
      {!items.length && !extra && <Empty />}
    </DashCard>
  )
}

function LateSitesCard({ late, navigateTo }) {
  return (
    <DashCard title="เลยกำหนดส่งมอบ" onOpen={() => navigateTo('sites')}>
      {late.top.map(s => (
        <ClickRow key={s.id} onClick={() => openSite(navigateTo, s)}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
          <span style={{ ...num, color: 'var(--red)', flexShrink: 0 }}>{s.daysLate} วัน</span>
        </ClickRow>
      ))}
      {late.rest > 0 && (
        <ClickRow onClick={() => navigateTo('sites')}>
          <span style={muted}>+{late.rest} ไซท์</span><span style={muted}>→</span>
        </ClickRow>
      )}
      {!late.total && <Empty>ไม่มีไซท์ที่เลยกำหนด</Empty>}
    </DashCard>
  )
}

const expensesDue = (from, to) => ({ dateField: 'due', dateFrom: from, dateTo: to, status: 'unpaid' })
const EARLIEST = '2000-01-01'

// การ์ดจัดเรียงด้วยปุ่มขึ้น/ลง แทน drag-and-drop -- ไม่ต้องเพิ่ม library ใช้ได้ทั้งเมาส์/นิ้ว
// ย้ายได้เฉพาะภายในกลุ่มเดียวกัน (เงิน / วันนี้)
function KpiCustomizeModal({ availableDefs, prefs, onSave, onClose }) {
  const available = new Set(availableDefs.map(d => d.id))
  const [order, setOrder] = useState(prefs.order.filter(id => available.has(id)))
  const [hidden, setHidden] = useState(new Set(prefs.hidden))

  const move = (id, dir) => {
    setOrder(o => {
      const same = o.filter(x => groupOf[x] === groupOf[id])
      const k = same.indexOf(id) + dir
      if (k < 0 || k >= same.length) return o
      const i = o.indexOf(id)
      const j = o.indexOf(same[k])
      const next = [...o]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }
  const toggle = (id) => {
    setHidden(h => {
      const next = new Set(h)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const labelById = Object.fromEntries(availableDefs.map(d => [d.id, d.label]))

  return (
    <Modal title="ปรับแต่งการ์ด" onClose={onClose} maxWidth={440}>
      <div className="modal-body" style={{ display: 'grid', gap: 6 }}>
        <p style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 4 }}>
          ติ๊กเพื่อซ่อน/แสดง และใช้ลูกศรจัดลำดับการ์ด — บันทึกไว้เฉพาะบัญชีนี้
        </p>
        {GROUPS.map(g => {
          const ids = order.filter(id => groupOf[id] === g.id)
          return (
            <div key={g.id} style={{ display: 'grid', gap: 6, marginBottom: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', letterSpacing: 0.5 }}>{g.label}</div>
              {ids.map((id, i) => (
                <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, background: 'var(--bg2)' }}>
                  <input type="checkbox" checked={!hidden.has(id)} onChange={() => toggle(id)} aria-label={labelById[id]} />
                  <span style={{ flex: 1, fontSize: 13, color: hidden.has(id) ? 'var(--text3)' : 'var(--text1)' }}>{labelById[id]}</span>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={i === 0} onClick={() => move(id, -1)}>↑</button>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={i === ids.length - 1} onClick={() => move(id, 1)}>↓</button>
                </div>
              ))}
            </div>
          )
        })}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onClose}>ยกเลิก</button>
        <button type="button" className="btn btn-primary" onClick={() => onSave({ order, hidden: [...hidden] })}>✅ บันทึก</button>
      </div>
    </Modal>
  )
}

// WORKER view (unchanged): Ongoing sites with billing progress.
function WorkerSiteProgress() {
  const { data: sites } = useSitesProgress()
  const ongoing = (sites || []).filter(s => s.status === 'Ongoing')

  return (
    <div>
      <div style={{ color: 'var(--text3)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>
        ไซท์งาน Ongoing ({ongoing.length} ไซท์)
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 12 }}>
        {ongoing.map(s => (
          <div key={s.id} className="card card-body" style={{ padding: '14px 16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 10.5, color: 'var(--accent)', fontWeight: 700, marginBottom: 2 }}>{s.site_number}</div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{s.name}</div>
              </div>
              <span className="badge badge-paid">{s.status}</span>
            </div>
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text2)', marginBottom: 5 }}>
                <span>ความคืบหน้างาน</span>
                <strong style={{ color: 'var(--blue)' }}>{s.billing_pct != null ? `${s.billing_pct.toFixed(1)}%` : '—'}</strong>
              </div>
              <div style={{ height: 6, borderRadius: 999, background: 'var(--bg4)', overflow: 'hidden' }}>
                <div style={{ height: '100%', borderRadius: 999, background: 'linear-gradient(90deg, var(--accent), var(--blue))', width: `${Math.min(100, s.billing_pct || 0)}%` }} />
              </div>
            </div>
          </div>
        ))}
        {!ongoing.length && <div style={{ color: 'var(--text3)', fontSize: 13 }}>ไม่มีไซท์งาน Ongoing</div>}
      </div>
    </div>
  )
}

const ALL_TABS = () => true

export default function Dashboard({ navigateTo, pendingCounts = null, canSeeTab = ALL_TABS }) {
  const { role, user } = useUserRole()
  // OWNER and ADMIN share one dashboard (owner decision B, 2026-10-21).
  if (role === 'OWNER' || role === 'ADMIN') return <OwnerDashboard navigateTo={navigateTo} user={user} pendingCounts={pendingCounts} canSeeTab={canSeeTab} />
  if (isPm(role)) return <PmDashboard navigateTo={navigateTo} pendingCounts={pendingCounts} canSeeTab={canSeeTab} />
  if (!role) return null
  return <WorkerSiteProgress />
}

// ── PM: site work only. No money hook is mounted here. ──
function PmDashboard({ navigateTo, pendingCounts, canSeeTab }) {
  const today = bangkokDate()
  const { data } = usePmDashboard(today, true)
  const crew = useMemo(() => (data ? todayCrewSummary(data.todayAssignments, data.checkins) : null), [data])
  // The tenant's central site (ส่วนกลาง / factory) has no BOQ to record.
  const centralIds = useMemo(() => new Set((data?.sites || []).filter(s => s.is_default).map(s => s.id)), [data])
  const zero = useMemo(() => (crew ? zeroProgressSites(crew.bySite.filter(s => !centralIds.has(s.siteId)), data.pctBySite) : []), [crew, centralIds, data])
  const withPct = useMemo(() => (crew ? crew.bySite.filter(s => !centralIds.has(s.siteId) && !zero.includes(s)) : []), [crew, centralIds, zero])
  const late = useMemo(() => lateSites(data?.sites, today, 4), [data, today])
  const repairs = useMemo(() => repairsThisWeek(data?.weekAssignments), [data])
  const leave = pendingSummary(pendingCounts, canSeeTab, ['leave_pending'])
  const week = weekRange(today)

  return (
    <div>
      <div style={CARD_GRID}>
        <SitesTodayCard crew={crew} navigateTo={navigateTo} showNotCheckedIn title="คนงานวันนี้ แยกไซท์" />
        <DashCard title="ต้องบันทึกยอด BOQ" onOpen={() => navigateTo('sites')}>
          {zero.map(s => (
            <ClickRow key={s.siteId} onClick={() => openSite(navigateTo, s)}>
              <span>{s.name}</span><span style={{ color: 'var(--red)', fontSize: 12 }}>0% · มีคนทำงานวันนี้</span>
            </ClickRow>
          ))}
          {withPct.map(s => (
            <ClickRow key={s.siteId} onClick={() => openSite(navigateTo, s)}>
              <span style={muted}>{s.name}</span><span style={{ ...muted, ...num }}>{Number(data.pctBySite[s.siteId]).toFixed(1)}%</span>
            </ClickRow>
          ))}
          {crew && !zero.length && !withPct.length && <Empty>ไม่มีไซท์ที่มีคนทำงานวันนี้</Empty>}
        </DashCard>
        <LateSitesCard late={late} navigateTo={navigateTo} />
        <PendingCard
          title="งานซ่อมที่นัดสัปดาห์นี้ · ลารออนุมัติ"
          items={leave}
          navigateTo={navigateTo}
          extra={(
            <>
              {repairs.map(r => (
                <ClickRow key={r.ticketId} onClick={() => navigateTo('assign')}>
                  <span>🔧 {fmtDate(r.date)} · {r.siteName}</span><span style={muted}>{r.crew} คน</span>
                </ClickRow>
              ))}
              {data && !repairs.length && <div style={muted}>ไม่มีงานซ่อมที่นัด {fmtDate(week.from)} – {fmtDate(week.to)}</div>}
            </>
          )}
        />
      </div>
    </div>
  )
}

// ── OWNER / ADMIN: the 8 money cards (unchanged maths) + the new cards, all customisable. ──
function OwnerDashboard({ navigateTo, user, pendingCounts, canSeeTab }) {
  const salesTab = canSeeTab('sales_report') ? 'sales_report' : 'income'
  const [period, setPeriod] = useState('ytd')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo,   setCustomTo]   = useState('')

  const [kpiPrefs, setKpiPrefs] = useState({ order: CARD_IDS, hidden: [] })
  const [showKpiCustomize, setShowKpiCustomize] = useState(false)
  useEffect(() => { if (user?.email) setKpiPrefs(loadKpiPrefs(user.email)) }, [user?.email])
  const handleSaveKpiPrefs = (next) => {
    setKpiPrefs(next)
    if (user?.email) saveKpiPrefs(user.email, next)
    setShowKpiCustomize(false)
  }

  // Date range
  const range = useMemo(() => {
    if (period === 'custom') return { from: customFrom, to: customTo }
    return getPeriodRange(period)
  }, [period, customFrom, customTo])

  const today = bangkokDate()
  const { data: sites }    = useSites()
  const { data: expenses } = useExpenses(range)
  const { data: incomes }  = useIncomes(range)
  const { data: forecast } = usePaymentForecast()
  const { data: retentionSummary } = useSiteRetentionSummary()
  const { hasModuleAccess } = useTenant()
  const hasChequeTracking = hasModuleAccess('cheque_tracking')
  const { data: cheques } = useCheques()
  const { data: chequeReminderDaysVal } = useAppSetting('cheque_reminder_days', '3')
  const { data: extra } = useOwnerDashboard(today, true)
  // cheques ไม่มีคอลัมน์ยอดเงินของตัวเอง -- ยอดมาจากรายจ่ายที่ผูกไว้
  // (เช็คใบเดียวจ่ายได้หลายบิล) เหมือน totalsByCheque ใน Cheques.jsx
  const { data: chequeExpenseRows } = useQuery(async () => {
    const { data, error } = await supabase.from('expenses').select('cheque_id, amount').not('cheque_id', 'is', null)
    if (error) throw error
    return data
  })
  const chequeTotalsById = useMemo(() => (chequeExpenseRows || []).reduce((map, r) => {
    map[r.cheque_id] = (map[r.cheque_id] || 0) + (r.amount || 0)
    return map
  }, {}), [chequeExpenseRows])

  const retentionDueSoon = useMemo(() => {
    const in30Days = new Date()
    in30Days.setDate(in30Days.getDate() + 30)
    const in30IsoDate = in30Days.toISOString().slice(0, 10)
    const matching = (retentionSummary || []).filter(r =>
      r.total_retention > 0 &&
      !r.retention_released &&
      r.due_date != null &&
      r.due_date <= in30IsoDate
    )
    return {
      count: matching.length,
      total: matching.reduce((sum, r) => sum + r.total_retention, 0),
    }
  }, [retentionSummary])

  // เตรียมเงินจ่ายเช็ค -- เช็คที่ยังไม่ขึ้นเงิน (issued/received) และครบกำหนด
  // ภายใน N วันข้างหน้า รวมเช็คที่เลยกำหนดไปแล้วแต่ยังไม่ขึ้นเงินด้วย
  const chequesDueSoon = useMemo(() => {
    const reminderDays = parseInt(chequeReminderDaysVal, 10) || 0
    const thresholdDate = new Date()
    thresholdDate.setDate(thresholdDate.getDate() + reminderDays)
    const thresholdIso = thresholdDate.toISOString().slice(0, 10)
    const matching = (cheques || []).filter(c =>
      c.status !== 'cashed' &&
      c.check_date != null &&
      c.check_date <= thresholdIso
    )
    return {
      count: matching.length,
      total: matching.reduce((sum, c) => sum + (chequeTotalsById[c.id] || 0), 0),
    }
  }, [cheques, chequeReminderDaysVal, chequeTotalsById])

  // ── KPI Calculations (unchanged) ──
  const totalIncome  = useMemo(() => (incomes  || []).reduce((s, i) => s + (i.received_amount || 0), 0), [incomes])
  const nonVatIncome = useMemo(() => (incomes  || []).filter(i => !i.vat).reduce((s, i) => s + (i.received_amount || 0), 0), [incomes])
  const totalExpense = useMemo(() => (expenses || []).reduce((s, e) => s + (e.amount || 0), 0), [expenses])
  const profit       = totalIncome - totalExpense

  // ยอดที่ต้องชำระ เดือนนี้ / เดือนหน้า
  const thisMonth = format(new Date(), 'yyyy-MM')
  const nextMonth = format(addMonths(new Date(), 1), 'yyyy-MM')
  const dueThisMonth = useMemo(() =>
    (forecast || []).filter(f => f.forecast_month?.startsWith(thisMonth))
                    .reduce((s, f) => s + (f.total_due || 0), 0)
  , [forecast, thisMonth])
  const dueNextMonth = useMemo(() =>
    (forecast || []).filter(f => f.forecast_month?.startsWith(nextMonth))
                    .reduce((s, f) => s + (f.total_due || 0), 0)
  , [forecast, nextMonth])

  // ── Monthly trend (same data/maths as the old chart; follows the page period) ──
  const monthlyData = useMemo(() => {
    const map = {}
    ;(expenses || []).forEach(e => {
      const m = (e.date || '').slice(0, 7)
      if (!m) return
      map[m] = map[m] || { month: m, expense: 0, income: 0 }
      map[m].expense += e.amount || 0
    })
    ;(incomes || []).forEach(i => {
      const m = (i.date || '').slice(0, 7)
      if (!m) return
      map[m] = map[m] || { month: m, expense: 0, income: 0 }
      map[m].income += i.received_amount || 0
    })
    return Object.values(map).sort((a,b) => a.month.localeCompare(b.month)).map(d => ({
      ...d,
      label: format(parseISO(d.month + '-01'), 'MMM yy', { locale: th })
    }))
  }, [expenses, incomes])

  const isDarkChart = getEffectiveTheme() === 'dark'
  const chartColors = {
    grid: isDarkChart ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)',
    tick: isDarkChart ? '#C9C2B8' : '#5F5A54',
    tooltipBg: isDarkChart ? '#3F3B36' : '#ffffff',
    tooltipBorder: isDarkChart ? '1px solid #4A4640' : '1px solid #E7E2DB',
    income: isDarkChart ? '#8DB596' : '#5E9A6C',
    expense: isDarkChart ? '#E0806A' : '#D0624F',
  }

  // ── New cards ──
  const dueAhead = useMemo(() => dueByMonth(extra?.unpaid, cheques, today, 3), [extra, cheques, today])
  const overdue = useMemo(() => overdueExpenses(extra?.unpaid, today), [extra, today])
  const crew = useMemo(() => (extra ? todayCrewSummary(extra.assignments, extra.checkins) : null), [extra])
  const late = useMemo(() => lateSites(sites, today, 4), [sites, today])
  const qt = useMemo(() => quotationCounts(extra?.quotations), [extra])
  const pendingItems = pendingSummary(pendingCounts, canSeeTab, ['po_draft', 'leave_pending', 'advances_pending', 'repair_pending'])

  // การ์ดที่ "มีสิทธิ์แสดง" (cheque_reminder ต้องมี module) แล้วกรอง/จัดลำดับตาม kpiPrefs
  const availableDefs = CARD_DEFS.filter(d => d.id !== 'cheque_reminder' || hasChequeTracking)
  const registry = {
    income: <Kpi key="income" label="รายรับรวม" value={fmtShort(totalIncome)} sub={`${fmt(totalIncome)} บาท`} cls="green" color="var(--green)" onClick={() => navigateTo('income')} />,
    non_vat_income: <Kpi key="non_vat_income" label="รายรับไม่มี VAT" value={fmtShort(nonVatIncome)} sub={`${fmt(nonVatIncome)} บาท`} cls="green" color="var(--green)" onClick={() => navigateTo('income')} />,
    expense: <Kpi key="expense" label="รายจ่ายรวม" value={fmtShort(totalExpense)} sub={`${fmt(totalExpense)} บาท`} cls="red" color="var(--red)" onClick={() => navigateTo('expenses', range.from ? { dateFrom: range.from, dateTo: range.to } : {})} />,
    profit: <Kpi key="profit" label="กำไรเบื้องต้น" value={fmtShort(profit)} sub={profit >= 0 ? `+${(profit/totalIncome*100).toFixed(1)}%` : 'ขาดทุน'} cls={profit>=0?'green':'red'} color={profit>=0?'var(--green)':'var(--red)'} onClick={() => navigateTo(salesTab)} />,
    due_this_month: <Kpi key="due_this_month" label={`ต้องชำระ ${format(new Date(), 'MMM yy', {locale:th})}`} value={fmtShort(dueThisMonth)} sub="ยอดค้างจ่ายเดือนนี้" cls="yellow" color="var(--yellow)"
      onClick={() => navigateTo('expenses', expensesDue(format(startOfMonth(new Date()), 'yyyy-MM-dd'), format(endOfMonth(new Date()), 'yyyy-MM-dd')))} />,
    due_next_month: <Kpi key="due_next_month" label={`ต้องชำระ ${format(addMonths(new Date(),1), 'MMM yy', {locale:th})}`} value={fmtShort(dueNextMonth)} sub="ยอดค้างจ่ายเดือนหน้า" cls="blue" color="var(--blue)"
      onClick={() => navigateTo('expenses', expensesDue(format(startOfMonth(addMonths(new Date(), 1)), 'yyyy-MM-dd'), format(endOfMonth(addMonths(new Date(), 1)), 'yyyy-MM-dd')))} />,
    retention: (
      <Kpi key="retention" label="Retention ใกล้ครบกำหนด"
           value={String(retentionDueSoon.count)}
           sub={retentionDueSoon.count > 0 ? `${fmt(retentionDueSoon.total)} บาท ภายใน 30 วัน` : 'ไม่มีรายการ'}
           cls="blue" color="var(--blue)"
           onClick={() => navigateTo('retention')} />
    ),
    ...(hasChequeTracking ? {
      cheque_reminder: (
        <Kpi key="cheque_reminder" label="เตรียมเงินจ่ายเช็ค"
             value={fmtShort(chequesDueSoon.total)}
             sub={chequesDueSoon.count > 0
               ? `${chequesDueSoon.count} ใบ ภายใน ${parseInt(chequeReminderDaysVal, 10) || 0} วัน`
               : 'ไม่มีรายการ'}
             cls={chequesDueSoon.count > 0 ? 'red' : 'green'} color={chequesDueSoon.count > 0 ? 'var(--red)' : 'var(--green)'}
             onClick={() => navigateTo('cheques')} />
      ),
    } : {}),
    monthly_chart: (
      <DashCard key="monthly_chart" wide title="รายรับ vs รายจ่าย รายเดือน" onOpen={() => navigateTo(salesTab)}>
        <div style={{ ...muted, marginTop: -6, marginBottom: 6 }}>ตามช่วงเวลาด้านบน</div>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={monthlyData} margin={{ top: 0, right: 6, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} vertical={false} />
            <XAxis dataKey="label" tick={{ fill: chartColors.tick, fontSize: 11 }} />
            <YAxis tickFormatter={fmtShort} tick={{ fill: chartColors.tick, fontSize: 10 }} width={44} />
            <Tooltip formatter={(v) => `${fmt(v)} บาท`} contentStyle={{ background: chartColors.tooltipBg, border: chartColors.tooltipBorder, borderRadius: 8 }} />
            <Bar dataKey="income"  name="รายรับ"  fill={chartColors.income} radius={[3,3,0,0]} />
            <Bar dataKey="expense" name="รายจ่าย" fill={chartColors.expense} radius={[3,3,0,0]} />
          </BarChart>
        </ResponsiveContainer>
        <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 6 }}>
          <span style={{ color: chartColors.income }}>■</span> รายรับ {fmtShort(totalIncome)} · <span style={{ color: chartColors.expense }}>■</span> รายจ่าย {fmtShort(totalExpense)} · ส่วนต่าง {profit >= 0 ? '+' : ''}{fmtShort(profit)}
        </div>
      </DashCard>
    ),
    due_ahead: (
      <DashCard key="due_ahead" title="ต้องชำระ 1–3 เดือนข้างหน้า" onOpen={() => navigateTo('expenses', expensesDue(today, dueAhead[dueAhead.length - 1].to))}>
        {dueAhead.map(m => (
          <ClickRow key={m.month} onClick={() => navigateTo('expenses', expensesDue(m.from, m.to))}>
            <span>{m.label}{m.isCurrent ? ' (เดือนนี้)' : ''}</span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <span style={{ ...num, color: m.amount ? 'var(--yellow)' : 'var(--text3)' }}>{fmt(m.amount)}</span>
              {hasChequeTracking && <span style={muted}>· เช็ค {m.chequeCount} ใบ</span>}
            </span>
          </ClickRow>
        ))}
        <div style={{ ...muted, marginTop: 6 }}>ไม่รวมที่เกินกำหนดแล้ว {fmt(overdue.total)} (แยกการ์ด)</div>
      </DashCard>
    ),
    crew_today: <CrewTodayCard key="crew_today" crew={crew} navigateTo={navigateTo} />,
    sites_today: <SitesTodayCard key="sites_today" crew={crew} navigateTo={navigateTo} />,
    pending: <PendingCard key="pending" items={pendingItems} navigateTo={navigateTo} />,
    overdue_expenses: (
      <DashCard key="overdue_expenses" title="ค่าใช้จ่ายเกินกำหนด" onOpen={() => navigateTo('expenses', expensesDue(EARLIEST, addDaysIso(today, -1)))}>
        <div style={{ ...num, fontSize: 22, color: overdue.count ? 'var(--red)' : 'var(--text3)' }}>{fmt(overdue.total)}</div>
        <div style={muted}>{overdue.count ? `${overdue.count} รายการ` : 'ไม่มีรายการเกินกำหนด'}</div>
      </DashCard>
    ),
    late_sites: <LateSitesCard key="late_sites" late={late} navigateTo={navigateTo} />,
    quotations_month: (
      <DashCard key="quotations_month" title="ใบเสนอราคาเดือนนี้" onOpen={() => navigateTo('quotations')}>
        <div style={{ fontSize: 15 }}>
          ส่ง <strong style={num}>{qt.sent}</strong> · รับ <strong style={{ ...num, color: 'var(--green)' }}>{qt.accepted}</strong> · ร่าง <strong style={num}>{qt.draft}</strong>
        </div>
      </DashCard>
    ),
  }
  const availableIds = availableDefs.map(d => d.id)
  const visible = kpiPrefs.order.filter(id => availableIds.includes(id) && !kpiPrefs.hidden.includes(id))
  const visibleMoney = visible.filter(id => groupOf[id] === 'money')
  const visibleToday = visible.filter(id => groupOf[id] === 'today')

  return (
    <div>
      <GuideProgressCard navigateTo={navigateTo} />
      {/* Period selector + money cards, capped so this region alone can't push the rest out
          of view on a short monitor -- see .page-toolbar-scroll in index.css. */}
      <div className="page-toolbar-scroll">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, flexWrap: 'wrap' }} data-phone="chips">
          <span className="label" style={{ marginBottom: 0 }}>ช่วงเวลา:</span>
          {PERIOD_OPTIONS.map(opt => (
            <button
              key={opt.value}
              className={`btn btn-sm ${period === opt.value ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setPeriod(opt.value)}
            >
              {opt.label}
            </button>
          ))}
          <button className={`btn btn-sm ${period === 'custom' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setPeriod('custom')}>
            กำหนดเอง
          </button>
          {period === 'custom' && (
            <>
              <input type="date" className="input input-sm" style={{ width: 140 }} value={customFrom} onChange={e => setCustomFrom(e.target.value)} />
              <span style={{ color: 'var(--text3)' }}>ถึง</span>
              <input type="date" className="input input-sm" style={{ width: 140 }} value={customTo} onChange={e => setCustomTo(e.target.value)} />
            </>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowKpiCustomize(true)}>⚙️ ปรับแต่งการ์ด</button>
        </div>
        {visibleMoney.length > 0 && (
          <div className={`kpi-grid kpi-grid-${visibleMoney.length}`} style={{ marginBottom: 20 }}>
            {visibleMoney.map(id => registry[id])}
          </div>
        )}
      </div>

      {visibleToday.length > 0 && <div style={CARD_GRID}>{visibleToday.map(id => registry[id])}</div>}

      {!visible.length && (
        <div className="card card-body" style={{ marginBottom: 20, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
          ซ่อนการ์ดทั้งหมดไว้ — กด "ปรับแต่งการ์ด" เพื่อแสดงกลับมา
        </div>
      )}

      {showKpiCustomize && (
        <KpiCustomizeModal
          availableDefs={availableDefs}
          prefs={kpiPrefs}
          onSave={handleSaveKpiPrefs}
          onClose={() => setShowKpiCustomize(false)}
        />
      )}
    </div>
  )
}
