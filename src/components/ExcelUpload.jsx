// ============================================================
// ExcelUpload — Drag & Drop Excel → Parse → Insert to Supabase
// รองรับ template รายจ่าย และ รายรับ
// ============================================================
import { useState, useRef, useMemo } from 'react'
import * as XLSX from 'xlsx'
import { supabase, fmt } from '../lib/supabase.js'
import { Modal } from './Modal.jsx'
import SearchableSelect from './SearchableSelect.jsx'

function excelDate(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v)
    return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`
  }
  return String(v).slice(0, 10)
}

const PAYMENT_METHOD_OPTS = ['transfer', 'check', 'cash', 'credit']
function normalizePaymentMethod(raw) {
  const s = String(raw || '').trim().toLowerCase()
  if (s.includes('cash') || s.includes('เงินสด')) return 'cash'
  if (s.includes('credit') || s.includes('เครดิต')) return 'credit'
  if (s.includes('check') || s.includes('เช็ค') || s.includes('เชค')) return 'check'
  if (s.includes('transfer') || s.includes('โอน')) return 'transfer'
  return PAYMENT_METHOD_OPTS.includes(s) ? s : 'transfer'
}

const PAYMENT_STATUS_OPTS = ['paid', 'pending', 'check_issued', 'check_cleared']
function normalizePaymentStatus(raw) {
  const s = String(raw || '').trim().toLowerCase()
  if (s.includes('paid') || s.includes('จ่ายแล้ว') || s.includes('ชำระแล้ว')) return 'paid'
  if (s.includes('check_cleared') || s.includes('เช็คขึ้นแล้ว')) return 'check_cleared'
  if (s.includes('check_issued') || s.includes('ออกเช็ค')) return 'check_issued'
  return PAYMENT_STATUS_OPTS.includes(s) ? s : 'pending'
}

/**
 * parseExpenseSheet — แปลง rows จาก template รายจ่าย (ค่าของ/วัสดุ เท่านั้น —
 * ค่าแรงช่างเหมาไปเข้าหน้า "ผู้รับเหมาช่วง" แทน) เป็น array of objects
 * ต้องตรงกับ TEMPLATE_รายจ่าย.xlsx (header อยู่ row 4, data เริ่ม row 6)
 *
 * Column order: Invoice no., วันที่สั่งสินค้า, หมวดหมู่สินค้า, รายละเอียด,
 * รหัสไซท์งาน, ชื่อ Supplier, VAT/NO VAT, มูลค่าก่อน VAT, มูลค่ารวม VAT,
 * วิธีชำระ, วันที่ชำระ, สถานะจ่าย
 */
async function parseExpenseSheet(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })
  const headerRowIdx = rows.findIndex(r => r.some(c => typeof c === 'string' && c.includes('วันที่')))
  if (headerRowIdx < 0) throw new Error('ไม่พบแถว header ในชีท รายจ่าย')

  const dataRows = rows.slice(headerRowIdx + 2) // ข้าม header + hint row

  const { data: sitesData } = await supabase.from('sites').select('id, site_number, name')
  const siteMap = {}
  sitesData?.forEach(s => { siteMap[s.site_number] = s.id; siteMap[s.name] = s.id })

  const { data: catsData } = await supabase.from('expense_categories').select('id, name')
  const catMap = {}
  catsData?.forEach(c => { catMap[c.name] = c.id })

  // Suppliers: exact-match by name. Unmatched rows are NOT blocked like
  // site/category — per spec, a new supplier gets auto-created at import
  // time (see handleImport). Preview still lets the user redirect an
  // unmatched row to an existing supplier first, in case it's just a
  // spelling variant of one that already exists.
  const { data: suppliersData } = await supabase.from('suppliers').select('id, name')
  const supplierMap = {}
  suppliersData?.forEach(s => { supplierMap[s.name] = s.id })

  const records = []
  for (const row of dataRows) {
    const invoiceNo  = row[0]
    const dateCell   = row[1]
    const catName    = row[2]
    const description = row[3]
    const siteCode   = row[4]
    const supplierName = row[5] ? String(row[5]).trim() : ''
    const vatFlag    = String(row[6] || '').trim().toLowerCase()
    const priceBeforeVat = row[7] != null ? parseFloat(row[7]) : null
    const priceAfterVat  = row[8] != null ? parseFloat(row[8]) : null
    if (!dateCell && priceAfterVat == null && priceBeforeVat == null) continue // skip empty rows

    // amount (VAT-inclusive) is the ground truth for what was actually
    // paid; amount_no_vat/vat are derived from whichever of the two price
    // columns is present. The VAT/NO VAT column is a hint, not the source
    // of truth, so a row still imports sensibly even if it disagrees with
    // the numbers (e.g. marked "NO VAT" but only "มูลค่ารวม VAT" filled in).
    let amount, amountNoVat
    if (priceAfterVat != null && priceBeforeVat != null) {
      amount = priceAfterVat
      amountNoVat = priceBeforeVat
    } else if (priceAfterVat != null) {
      amount = priceAfterVat
      amountNoVat = vatFlag.includes('no') ? priceAfterVat : priceAfterVat
    } else if (priceBeforeVat != null) {
      amount = priceBeforeVat
      amountNoVat = priceBeforeVat
    } else {
      continue // no usable amount at all
    }
    if (!amount) continue
    const vat = parseFloat((amount - amountNoVat).toFixed(2))

    records.push({
      invoice_no:      invoiceNo || '',
      date:            excelDate(dateCell),
      description:     description || '',
      site_id:         siteMap[siteCode] || null,
      category_id:     catMap[catName] || null,
      supplier:        supplierName,
      supplier_id:     supplierMap[supplierName] || null,
      _newSupplierName: !supplierMap[supplierName] && supplierName ? supplierName : null,
      amount,
      amount_no_vat:   amountNoVat,
      vat,
      payment_method:  normalizePaymentMethod(row[9]),
      check_date:      excelDate(row[10]),
      status:          normalizePaymentStatus(row[11]),
    })
  }
  return records
}

const round2 = (n) => Math.round(n * 100) / 100

/**
 * calcIncomeAmounts — VAT / withholding tax / retention are never entered
 * per-row; they're derived from whichever site the row belongs to, same
 * as the manual "เพิ่มรายรับ" form's auto-fill (Income.jsx: site.default_
 * vat_pct/default_tax_withheld_pct/default_retention_pct). Exported here
 * so both the initial parse and a later site correction in the preview
 * (updateRowSite) can recompute identically.
 */
function calcIncomeAmounts(noVat, site) {
  const vat            = round2(noVat * (site?.default_vat_pct ?? 0) / 100)
  const taxWithheld     = round2(noVat * (site?.default_tax_withheld_pct ?? 0) / 100)
  const retention       = round2(noVat * (site?.default_retention_pct ?? 0) / 100)
  const receivedAmount = round2(noVat + vat - taxWithheld - retention)
  return { vat, taxWithheld, retention, receivedAmount }
}

/**
 * parseIncomeSheet — แปลง rows จาก template รายรับ. Only มูลค่าก่อน VAT is
 * entered per-row; VAT/tax/retention/ยอดที่ได้รับจริง are all calculated
 * from the matched site's own default percentages (calcIncomeAmounts).
 */
async function parseIncomeSheet(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })
  const headerRowIdx = rows.findIndex(r => r.some(c => typeof c === 'string' && c.includes('วันที่')))
  if (headerRowIdx < 0) throw new Error('ไม่พบแถว header ในชีท รายรับ')

  const dataRows = rows.slice(headerRowIdx + 2)

  const { data: sitesData } = await supabase.from('sites')
    .select('id, site_number, name, default_vat_pct, default_tax_withheld_pct, default_retention_pct')
  const siteMap = {}
  sitesData?.forEach(s => { siteMap[s.site_number] = s; siteMap[s.name] = s })

  const records = []
  for (const row of dataRows) {
    if (!row[1]) continue
    const dateVal = excelDate(row[1])
    const noVat = parseFloat(row[5]) || 0
    if (noVat === 0) continue

    const site = siteMap[row[2]] || null
    const { vat, taxWithheld, retention, receivedAmount } = calcIncomeAmounts(noVat, site)

    records.push({
      invoice_no:      row[0] || '',
      date:            dateVal,
      site_id:         site?.id || null,
      client_name:     row[3] || '',
      description:     row[4] || '',
      amount_no_vat:   noVat,
      vat,
      tax_withheld:    taxWithheld,
      retention,
      received_amount: receivedAmount,
    })
  }
  return records
}

// sites.status has a DB CHECK constraint allowing only these exact strings
// (same list as Sites.jsx's STATUS_OPTS) — free-text Excel input rarely
// matches exactly (case, Thai wording, extra spaces), so normalize on
// import instead of passing the raw cell straight to insert.
const SITE_STATUS_OPTS = ['Ongoing', 'Completed', 'On Hold', 'Cancelled']
function normalizeSiteStatus(raw) {
  const s = String(raw || '').trim().toLowerCase()
  const match = SITE_STATUS_OPTS.find(opt => opt.toLowerCase() === s)
  return match || 'Ongoing'
}

async function parseSiteSheet(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })
  const headerRowIdx = rows.findIndex(r => r.some(c => typeof c === 'string' && c.includes('ชื่อไซท์งาน')))
  if (headerRowIdx < 0) throw new Error('ไม่พบแถว header (ชื่อไซท์งาน) ในชีท')
  const dataRows = rows.slice(headerRowIdx + 2)
  const { data: clientsData } = await supabase.from('clients').select('id, name, client_number')
  const clientMap = {}
  clientsData?.forEach(c => { clientMap[c.name] = c.id; clientMap[c.client_number] = c.id })
  const records = []
  for (const row of dataRows) {
    if (!row[0]) continue
    records.push({
      name:           String(row[0]),
      client_id:      clientMap[row[1]] || null,
      location:       row[2] || null,
      status:         normalizeSiteStatus(row[3]),
      start_date:     row[4] ? String(row[4]).slice(0,10) : null,
      end_date:       row[5] ? String(row[5]).slice(0,10) : null,
      contract_value: parseFloat(row[6]) || null,
      cost_glass:     parseFloat(row[7]) || null,
      cost_aluminum:  parseFloat(row[8]) || null,
      cost_equipment: parseFloat(row[9]) || null,
      cost_rubber:    parseFloat(row[10]) || null,
    })
  }
  return records
}

async function parseClientSheet(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })
  const headerRowIdx = rows.findIndex(r => r.some(c => typeof c === 'string' && c.includes('ชื่อลูกค้า')))
  if (headerRowIdx < 0) throw new Error('ไม่พบแถว header (ชื่อลูกค้า)')
  const dataRows = rows.slice(headerRowIdx + 2)
  const records = []
  for (const row of dataRows) {
    if (!row[0]) continue
    records.push({
      name:           String(row[0]),
      contact_person: row[1] || null,
      position:       row[2] || null,
      phone:          row[3] ? String(row[3]) : null,
      email:          row[4] || null,
      client_type:    row[5] || null,
    })
  }
  return records
}

async function parseSupplierSheet(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })
  const headerRowIdx = rows.findIndex(r => r.some(c => typeof c === 'string' && (c.includes('Supplier') || c.includes('supplier'))))
  if (headerRowIdx < 0) throw new Error('ไม่พบแถว header (Supplier)')
  const dataRows = rows.slice(headerRowIdx + 2)
  const records = []
  for (const row of dataRows) {
    if (!row[0]) continue
    records.push({
      name:           String(row[0]),
      contact_person: row[1] || null,
      phone:          row[2] ? String(row[2]) : null,
      email:          row[3] || null,
      category:       row[4] || null,
      payment_terms:  row[5] || null,
      address:        row[6] || null,
      notes:          row[7] || null,
    })
  }
  return records
}

export default function ExcelUpload({ type = 'expense', onSuccess }) {
  // type: 'expense' | 'income'
  const [dragging, setDragging] = useState(false)
  const [preview, setPreview] = useState(null)   // parsed rows before insert
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [sites, setSites] = useState([])         // for the site-correction dropdown (expense/income only)
  const [categories, setCategories] = useState([]) // for the category-correction dropdown (expense only)
  const [suppliers, setSuppliers] = useState([])   // for the supplier-redirect dropdown (expense only)
  const fileRef = useRef()

  const siteOpts = useMemo(() => sites.map(s => ({
    value: s.id, label: `${s.site_number} · ${s.name}`, keywords: `${s.site_number} ${s.name}`,
  })), [sites])

  const categoryOpts = useMemo(() => categories.map(c => ({
    value: c.id, label: c.name, keywords: c.name,
  })), [categories])

  const supplierOpts = useMemo(() => suppliers.map(s => ({
    value: s.id, label: s.name, keywords: s.name,
  })), [suppliers])

  const updateRowSite = (i, siteId) => {
    setPreview(prev => prev.map((r, idx) => {
      if (idx !== i) return r
      if (type === 'income') {
        // VAT/tax/retention depend on the site's own percentages -- redo
        // the calc so correcting an unmatched site also fixes these,
        // instead of leaving them stuck at whatever (usually zero) the
        // initial parse computed before a site was known.
        const site = sites.find(s => s.id === siteId)
        const { vat, taxWithheld, retention, receivedAmount } = calcIncomeAmounts(r.amount_no_vat, site)
        return { ...r, site_id: siteId, vat, tax_withheld: taxWithheld, retention, received_amount: receivedAmount }
      }
      return { ...r, site_id: siteId }
    }))
  }

  const updateRowCategory = (i, categoryId) => {
    setPreview(prev => prev.map((r, idx) => idx === i ? { ...r, category_id: categoryId } : r))
  }

  // picking an existing supplier from the dropdown means this row is no
  // longer a "create new" candidate — clear the marker so handleImport
  // doesn't also create a duplicate.
  const updateRowSupplier = (i, supplierId) => {
    setPreview(prev => prev.map((r, idx) => idx === i ? { ...r, supplier_id: supplierId, _newSupplierName: null } : r))
  }

  const updateRowField = (i, key, value) => {
    setPreview(prev => prev.map((r, idx) => idx === i ? { ...r, [key]: value } : r))
  }

  const processFile = async (file) => {
    setError(null)
    try {
      const buf = await file.arrayBuffer()
      const wb  = XLSX.read(buf, { type: 'array', cellDates: false })
      const sheetName = wb.SheetNames[0]
      const ws = wb.Sheets[sheetName]

      // Excel site names/codes are typed offline and often don't match the
      // system exactly (typos, abbreviation variants like MFPK/MFDK/MFKP) —
      // fetch the site list so unmatched rows can be corrected by hand in
      // the preview instead of silently importing with no site.
      if (type === 'expense' || type === 'income') {
        const { data: sitesData } = await supabase.from('sites')
          .select('id, site_number, name, default_vat_pct, default_tax_withheld_pct, default_retention_pct')
          .order('site_number')
        setSites(sitesData || [])
      }
      if (type === 'expense') {
        const { data: catsData } = await supabase.from('expense_categories').select('id, name').order('sort_order')
        setCategories(catsData || [])
        const { data: supData } = await supabase.from('suppliers').select('id, name').order('name')
        setSuppliers(supData || [])
      }

      const records =
        type === 'expense'  ? await parseExpenseSheet(ws)  :
        type === 'income'   ? await parseIncomeSheet(ws)   :
        type === 'site'     ? await parseSiteSheet(ws)     :
        type === 'client'   ? await parseClientSheet(ws)   :
                              await parseSupplierSheet(ws)

      if (!records.length) throw new Error('ไม่พบข้อมูลในไฟล์ กรุณาตรวจสอบ format')
      setPreview(records)
    } catch (e) {
      setError(e.message)
    }
  }

  const handleDrop = (e) => {
    e.preventDefault(); setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) processFile(file)
  }

  const handleImport = async () => {
    if (!preview?.length) return
    setLoading(true)
    try {
      let rows = preview

      if (type === 'expense') {
        // Rows still marked _newSupplierName (the user didn't redirect them
        // to an existing supplier in the preview) get a brand-new supplier
        // row created now, right before the expenses themselves are
        // inserted — not at parse time, so cancelling the import creates
        // nothing. One insert per distinct new name, even if several rows
        // share it, so we don't create duplicate suppliers for the same
        // name appearing on multiple expense rows.
        const newNames = [...new Set(rows.filter(r => r._newSupplierName).map(r => r._newSupplierName))]
        if (newNames.length) {
          const { data: created, error: supErr } = await supabase
            .from('suppliers').insert(newNames.map(name => ({ name }))).select('id, name')
          if (supErr) throw supErr
          const createdMap = {}
          created.forEach(s => { createdMap[s.name] = s.id })
          rows = rows.map(r => r._newSupplierName
            ? { ...r, supplier_id: createdMap[r._newSupplierName] || r.supplier_id }
            : r)
        }
        // _newSupplierName is a preview-only marker, not a real expenses column
        rows = rows.map(({ _newSupplierName, ...rest }) => rest)
      }

      const table =
        type === 'expense'  ? 'expenses'  :
        type === 'income'   ? 'incomes'   :
        type === 'site'     ? 'sites'     :
        type === 'client'   ? 'clients'   :
                              'suppliers'
      const { error } = await supabase.from(table).insert(rows)
      if (error) throw error
      setPreview(null)
      onSuccess?.(`นำเข้าสำเร็จ ${rows.length} รายการ`)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const label =
    type === 'expense'  ? 'รายจ่าย'   :
    type === 'income'   ? 'รายรับ'    :
    type === 'site'     ? 'ไซท์งาน'  :
    type === 'client'   ? 'ลูกค้า'   :
                          'Supplier'

  return (
    <>
      {/* Drop zone */}
      <div
        className={`drop-zone ${dragging ? 'active' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileRef.current?.click()}
      >
        <div style={{ fontSize: 28, marginBottom: 8 }}>📥</div>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          วาง Excel {label} ที่นี่
        </div>
        <div style={{ fontSize: 12 }}>
          หรือคลิกเพื่อเลือกไฟล์ (.xlsx) — ต้องใช้ TEMPLATE_{label}.xlsx
        </div>
        <input
          ref={fileRef} type="file" accept=".xlsx"
          style={{ display: 'none' }}
          onChange={(e) => e.target.files[0] && processFile(e.target.files[0])}
        />
      </div>

      {error && <div className="alert alert-error" style={{ marginTop: 8 }}>⚠️ {error}</div>}

      {/* Preview modal */}
      {preview && (
        <Modal title={`ตัวอย่างข้อมูล${label} (${preview.length} รายการ)`} onClose={() => setPreview(null)} maxWidth={800}>
          <div className="modal-body">
            <div className="alert alert-info" style={{ marginBottom: 12 }}>
              ตรวจสอบข้อมูลก่อนนำเข้า — ระบบจะ insert ทั้งหมดเข้า Supabase
            </div>
            <div className="table-wrap" style={{ maxHeight: 320 }}>
              <table>
                <thead>
                  <tr>
                    {type === 'expense' ? <>
                      <th>Invoice no.</th><th>วันที่</th><th>รายละเอียด</th><th>ไซท์</th><th>หมวด</th><th>Supplier</th><th>มูลค่า (รวม VAT)</th><th>สถานะ</th>
                    </> : type === 'income' ? <>
                      <th>เลขใบแจ้งหนี้</th><th>วันที่</th><th>ไซท์</th><th>ลูกค้า</th><th>ยอดรับจริง</th>
                    </> : type === 'site' ? <>
                      <th>ชื่อไซท์งาน</th><th>ลูกค้า</th><th>สถานะ</th><th>มูลค่าสัญญา</th><th>วันจบงาน</th>
                    </> : type === 'client' ? <>
                      <th>ชื่อลูกค้า / บริษัท</th><th>ผู้ติดต่อ</th><th>ตำแหน่ง</th><th>เบอร์โทร</th><th>ประเภท</th>
                    </> : <>
                      <th>ชื่อ Supplier</th><th>หมวดสินค้า</th><th>ผู้ติดต่อ</th><th>เบอร์โทร</th><th>เงื่อนไขชำระ</th>
                    </>}
                  </tr>
                </thead>
                <tbody>
                  {preview.slice(0, 50).map((r, i) => (
                    <tr key={i}>
                      {type === 'expense' ? <>
                        <td style={{ fontSize: 11, color: 'var(--accent)' }}>{r.invoice_no || '—'}</td>
                        <td>{r.date}</td>
                        <td style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.description}</td>
                        <td style={{ minWidth: 150 }}>
                          {r.site_id ? <span style={{ color: 'var(--green)', fontSize: 11 }}>✓</span> : (
                            <SearchableSelect value={r.site_id} onChange={id => updateRowSite(i, id)}
                              placeholder="⚠️ ไม่พบไซท์ — เลือกเอง" options={siteOpts} />
                          )}
                        </td>
                        <td style={{ minWidth: 150 }}>
                          {r.category_id ? <span style={{ color: 'var(--green)', fontSize: 11 }}>✓</span> : (
                            <SearchableSelect value={r.category_id} onChange={id => updateRowCategory(i, id)}
                              placeholder="⚠️ ไม่พบหมวด — เลือกเอง" options={categoryOpts} />
                          )}
                        </td>
                        <td style={{ minWidth: 150 }}>
                          {r.supplier_id ? (
                            <span style={{ color: 'var(--green)', fontSize: 11 }}>✓ {r.supplier}</span>
                          ) : r._newSupplierName ? (
                            <div>
                              <div style={{ color: 'var(--yellow)', fontSize: 11, marginBottom: 3 }}>🆕 จะสร้างใหม่: {r._newSupplierName}</div>
                              <SearchableSelect value={null} onChange={id => updateRowSupplier(i, id)}
                                placeholder="หรือเลือก Supplier ที่มีอยู่แล้ว" options={supplierOpts} />
                            </div>
                          ) : <span style={{ color: 'var(--text3)', fontSize: 11 }}>— ไม่ระบุ —</span>}
                        </td>
                        <td style={{ color: 'var(--red)', fontWeight: 600 }}>
                          {fmt(r.amount)}
                          {r.vat > 0 && <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 400 }}>VAT {fmt(r.vat)}</div>}
                        </td>
                        <td><span className={`badge badge-${r.status}`}>{r.status}</span></td>
                      </> : type === 'income' ? <>
                        <td style={{ fontSize: 11, color: 'var(--accent)' }}>{r.invoice_no || '(auto)'}</td>
                        <td>{r.date}</td>
                        <td style={{ minWidth: 160 }}>
                          {r.site_id ? <span style={{ color: 'var(--green)', fontSize: 11 }}>✓</span> : (
                            <SearchableSelect value={r.site_id} onChange={id => updateRowSite(i, id)}
                              placeholder="⚠️ ไม่พบไซท์ — เลือกเอง" options={siteOpts} />
                          )}
                        </td>
                        <td style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.client_name}</td>
                        <td style={{ color: 'var(--green)', fontWeight: 600 }}>
                          {fmt(r.received_amount)}
                          <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 400 }}>
                            VAT {fmt(r.vat)} · หัก ณ ที่จ่าย {fmt(r.tax_withheld)} · Retention {fmt(r.retention)}
                          </div>
                        </td>
                      </> : type === 'site' ? <>
                        <td style={{ fontWeight: 600 }}>{r.name}</td>
                        <td style={{ fontSize: 11, color: r.client_id ? 'var(--green)' : 'var(--text3)' }}>{r.client_id ? '✓ linked' : r.client_name || '—'}</td>
                        <td>
                          <select className="select" style={{ fontSize: 12, padding: '2px 6px' }}
                            value={r.status || 'Ongoing'} onChange={e => updateRowField(i, 'status', e.target.value)}>
                            {SITE_STATUS_OPTS.map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </td>
                        <td style={{ color: 'var(--text2)', fontVariantNumeric: 'tabular-nums' }}>{r.contract_value ? fmt(r.contract_value) : '—'}</td>
                        <td style={{ fontSize: 12 }}>{r.end_date || '—'}</td>
                      </> : type === 'client' ? <>
                        <td style={{ fontWeight: 600 }}>{r.name}</td>
                        <td>{r.contact_person || '—'}</td>
                        <td style={{ fontSize: 12 }}>{r.position || '—'}</td>
                        <td style={{ fontSize: 12 }}>{r.phone || '—'}</td>
                        <td style={{ fontSize: 11 }}>{r.client_type || '—'}</td>
                      </> : <>
                        <td style={{ fontWeight: 600 }}>{r.name}</td>
                        <td><span className="badge">{r.category || '—'}</span></td>
                        <td>{r.contact_person || '—'}</td>
                        <td style={{ fontSize: 12 }}>{r.phone || '—'}</td>
                        <td style={{ fontSize: 12 }}>{r.payment_terms || '—'}</td>
                      </>}
                    </tr>
                  ))}
                  {preview.length > 50 && (
                    <tr><td colSpan={type === 'expense' ? 8 : 5} style={{ textAlign: 'center', color: 'var(--text3)', padding: 8 }}>
                      ... และอีก {preview.length - 50} รายการ
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-ghost" onClick={() => setPreview(null)}>ยกเลิก</button>
            <button className="btn btn-success" onClick={handleImport} disabled={loading}>
              {loading ? '⏳ กำลังนำเข้า...' : `✅ นำเข้า ${preview.length} รายการ`}
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}
