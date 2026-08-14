// ============================================================
// ExcelUpload — Drag & Drop Excel → Parse → Insert to Supabase
// รองรับ template รายจ่าย และ รายรับ
// ============================================================
import { useState, useRef, useMemo } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase.js'
import { Modal } from './Modal.jsx'
import SearchableSelect from './SearchableSelect.jsx'

/**
 * parseExpenseSheet — แปลง rows จาก template รายจ่าย เป็น array of objects
 * ต้องตรงกับ TEMPLATE_รายจ่าย.xlsx (header อยู่ row 4, data เริ่ม row 6)
 */
async function parseExpenseSheet(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })
  // หาแถว header (มีคำว่า "วันที่" หรือ "รายละเอียด")
  const headerRowIdx = rows.findIndex(r => r.some(c => typeof c === 'string' && c.includes('วันที่')))
  if (headerRowIdx < 0) throw new Error('ไม่พบแถว header ในชีท รายจ่าย')

  const dataRows = rows.slice(headerRowIdx + 2) // ข้าม header + hint row

  // ดึง site_id จาก site_number
  const { data: sitesData } = await supabase.from('sites').select('id, site_number, name')
  const siteMap = {}
  sitesData?.forEach(s => { siteMap[s.site_number] = s.id; siteMap[s.name] = s.id })

  // ดึง category_id จากชื่อ
  const { data: catsData } = await supabase.from('expense_categories').select('id, name')
  const catMap = {}
  catsData?.forEach(c => { catMap[c.name] = c.id })

  const records = []
  for (const row of dataRows) {
    if (!row[0] && !row[5]) continue // skip empty rows
    const siteCode = row[2]
    const catName  = row[3]
    const amt      = parseFloat(row[5]) || 0
    if (amt === 0) continue

    // Convert Excel date serial if needed
    let dateVal = row[0]
    if (typeof dateVal === 'number') {
      dateVal = XLSX.SSF.parse_date_code(dateVal)
      dateVal = `${dateVal.y}-${String(dateVal.m).padStart(2,'0')}-${String(dateVal.d).padStart(2,'0')}`
    } else if (dateVal) {
      dateVal = String(dateVal).slice(0, 10)
    }

    records.push({
      date:            dateVal,
      description:     row[1] || '',
      site_id:         siteMap[siteCode] || null,
      category_id:     catMap[catName] || null,
      supplier:        row[4] || '',
      amount:          amt,
      payment_method:  row[6] || 'transfer',
      check_date:      row[7] ? String(row[7]).slice(0,10) : null,
      status:          row[8] || 'pending',
      payer:           row[9] || '',
      notes:           row[10] || '',
      invoice_no:      row[11] || '',
    })
  }
  return records
}

/**
 * parseIncomeSheet — แปลง rows จาก template รายรับ
 */
async function parseIncomeSheet(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })
  const headerRowIdx = rows.findIndex(r => r.some(c => typeof c === 'string' && c.includes('วันที่')))
  if (headerRowIdx < 0) throw new Error('ไม่พบแถว header ในชีท รายรับ')

  const dataRows = rows.slice(headerRowIdx + 2)

  const { data: sitesData } = await supabase.from('sites').select('id, site_number')
  const siteMap = {}
  sitesData?.forEach(s => { siteMap[s.site_number] = s.id })

  const records = []
  for (const row of dataRows) {
    if (!row[1]) continue
    let dateVal = row[1]
    if (typeof dateVal === 'number') {
      dateVal = XLSX.SSF.parse_date_code(dateVal)
      dateVal = `${dateVal.y}-${String(dateVal.m).padStart(2,'0')}-${String(dateVal.d).padStart(2,'0')}`
    } else {
      dateVal = String(dateVal).slice(0, 10)
    }
    const noVat = parseFloat(row[5]) || 0
    if (noVat === 0) continue

    records.push({
      invoice_no:      row[0] || '',
      date:            dateVal,
      site_id:         siteMap[row[2]] || null,
      client_name:     row[3] || '',
      description:     row[4] || '',
      amount_no_vat:   noVat,
      vat:             parseFloat(row[6]) || 0,
      tax_withheld:    parseFloat(row[7]) || 0,
      retention:       parseFloat(row[8]) || 0,
      received_amount: parseFloat(row[9]) || (noVat + (parseFloat(row[6]) || 0)),
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
      cost_labor:     parseFloat(row[11]) || null,
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
  const fileRef = useRef()

  const siteOpts = useMemo(() => sites.map(s => ({
    value: s.id, label: `${s.site_number} · ${s.name}`, keywords: `${s.site_number} ${s.name}`,
  })), [sites])

  const updateRowSite = (i, siteId) => {
    setPreview(prev => prev.map((r, idx) => idx === i ? { ...r, site_id: siteId } : r))
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
        const { data: sitesData } = await supabase.from('sites').select('id, site_number, name').order('site_number')
        setSites(sitesData || [])
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
      const table =
        type === 'expense'  ? 'expenses'  :
        type === 'income'   ? 'incomes'   :
        type === 'site'     ? 'sites'     :
        type === 'client'   ? 'clients'   :
                              'suppliers'
      const { error } = await supabase.from(table).insert(preview)
      if (error) throw error
      setPreview(null)
      onSuccess?.(`นำเข้าสำเร็จ ${preview.length} รายการ`)
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
                      <th>วันที่</th><th>รายละเอียด</th><th>ไซท์</th><th>หมวด</th><th>มูลค่า</th><th>สถานะ</th>
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
                        <td>{r.date}</td>
                        <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.description}</td>
                        <td style={{ minWidth: 160 }}>
                          {r.site_id ? <span style={{ color: 'var(--green)', fontSize: 11 }}>✓</span> : (
                            <SearchableSelect value={r.site_id} onChange={id => updateRowSite(i, id)}
                              placeholder="⚠️ ไม่พบไซท์ — เลือกเอง" options={siteOpts} />
                          )}
                        </td>
                        <td style={{ color: r.category_id ? 'var(--text2)' : 'var(--yellow)', fontSize: 11 }}>{r.category_id ? '✓' : '⚠️ ไม่พบหมวด'}</td>
                        <td style={{ color: 'var(--red)', fontWeight: 600 }}>{Number(r.amount).toLocaleString('th-TH')}</td>
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
                        <td style={{ color: 'var(--green)', fontWeight: 600 }}>{Number(r.received_amount).toLocaleString('th-TH')}</td>
                      </> : type === 'site' ? <>
                        <td style={{ fontWeight: 600 }}>{r.name}</td>
                        <td style={{ fontSize: 11, color: r.client_id ? 'var(--green)' : 'var(--text3)' }}>{r.client_id ? '✓ linked' : r.client_name || '—'}</td>
                        <td>
                          <select className="select" style={{ fontSize: 12, padding: '2px 6px' }}
                            value={r.status || 'Ongoing'} onChange={e => updateRowField(i, 'status', e.target.value)}>
                            {SITE_STATUS_OPTS.map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </td>
                        <td style={{ color: 'var(--text2)', fontVariantNumeric: 'tabular-nums' }}>{r.contract_value ? Number(r.contract_value).toLocaleString('th-TH') : '—'}</td>
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
                    <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text3)', padding: 8 }}>
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
