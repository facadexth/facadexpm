// ============================================================
// Dashboard — ภาพรวม
// ✅ เลือกช่วงเวลาได้
// ✅ ยอดที่ต้องชำระ เดือนนี้/เดือนหน้า
// ✅ Monthly chart รายรับ vs รายจ่าย
// ✅ ตาราง Ongoing sites พร้อม sort ทุกคอลัมน์
// ✅ Export/Import ถูกซ่อน → มูลค่าสัญญาอยู่ในหน้าไซท์งานแทน
// ============================================================
import { useState, useEffect, useMemo } from 'react'
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { useSites, useExpenses, useIncomes, usePaymentForecast, useSitesProgress, useSiteRetentionSummary, useCheques, useAppSetting, useQuery } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { useTenant } from '../hooks/useTenant.js'
import { supabase, fmt, fmtShort, fmtDate } from '../lib/supabase.js'
import { Modal } from '../components/Modal.jsx'
import { startOfYear, endOfYear, startOfMonth, endOfMonth, addMonths, format, parseISO } from 'date-fns'
import { th } from 'date-fns/locale'
import { getEffectiveTheme } from '../lib/theme.js'

// การ์ด KPI ทั้งหมดที่ผู้ใช้เลือกซ่อน/แสดง/จัดลำดับเองได้ (ต่อผู้ใช้แต่ละคน
// ไม่ใช่ต่อ tenant -- เก็บใน localStorage คีย์ตามอีเมล เหมือน useDraftForm/
// permissions ที่มีอยู่แล้วในแอปนี้ ไม่ต้องมี schema/RLS ใหม่)
const KPI_DEFS = [
  { id: 'income', label: 'รายรับรวม' },
  { id: 'non_vat_income', label: 'รายรับไม่มี VAT' },
  { id: 'expense', label: 'รายจ่ายรวม' },
  { id: 'profit', label: 'กำไรเบื้องต้น' },
  { id: 'due_this_month', label: 'ต้องชำระเดือนนี้' },
  { id: 'due_next_month', label: 'ต้องชำระเดือนหน้า' },
  { id: 'retention', label: 'Retention ใกล้ครบกำหนด' },
  { id: 'cheque_reminder', label: 'เตรียมเงินจ่ายเช็ค' },
]
const DEFAULT_KPI_ORDER = KPI_DEFS.map(d => d.id)

function kpiPrefsKey(email) { return `dashboard-kpi-prefs:${email}` }

function loadKpiPrefs(email) {
  try {
    const raw = localStorage.getItem(kpiPrefsKey(email))
    if (!raw) return { order: DEFAULT_KPI_ORDER, hidden: [] }
    const parsed = JSON.parse(raw)
    const savedOrder = Array.isArray(parsed.order) ? parsed.order : DEFAULT_KPI_ORDER
    // การ์ดใหม่ที่เพิ่มเข้ามาทีหลัง (เช่น cheque_reminder) จะไม่อยู่ใน order
    // ที่เคยบันทึกไว้ -- ต่อท้ายให้อัตโนมัติ ไม่งั้นจะหายไปเงียบๆ สำหรับคนที่
    // เคยปรับแต่งไว้ก่อนหน้านี้
    const missing = DEFAULT_KPI_ORDER.filter(id => !savedOrder.includes(id))
    return { order: [...savedOrder, ...missing], hidden: Array.isArray(parsed.hidden) ? parsed.hidden : [] }
  } catch {
    return { order: DEFAULT_KPI_ORDER, hidden: [] }
  }
}

function saveKpiPrefs(email, prefs) {
  localStorage.setItem(kpiPrefsKey(email), JSON.stringify(prefs))
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

// จัดลำดับด้วยปุ่มขึ้น/ลง แทน drag-and-drop -- ไม่ต้องเพิ่ม library ใหม่ ใช้ได้ทั้ง
// เมาส์/นิ้วแน่นอน ไม่ต้องกังวลเรื่อง touch drag บนแท็บเล็ต/มือถือ
function KpiCustomizeModal({ availableDefs, prefs, onSave, onClose }) {
  const [order, setOrder] = useState(prefs.order.filter(id => availableDefs.some(d => d.id === id)))
  const [hidden, setHidden] = useState(new Set(prefs.hidden))

  const move = (id, dir) => {
    setOrder(o => {
      const i = o.indexOf(id)
      const j = i + dir
      if (j < 0 || j >= o.length) return o
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
    <Modal title="ปรับแต่งการ์ด" onClose={onClose} maxWidth={420}>
      <div className="modal-body" style={{ display: 'grid', gap: 6 }}>
        <p style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 4 }}>
          ติ๊กเพื่อซ่อน/แสดง และใช้ลูกศรจัดลำดับการ์ด — บันทึกไว้เฉพาะบัญชีนี้
        </p>
        {order.map((id, i) => (
          <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, background: 'var(--bg2)' }}>
            <input type="checkbox" checked={!hidden.has(id)} onChange={() => toggle(id)} />
            <span style={{ flex: 1, fontSize: 13, color: hidden.has(id) ? 'var(--text3)' : 'var(--text1)' }}>{labelById[id]}</span>
            <button type="button" className="btn btn-ghost btn-sm" disabled={i === 0} onClick={() => move(id, -1)}>↑</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={i === order.length - 1} onClick={() => move(id, 1)}>↓</button>
          </div>
        ))}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onClose}>ยกเลิก</button>
        <button type="button" className="btn btn-primary" onClick={() => onSave({ order, hidden: [...hidden] })}>✅ บันทึก</button>
      </div>
    </Modal>
  )
}

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

export default function Dashboard({ navigateTo, openSiteOverview }) {
  const { isAtLeast, user } = useUserRole()
  const canSeeFinancials = isAtLeast('ADMIN')
  const [period, setPeriod] = useState('ytd')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo,   setCustomTo]   = useState('')
  const [sortCol,    setSortCol]    = useState('total_expense')
  const [sortDir,    setSortDir]    = useState('desc')

  // การ์ด KPI ที่แสดง/ซ่อน/จัดลำดับเอง -- ต่อผู้ใช้ (localStorage คีย์ตามอีเมล)
  const [kpiPrefs, setKpiPrefs] = useState({ order: DEFAULT_KPI_ORDER, hidden: [] })
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

  const { data: sites }    = useSites()
  const { data: expenses } = useExpenses(range)
  const { data: incomes }  = useIncomes(range)
  const { data: forecast } = usePaymentForecast()
  const { data: retentionSummary } = useSiteRetentionSummary()
  const { hasModuleAccess } = useTenant()
  const hasChequeTracking = hasModuleAccess('cheque_tracking')
  const { data: cheques } = useCheques()
  const { data: chequeReminderDaysVal } = useAppSetting('cheque_reminder_days', '3')
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
    const todayIso = new Date().toISOString().slice(0, 10)
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
  // ภายใน N วันข้างหน้า (N ตั้งค่าได้ที่หน้าตั้งค่า) รวมเช็คที่เลยกำหนดไปแล้ว
  // แต่ยังไม่ขึ้นเงินด้วย (check_date <= เกณฑ์ ไม่ใช่ระหว่างวันนี้ถึงเกณฑ์) --
  // อันนั้นยิ่งเร่งด่วนกว่าอีก ไม่ใช่กรณีที่ควรตกหล่นไปจากการ์ดนี้
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

  // ── KPI Calculations ──
  const totalIncome  = useMemo(() => (incomes  || []).reduce((s, i) => s + (i.received_amount || 0), 0), [incomes])
  const nonVatIncome = useMemo(() => (incomes  || []).filter(i => !i.vat).reduce((s, i) => s + (i.received_amount || 0), 0), [incomes])
  const totalExpense = useMemo(() => (expenses || []).reduce((s, e) => s + (e.amount || 0), 0), [expenses])
  const profit       = totalIncome - totalExpense
  const ongoingCount = (sites || []).filter(s => s.status === 'Ongoing').length

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
  // payment_forecast (the view) is grouped by (month, payment_method,
  // status), so the same month can appear as several rows -- collapse to
  // one total per month before showing the "ยอดที่ต้องชำระ (รายเดือน)" list.
  const monthlyForecast = useMemo(() => {
    const map = {}
    ;(forecast || []).forEach(f => {
      if (!f.forecast_month) return
      map[f.forecast_month] = (map[f.forecast_month] || 0) + (f.total_due || 0)
    })
    return Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([forecast_month, total_due]) => ({ forecast_month, total_due }))
  }, [forecast])

  // ── Monthly trend ──
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
    tick: isDarkChart ? '#9e9ec8' : '#565a7a',
    tooltipBg: isDarkChart ? '#252840' : '#ffffff',
    tooltipBorder: isDarkChart ? '1px solid rgba(108,99,255,0.3)' : '1px solid rgba(108,99,255,0.25)',
  }

  // ── Ongoing sites table ──
  const ongoingSites = useMemo(() => {
    const rows = (sites || []).filter(s => s.status === 'Ongoing')
    return [...rows].sort((a, b) => {
      const va = a[sortCol] ?? 0
      const vb = b[sortCol] ?? 0
      if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va)
      return sortDir === 'asc' ? va - vb : vb - va
    })
  }, [sites, sortCol, sortDir])

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('desc') }
  }

  const sortIcon = (col) => sortCol === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕'

  if (!canSeeFinancials) {
    return <WorkerSiteProgress />
  }

  // เตรียมการ์ดทั้งหมดที่ "มีสิทธิ์แสดง" ไว้ก่อน (cheque_reminder ต้องมี module
  // เท่านั้น) แล้วค่อยกรอง/จัดลำดับตาม kpiPrefs ของผู้ใช้คนนี้ทับอีกที
  const availableKpiDefs = KPI_DEFS.filter(d => d.id !== 'cheque_reminder' || hasChequeTracking)
  const kpiRegistry = {
    income: <Kpi key="income" label="รายรับรวม" value={fmtShort(totalIncome)} sub={`${fmt(totalIncome)} บาท`} cls="green" color="var(--green)" />,
    non_vat_income: <Kpi key="non_vat_income" label="รายรับไม่มี VAT" value={fmtShort(nonVatIncome)} sub={`${fmt(nonVatIncome)} บาท`} cls="green" color="var(--green)" />,
    expense: <Kpi key="expense" label="รายจ่ายรวม" value={fmtShort(totalExpense)} sub={`${fmt(totalExpense)} บาท`} cls="red" color="var(--red)" />,
    profit: <Kpi key="profit" label="กำไรเบื้องต้น" value={fmtShort(profit)} sub={profit >= 0 ? `+${(profit/totalIncome*100).toFixed(1)}%` : 'ขาดทุน'} cls={profit>=0?'green':'red'} color={profit>=0?'var(--green)':'var(--red)'} />,
    due_this_month: <Kpi key="due_this_month" label={`ต้องชำระ ${format(new Date(), 'MMM yy', {locale:th})}`} value={fmtShort(dueThisMonth)} sub="ยอดค้างจ่ายเดือนนี้" cls="yellow" color="var(--yellow)" />,
    due_next_month: <Kpi key="due_next_month" label={`ต้องชำระ ${format(addMonths(new Date(),1), 'MMM yy', {locale:th})}`} value={fmtShort(dueNextMonth)} sub="ยอดค้างจ่ายเดือนหน้า" cls="blue" color="var(--blue)" />,
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
  }
  const availableKpiIds = availableKpiDefs.map(d => d.id)
  const visibleKpiIds = kpiPrefs.order.filter(id => availableKpiIds.includes(id) && !kpiPrefs.hidden.includes(id))

  return (
    <div>
      {/* ── Period Selector ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
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

      {/* ── KPI Cards ── */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => setShowKpiCustomize(true)}>⚙️ ปรับแต่งการ์ด</button>
      </div>
      {visibleKpiIds.length > 0 ? (
        <div className={`kpi-grid kpi-grid-${visibleKpiIds.length}`} style={{ marginBottom: 20 }}>
          {visibleKpiIds.map(id => kpiRegistry[id])}
        </div>
      ) : (
        <div className="card card-body" style={{ marginBottom: 20, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
          ซ่อนการ์ดทั้งหมดไว้ — กด "ปรับแต่งการ์ด" เพื่อแสดงกลับมา
        </div>
      )}

      {/* ── Charts ── */}
      <div className="chart-grid-2-1" style={{ marginBottom: 20 }}>
        <div className="card card-body">
          <div className="card-title" style={{ marginBottom: 16 }}>รายรับ vs รายจ่าย รายเดือน</div>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={monthlyData} margin={{ top: 0, right: 10, bottom: 0, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
              <XAxis dataKey="label" tick={{ fill: chartColors.tick, fontSize: 11 }} />
              <YAxis tickFormatter={fmtShort} tick={{ fill: chartColors.tick, fontSize: 10 }} />
              <Tooltip formatter={(v) => `${fmt(v)} บาท`} contentStyle={{ background: chartColors.tooltipBg, border: chartColors.tooltipBorder, borderRadius: 8 }} />
              <Legend wrapperStyle={{ fontSize: 12, color: chartColors.tick }} />
              <Bar dataKey="income"  name="รายรับ"  fill="#00d4aa" radius={[3,3,0,0]} />
              <Bar dataKey="expense" name="รายจ่าย" fill="#ff6b6b" radius={[3,3,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* ยอดต้องชำระรายเดือน */}
        <div className="card card-body">
          <div className="card-title" style={{ marginBottom: 16 }}>ยอดที่ต้องชำระ (รายเดือน)</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {monthlyForecast.slice(0, 6).map((f) => {
              const monthDate = f.forecast_month ? parseISO(f.forecast_month) : null
              const month = monthDate ? format(monthDate, 'MMM yy', { locale: th }) : '—'
              return (
                <div key={f.forecast_month}
                  onClick={() => monthDate && navigateTo('expenses', {
                    dateField: 'due',
                    dateFrom: format(startOfMonth(monthDate), 'yyyy-MM-dd'),
                    dateTo: format(endOfMonth(monthDate), 'yyyy-MM-dd'),
                    status: 'unpaid',
                  })}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: monthDate ? 'pointer' : 'default' }}
                >
                  <span style={{ color: 'var(--text2)', fontSize: 12 }}>{month}</span>
                  <span style={{ color: 'var(--yellow)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                    {fmt(f.total_due)} บาท
                  </span>
                </div>
              )
            })}
            {!monthlyForecast.length && <div style={{ color: 'var(--text3)', fontSize: 12 }}>ไม่มียอดค้างจ่าย</div>}
          </div>
        </div>
      </div>

      {/* ── Ongoing Sites Table ── */}
      <div style={{ color: 'var(--text3)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>
        ไซท์งาน Ongoing ({ongoingCount} ไซท์) — กดหัวตารางเพื่อเรียง | กดตัวเลขเพื่อดูรายละเอียด
      </div>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="sortable" onClick={() => toggleSort('site_number')}>รหัส{sortIcon('site_number')}</th>
                <th className="sortable" onClick={() => toggleSort('name')}>ชื่อไซท์งาน{sortIcon('name')}</th>
                <th className="sortable" onClick={() => toggleSort('contract_value')}>มูลค่าสัญญา{sortIcon('contract_value')}</th>
                <th className="sortable" onClick={() => toggleSort('total_income')}>รายรับ (เบิก){sortIcon('total_income')}</th>
                <th className="sortable" onClick={() => toggleSort('total_expense')}>รายจ่าย (ต้นทุน){sortIcon('total_expense')}</th>
                <th className="sortable" onClick={() => toggleSort('gross_profit')}>กำไร{sortIcon('gross_profit')}</th>
                <th className="sortable" onClick={() => toggleSort('billing_pct')}>% เบิก{sortIcon('billing_pct')}</th>
                <th className="sortable" onClick={() => toggleSort('outstanding_expense')}>ค้างจ่าย{sortIcon('outstanding_expense')}</th>
                <th className="sortable" onClick={() => toggleSort('end_date')}>วันจบงาน{sortIcon('end_date')}</th>
              </tr>
            </thead>
            <tbody>
              {ongoingSites.map(s => {
                const daysLeft = s.end_date ? Math.ceil((new Date(s.end_date) - new Date()) / 86400000) : null
                const pct = s.billing_pct
                return (
                  <tr key={s.id}>
                    <td style={{ color: 'var(--accent)', fontSize: 11 }}>{s.site_number}</td>
                    <td style={{ cursor: 'pointer' }} onClick={() => openSiteOverview(s.id)}><strong style={{ fontSize: 12 }}>{s.name}</strong></td>
                    <td className="font-mono" style={{ color: 'var(--text2)' }}>
                      {s.contract_value > 0 ? fmt(s.contract_value) : <span style={{ color: 'var(--text3)' }}>—</span>}
                    </td>
                    <td
                      className="font-mono text-green"
                      style={{ cursor: 'pointer', textDecoration: 'underline dotted' }}
                      onClick={() => navigateTo('income', { siteId: s.id, siteName: s.name })}
                      title="คลิกดูรายรับของไซท์นี้"
                    >
                      {s.total_income > 0 ? fmt(s.total_income) : '—'}
                    </td>
                    <td
                      className="font-mono"
                      style={{ color: 'var(--red)', cursor: 'pointer', textDecoration: 'underline dotted' }}
                      onClick={() => navigateTo('expenses', { siteId: s.id, siteName: s.name })}
                      title="คลิกดูรายจ่ายของไซท์นี้"
                    >
                      {s.total_expense > 0 ? fmt(s.total_expense) : '—'}
                    </td>
                    <td className="font-mono" style={{ color: (s.gross_profit || 0) >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>
                      {s.total_income > 0 ? fmt(s.gross_profit) : '—'}
                    </td>
                    <td style={{ minWidth: 110 }}>
                      {pct != null ? (
                        <>
                          <div className="progress" style={{ marginBottom: 3 }}>
                            <div className={`progress-bar ${pct > 100 ? 'over' : ''}`} style={{ width: `${Math.min(100, pct)}%` }} />
                          </div>
                          <span style={{ fontSize: 10, color: pct > 100 ? 'var(--red)' : 'var(--text2)' }}>{pct.toFixed(1)}%</span>
                        </>
                      ) : <span style={{ color: 'var(--text3)', fontSize: 11 }}>ใส่มูลค่าสัญญา</span>}
                    </td>
                    <td className="font-mono" style={{ color: (s.outstanding_expense || 0) > 0 ? 'var(--yellow)' : 'var(--text3)' }}>
                      {(s.outstanding_expense || 0) > 0 ? fmt(s.outstanding_expense) : '—'}
                    </td>
                    <td>
                      {s.end_date ? (
                        <div>
                          <div style={{ fontSize: 11, color: 'var(--text2)' }}>{fmtDate(s.end_date)}</div>
                          {daysLeft !== null && (
                            <div className={`countdown ${daysLeft < 0 ? 'overdue' : daysLeft < 14 ? 'warning' : 'ok'}`}>
                              {daysLeft < 0 ? `เกิน ${Math.abs(daysLeft)} วัน` : `เหลือ ${daysLeft} วัน`}
                            </div>
                          )}
                        </div>
                      ) : <span style={{ color: 'var(--text3)' }}>—</span>}
                    </td>
                  </tr>
                )
              })}
              {!ongoingSites.length && (
                <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ไม่มีข้อมูลไซท์งาน Ongoing</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showKpiCustomize && (
        <KpiCustomizeModal
          availableDefs={availableKpiDefs}
          prefs={kpiPrefs}
          onSave={handleSaveKpiPrefs}
          onClose={() => setShowKpiCustomize(false)}
        />
      )}
    </div>
  )
}
