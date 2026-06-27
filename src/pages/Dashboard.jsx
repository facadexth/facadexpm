// ============================================================
// Dashboard — ภาพรวม
// ✅ เลือกช่วงเวลาได้
// ✅ ยอดที่ต้องชำระ เดือนนี้/เดือนหน้า
// ✅ Monthly chart รายรับ vs รายจ่าย
// ✅ ตาราง Ongoing sites พร้อม sort ทุกคอลัมน์
// ✅ Export/Import ถูกซ่อน → มูลค่าสัญญาอยู่ในหน้าไซท์งานแทน
// ============================================================
import { useState, useMemo } from 'react'
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { useSites, useExpenses, useIncomes, usePaymentForecast } from '../hooks/useSupabase.js'
import { fmt, fmtShort, fmtDate } from '../lib/supabase.js'
import { startOfYear, endOfYear, startOfMonth, endOfMonth, addMonths, format, parseISO } from 'date-fns'
import { th } from 'date-fns/locale'

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

function Kpi({ label, value, sub, color = 'var(--accent)', cls = '' }) {
  return (
    <div className={`kpi-card ${cls}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value" style={{ color }}>{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  )
}

export default function Dashboard({ navigateTo }) {
  const [period, setPeriod] = useState('ytd')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo,   setCustomTo]   = useState('')
  const [sortCol,    setSortCol]    = useState('total_expense')
  const [sortDir,    setSortDir]    = useState('desc')

  // Date range
  const range = useMemo(() => {
    if (period === 'custom') return { from: customFrom, to: customTo }
    return getPeriodRange(period)
  }, [period, customFrom, customTo])

  const { data: sites }    = useSites()
  const { data: expenses } = useExpenses(range)
  const { data: incomes }  = useIncomes(range)
  const { data: forecast } = usePaymentForecast()

  // ── KPI Calculations ──
  const totalIncome  = useMemo(() => (incomes  || []).reduce((s, i) => s + (i.received_amount || 0), 0), [incomes])
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
      <div className="kpi-grid kpi-grid-5" style={{ marginBottom: 20 }}>
        <Kpi label="รายรับรวม"       value={fmtShort(totalIncome)}  sub={`${fmt(totalIncome)} บาท`}   cls="green" color="var(--green)" />
        <Kpi label="รายจ่ายรวม"      value={fmtShort(totalExpense)} sub={`${fmt(totalExpense)} บาท`}  cls="red"   color="var(--red)" />
        <Kpi label="กำไรเบื้องต้น"   value={fmtShort(profit)}       sub={profit >= 0 ? `+${(profit/totalIncome*100).toFixed(1)}%` : 'ขาดทุน'} cls={profit>=0?'green':'red'} color={profit>=0?'var(--green)':'var(--red)'} />
        <Kpi label={`ต้องชำระ ${format(new Date(), 'MMM yy', {locale:th})}`}
             value={fmtShort(dueThisMonth)} sub="ยอดค้างจ่ายเดือนนี้" cls="yellow" color="var(--yellow)" />
        <Kpi label={`ต้องชำระ ${format(addMonths(new Date(),1), 'MMM yy', {locale:th})}`}
             value={fmtShort(dueNextMonth)} sub="ยอดค้างจ่ายเดือนหน้า" cls="blue" color="var(--blue)" />
      </div>

      {/* ── Charts ── */}
      <div className="chart-grid-2-1" style={{ marginBottom: 20 }}>
        <div className="card card-body">
          <div className="card-title" style={{ marginBottom: 16 }}>รายรับ vs รายจ่าย รายเดือน</div>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={monthlyData} margin={{ top: 0, right: 10, bottom: 0, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="label" tick={{ fill: '#9e9ec8', fontSize: 11 }} />
              <YAxis tickFormatter={fmtShort} tick={{ fill: '#9e9ec8', fontSize: 10 }} />
              <Tooltip formatter={(v) => `${fmt(v)} บาท`} contentStyle={{ background: '#252840', border: '1px solid rgba(108,99,255,0.3)', borderRadius: 8 }} />
              <Legend wrapperStyle={{ fontSize: 12, color: '#9e9ec8' }} />
              <Bar dataKey="income"  name="รายรับ"  fill="#00d4aa" radius={[3,3,0,0]} />
              <Bar dataKey="expense" name="รายจ่าย" fill="#ff6b6b" radius={[3,3,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* ยอดต้องชำระรายเดือน */}
        <div className="card card-body">
          <div className="card-title" style={{ marginBottom: 16 }}>ยอดที่ต้องชำระ (รายเดือน)</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {(forecast || []).slice(0, 6).map((f, i) => {
              const month = f.forecast_month ? format(parseISO(f.forecast_month), 'MMM yy', { locale: th }) : '—'
              return (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: 'var(--text2)', fontSize: 12 }}>{month}</span>
                  <span style={{ color: 'var(--yellow)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                    {fmt(f.total_due)} บาท
                  </span>
                </div>
              )
            })}
            {!forecast?.length && <div style={{ color: 'var(--text3)', fontSize: 12 }}>ไม่มียอดค้างจ่าย</div>}
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
                    <td><strong style={{ fontSize: 12 }}>{s.name}</strong></td>
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
    </div>
  )
}
