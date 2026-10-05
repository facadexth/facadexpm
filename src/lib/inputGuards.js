// App-wide input guards, installed once from main.jsx.
//  1. Enter inside an <input> in a <form> must not submit it (users press
//     the save button). Forms that opt out carry `data-enter-submit`.
//  2. Wheel over a focused number input must not change its value.

const NON_TEXT_TYPES = ['submit', 'button', 'reset', 'image', 'file']

export function shouldBlockEnter(event) {
  const t = event.target
  return (
    event.key === 'Enter' &&
    !event.isComposing &&
    t?.tagName === 'INPUT' &&
    !NON_TEXT_TYPES.includes(t.type) &&
    !!t.form &&
    !t.closest?.('[data-enter-submit]')
  )
}

export function shouldBlurOnWheel(event, doc) {
  const t = event.target
  return t?.tagName === 'INPUT' && t.type === 'number' && doc.activeElement === t
}

const installed = new WeakMap()

export function installInputGuards(doc = document) {
  if (installed.has(doc)) return installed.get(doc)
  // Capture phase, preventDefault only: the inputs' own onKeyDown still runs.
  const onKeyDown = (event) => { if (shouldBlockEnter(event)) event.preventDefault() }
  // Blur before the browser applies the wheel step: page scrolls, value stays.
  const onWheel = (event) => { if (shouldBlurOnWheel(event, doc)) event.target.blur() }
  doc.addEventListener('keydown', onKeyDown, true)
  doc.addEventListener('wheel', onWheel, { passive: true, capture: true })
  const remove = () => {
    doc.removeEventListener('keydown', onKeyDown, true)
    doc.removeEventListener('wheel', onWheel, { passive: true, capture: true })
    installed.delete(doc)
  }
  installed.set(doc, remove)
  return remove
}
