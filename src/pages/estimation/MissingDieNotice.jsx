// src/pages/estimation/MissingDieNotice.jsx
// Warning on the cut sheet and the stickers: which profiles have no die no. yet (missing = projectBomHelpers.missingDieNos).
// The die no. is alu_profiles.drawing_no, entered in the aluminium catalogue.
export default function MissingDieNotice({ missing }) {
  if (!missing) return null
  const series = missing.series.length ? ` (ซีรีส์ ${missing.series.join(', ')})` : ''
  return (
    <div className="alert alert-warning" style={{ fontSize: 13, margin: 0 }}>
      {`หน้าตัด ${missing.names.length} ตัวยังไม่มีรหัส: ${missing.names.join(', ')}${series} — กรอกในแคตตาล็อก`}
      <span style={{ fontSize: 12 }}>{' (เมนู แคตตาล็อกอลูมิเนียม › หน้าตัด · สี · ความยาว › DIE NO.)'}</span>
    </div>
  )
}
