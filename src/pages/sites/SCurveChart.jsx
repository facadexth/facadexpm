// ============================================================
// SCurveChart — แผน vs เบิกจริง vs ต้นทุน สะสม ต่อไซท์เดียว
// ============================================================
import { useMemo } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { useSitePhases, useIncomes, useExpenses } from '../../hooks/useSupabase.js'
import { buildPlanSeries, buildActualSeries, buildCostSeries, mergeCumulativeSeries } from './scurveCalc.js'
import { fmt } from '../../lib/supabase.js'

export default function SCurveChart({ site }) {
  const { data: allPhases } = useSitePhases()
  const { data: incomes } = useIncomes({ siteId: site.id })
  const { data: expenses } = useExpenses({ siteId: site.id })

  const chartData = useMemo(() => {
    const phasesForSite = (allPhases || []).filter((p) => p.site_id === site.id)
    const plan = buildPlanSeries(phasesForSite, site.contract_value)
    const actual = buildActualSeries(incomes || [])
    const cost = buildCostSeries(expenses || [])
    return mergeCumulativeSeries({ plan, actual, cost })
  }, [allPhases, incomes, expenses, site.id, site.contract_value])

  if (!chartData.length) {
    return (
      <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>
        ยังไม่มีข้อมูลพอสำหรับกราฟ S-curve ของ {site.name} (ต้องมีวันที่ขั้นตอนงาน หรือรายรับ/รายจ่ายอย่างน้อย 1 รายการ)
      </div>
    )
  }

  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 12 }}>S-curve: {site.name}</div>
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="date" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => fmt(v)} />
          <Tooltip formatter={(v) => fmt(v)} />
          <Legend />
          <Line type="monotone" dataKey="plan" name="แผนเบิกเงิน" stroke="var(--accent)" dot={false} />
          <Line type="monotone" dataKey="actual" name="เบิกจริง" stroke="var(--green)" dot={false} />
          <Line type="monotone" dataKey="cost" name="ต้นทุนเรา" stroke="var(--red)" dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
