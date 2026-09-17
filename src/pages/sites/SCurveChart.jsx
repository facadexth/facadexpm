// ============================================================
// SCurveChart — แผน vs เบิกจริง vs ต้นทุน สะสม ต่อไซท์เดียว
// แกนเวลาใช้ range/เดือนเดียวกับ GanttView เป๊ะๆ (ผ่าน computeTimelineRange/
// computeMonthTicks จาก ganttTimeline.js) เพื่อให้ 2 กราฟอ่านคู่กันได้ตรงกัน
// ============================================================
import { useMemo } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine, ResponsiveContainer } from 'recharts'
import { format } from 'date-fns'
import { th } from 'date-fns/locale'
import { useSitePhases, useIncomes, useExpenses } from '../../hooks/useSupabase.js'
import { buildPlanSeries, buildActualSeries, buildCostSeries, mergeCumulativeSeries } from './scurveCalc.js'
import { computeTimelineRange, computeMonthTicks } from './ganttTimeline.js'
import { fmt } from '../../lib/supabase.js'
import { getEffectiveTheme } from '../../lib/theme.js'

const TODAY_ISO = new Date().toISOString().slice(0, 10)

export default function SCurveChart({ site }) {
  const { data: allPhases } = useSitePhases()
  const { data: incomes } = useIncomes({ siteId: site.id })
  const { data: expenses } = useExpenses({ siteId: site.id })

  // SVG presentation attributes (stroke=...) don't resolve CSS var() --
  // only real CSS property values do -- so derive literal hex colors here
  // instead, following Dashboard.jsx's chartColors pattern.
  const isDarkChart = getEffectiveTheme() === 'dark'
  const chartColors = {
    accent: isDarkChart ? '#6c63ff' : '#3e5c46',
    green: '#00d4aa',
    red: '#ff6b6b',
    border: isDarkChart ? 'rgba(108,99,255,0.2)' : 'rgba(62,92,70,0.18)',
    text3: isDarkChart ? '#5c5f80' : '#928c7a',
  }

  const phasesForSite = useMemo(() => (allPhases || []).filter((p) => p.site_id === site.id), [allPhases, site.id])

  // Same function GanttView uses for its own timeline -- same site, same
  // phases, so this always produces the identical range GanttView shows.
  const range = useMemo(() => computeTimelineRange([site], { [site.id]: phasesForSite }), [site, phasesForSite])

  const chartData = useMemo(() => {
    const plan = buildPlanSeries(phasesForSite, site.contract_value)
    const actual = buildActualSeries(incomes || [])
    const cost = buildCostSeries(expenses || [])
    return mergeCumulativeSeries({ plan, actual, cost }, TODAY_ISO).map((row) => ({ ...row, ts: new Date(row.date).getTime() }))
  }, [phasesForSite, incomes, expenses, site.contract_value])

  if (!chartData.length) {
    return (
      <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>
        ยังไม่มีข้อมูลพอสำหรับกราฟ S-curve ของ {site.name} (ต้องมีวันที่ขั้นตอนงาน หรือรายรับ/รายจ่ายอย่างน้อย 1 รายการ)
      </div>
    )
  }

  // Domain: same range as the Gantt when it has one (dated phases); fall
  // back to the chart's own data span otherwise (e.g. a site with only
  // income/expense rows and no dated phases yet -- Gantt would show its
  // own "no dates" empty state in that case, so there's nothing to match).
  const domainStart = range ? range.start.getTime() : chartData[0].ts
  const domainEnd = range ? range.end.getTime() : chartData[chartData.length - 1].ts
  const monthTicks = range ? computeMonthTicks(range).map((t) => t.date.getTime()) : undefined
  const monthLabel = (ts) => format(new Date(ts), 'MMM yy', { locale: th })

  const todayTs = new Date(TODAY_ISO).getTime()
  const todayInRange = domainStart <= todayTs && todayTs <= domainEnd

  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 12 }}>S-curve: {site.name}</div>
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={chartData} margin={{ left: 114, right: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={chartColors.border} />
          <XAxis dataKey="ts" type="number" scale="time" domain={[domainStart, domainEnd]}
            ticks={monthTicks} tickFormatter={monthLabel} tick={{ fontSize: 11 }} />
          {/* width fixed (not auto) so the plot area's left edge is
              predictable -- paired with the chart's own margin.left above
              to land the plot area at the same 178px offset (170px phase
              label column + 8px gap) GanttView's track starts at, so the
              two charts' timelines line up when stacked. */}
          <YAxis width={64} tick={{ fontSize: 11 }} tickFormatter={(v) => fmt(v)} />
          <Tooltip formatter={(v) => fmt(v)} labelFormatter={(ts) => format(new Date(ts), 'd MMM yyyy', { locale: th })} />
          <Legend />
          {todayInRange && (
            <ReferenceLine x={todayTs} stroke={chartColors.text3} strokeDasharray="3 4"
              label={{ value: 'วันนี้', position: 'top', fontSize: 10, fill: chartColors.text3 }} />
          )}
          <Line type="monotone" dataKey="plan" name="แผนเบิกเงิน" stroke={chartColors.accent} dot={false} />
          <Line type="monotone" dataKey="actual" name="เบิกจริง" stroke={chartColors.green} dot={false} connectNulls={false} />
          <Line type="monotone" dataKey="cost" name="ต้นทุนเรา" stroke={chartColors.red} dot={false} connectNulls={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
