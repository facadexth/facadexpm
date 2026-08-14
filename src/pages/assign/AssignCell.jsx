// ============================================================
// AssignCell — one worker×day cell.
// Full block when both shifts share the same site+type; split top/bottom otherwise.
// Site/factory cells are coloured per-site; week shows the full site name,
// month shows an abbreviation (full name on hover).
// ============================================================
import { TYPE_COLOR, TYPE_LABEL, SITE_TYPES, siteColor, siteAbbrev } from './constants.js'

// resolve one shift-segment into { bg, color, label, title }
function segInfo(seg, variant) {
  if (!seg) return null
  if (SITE_TYPES.includes(seg.type)) {
    const c = siteColor(seg.site_id)
    const full = seg.site_name || seg.site_number || '—'
    const pre = seg.type === 'factory' ? '🏭 ' : ''
    const label = variant === 'month' ? siteAbbrev(seg.site_name || seg.site_number) : full
    return {
      bg: c.bg, color: c.color, label: pre + label,
      title: `${full}${seg.type === 'factory' ? ' (ผลิตที่โรงงาน)' : ''}${seg.ot > 0 ? ' · OT ' + seg.ot + 'h' : ''}`,
    }
  }
  const tc = TYPE_COLOR[seg.type] || TYPE_COLOR.holiday
  return { bg: tc.bg, color: tc.color, label: TYPE_LABEL[seg.type] || seg.type, title: seg.type }
}

function Half({ info, onClick, h, fontSize }) {
  return (
    <div onClick={onClick} title={info?.title || 'คลิกเพื่อกำหนด'}
      style={{
        height: h, display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer', fontSize, fontWeight: 700, overflow: 'hidden', padding: '0 3px',
        background: info ? info.bg : 'transparent', color: info ? info.color : 'var(--bg4)',
        whiteSpace: 'nowrap', textOverflow: 'ellipsis',
      }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{info ? info.label : '·'}</span>
    </div>
  )
}

export default function AssignCell({ cell = {}, ot = null, onEdit, w = '100%', h = 32, variant = 'week' }) {
  const { morning, evening } = cell
  const same = morning && evening
    && morning.site_id === evening.site_id && morning.type === evening.type
  const fontSize = variant === 'month' ? 8 : 11

  const otTitle = ot && [
    ot.site_name || ot.site_number || '',
    `${ot.start_time?.slice(0, 5)}-${ot.end_time?.slice(0, 5)}${ot.is_overnight ? ' (ข้ามคืน)' : ''}`,
    `${ot.ot_hours} ชม.`,
  ].filter(Boolean).join(' · ')
  const otBadge = ot && (
    <span title={otTitle} style={{
      position: 'absolute', top: -2, right: -2, fontSize: 9, lineHeight: 1,
      background: 'var(--bg)', borderRadius: '50%', padding: 1,
    }}>⚡</span>
  )

  // full-day block (both shifts identical)
  if (same) {
    const info = segInfo(morning, variant)
    return (
      <div style={{ position: 'relative', width: w, height: h }}>
        <div onClick={() => onEdit('morning')} title={info.title}
          style={{
            width: '100%', height: '100%', borderRadius: 4, display: 'flex', alignItems: 'center',
            justifyContent: 'center', cursor: 'pointer', fontSize, fontWeight: 700,
            background: info.bg, color: info.color, overflow: 'hidden', padding: '0 4px',
            whiteSpace: 'nowrap',
          }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{info.label}</span>
        </div>
        {otBadge}
      </div>
    )
  }

  // split (or partially empty)
  return (
    <div style={{ position: 'relative', width: w, height: h }}>
      <div style={{ width: '100%', height: '100%', borderRadius: 4, overflow: 'hidden', background: 'rgba(255,255,255,.03)' }}>
        <Half info={segInfo(morning, variant)} h={h / 2} fontSize={Math.max(8, fontSize - 1)} onClick={() => onEdit('morning')} />
        <Half info={segInfo(evening, variant)} h={h / 2} fontSize={Math.max(8, fontSize - 1)} onClick={() => onEdit('evening')} />
      </div>
      {otBadge}
    </div>
  )
}
