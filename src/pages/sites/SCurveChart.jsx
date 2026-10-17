// ============================================================
// SCurveChart — แผน vs เบิกจริง vs ต้นทุน สะสม ต่อไซท์เดียว
// แกนเวลาใช้ range/เดือนเดียวกับ GanttView เป๊ะๆ (ผ่าน computeTimelineRange/
// computeMonthTicks จาก ganttTimeline.js) เพื่อให้ 2 กราฟอ่านคู่กันได้ตรงกัน
// สองโหมด: "เงิน" (เดิม: แผนเบิกเงิน/เบิกจริง/ต้นทุน, เฉพาะ canSeeMoney) กับ
// "งานจริง %" (PLAN ล่าสุดเป็น % เทียบ % ตามสัญญารายวัน + วันนี้สด; ต้องมี
// schema ของ migration 07) -- PM เห็นเฉพาะงานจริง %
// ============================================================
import { useMemo, useState } from 'react'
import { millionBahtTick } from '../../lib/millionBahtTick.js'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine, ResponsiveContainer } from 'recharts'
import { format } from 'date-fns'
import { th } from 'date-fns/locale'
import { useSitePhases, useSubtasks, usePhaseTasks, useIncomes, useExpenses, useSitePlans, useSiteProgressDaily } from '../../hooks/useSupabase.js'
import { buildPlanSeries, buildActualSeries, buildCostSeries, mergeCumulativeSeries } from './scurveCalc.js'
import { planPctSeries, workSeries } from './planLayer.js'
import { siteProgress } from './progressCalc.js'
import { useUserRole } from '../../hooks/useUserRole.js'
import { canSeeMoney } from '../../lib/roles.js'
import { useProgressSchemaReady } from '../../lib/progressSchema.js'
import { flattenLeaves, groupSubtasksByParent } from './subtaskCalc.js'
import { computeTimelineRange, computeFocusRange, computeAxisTicks, expandRangeForTransactions } from './ganttTimeline.js'
import { fmt } from '../../lib/supabase.js'
import { getEffectiveTheme } from '../../lib/theme.js'

const TODAY_ISO = new Date().toISOString().slice(0, 10)
// money hooks for a role that cannot see money: filter on a UUID no site has -> 0 rows
const NIL_SITE_ID = '00000000-0000-0000-0000-000000000000'

export default function SCurveChart({ site, compact = false }) {
  const { role } = useUserRole()
  const progressReady = useProgressSchemaReady()
  const money = canSeeMoney(role)
  // money roles keep เงิน by default and may switch; everyone else gets งานจริง % only
  const [modeChoice, setModeChoice] = useState('money')
  const mode = !money ? 'work' : progressReady && modeChoice === 'work' ? 'work' : 'money'

  const { data: allPhases } = useSitePhases()
  const { data: allSubtasks } = useSubtasks()
  const { data: allTasks } = usePhaseTasks()
  const { data: incomes } = useIncomes({ siteId: money ? site.id : NIL_SITE_ID })
  const { data: expenses } = useExpenses({ siteId: money ? site.id : NIL_SITE_ID })
  const sitePlans = useSitePlans(progressReady ? site.id : null)
  const { data: daily } = useSiteProgressDaily(progressReady ? site.id : null)

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
  const subtasksForSite = useMemo(() => (allSubtasks || []).filter((s) => s.site_id === site.id), [allSubtasks, site.id])
  const subtasksByParent = useMemo(() => groupSubtasksByParent(subtasksForSite), [subtasksForSite])
  const leaves = useMemo(() => flattenLeaves(phasesForSite, subtasksByParent), [phasesForSite, subtasksByParent])

  // Same function GanttView uses for its own timeline -- same site, same
  // phases, so this always produces the identical range GanttView shows.
  const baseRange = useMemo(() => computeTimelineRange([site], { [site.id]: phasesForSite }), [site, phasesForSite])

  // Widen it to also cover real income/expense dates -- a site can have
  // costs recorded before/after its formally dated phases (e.g. an early
  // deposit or expense before the first phase starts), and GanttView
  // widens by this exact same amount (same incomes/expenses, same
  // function) so the two charts' timelines never drift apart.
  const transactionDates = useMemo(() => [
    ...(incomes || []).map((i) => i.date),
    ...(expenses || []).map((e) => e.date),
  ], [incomes, expenses])
  const expandedRange = useMemo(() => expandRangeForTransactions(baseRange, transactionDates), [baseRange, transactionDates])
  // Same work-focused range the Gantt shows (GanttView.jsx's focusRange: phases + subtasks +
  // today when near) so the two charts line up. Money recorded outside it, such as a deposit
  // months before work starts, is still in the cumulative totals; it just sits left of the axis.
  const range = useMemo(() => {
    if (!baseRange) return expandedRange
    const extra = subtasksForSite.flatMap((s) => [s.start_date, s.end_date])
    return computeFocusRange(baseRange, extra, TODAY_ISO)
  }, [baseRange, expandedRange, subtasksForSite])

  // A mistyped date (e.g. year 82026) would stretch the whole time axis, so records dated
  // outside a believable window are left out of the chart and counted for a visible warning.
  const plausibleDate = (d) => typeof d === 'string' && d >= '2000-01-01' && d <= '2100-12-31'
  const badDateCount = useMemo(
    () => [...(incomes || []), ...(expenses || [])].filter((r) => !plausibleDate(r.date)).length,
    [incomes, expenses],
  )

  // งานจริง %: the latest PLAN as a % series vs daily % ตามสัญญา + today's live %
  // (progressCalc.js -- PM cannot call site_progress_pct, see global constraints)
  const latestPlan = sitePlans.plans[0] || null
  const livePct = useMemo(() => siteProgress({
    phases: phasesForSite,
    subtasks: subtasksForSite,
    tasks: (allTasks || []).filter((t) => t.site_id === site.id),
  }).contractPct, [phasesForSite, subtasksForSite, allTasks, site.id])
  const workData = useMemo(() => {
    if (mode !== 'work') return []
    const plan = latestPlan ? planPctSeries(sitePlans.items[latestPlan.id] || []) : []
    const extraDates = range ? [range.start.toISOString().slice(0, 10), range.end.toISOString().slice(0, 10)] : []
    const rows = workSeries({ plan, daily, todayISO: TODAY_ISO, livePct, extraDates }).map((row) => ({ ...row, ts: new Date(row.date).getTime() }))
    if (!range) return rows
    return rows.filter((row) => row.ts >= range.start.getTime() && row.ts <= range.end.getTime())
  }, [mode, latestPlan, sitePlans.items, daily, livePct, range])

  const moneyData = useMemo(() => {
    if (mode !== 'money') return []
    const plan = buildPlanSeries(leaves, site.contract_value)
    const actual = buildActualSeries((incomes || []).filter((r) => plausibleDate(r.date)))
    const cost = buildCostSeries((expenses || []).filter((r) => plausibleDate(r.date)))
    // Anchor the line data at the same range.start/range.end GanttView's
    // own timeline uses, so the plotted lines actually reach both edges
    // of the axis instead of starting/stopping wherever a real
    // transaction or phase end-date happens to land.
    const extraDates = range ? [range.start.toISOString().slice(0, 10), range.end.toISOString().slice(0, 10)] : []
    const rows = mergeCumulativeSeries({ plan, actual, cost }, TODAY_ISO, extraDates).map((row) => ({ ...row, ts: new Date(row.date).getTime() }))
    // Keep only the visible window. Rows are forward-filled running totals, so the first row
    // inside the window (range.start was added above) already carries everything earlier,
    // such as a deposit paid months before work started.
    if (!range) return rows
    return rows.filter((row) => row.ts >= range.start.getTime() && row.ts <= range.end.getTime())
  }, [mode, leaves, incomes, expenses, site.contract_value, range])

  const chartData = mode === 'work' ? workData : moneyData
  // a non-money role before migration 07 has no mode to show (SiteDetail does not mount it then)
  if (!money && !progressReady) return null

  const modeToggle = money && progressReady && (
    <div style={{ display: 'flex', gap: 4 }}>
      <button type="button" className={`btn btn-sm ${mode === 'work' ? 'btn-primary' : 'btn-ghost'}`}
        aria-pressed={mode === 'work'} onClick={() => setModeChoice('work')}>งานจริง %</button>
      <button type="button" className={`btn btn-sm ${mode === 'money' ? 'btn-primary' : 'btn-ghost'}`}
        aria-pressed={mode === 'money'} onClick={() => setModeChoice('money')}>เงิน</button>
    </div>
  )

  if (!chartData.length) {
    return (
      <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>
        {modeToggle && <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>{modeToggle}</div>}
        {mode === 'work'
          ? `ยังไม่มีข้อมูลพอสำหรับกราฟ S-curve ของ ${site.name} (ต้องมีวันที่ขั้นตอนงาน)`
          : `ยังไม่มีข้อมูลพอสำหรับกราฟ S-curve ของ ${site.name} (ต้องมีวันที่ขั้นตอนงาน หรือรายรับ/รายจ่ายอย่างน้อย 1 รายการ)`}
      </div>
    )
  }

  // Domain: same range as the Gantt when it has one (dated phases); fall
  // back to the chart's own data span otherwise (e.g. a site with only
  // income/expense rows and no dated phases yet -- Gantt would show its
  // own "no dates" empty state in that case, so there's nothing to match).
  const domainStart = range ? range.start.getTime() : chartData[0].ts
  const domainEnd = range ? range.end.getTime() : chartData[chartData.length - 1].ts
  // Same tick spacing as the Gantt axis: fine day ticks for a short span, months for a long one.
  const axis = range ? computeAxisTicks(range) : null
  const fine = !!axis && axis.days.length > 0
  const axisTicks = axis ? (fine ? axis.days : axis.months).map((t) => t.date.getTime()) : undefined
  // Tick times are UTC midnight; format their UTC calendar day so the label never slips a day.
  const monthLabel = (ts) => { const d = new Date(ts); const local = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); return format(local, fine ? 'd MMM' : 'MMM yy', { locale: th }) }

  const todayTs = new Date(TODAY_ISO).getTime()
  const todayInRange = domainStart <= todayTs && todayTs <= domainEnd

  return (
    // compact (phone): value axis flush left, no Gantt alignment offset (owner 2026-10-17)
    <div className="card" style={{ padding: compact ? '12px 8px' : 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>
          S-curve: {site.name}
          {!money && <span style={{ marginLeft: 8, fontSize: 11.5, fontWeight: 400, color: 'var(--text3)' }}>งานจริง %</span>}
        </div>
        {modeToggle}
      </div>
      {mode === 'work' && !latestPlan && (
        <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>ยังไม่มี PLAN จึงยังไม่มีเส้นแผน</div>
      )}
      {mode === 'money' && badDateCount > 0 && (
        <div className="alert alert-warning" style={{ fontSize: 12, marginBottom: 10 }}>
          ⚠️ มี {badDateCount} รายการรายรับ/รายจ่ายของไซต์นี้ที่วันที่ผิดปกติ (เช่นพิมพ์ปีผิด) จึงไม่ถูกนับในกราฟนี้ ตรวจสอบและแก้วันที่ในหน้ารายการ
        </div>
      )}
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={chartData} margin={compact ? { left: 0, right: 8 } : { left: 114, right: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={chartColors.border} />
          <XAxis dataKey="ts" type="number" scale="time" domain={[domainStart, domainEnd]}
            ticks={axisTicks} tickFormatter={monthLabel} tick={{ fontSize: 11 }} />
          {/* width fixed (not auto) so the plot area's left edge is
              predictable -- paired with the chart's own margin.left above
              to land the plot area at the same 178px offset (170px phase
              label column + 8px gap) GanttView's track starts at, so the
              two charts' timelines line up when stacked. */}
          {mode === 'work' ? (
            <YAxis width={compact ? 58 : 64} tick={{ fontSize: 11 }} domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} />
          ) : (
            <YAxis width={compact ? 58 : 64} tick={{ fontSize: 11 }} tickFormatter={compact ? millionBahtTick : (v) => fmt(v)} />
          )}
          <Tooltip formatter={mode === 'work' ? (v) => `${Math.round(v * 10) / 10}%` : (v) => fmt(v)} labelFormatter={(ts) => format(new Date(ts), 'd MMM yyyy', { locale: th })} />
          <Legend />
          {todayInRange && (
            <ReferenceLine x={todayTs} stroke={chartColors.text3} strokeDasharray="3 4"
              label={{ value: 'วันนี้', position: 'top', fontSize: 10, fill: chartColors.text3 }} />
          )}
          {mode === 'work' ? (
            <>
              {latestPlan && <Line type="monotone" dataKey="plan" name={`แผน (PLAN v${latestPlan.version})`} stroke={chartColors.accent} dot={false} />}
              <Line type="monotone" dataKey="actual" name="งานจริง" stroke={chartColors.green} dot={false} connectNulls={false} />
            </>
          ) : (
            <>
              <Line type="monotone" dataKey="plan" name="แผนเบิกเงิน" stroke={chartColors.accent} dot={false} />
              <Line type="monotone" dataKey="actual" name="เบิกจริง" stroke={chartColors.green} dot={false} connectNulls={false} />
              <Line type="monotone" dataKey="cost" name="ต้นทุนเรา" stroke={chartColors.red} dot={false} connectNulls={false} />
            </>
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
