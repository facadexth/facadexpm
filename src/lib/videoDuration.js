// Length of a video File in seconds, read from a hidden <video> element's loadedmetadata.
// Rejects when the browser cannot read it within `timeoutMs` (the page then refuses the file,
// because the server has no length check -- ruling R8).
export function readVideoSeconds(file, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const v = document.createElement('video')
    let done = false
    const finish = (fn, val) => {
      if (done) return
      done = true
      clearTimeout(t)
      v.removeAttribute('src')
      try { v.load() } catch { /* ignore */ }
      URL.revokeObjectURL(url)
      fn(val)
    }
    const t = setTimeout(() => finish(reject, new Error('timeout')), timeoutMs)
    v.preload = 'metadata'
    v.muted = true
    v.onloadedmetadata = () => {
      const d = v.duration
      if (Number.isFinite(d) && d >= 0) finish(resolve, d)
      else finish(reject, new Error('no duration'))
    }
    v.onerror = () => finish(reject, new Error('unreadable'))
    v.src = url
  })
}
