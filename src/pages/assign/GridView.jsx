// ============================================================
// GridView — workers × days matrix (used by Month & Week views)
// Fills full width: day columns share the space equally (equal gaps),
// cells stretch to fill their column so no dead space on the right.
// ============================================================
import { fmt } from '../../lib/supabase.js'
import AssignCell from './AssignCell.jsx'
import { DOW_TH, SITE_TYPES } from './constants.js'

export default function GridView({ days, workers, cellLookup, onEditHalf, cellH = 32, variant = 'week' }) {
  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="table-wrap" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <th style={{ width: 150, position: 'sticky', left: 0, background: 'var(--bg3)', zIndex: 10 }}>ช่าง</th>
              {days.map(d => (
                <th key={d.iso} style={{
                  padding: '6px 2px', textAlign: 'center', fontSize: 10,
                  color: d.isSunday ? 'var(--text3)' : 'var(--text2)', opacity: d.isSunday ? 0.45 : 1,
                }}>
                  <div style={{ fontSize: 9 }}>{DOW_TH[d.dow]}</div>
                  <div>{d.date.getDate()}</div>
                </th>
              ))}
              <th style={{ width: 60, textAlign: 'right' }}>รวมวัน</th>
            </tr>
          </thead>
          <tbody>
            {(workers || []).map(w => {
              const row = cellLookup[w.id] || {}
              let workDays = 0
              days.forEach(d => {
                const c = row[d.iso]
                if (c?.morning && SITE_TYPES.includes(c.morning.type)) workDays += 0.5
                if (c?.evening && SITE_TYPES.includes(c.evening.type)) workDays += 0.5
              })
              return (
                <tr key={w.id}>
                  <td style={{ position: 'sticky', left: 0, background: 'var(--bg3)', zIndex: 5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{w.nickname || w.name}</div>
                    <div style={{ fontSize: 10, color: 'var(--text3)' }}>{fmt(Math.round((w.monthly_salary || 0) / 26))} บ/วัน</div>
                  </td>
                  {days.map(d => (
                    <td key={d.iso} style={{ padding: 2, textAlign: 'center', opacity: d.isSunday ? 0.5 : 1 }}>
                      <AssignCell
                        cell={row[d.iso] || {}}
                        w="100%" h={cellH} variant={variant}
                        onEdit={(shift) => !d.isSunday && onEditHalf(w, d.iso, shift)}
                      />
                    </td>
                  ))}
                  <td style={{ textAlign: 'right', fontSize: 11, whiteSpace: 'nowrap', color: workDays > 0 ? 'var(--green)' : 'var(--text3)', fontWeight: 700 }}>
                    {workDays > 0 ? `${workDays}` : '0'}
                  </td>
                </tr>
              )
            })}
            {!(workers || []).length && (
              <tr><td colSpan={days.length + 2} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีช่าง</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
