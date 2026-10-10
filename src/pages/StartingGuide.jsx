// เริ่มต้นใช้งาน -- checklist for new tenants, from sign-up to the first invoice.
// Progress comes from real data (see lib/guideProgress.js), nothing is ticked by hand.
import { useMemo } from 'react'
import { useTenant } from '../hooks/useTenant.js'
import { useGuideFacts } from '../hooks/useGuideFacts.js'
import { computeGuide } from '../lib/guideProgress.js'
import { PLATFORM_BOT_BASIC_ID } from '../lib/platformLineBot.js'

export default function StartingGuide({ navigateTo }) {
  const { tenant, hasModuleAccess } = useTenant()
  const { data: facts, loading, error, refetch } = useGuideFacts()
  const guide = useMemo(
    () => computeGuide(facts ? { ...facts, tenant } : { tenant }, hasModuleAccess || (() => true)),
    [facts, tenant, hasModuleAccess],
  )

  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <div className="card-title">🚀 เริ่มต้นใช้งาน</div>
          <button className="btn btn-ghost" onClick={refetch} disabled={loading}>{loading ? '⏳...' : '↻ ตรวจอีกครั้ง'}</button>
        </div>
        <div className="card-body">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 28, fontWeight: 700 }}>{guide.done}/{guide.total}</span>
            <span style={{ color: 'var(--text3)' }}>ขั้นตอนที่ทำแล้ว ({guide.pct}%)</span>
          </div>
          <div style={{ height: 8, borderRadius: 4, background: 'var(--border)', overflow: 'hidden' }} role="progressbar" aria-valuenow={guide.pct} aria-valuemin={0} aria-valuemax={100}>
            <div style={{ width: `${guide.pct}%`, height: '100%', background: 'var(--green)' }} />
          </div>
          <p style={{ marginTop: 12, marginBottom: 0, color: 'var(--text3)', fontSize: 13.5 }}>
            ระบบตรวจจากข้อมูลจริงของบริษัทคุณ ไม่ต้องกดติ๊กเอง ทำขั้นไหนเสร็จ ขั้นนั้นจะขึ้นเครื่องหมายถูกเอง
            {guide.complete && ' ครบทุกขั้นที่จำเป็นแล้ว'}
          </p>
          {error && <p style={{ color: 'var(--red)', marginBottom: 0 }}>ตรวจสถานะไม่สำเร็จ ลองกด "ตรวจอีกครั้ง"</p>}
        </div>
      </div>

      <div style={{ display: 'grid', gap: 12 }}>
        {guide.steps.map((s, i) => {
          const isNext = guide.next?.id === s.id
          return (
            <div key={s.id} className="card" style={isNext ? { borderColor: 'var(--accent)' } : undefined}>
              <div className="card-body" style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div
                  aria-hidden="true"
                  style={{
                    width: 32, height: 32, borderRadius: '50%', flex: '0 0 32px', display: 'grid', placeItems: 'center', fontWeight: 700,
                    background: s.done ? 'var(--green)' : 'var(--border)', color: s.done ? '#fff' : 'var(--text2)',
                  }}
                >{s.done ? '✓' : i + 1}</div>
                <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>
                    {s.title}
                    {s.locked && <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text3)', fontWeight: 400 }}>ไม่รวมในแพ็กเกจของคุณ</span>}
                  </div>
                  <div style={{ color: 'var(--text3)', fontSize: 13.5, marginTop: 2 }}>
                    {s.why}
                    {s.id === 'line' && !s.locked && <> ชื่อบอท: <b>@{PLATFORM_BOT_BASIC_ID}</b></>}
                  </div>
                </div>
                {s.go && !s.locked && !s.done && (
                  <button className={`btn ${isNext ? 'btn-primary' : 'btn-ghost'}`} onClick={() => navigateTo(s.go)}>ไปทำขั้นนี้</button>
                )}
                {s.go && !s.locked && s.done && s.id !== 'signup' && (
                  <button className="btn btn-ghost" onClick={() => navigateTo(s.go)}>เปิดดู</button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
