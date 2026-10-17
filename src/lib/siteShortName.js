// Short display name for a site (phone assign grid, etc.).
// A hand-set sites.short_name wins; otherwise derive one from the full name.

let segmenter = null
try {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) segmenter = new Intl.Segmenter('th', { granularity: 'grapheme' })
} catch { segmenter = null }

/** Split into user-perceived characters so Thai combining marks stay with their base letter. */
function graphemes(s) {
  if (segmenter) return Array.from(segmenter.segment(s), x => x.segment)
  return Array.from(s)
}

function truncate(s, max) {
  const g = graphemes(s)
  if (g.length <= max) return s
  const cut = g.slice(0, max)
  // a Thai leading vowel (เ แ โ ใ ไ) belongs to the next letter; never end on one
  while (cut.length && /^[เแโใไ]$/.test(cut[cut.length - 1])) cut.pop()
  return cut.join('') + '…'
}

const LEADING = /^(?:โครงการ|บริษัท|งาน)\s*/
const TRAILING_COMPANY = /\s*(?:\(มหาชน\)|จำกัด)\s*$/

export function autoShortName(name, max = 14) {
  let s = String(name ?? '').trim().replace(/\s+/g, ' ')
  if (!s) return ''
  const stripped = s.replace(LEADING, '').trim()
  if (stripped) s = stripped
  // trailing "(…)" and company suffixes, repeated (e.g. "ซันไรส์ จำกัด (มหาชน)")
  for (let prev = null; prev !== s;) {
    prev = s
    const t = s.replace(/\s*\([^()]*\)\s*$/, '').replace(TRAILING_COMPANY, '').trim()
    if (t) s = t
  }
  const words = s.split(' ')
  let out = words[0]
  if (graphemes(out).length < 4) {
    for (let i = 1; i < words.length; i++) {
      const next = out + ' ' + words[i]
      if (graphemes(next).length > max) break
      out = next
    }
  }
  return truncate(out, max)
}

export function siteShortName(site, max = 14) {
  const manual = typeof site?.short_name === 'string' ? site.short_name.trim() : ''
  if (manual) return manual
  return autoShortName(site?.name, max)
}
