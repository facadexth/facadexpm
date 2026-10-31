// Pointer maths for content rotated 90deg clockwise by CSS (LandscapeView's .is-rotated stage).
// recharts reads the touch position in screen axes and divides by rect.width / offsetWidth, which is wrong once the
// chart is rotated, so tooltips never show. Given the chart container's screen bounding rect, its own (unrotated)
// offsetWidth and the finger's screen point, return the clientX/clientY that make recharts land on the right spot.
export function rotatedChartClientPoint(rect, offsetWidth, screenX, screenY) {
  // rotate(90deg): the element's local +x runs down the screen, local +y runs right-to-left; local (0,0) sits at the
  // rect's top-right corner.
  const localX = screenY - rect.top
  const localY = rect.right - screenX
  const scale = (rect.width / offsetWidth) || 1   // what recharts will divide by
  return { clientX: rect.left + localX * scale, clientY: rect.top + localY * scale }
}
