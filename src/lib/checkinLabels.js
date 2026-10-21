// Labels for FieldFormPage's เช็คอิน/เช็คเอาท์ screen. A site link keeps the original
// wording; a fixed-location link (office admin with no site today, 2026-10-21) puts the
// place in the title: "เช็คอินที่ สำนักงาน".
export function checkinPageLabels({ actionType, workerName, siteName, placeKind }) {
  const verb = actionType === 'check_in' ? 'เช็คอิน' : 'เช็คเอาท์'
  if (placeKind === 'location') {
    return { title: `📍 ${verb}ที่ ${siteName}`, subtitle: `สวัสดีครับคุณ${workerName}`, farFrom: 'ห่างจากตำแหน่งที่กำหนด' }
  }
  return { title: `📍 ${verb}`, subtitle: `สวัสดีครับคุณ${workerName} — ${siteName}`, farFrom: 'ห่างจากไซท์งาน' }
}
