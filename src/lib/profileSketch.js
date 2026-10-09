// src/lib/profileSketch.js
// A rough cross-section sketch from the catalog dimensions, for the profile form (proportions only; the real
// detail is in the attached drawing). shape: 'box' (closed hollow) | 'u' (open channel with lips, e.g. กล่องเรียบ).
// Returns an SVG string with literal colours.
const INK = '#1f2328'
const FILL = '#d6dbe0'
const n2 = n => Math.round(n * 100) / 100

export function profileSketchSvg({ width_mm, depth_mm, wall_mm, shape }) {
  const w = Number(width_mm)
  const d = Number(depth_mm)
  if (!(w > 0) || !(d > 0)) return ''
  const t0 = Number(wall_mm) > 0 ? Number(wall_mm) : Math.min(w, d) * 0.04
  const k = Math.min(140 / w, 80 / d)
  const W = w * k
  const D = d * k
  const T = Math.max(1.6, Math.min(t0 * k, Math.min(W, D) / 3))
  const x = (160 - W) / 2
  const y = (100 - D) / 2
  let body
  if (shape === 'u') {
    const yb = y + D - T / 2
    const lip = Math.min(W * 0.12, 14)
    const hk = Math.max(2.5, D * 0.12)
    body = `<polyline points="${n2(x + lip)},${n2(yb)} ${n2(x + T / 2)},${n2(yb)} ${n2(x + T / 2)},${n2(y + T / 2)} ${n2(x + W - T / 2)},${n2(y + T / 2)} ${n2(x + W - T / 2)},${n2(yb)} ${n2(x + W - lip)},${n2(yb)}" fill="none" stroke="${INK}" stroke-width="${n2(T)}"/>`
      + `<rect x="${n2(x + lip - hk * 0.2)}" y="${n2(yb - T / 2 - hk)}" width="${n2(T * 1.6)}" height="${n2(hk)}" fill="${INK}"/>`
      + `<rect x="${n2(x + W - lip - T * 1.4)}" y="${n2(yb - T / 2 - hk)}" width="${n2(T * 1.6)}" height="${n2(hk)}" fill="${INK}"/>`
  } else {
    body = `<rect x="${n2(x)}" y="${n2(y)}" width="${n2(W)}" height="${n2(D)}" fill="${FILL}" stroke="${INK}"/>`
      + `<rect x="${n2(x + T)}" y="${n2(y + T)}" width="${n2(Math.max(0, W - 2 * T))}" height="${n2(Math.max(0, D - 2 * T))}" fill="#ffffff" stroke="${INK}"/>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 116" width="160" height="116">${body}<text x="80" y="112" font-size="9" fill="#6b7280" text-anchor="middle">${n2(w)} x ${n2(d)} mm</text></svg>`
}
