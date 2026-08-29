// ============================================================
// CategoryPieTooltip -- shared Recharts <Tooltip content> for the
// category-breakdown pie charts in Expenses.jsx and SiteOverviewModal.jsx.
// When hovering the merged "อื่นๆ" slice (see groupSmallSlices in
// lib/expenseChart.js), lists the individual categories it absorbed
// instead of just the blended total.
// ============================================================
import { fmt } from '../lib/supabase.js'

export default function CategoryPieTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div style={{
      background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8,
      padding: '8px 10px', fontSize: 12, boxShadow: '0 4px 16px rgba(0,0,0,.18)', minWidth: 140,
    }}>
      <div style={{ fontWeight: 700, color: 'var(--text)' }}>{d.name}: {fmt(d.value)} บาท</div>
      {d.items?.length > 0 && (
        <div style={{ display: 'grid', gap: 3, marginTop: 6, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
          {d.items.map(it => (
            <div key={it.name} style={{ display: 'flex', justifyContent: 'space-between', gap: 14, color: 'var(--text3)' }}>
              <span>{it.name}</span>
              <span className="font-mono">{fmt(it.value)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
