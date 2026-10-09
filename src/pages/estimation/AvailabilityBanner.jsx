// src/pages/estimation/AvailabilityBanner.jsx
// Amber warnings (mockup screen 3 + project hardware package). Never blocks saving.
export default function AvailabilityBanner({ issues, hardware, typeNames }) {
  const missing = (hardware && hardware.missingTypeIds) || []
  const wrong = !!(hardware && hardware.wrongSeries)
  if (!(issues || []).length && !missing.length && !wrong) return null
  const box = { padding: 12, background: 'var(--amber-bg, #fff7e0)', border: '1px solid var(--amber, #e0a800)', borderRadius: 8, fontSize: 13 }
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {(issues || []).length > 0 && (
        <div style={box}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>⚠️ ซีรีส์ที่ใช้ไม่มีแบบเหล่านี้ ({issues.length} รายการ) คิดราคาไม่ได้จนกว่าจะเปลี่ยน</div>
          <ul style={{ margin: '0 0 0 18px' }}>
            {issues.map((x, i) => (
              <li key={i}>
                {x.item.opening_no}{x.item.item_name ? ` · ${x.item.item_name}` : ''}: {x.which === 'addon' ? 'ชุดต่อเติม ' : ''}{x.template.name}
                {' — '}{x.offeredBy.length ? `มีในซีรีส์ ${x.offeredBy.join(', ')}` : 'ยังไม่มีซีรีส์ไหนทำแบบนี้'}
              </li>
            ))}
          </ul>
        </div>
      )}
      {missing.length > 0 && (
        <div style={box}>⚠️ ประเภท {missing.map(id => (typeNames || {})[id] || id).join(', ')} ยังไม่ได้กำหนดชุดอุปกรณ์ คิดราคาโดยไม่มีชุด</div>
      )}
      {wrong && <div style={box}>⚠️ ชุดนี้ไม่ใช่ของซีรีส์ที่เลือก</div>}
    </div>
  )
}
