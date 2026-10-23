// Read-only plan with its marks. Marks are 0–1 fractions of the displayed image, drawn in an SVG
// with viewBox 0 0 1 1 stretched over the image, so they line up at any size (screen or print).
export function pinLabel(taskId, cardOrder = []) {
  const i = taskId ? cardOrder.indexOf(taskId) : -1
  return i >= 0 ? String(i + 1) : '•'
}

export default function PlanMarkup({ plan, src, marks = [], colourFor = () => '#9ca3af', cardOrder = [], imgRef, children, onPointerDown, onPointerMove, onPointerUp, style }) {
  const url = src ?? plan?.url ?? plan?.signedUrl
  return (
    <div style={{ position: 'relative', width: '100%', lineHeight: 0, touchAction: onPointerDown ? 'none' : undefined, ...style }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      <img ref={imgRef} src={url} alt={plan?.title || 'แบบแปลน'} draggable={false}
        style={{ width: '100%', height: 'auto', display: 'block', userSelect: 'none' }} />
      <svg viewBox="0 0 1 1" preserveAspectRatio="none" data-testid="plan-svg"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        {marks.map((m, i) => {
          const c = colourFor(m.task_id ?? m.taskId ?? null)
          if (m.kind === 'rect') {
            return <rect key={m.id || i} data-kind="rect" x={m.x} y={m.y} width={m.w} height={m.h}
              fill={c} fillOpacity={0.35} stroke={c} strokeWidth={2} vectorEffect="non-scaling-stroke" />
          }
          return (
            <g key={m.id || i} data-kind="pin">
              <ellipse cx={m.x} cy={m.y} rx={0.018} ry={0.024} fill={c} stroke="#fff" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
              <text x={m.x} y={m.y} fontSize={0.025} textAnchor="middle" dominantBaseline="central" fill="#fff"
                style={{ fontWeight: 700 }}>{pinLabel(m.task_id ?? m.taskId, cardOrder)}</text>
            </g>
          )
        })}
        {children}
      </svg>
    </div>
  )
}
