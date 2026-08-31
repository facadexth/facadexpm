// ============================================================
// SignaturePad — plain <canvas> signature capture, no external library.
// Works with mouse, touch, and stylus via Pointer Events (one API for all
// three, which is exactly the "tablet, mobile, laptop" spread this was
// built for). Exposes the drawn signature as a PNG data URL via
// onChange(dataUrl | null) -- null once cleared/empty, so callers can
// gate their save button on "has a real signature" without re-deriving it.
// ============================================================
import { useRef, useEffect, useState } from 'react'

export default function SignaturePad({ onChange, height = 180 }) {
  const canvasRef = useRef(null)
  const drawingRef = useRef(false)
  const lastPointRef = useRef(null)
  const [empty, setEmpty] = useState(true)

  // Canvas backing size must match its CSS size in device pixels or strokes
  // look blurry/misaligned on high-DPI screens -- resize once on mount to
  // the element's actual rendered box, scaled by devicePixelRatio.
  useEffect(() => {
    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    const ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)
    ctx.lineWidth = 2.2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#1a1a1a'
  }, [])

  const pointFromEvent = (e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const handlePointerDown = (e) => {
    e.preventDefault()
    canvasRef.current.setPointerCapture(e.pointerId)
    drawingRef.current = true
    lastPointRef.current = pointFromEvent(e)
  }

  const handlePointerMove = (e) => {
    if (!drawingRef.current) return
    e.preventDefault()
    const ctx = canvasRef.current.getContext('2d')
    const p = pointFromEvent(e)
    ctx.beginPath()
    ctx.moveTo(lastPointRef.current.x, lastPointRef.current.y)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
    lastPointRef.current = p
    if (empty) setEmpty(false)
  }

  const finishStroke = () => {
    if (!drawingRef.current) return
    drawingRef.current = false
    onChange(canvasRef.current.toDataURL('image/png'))
  }

  const handleClear = () => {
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr)
    setEmpty(true)
    onChange(null)
  }

  return (
    <div>
      <canvas
        ref={canvasRef}
        style={{
          width: '100%', height, display: 'block', touchAction: 'none',
          background: '#fff', border: '1px solid var(--border)', borderRadius: 8, cursor: 'crosshair',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishStroke}
        onPointerLeave={finishStroke}
        onPointerCancel={finishStroke}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
        <span style={{ fontSize: 11, color: 'var(--text3)' }}>เซ็นด้วยนิ้ว ปากกา หรือเมาส์ในกรอบด้านบน</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={handleClear} disabled={empty}>ล้างลายเซ็น</button>
      </div>
    </div>
  )
}
