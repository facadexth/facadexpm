// After an ADMIN/OWNER login is created, say whether it is tied to an
// employee record in HR. The tie is workers.email = the login email; it is
// what lets the person see their own leave and check-in data.
//
// Returns { kind: 'linked' | 'name_match' | 'none', worker? }:
//  linked      a worker already carries this email
//  name_match  an employee with the same name exists but has no email yet
//              (likely the same person -- add the email there, don't make a duplicate)
//  none        no employee record at all

const norm = (s) => String(s || '').trim().toLowerCase()

export function linkHint({ email, name, workers }) {
  const list = workers || []
  const byEmail = list.find(w => norm(w.email) && norm(w.email) === norm(email))
  if (byEmail) return { kind: 'linked', worker: byEmail }
  const wanted = norm(name)
  if (wanted) {
    const byName = list.find(w => !norm(w.email) && (norm(w.name) === wanted || norm(w.nickname) === wanted))
    if (byName) return { kind: 'name_match', worker: byName }
  }
  return { kind: 'none' }
}

export function linkHintMessage(hint) {
  if (hint.kind === 'name_match') {
    return `พบพนักงานชื่อ "${hint.worker.name}" ในหน้าบุคคลที่ยังไม่มีอีเมล ถ้าเป็นคนเดียวกัน ให้ไปใส่อีเมลนี้ในข้อมูลพนักงานคนนั้น (อย่าสร้างซ้ำ) เพื่อให้เห็นข้อมูลลาและเช็คอินของตัวเอง`
  }
  if (hint.kind === 'none') {
    return 'ยังไม่มีข้อมูลพนักงานผูกกับอีเมลนี้ ถ้าคนนี้เป็นพนักงานด้วย ให้ไปเพิ่มในหน้าบุคคล โดยใส่อีเมลเดียวกัน เพื่อให้เห็นข้อมูลลาและเช็คอินของตัวเอง'
  }
  return null
}
