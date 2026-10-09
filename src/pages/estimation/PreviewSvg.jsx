// src/pages/estimation/PreviewSvg.jsx
// Draws a buildFramePreview() result as SVG with theme colours (CSS variables), so it follows light/dark.
// style: 'double' | 'solid' | 'cad' | 'parts' ('parts' = double + the part labels the preview carries).
// The stored snapshot uses previewSvgString() with literal colours instead; this one is for the screen only.
import { arrowHeads } from '../../lib/framePreview.js'

const INK = 'var(--text)'
const DIM = 'var(--accent)'

function Unit({ u, frameFill, glassFill }) {
  return (
    <g>
      <rect x={u.outer.x} y={u.outer.y} width={u.outer.w} height={u.outer.h} fill={frameFill} stroke={INK} strokeWidth={1.2} />
      <rect x={u.inner.x} y={u.inner.y} width={u.inner.w} height={u.inner.h} fill={glassFill} fillOpacity={glassFill === 'none' ? undefined : 0.28} stroke={INK} strokeWidth={1} />
      {u.lines.map((l, i) => <line key={`l${i}`} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke={INK} strokeWidth={1} />)}
      {u.seams.map((l, i) => <line key={`s${i}`} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke={INK} strokeWidth={1.2} />)}
      {u.decor.map((d, i) => {
        if (d.type === 'circle') return <circle key={`d${i}`} cx={d.cx} cy={d.cy} r={d.r} fill={INK} />
        if (d.type === 'polyline') return (
          <g key={`d${i}`}>
            <polyline points={d.points.map(([x, y]) => `${x},${y}`).join(' ')} fill="none" stroke={INK} strokeWidth={0.9} strokeDasharray={d.dashed ? '4 3' : undefined} />
            {d.arrow && arrowHeads(d.points).map((h, k) => <polyline key={k} points={h.map(([x, y]) => `${x},${y}`).join(' ')} fill="none" stroke={INK} strokeWidth={0.9} />)}
          </g>
        )
        return <line key={`d${i}`} x1={d.x1} y1={d.y1} x2={d.x2} y2={d.y2} stroke={INK} strokeWidth={d.heavy ? 3 : 1} strokeLinecap="round" />
      })}
    </g>
  )
}

function Dim({ d }) {
  const vertical = d.kind === 'height'
  const cx = (d.x1 + d.x2) / 2
  const cy = (d.y1 + d.y2) / 2
  return (
    <g>
      <line x1={d.x1} y1={d.y1} x2={d.x2} y2={d.y2} stroke={DIM} strokeWidth={0.8} />
      {vertical
        ? <><line x1={d.x1 - 6} y1={d.y1} x2={d.x1 + 6} y2={d.y1} stroke={DIM} strokeWidth={0.8} /><line x1={d.x2 - 6} y1={d.y2} x2={d.x2 + 6} y2={d.y2} stroke={DIM} strokeWidth={0.8} /></>
        : <><line x1={d.x1} y1={d.y1 - 6} x2={d.x1} y2={d.y1 + 6} stroke={DIM} strokeWidth={0.8} /><line x1={d.x2} y1={d.y2 - 6} x2={d.x2} y2={d.y2 + 6} stroke={DIM} strokeWidth={0.8} /></>}
      {vertical
        ? <text x={d.x1 - 5} y={cy} fontSize={11} fill={DIM} textAnchor="middle" transform={`rotate(-90 ${d.x1 - 5} ${cy})`}>{d.text}</text>
        : <text x={cx} y={d.y1 - 4} fontSize={11} fill={DIM} textAnchor="middle">{d.text}</text>}
    </g>
  )
}

export default function PreviewSvg({ preview, style = 'double', maxWidth = 360, label = 'ภาพตัวอย่าง' }) {
  if (!preview) return null
  const frameFill = style === 'cad' ? 'none' : style === 'solid' ? 'var(--text3)' : 'var(--bg3)'
  const glassFill = style === 'cad' ? 'none' : 'var(--blue)'
  const { width, height } = preview.viewBox
  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} style={{ width: '100%', maxWidth, height: 'auto', display: 'block', margin: '0 auto' }}>
      {preview.units.map((u, i) => <Unit key={i} u={u} frameFill={frameFill} glassFill={glassFill} />)}
      {preview.dims.map((d, i) => <Dim key={i} d={d} />)}
      {(preview.labels || []).map((l, i) => (
        <text key={i} x={l.x} y={l.y} fontSize={9} fill={INK} textAnchor="middle" transform={l.rotate ? `rotate(-90 ${l.x} ${l.y})` : undefined}>{l.text}</text>
      ))}
    </svg>
  )
}
