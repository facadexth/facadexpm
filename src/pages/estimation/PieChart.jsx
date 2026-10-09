// Plain-SVG pie chart. data = [{ key, label, value }]. Colours come from CSS variables with fallbacks.
import { fmt } from '../../lib/supabase.js'

const COLORS = ['var(--accent, #D4B596)', 'var(--green, #8DB596)', 'var(--blue, #4ecdc4)', 'var(--yellow, #ffd166)', 'var(--red, #E0806A)',
  '#9b8fd4', '#d48fb5', '#7fa6d4', '#b5b58d']

const pt = (cx, cy, r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)]

export default function PieChart({ data, title }) {
  const items = (data || []).filter(d => Number.isFinite(Number(d.value)) && Number(d.value) > 0)
  const total = items.reduce((s, d) => s + Number(d.value), 0)
  const cx = 70, cy = 70, r = 60
  let angle = -Math.PI / 2
  const slices = items.map((d, i) => {
    const frac = Number(d.value) / total
    const a0 = angle
    angle += frac * 2 * Math.PI
    return { ...d, frac, a0, a1: angle, color: COLORS[i % COLORS.length] }
  })
  return (
    <div style={{ minWidth: 0 }}>
      {title && <div style={{ fontWeight: 700, marginBottom: 6 }}>{title}</div>}
      {!slices.length ? <div style={{ color: 'var(--text3)', fontSize: 12 }}>ไม่มีข้อมูล</div> : (
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <svg viewBox="0 0 140 140" width="160" height="160" role="img" aria-label={title || 'pie'}>
            {slices.length === 1
              ? <circle cx={cx} cy={cy} r={r} fill={slices[0].color} />
              : slices.map(s => {
                const [x0, y0] = pt(cx, cy, r, s.a0)
                const [x1, y1] = pt(cx, cy, r, s.a1)
                const large = s.a1 - s.a0 > Math.PI ? 1 : 0
                return <path key={s.key} d={`M${cx},${cy} L${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)} Z`} fill={s.color} stroke="var(--bg2, #fff)" strokeWidth="1" />
              })}
            {slices.filter(s => s.frac >= 0.06).map(s => {
              const [lx, ly] = pt(cx, cy, r * 0.62, (s.a0 + s.a1) / 2)
              return <text key={`t-${s.key}`} x={lx.toFixed(1)} y={ly.toFixed(1)} textAnchor="middle" dominantBaseline="middle" fontSize="9" fill="var(--on-accent, #1E1E1E)">{(s.frac * 100).toFixed(0)}%</text>
            })}
          </svg>
          <div style={{ display: 'grid', gap: 3, fontSize: 12 }}>
            {slices.map(s => (
              <div key={s.key} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ width: 10, height: 10, background: s.color, display: 'inline-block', borderRadius: 2 }} />
                <span>{s.label}</span>
                <span className="font-mono" style={{ color: 'var(--text3)' }}>{fmt(s.value)} ({(s.frac * 100).toFixed(1)}%)</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
