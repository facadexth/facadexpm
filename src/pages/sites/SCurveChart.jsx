// ============================================================
// SCurveChart — แผน vs เบิกจริง vs ต้นทุน สะสม ต่อไซท์เดียว
// ============================================================
import { useMemo } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine, ResponsiveContainer } from 'recharts'
import { useSitePhases, useIncomes, useExpenses } from '../../hooks/useSupabase.js'
import { buildPlanSeries, buildActualSeries, buildCostSeries, mergeCumulativeSeries } from './scurveCalc.js'
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

  const chartData = useMemo(() => {
    const phasesForSite = (allPhases || []).filter((p) => p.site_id === site.id)
    const plan = buildPlanSeries(phasesForSite, site.contract_value)
    const actual = buildActualSeries(incomes || [])
    const cost = buildCostSeries(expenses || [])
    return mergeCumulativeSeries({ plan, actual, cost }, TODAY_ISO)
  }, [allPhases, incomes, expenses, site.id, site.contract_value])

  if (!chartData.length) {
    return (
      <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>
        ยังไม่มีข้อมูลพอสำหรับกราฟ S-curve ของ {site.name} (ต้องมีวันที่ขั้นตอนงาน หรือรายรับ/รายจ่ายอย่างน้อย 1 รายการ)
      </div>
    )
  }

  // ReferenceLine only makes sense if today actually falls within the
  // chart's own date axis -- otherwise it'd clamp to an edge and imply
  // "today = project start/end", which is wrong for a finished or
  // not-yet-started site's chart.
  const todayInRange = chartData[0].date <= TODAY_ISO && TODAY_ISO <= chartData[chartData.length - 1].date

  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 12 }}>S-curve: {site.name}</div>
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke={chartColors.border} />
          <XAxis dataKey="date" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => fmt(v)} />
          <Tooltip formatter={(v) => fmt(v)} />
          <Legend />
          {todayInRange && (
            <ReferenceLine x={TODAY_ISO} stroke={chartColors.text3} strokeDasharray="3 4"
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
