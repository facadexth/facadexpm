// Layout fingerprint (mobile-view spec §2, guard 3). Run INSIDE a logged-in tab of the app (Chrome tool /
// DevTools console), not in Node. It embeds the app in iframes at the given widths, opens each tab id, and
// records every element under header / nav / main: tag, class list, rounded bounding rect and a few computed
// styles. Table bodies keep only their first 3 rows so data drift does not count as a layout change.
// Compare two captures with: node scripts/layout-fingerprint-diff.mjs before.json after.json
//
// Usage in the console:  await layoutFingerprint({ origin: location.origin, widths: [1440, 1024],
//                          tabs: ['dashboard', 'sites', 'quotations', 'cheques'] })
(function () {
  const STYLES = ['display', 'position', 'width', 'height', 'padding', 'margin', 'font-size', 'flex-direction',
    'grid-template-columns', 'overflow-x', 'white-space', 'visibility']
  const sleep = ms => new Promise(r => setTimeout(r, ms))

  function describe(doc) {
    const out = []
    const roots = [...doc.querySelectorAll('header, nav, main')]
    for (const root of roots) {
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
      let el = root
      while (el) {
        // skip table rows after the third (data drift), and anything inside them
        const tr = el.closest ? el.closest('tbody > tr') : null
        if (tr && tr.parentElement && [...tr.parentElement.children].indexOf(tr) >= 3) { el = walker.nextNode(); continue }
        const r = el.getBoundingClientRect()
        const cs = doc.defaultView.getComputedStyle(el)
        out.push({
          path: pathOf(el), tag: el.tagName.toLowerCase(), cls: [...el.classList].sort().join(' '),
          rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
          st: STYLES.map(k => cs.getPropertyValue(k)),
        })
        el = walker.nextNode()
      }
    }
    return out
  }

  function pathOf(el) {
    const parts = []
    while (el && el.nodeType === 1 && parts.length < 12) {
      const p = el.parentElement
      const idx = p ? [...p.children].indexOf(el) : 0
      parts.unshift(el.tagName.toLowerCase() + ':' + idx)
      el = p
    }
    return parts.join('>')
  }

  async function waitReady(win) {
    for (let i = 0; i < 60; i++) {
      const main = win.document.querySelector('main')
      if (main && main.textContent.trim().length > 50 && !/กำลังโหลด/.test(main.textContent)) { await sleep(1500); return true }
      await sleep(500)
    }
    return false
  }

  window.layoutFingerprint = async function ({ origin = location.origin, widths = [1440, 1024], tabs = ['dashboard'], height = 1600 } = {}) {
    const result = { origin, at: new Date().toISOString(), pages: {} }
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:#333'
    document.body.appendChild(host)
    for (const w of widths) {
      const f = document.createElement('iframe')
      f.style.cssText = `width:${w}px;height:${height}px;border:0;background:#fff`
      host.appendChild(f)
      for (const tab of tabs) {
        f.src = `${origin}/#tab=${tab}&fp=${Date.now()}`
        await new Promise(r => { f.onload = r })
        const ok = await waitReady(f.contentWindow)
        result.pages[`${tab}@${w}`] = ok ? describe(f.contentDocument) : { error: 'page did not become ready' }
      }
      f.remove()
    }
    host.remove()
    return result
  }
})()
