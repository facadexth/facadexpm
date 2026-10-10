// Starting guide (new tenants): the checklist and how each step is judged done.
// Progress is read from the tenant's real data, never from ticks the user
// makes by hand -- so it is right on every device and nothing extra is stored.
// Pure on purpose: the page fetches the facts, this file decides.

// go = App tab id the "ไปทำ" button opens. module = tenant module needed to do
// the step at all (null = always available); a step whose module is missing is
// shown as "ไม่รวมในแพ็กเกจ" and left out of the percentage.
export const GUIDE_STEPS = [
  {
    id: 'signup', title: 'สมัครสมาชิกและเข้าสู่ระบบ', go: null, module: null,
    why: 'ต้องมีบัญชีก่อน ข้อมูลทุกอย่างจะผูกกับบริษัทของคุณ',
  },
  {
    id: 'company', title: 'ใส่ข้อมูลบริษัทและบัญชีธนาคาร', go: 'settings', module: null,
    why: 'ชื่อ ที่อยู่ เลขผู้เสียภาษี และบัญชีธนาคาร จะขึ้นในเอกสารทุกใบที่ส่งให้ลูกค้า',
  },
  {
    id: 'client', title: 'เพิ่มลูกค้า', go: 'clients', module: null,
    why: 'ใบเสนอราคาและใบแจ้งหนี้ต้องเลือกลูกค้า ใส่ครั้งเดียวใช้ได้ทุกครั้ง',
  },
  {
    id: 'quotation', title: 'ออกใบเสนอราคา', go: 'quotations', module: 'quotations',
    why: 'เป็นต้นทางของงาน ลูกค้าอนุมัติแล้วต่อไปเป็นใบแจ้งหนี้ได้โดยไม่ต้องคีย์ซ้ำ',
  },
  {
    id: 'site', title: 'ผูกไซท์งาน', go: 'sites', module: null,
    why: 'รายรับรายจ่ายของงานนั้นจะรวมอยู่ที่เดียว เห็นกำไรเบื้องต้นได้',
  },
  {
    id: 'invoice', title: 'ออกใบแจ้งหนี้ใบแรก', go: 'invoices', module: 'invoices',
    why: 'เก็บเงินตามงวดงาน เลือกหักมัดจำก่อน VAT ได้ และตัดสต็อกตามใบแจ้งหนี้',
  },
  {
    id: 'line', title: 'เชื่อม LINE (ไม่บังคับ)', go: 'communication_center', module: 'line_bot', optional: true,
    why: 'เพิ่มเพื่อนบอทของ CHANG แล้วเชื่อมกลุ่มทีมงาน เพื่อรับข้อความที่เกี่ยวกับงาน',
  },
]

const filled = v => typeof v === 'string' && v.trim().length > 0

// facts: { tenant, bankAccounts, clients, quotations, sites, invoices, lineConnected }
export function isStepDone(id, facts) {
  const f = facts || {}
  switch (id) {
    case 'signup':    return true
    case 'company': {
      const t = f.tenant || {}
      const bankOk = (f.bankAccounts || 0) > 0 || filled(t.bank_account_no)
      return filled(t.company_name) && filled(t.address) && filled(t.tax_id) && bankOk
    }
    case 'client':    return (f.clients || 0) > 0
    case 'quotation': return (f.quotations || 0) > 0
    case 'site':      return (f.sites || 0) > 0
    case 'invoice':   return (f.invoices || 0) > 0
    case 'line':      return !!f.lineConnected
    default:          return false
  }
}

// hasModule: (key) => boolean (useTenant().hasModuleAccess)
export function computeGuide(facts, hasModule = () => true) {
  const steps = GUIDE_STEPS.map(s => {
    const locked = s.module != null && !hasModule(s.module)
    return { ...s, locked, done: !locked && isStepDone(s.id, facts) }
  })
  // Optional steps (LINE) still show their own tick but never hold the guide open.
  const counted = steps.filter(s => !s.locked && !s.optional)
  const done = counted.filter(s => s.done).length
  const total = counted.length
  const next = counted.find(s => !s.done) || null
  return { steps, done, total, pct: total ? Math.round((done / total) * 100) : 0, next, complete: total > 0 && done === total }
}
