// ============================================================
// AssignCell — one worker×day cell.
// Full block when both shifts share the same site+type; split top/bottom otherwise.
// ============================================================
import { TYPE_COLOR, TYPE_LABEL, SITE_TYPES } from './constants.js'

function halfLabel(seg) {
  if (!seg) return ''
  if (SITE_TYPES.includes(seg.type)) return seg.site_number || TYPE_LABEL[seg.type] || '•'
  return TYPE_LABEL[seg.type] || '•'
}

function Half({ seg, onClick, h, showOt }) {
  const tc = seg ? (TYPE_COLOR[seg.type] || TYPE_COLOR.site) : null
  return (
    <div
      onClick={onClick}
      title={seg ? `${seg.type}${seg.site_number ? ' · ' + seg.site_number : ''}${seg.ot > 0 ? ' OT' + seg.ot + 'h' : ''}` : 'คลิกเพื่อกำหนด'}
      style={{
        height: h, display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer', fontSize: 8, fontWeight: 700, overflow: 'hidden',
        background: tc ? tc.bg : 'transparent', color: tc ? tc.color : 'var(--bg4)',
      }}>
      {seg ? (<>{halfLabel(seg)}{showOt && seg.ot > 0 && <span style={{ fontSize: 7 }}>⚡</span>}</>) : '·'}
    </div>
  )
}

export default function AssignCell({ cell = {}, onEdit, w = 30, h = 30 }) {
  const { morning, evening } = cell
  const same = morning && evening
    && morning.site_id === evening.site_id && morning.type === evening.type
  const tc = morning ? (TYPE_COLOR[morning.type] || TYPE_COLOR.site) : null

  // full-day block (both shifts identical)
  if (same) {
    return (
      <div
        onClick={() => onEdit('morning')}
        title={`${morning.type}${morning.site_number ? ' · ' + morning.site_number : ''} (เต็มวัน)`}
        style={{
          width: w, height: h, borderRadius: 4, display: 'flex', alignItems: 'center',
          justifyContent: 'center', cursor: 'pointer', fontSize: 8, fontWeight: 700,
          background: tc.bg, color: tc.color, margin: '0 auto', overflow: 'hidden',
        }}>
        {halfLabel(morning)}{morning.ot > 0 && <span style={{ fontSize: 7 }}>⚡</span>}
      </div>
    )
  }

  // split (or partially empty)
  return (
    <div style={{ width: w, height: h, borderRadius: 4, overflow: 'hidden', margin: '0 auto', background: 'rgba(255,255,255,.03)' }}>
      <Half seg={morning} h={h / 2} onClick={() => onEdit('morning')} showOt />
      <Half seg={evening} h={h / 2} onClick={() => onEdit('evening')} showOt />
    </div>
  )
}
