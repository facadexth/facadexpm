// Read-only plan with its marks. Marks are 0–1 fractions of the displayed image, drawn in an SVG
// with viewBox 0 0 1 1 stretched over the image, so they line up at any size (screen or print).
export function pinLabel(taskId, cardOrder = []) {
  const i = taskId ? cardOrder.indexOf(taskId) : -1
  return i >= 0 ? String(i + 1) : '•'
}

export default function PlanMarkup({ plan, src, marks = [], colourFor = () => '#9ca3af', cardOrder = [], imgRef, children, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, style }) {
  const url = src ?? plan?.url ?? plan?.signedUrl
  return (
    <div style={{ position: 'relative', width: '100%', lineHeight: 0, touchAction: onPointerDown ? 'none' : undefined, ...style }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}>
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
          return null
        })}
        {children}
      </svg>
      {/* Pins are HTML so they stay round at any aspect ratio (the SVG above is stretched). */}
      {marks.map((m, i) => m.kind === 'rect' ? null : (
        <span key={'pin' + (m.id || i)} data-kind="pin" style={{
          position: 'absolute', left: `${m.x * 100}%`, top: `${m.y * 100}%`, transform: 'translate(-50%,-50%)',
          width: 22, height: 22, borderRadius: '50%', boxSizing: 'border-box', border: '2px solid #fff',
          background: colourFor(m.task_id ?? m.taskId ?? null), color: '#fff', fontSize: 12, fontWeight: 700,
          lineHeight: '18px', textAlign: 'center', pointerEvents: 'none',
          WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact',
        }}>{pinLabel(m.task_id ?? m.taskId, cardOrder)}</span>
      ))}
    </div>
  )
}
