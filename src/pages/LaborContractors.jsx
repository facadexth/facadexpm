// ============================================================
// LaborContractors — ผู้รับเหมาค่าแรง
// Sub-tab 1: ผู้รับเหมา (master list, LC-YYYY-NNN)
// Sub-tab 2: สัญญา (contract per site, progress comparison)
// Sub-tab 3: การเบิก (payment requests + PDF)
// ============================================================
import { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import {
  useLaborSubcontractors, useLaborContracts,
  useAllLaborPayments, useSites
} from '../hooks/useSupabase.js'
import { fmt, fmtDate } from '../lib/supabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import { auditLog } from '../lib/audit.js'
import { downloadPDF } from '../lib/pdf.js'

// ── Sub-tab 1: ผู้รับเหมา ─────────────────────────────────────

function SubcontractorTab() {
  const { data: subs, refetch } = useLaborSubcontractors()
  const [showForm, setShowForm] = useState(false)
  const [editItem, setEditItem] = useState(null)
  const [deleteId, setDeleteId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')

  const filtered = useMemo(() =>
    (subs||[]).filter(s => !search ||
      s.name?.toLowerCase().includes(search.toLowerCase()) ||
      s.subcontractor_number?.toLowerCase().includes(search.toLowerCase())
    )
  , [subs, search])

  const EMPTY = { name:'', contact_person:'', phone:'', email:'', notes:'' }
  const [form, setForm] = useState(EMPTY)
  const set = (k,v) => setForm(f => ({...f, [k]:v}))

  const handleOpen = (item) => {
    setEditItem(item||null)
    setForm(item ? { name:item.name, contact_person:item.contact_person||'', phone:item.phone||'', email:item.email||'', notes:item.notes||'' } : EMPTY)
    setShowForm(true)
  }

  const handleSave = async (e) => {
    e.preventDefault(); setSaving(true)
    try {
      const payload = { name:form.name, contact_person:form.contact_person||null, phone:form.phone||null, email:form.email||null, notes:form.notes||null }
      if (editItem) {
        const { error } = await supabase.from('labor_subcontractors').update(payload).eq('id', editItem.id)
        if (error) throw error
        await auditLog('labor_subcontractors', editItem.id, 'UPDATE', null, payload)
      } else {
        const { data, error } = await supabase.from('labor_subcontractors').insert(payload).select().single()
        if (error) throw error
        await auditLog('labor_subcontractors', data.id, 'INSERT', null, payload)
      }
      setShowForm(false); refetch()
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSaving(false) }
  }

  const handleDelete = async () => {
    if (!deleteId) return
    const { error } = await supabase.from('labor_subcontractors').delete().eq('id', deleteId)
    if (!error) { await auditLog('labor_subcontractors', deleteId, 'DELETE', null, null); setDeleteId(null); refetch() }
    else alert('Error: ' + error.message)
  }

  return (
    <div>
      <div style={{ display:'flex', gap:10, marginBottom:16, alignItems:'center' }}>
        <button className="btn btn-primary" onClick={() => handleOpen(null)}>+ เพิ่มผู้รับเหมา</button>
        <input className="input input-sm" style={{ width:220 }} placeholder="ค้นหาชื่อ / รหัส..."
          value={search} onChange={e => setSearch(e.target.value)} />
        <span style={{ color:'var(--text3)', fontSize:13 }}>{filtered.length} รายการ</span>
      </div>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead><tr><th>รหัส</th><th>ชื่อผู้รับเหมา</th><th>ผู้ติดต่อ</th><th>เบอร์โทร</th><th>อีเมล</th><th></th></tr></thead>
            <tbody>
              {filtered.map(s => (
                <tr key={s.id}>
                  <td style={{ color:'var(--accent)', fontWeight:700, fontSize:11 }}>{s.subcontractor_number}</td>
                  <td style={{ fontWeight:600 }}>{s.name}</td>
                  <td style={{ fontSize:12 }}>{s.contact_person||'—'}</td>
                  <td style={{ fontSize:12 }}>{s.phone||'—'}</td>
                  <td style={{ fontSize:12 }}>{s.email||'—'}</td>
                  <td style={{ whiteSpace:'nowrap' }}>
                    <button className="btn btn-sm btn-ghost" onClick={() => handleOpen(s)}>แก้ไข</button>
                    <button className="btn btn-sm btn-ghost" style={{ color:'var(--red)' }} onClick={() => setDeleteId(s.id)}>ลบ</button>
                  </td>
                </tr>
              ))}
              {!filtered.length && <tr><td colSpan={6} style={{ textAlign:'center', color:'var(--text3)', padding:24 }}>ยังไม่มีผู้รับเหมา</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {showForm && (
        <Modal title={editItem?`แก้ไข ${editItem.subcontractor_number}`:'เพิ่มผู้รับเหมาใหม่'}
          onClose={() => setShowForm(false)} maxWidth={520}>
          <form onSubmit={handleSave}>
            <div className="modal-body" style={{ display:'grid', gap:12 }}>
              <div><label className="label">ชื่อผู้รับเหมา / บริษัท ★</label>
                <input className="input" required value={form.name} onChange={e => set('name', e.target.value)} /></div>
              <div className="form-grid-2">
                <div><label className="label">ผู้ติดต่อ</label>
                  <input className="input" value={form.contact_person} onChange={e => set('contact_person', e.target.value)} /></div>
                <div><label className="label">เบอร์โทร</label>
                  <input className="input" value={form.phone} onChange={e => set('phone', e.target.value)} /></div>
              </div>
              <div><label className="label">อีเมล</label>
                <input type="email" className="input" value={form.email} onChange={e => set('email', e.target.value)} /></div>
              <div><label className="label">หมายเหตุ</label>
                <textarea className="textarea" rows={2} value={form.notes} onChange={e => set('notes', e.target.value)} /></div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-ghost" onClick={() => setShowForm(false)}>ยกเลิก</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving?'⏳...':'✅ บันทึก'}</button>
            </div>
          </form>
        </Modal>
      )}

      {deleteId && (
        <ConfirmDialog title="ลบผู้รับเหมา" message="ยืนยันการลบ? ถ้ามีสัญญาผูกอยู่จะลบไม่ได้"
          onConfirm={handleDelete} onCancel={() => setDeleteId(null)} />
      )}
    </div>
  )
}

// ── Sub-tab 2: สัญญา ──────────────────────────────────────────

function ContractsTab() {
  const [siteFilter, setSiteFilter] = useState('')
  const [subFilter,  setSubFilter]  = useState('')
  const [statusFilter, setStatusFilter] = useState('active')
  const { data: contracts, refetch } = useLaborContracts({ siteId: siteFilter||undefined, subcontractorId: subFilter||undefined, status: statusFilter||undefined })
  const { data: subs  } = useLaborSubcontractors()
  const { data: sites } = useSites()
  const [showForm, setShowForm] = useState(false)
  const [editItem, setEditItem] = useState(null)
  const [saving, setSaving] = useState(false)
  const [showPayModal, setShowPayModal] = useState(null)

  const EMPTY_C = { subcontractor_id:'', site_id:'', work_description:'', contract_amount:'', retention_pct:'5', withholding_tax_pct:'3', site_note:'', start_date:'' }
  const [form, setForm] = useState(EMPTY_C)
  const set = (k,v) => setForm(f => ({...f,[k]:v}))

  const handleOpen = (item) => {
    setEditItem(item||null)
    setForm(item ? { subcontractor_id:item.subcontractor_id, site_id:item.site_id, work_description:item.work_description||'', contract_amount:item.contract_amount||'', retention_pct:item.retention_pct||5, withholding_tax_pct:item.withholding_tax_pct||3, site_note:item.site_note||'', start_date:item.start_date||'' } : EMPTY_C)
    setShowForm(true)
  }

  const handleSave = async (e) => {
    e.preventDefault(); setSaving(true)
    try {
      const payload = { subcontractor_id:form.subcontractor_id, site_id:form.site_id, work_description:form.work_description, contract_amount:parseFloat(form.contract_amount)||0, retention_pct:parseFloat(form.retention_pct)||5, withholding_tax_pct:parseFloat(form.withholding_tax_pct)||3, site_note:form.site_note||null, start_date:form.start_date||null }
      if (editItem) {
        const { error } = await supabase.from('labor_contracts').update(payload).eq('id', editItem.id)
        if (error) throw error
        await auditLog('labor_contracts', editItem.id, 'UPDATE', null, payload)
      } else {
        const { data, error } = await supabase.from('labor_contracts').insert(payload).select().single()
        if (error) throw error
        await auditLog('labor_contracts', data.id, 'INSERT', null, payload)
      }
      setShowForm(false); refetch()
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSaving(false) }
  }

  return (
    <div>
      <div style={{ display:'flex', gap:10, marginBottom:16, flexWrap:'wrap', alignItems:'center' }}>
        <button className="btn btn-primary" onClick={() => handleOpen(null)}>+ เพิ่มสัญญา</button>
        <select className="select input-sm" style={{ width:200 }} value={siteFilter} onChange={e => setSiteFilter(e.target.value)}>
          <option value="">ทุกไซท์</option>
          {(sites||[]).map(s => <option key={s.id} value={s.id}>{s.site_number} · {s.name}</option>)}
        </select>
        <select className="select input-sm" style={{ width:200 }} value={subFilter} onChange={e => setSubFilter(e.target.value)}>
          <option value="">ทุกผู้รับเหมา</option>
          {(subs||[]).map(s => <option key={s.id} value={s.id}>{s.subcontractor_number} · {s.name}</option>)}
        </select>
        {['active','completed','cancelled',''].map(s => (
          <button key={s} className={`btn btn-sm ${statusFilter===s?'btn-primary':'btn-ghost'}`} onClick={() => setStatusFilter(s)}>
            {s||'ทั้งหมด'}
          </button>
        ))}
      </div>

      {(contracts||[]).some(c => c.retention_releasable && c.total_retention_held - (c.retention_released||0) > 0) && (
        <div className="alert alert-warning" style={{ marginBottom:12 }}>
          ⚠️ มีสัญญาที่ประกันผลงานครบกำหนดคืน — ดูด้านล่าง
        </div>
      )}

      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(380px,1fr))', gap:14 }}>
        {(contracts||[]).map(c => {
          const netRetention = (c.total_retention_held||0) - (c.retention_released||0)
          const cPct = c.contractor_billing_pct || 0
          return (
            <div key={c.id} className="card card-body" style={{ padding:'16px 18px' }}>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:10 }}>
                <div>
                  <div style={{ fontSize:11, color:'var(--accent)' }}>{c.subcontractor_number}</div>
                  <div style={{ fontWeight:700, fontSize:14 }}>{c.subcontractor_name}</div>
                  <div style={{ fontSize:12, color:'var(--text3)' }}>{c.work_description}</div>
                </div>
                <div style={{ textAlign:'right' }}>
                  <div style={{ fontSize:11, color:'var(--text3)' }}>{c.site_number} · {c.site_name}</div>
                  <span className={`badge ${c.status==='active'?'badge-ongoing':c.status==='completed'?'badge-status-completed':'badge-pending'}`}>{c.status}</span>
                  {c.retention_releasable && netRetention > 0 && (
                    <div style={{ fontSize:11, color:'var(--yellow)', marginTop:4 }}>⚠️ ประกันครบกำหนดคืน</div>
                  )}
                </div>
              </div>

              <div style={{ marginBottom:10 }}>
                <div style={{ fontSize:11, color:'var(--text3)', marginBottom:4 }}>% เบิก (ผู้รับเหมา)</div>
                <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                  <span style={{ fontSize:11, color:'var(--text3)', width:80 }}>ผู้รับเหมา</span>
                  <div className="progress" style={{ flex:1 }}><div className="progress-bar" style={{ width:`${Math.min(100,cPct)}%` }} /></div>
                  <span style={{ fontSize:12, fontWeight:700, color:'var(--accent)', width:40, textAlign:'right' }}>{cPct.toFixed(1)}%</span>
                </div>
              </div>

              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8, fontSize:12, marginBottom:10 }}>
                <div><div style={{ color:'var(--text3)', fontSize:10 }}>มูลค่าสัญญา</div><div className="font-mono">{fmt(c.contract_amount)}</div></div>
                <div><div style={{ color:'var(--text3)', fontSize:10 }}>เบิกแล้ว (gross)</div><div className="font-mono" style={{ color:'var(--green)' }}>{fmt(c.total_billed_gross)}</div></div>
                <div><div style={{ color:'var(--text3)', fontSize:10 }}>คงเหลือ</div><div className="font-mono" style={{ color:'var(--yellow)' }}>{fmt(c.remaining_amount)}</div></div>
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, fontSize:12, marginBottom:12 }}>
                <div><div style={{ color:'var(--text3)', fontSize:10 }}>ประกันค้างอยู่</div><div className="font-mono" style={{ color:'var(--red)' }}>{fmt(netRetention)}</div></div>
                <div><div style={{ color:'var(--text3)', fontSize:10 }}>โอนสุทธิแล้ว</div><div className="font-mono">{fmt(c.total_paid_net)}</div></div>
              </div>

              <div style={{ display:'flex', gap:6 }}>
                <button className="btn btn-sm btn-primary" onClick={() => setShowPayModal(c)}>เบิกเงิน</button>
                {c.retention_releasable && netRetention > 0 && (
                  <button className="btn btn-sm btn-warning" onClick={() => setShowPayModal({ ...c, _isRetentionRelease: true })}>
                    คืนประกัน
                  </button>
                )}
                <button className="btn btn-sm btn-ghost" onClick={() => handleOpen(c)}>แก้ไข</button>
              </div>
              {c.site_note && <div style={{ marginTop:8, fontSize:11, color:'var(--text3)' }}>📝 {c.site_note}</div>}
            </div>
          )
        })}
        {!(contracts||[]).length && <div style={{ color:'var(--text3)', fontSize:13 }}>ไม่พบสัญญา</div>}
      </div>

      {showForm && (
        <Modal title={editItem?'แก้ไขสัญญา':'เพิ่มสัญญาใหม่'} onClose={() => setShowForm(false)} maxWidth={560}>
          <form onSubmit={handleSave}>
            <div className="modal-body" style={{ display:'grid', gap:12 }}>
              <div className="form-grid-2">
                <div><label className="label">ผู้รับเหมา ★</label>
                  <select className="select" required value={form.subcontractor_id} onChange={e => set('subcontractor_id',e.target.value)}>
                    <option value="">— เลือก —</option>
                    {(subs||[]).map(s => <option key={s.id} value={s.id}>{s.subcontractor_number} · {s.name}</option>)}
                  </select></div>
                <div><label className="label">ไซท์งาน ★</label>
                  <select className="select" required value={form.site_id} onChange={e => set('site_id',e.target.value)}>
                    <option value="">— เลือก —</option>
                    {(sites||[]).map(s => <option key={s.id} value={s.id}>{s.site_number} · {s.name}</option>)}
                  </select></div>
              </div>
              <div><label className="label">ประเภทงาน ★</label>
                <input className="input" required value={form.work_description} onChange={e => set('work_description',e.target.value)} placeholder="เช่น ติดตั้งอลูมิเนียม" /></div>
              <div><label className="label">มูลค่าสัญญา (บาท) ★</label>
                <input type="number" className="input" required min="0" step="0.01" value={form.contract_amount} onChange={e => set('contract_amount',e.target.value)} /></div>
              <div className="form-grid-3">
                <div><label className="label">ประกันผลงาน %</label>
                  <input type="number" className="input" min="0" max="100" step="0.1" value={form.retention_pct} onChange={e => set('retention_pct',e.target.value)} /></div>
                <div><label className="label">ภาษีหัก ณ ที่จ่าย %</label>
                  <input type="number" className="input" min="0" max="100" step="0.1" value={form.withholding_tax_pct} onChange={e => set('withholding_tax_pct',e.target.value)} /></div>
                <div><label className="label">วันเริ่มสัญญา</label>
                  <input type="date" className="input" value={form.start_date} onChange={e => set('start_date',e.target.value)} /></div>
              </div>
              <div><label className="label">หมายเหตุเฉพาะงานนี้</label>
                <textarea className="textarea" rows={2} value={form.site_note} onChange={e => set('site_note',e.target.value)} /></div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-ghost" onClick={() => setShowForm(false)}>ยกเลิก</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving?'⏳...':'✅ บันทึก'}</button>
            </div>
          </form>
        </Modal>
      )}

      {showPayModal && (
        <PaymentModal contract={showPayModal} onClose={() => { setShowPayModal(null); refetch() }} />
      )}
    </div>
  )
}

// ── Payment Modal ─────────────────────────────────────────────

function PaymentModal({ contract, onClose }) {
  const isRetentionRelease = contract._isRetentionRelease || false
  const [saving, setSaving] = useState(false)
  const [pdfPreview, setPdfPreview] = useState(null)

  const netRetention = (contract.total_retention_held||0) - (contract.retention_released||0)

  const [form, setForm] = useState({
    payment_date: new Date().toISOString().slice(0,10),
    work_description: isRetentionRelease ? 'คืนประกันผลงาน' : '',
    progress_pct: '',
    gross_amount: isRetentionRelease ? netRetention.toFixed(2) : '',
    notes: '',
  })
  const set = (k,v) => setForm(f => ({...f,[k]:v}))

  const gross = parseFloat(form.gross_amount) || 0
  const withholdingTax = isRetentionRelease ? 0 : parseFloat((gross * (contract.withholding_tax_pct||3) / 100).toFixed(2))
  const retentionAmt   = isRetentionRelease ? 0 : (() => {
    const siteEnded = contract.site_end_date
    const releasable = contract.retention_releasable
    if (!siteEnded || !releasable) return parseFloat((gross * (contract.retention_pct||5) / 100).toFixed(2))
    return 0
  })()
  const netAmount = parseFloat((gross - withholdingTax - retentionAmt).toFixed(2))

  const handleSave = async () => {
    if (!form.gross_amount || gross <= 0) return alert('กรุณากรอกยอดเบิก')
    setSaving(true)
    try {
      const payload = {
        contract_id: contract.id,
        payment_date: form.payment_date,
        work_description: form.work_description||null,
        progress_pct: parseFloat(form.progress_pct)||null,
        gross_amount: gross,
        withholding_tax: withholdingTax,
        retention_amount: retentionAmt,
        net_amount: netAmount,
        is_retention_release: isRetentionRelease,
        notes: form.notes||null,
      }
      const { data, error } = await supabase.from('labor_payments').insert(payload).select().single()
      if (error) throw error
      await auditLog('labor_payments', data.id, 'INSERT', null, payload)
      setPdfPreview(data)
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSaving(false) }
  }

  const handleDownloadPDF = async () => {
    await downloadPDF('payment-pdf-preview', `${pdfPreview?.payment_number||'payment'}.pdf`)
  }

  if (pdfPreview) {
    return (
      <Modal title={`เบิกสำเร็จ — ${pdfPreview.payment_number}`} onClose={onClose} maxWidth={600}>
        <div className="modal-body">
          <div id="payment-pdf-preview" style={{ fontFamily:'Sarabun,sans-serif', padding:'20px 24px', background:'#fff', color:'#111' }}>
            <div style={{ textAlign:'center', marginBottom:16 }}>
              <div style={{ fontSize:18, fontWeight:800 }}>FACADE X</div>
              <div style={{ fontSize:14, fontWeight:600 }}>ใบเบิกเงินผู้รับเหมาค่าแรง</div>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:12, fontSize:13 }}>
              <div><strong>เลขที่:</strong> {pdfPreview.payment_number}</div>
              <div><strong>วันที่:</strong> {new Date(pdfPreview.payment_date).toLocaleDateString('th-TH')}</div>
              <div><strong>ผู้รับเหมา:</strong> {contract.subcontractor_name}</div>
              <div><strong>รหัส:</strong> {contract.subcontractor_number}</div>
              <div><strong>ไซท์งาน:</strong> {contract.site_name}</div>
              <div><strong>รหัสไซท์:</strong> {contract.site_number}</div>
            </div>
            {pdfPreview.work_description && <div style={{ fontSize:13, marginBottom:8 }}><strong>รายละเอียดงาน:</strong> {pdfPreview.work_description}</div>}
            {pdfPreview.progress_pct && <div style={{ fontSize:13, marginBottom:12 }}><strong>Progress สะสม:</strong> {pdfPreview.progress_pct}%</div>}
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              <tbody>
                <tr><td style={{ padding:'6px 0', borderBottom:'1px solid #ddd' }}>ยอดเบิกครั้งนี้</td><td style={{ textAlign:'right', padding:'6px 0', borderBottom:'1px solid #ddd' }}>{fmt(pdfPreview.gross_amount)} บาท</td></tr>
                {pdfPreview.withholding_tax > 0 && <tr><td style={{ padding:'6px 0', borderBottom:'1px solid #ddd', color:'#c00' }}>หักภาษี ณ ที่จ่าย ({contract.withholding_tax_pct}%)</td><td style={{ textAlign:'right', padding:'6px 0', borderBottom:'1px solid #ddd', color:'#c00' }}>({fmt(pdfPreview.withholding_tax)}) บาท</td></tr>}
                {pdfPreview.retention_amount > 0 && <tr><td style={{ padding:'6px 0', borderBottom:'1px solid #ddd', color:'#c00' }}>หักประกันผลงาน ({contract.retention_pct}%)</td><td style={{ textAlign:'right', padding:'6px 0', borderBottom:'1px solid #ddd', color:'#c00' }}>({fmt(pdfPreview.retention_amount)}) บาท</td></tr>}
                <tr style={{ fontWeight:700, fontSize:15 }}><td style={{ padding:'8px 0', borderBottom:'2px solid #111' }}>ยอดโอน</td><td style={{ textAlign:'right', padding:'8px 0', borderBottom:'2px solid #111' }}>{fmt(pdfPreview.net_amount)} บาท</td></tr>
              </tbody>
            </table>
            <div style={{ marginTop:12, display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, fontSize:12, color:'#555' }}>
              <div>มูลค่าสัญญา: {fmt(contract.contract_amount)} บาท</div>
              <div>เบิกสะสม: {fmt((contract.total_billed_gross||0) + pdfPreview.gross_amount)} บาท</div>
              <div>ประกันผลงานค้างอยู่: {fmt((contract.total_retention_held||0) + pdfPreview.retention_amount)} บาท</div>
              <div>คงเหลือ: {fmt((contract.remaining_amount||0) - pdfPreview.gross_amount)} บาท</div>
            </div>
            <div style={{ marginTop:24, display:'grid', gridTemplateColumns:'1fr 1fr', gap:20, textAlign:'center', fontSize:12 }}>
              <div style={{ borderTop:'1px solid #999', paddingTop:6 }}>ลายเซ็นผู้รับเหมา</div>
              <div style={{ borderTop:'1px solid #999', paddingTop:6 }}>ลายเซ็นผู้อนุมัติ</div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
          <button className="btn btn-primary" onClick={handleDownloadPDF}>📄 Download PDF</button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title={isRetentionRelease ? `คืนประกันผลงาน — ${contract.subcontractor_name}` : `เบิกเงิน — ${contract.subcontractor_name}`}
      onClose={onClose} maxWidth={520}>
      <div className="modal-body" style={{ display:'grid', gap:12 }}>
        <div style={{ background:'rgba(108,99,255,0.1)', borderRadius:8, padding:'10px 14px', fontSize:12 }}>
          <strong>{contract.site_number} · {contract.site_name}</strong> — {contract.work_description}<br/>
          มูลค่าสัญญา: {fmt(contract.contract_amount)} | เบิกแล้ว: {fmt(contract.total_billed_gross)} | คงเหลือ: {fmt(contract.remaining_amount)}
        </div>

        <div className="form-grid-2">
          <div><label className="label">วันที่เบิก ★</label>
            <input type="date" className="input" value={form.payment_date} onChange={e => set('payment_date',e.target.value)} /></div>
          {!isRetentionRelease && <div><label className="label">Progress สะสม (%)</label>
            <input type="number" className="input" min="0" max="100" step="1" value={form.progress_pct} onChange={e => set('progress_pct',e.target.value)} placeholder="0-100" /></div>}
        </div>
        <div><label className="label">รายละเอียดงวด</label>
          <input className="input" value={form.work_description} onChange={e => set('work_description',e.target.value)} placeholder="เช่น งวดที่ 1 ติดตั้งโครงสร้าง 30%" /></div>
        <div><label className="label">ยอดเบิก (บาท) ★</label>
          <input type="number" className="input" min="0" step="0.01" value={form.gross_amount} onChange={e => set('gross_amount',e.target.value)} /></div>

        {gross > 0 && (
          <div style={{ background:'rgba(0,0,0,0.2)', borderRadius:8, padding:'12px 14px', fontSize:13 }}>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
              <span>ยอดเบิก</span><span className="font-mono">{fmt(gross)}</span>
            </div>
            {withholdingTax > 0 && <div style={{ display:'flex', justifyContent:'space-between', color:'var(--red)', marginBottom:4 }}>
              <span>หักภาษี {contract.withholding_tax_pct}%</span><span className="font-mono">({fmt(withholdingTax)})</span>
            </div>}
            {retentionAmt > 0 && <div style={{ display:'flex', justifyContent:'space-between', color:'var(--red)', marginBottom:4 }}>
              <span>หักประกันผลงาน {contract.retention_pct}%</span><span className="font-mono">({fmt(retentionAmt)})</span>
            </div>}
            <div style={{ display:'flex', justifyContent:'space-between', fontWeight:700, fontSize:15, borderTop:'1px solid var(--border)', paddingTop:8, marginTop:4 }}>
              <span>ยอดโอน</span><span className="font-mono" style={{ color:'var(--green)' }}>{fmt(netAmount)}</span>
            </div>
          </div>
        )}
        <div><label className="label">หมายเหตุ</label>
          <input className="input" value={form.notes} onChange={e => set('notes',e.target.value)} /></div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ยกเลิก</button>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving?'⏳...':'✅ บันทึกและดู PDF'}
        </button>
      </div>
    </Modal>
  )
}

// ── Sub-tab 3: การเบิก ────────────────────────────────────────

function PaymentsTab() {
  const [statusFilter, setStatusFilter] = useState('')
  const { data: payments, refetch } = useAllLaborPayments({ status: statusFilter||undefined })

  const handleMarkPaid = async (id) => {
    const today = new Date().toISOString().slice(0,10)
    const { error } = await supabase.from('labor_payments').update({ status:'paid', paid_date: today }).eq('id', id)
    if (!error) { await auditLog('labor_payments', id, 'UPDATE', null, { status:'paid', paid_date:today }); refetch() }
    else alert('Error: ' + error.message)
  }

  return (
    <div>
      <div style={{ display:'flex', gap:10, marginBottom:16, alignItems:'center' }}>
        {['','pending','paid'].map(s => (
          <button key={s} className={`btn btn-sm ${statusFilter===s?'btn-primary':'btn-ghost'}`} onClick={() => setStatusFilter(s)}>
            {s===''?'ทั้งหมด':s==='pending'?'⏳ ค้างจ่าย':'✅ จ่ายแล้ว'}
          </button>
        ))}
        <span style={{ color:'var(--text3)', fontSize:12 }}>{(payments||[]).length} รายการ</span>
      </div>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>เลขที่เบิก</th><th>วันที่</th><th>ผู้รับเหมา</th><th>ไซท์</th>
                <th>รายละเอียด</th><th>% สะสม</th>
                <th>ยอดเบิก</th><th>หักภาษี</th><th>หักประกัน</th><th>ยอดโอน</th>
                <th>สถานะ</th><th></th>
              </tr>
            </thead>
            <tbody>
              {(payments||[]).map(p => (
                <tr key={p.id}>
                  <td style={{ color:'var(--accent)', fontSize:11, fontWeight:700 }}>
                    {p.payment_number}
                    {p.is_retention_release && <span style={{ marginLeft:4, background:'rgba(255,209,102,0.2)', color:'var(--yellow)', fontSize:9, padding:'1px 4px', borderRadius:4 }}>คืนประกัน</span>}
                  </td>
                  <td style={{ fontSize:12 }}>{new Date(p.payment_date).toLocaleDateString('th-TH')}</td>
                  <td style={{ fontSize:12 }}>{p.labor_contracts?.labor_subcontractors?.name||'—'}</td>
                  <td style={{ fontSize:11, color:'var(--text3)' }}>{p.labor_contracts?.sites?.site_number}</td>
                  <td style={{ fontSize:11, color:'var(--text3)', maxWidth:150, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.work_description||'—'}</td>
                  <td style={{ textAlign:'center', color:'var(--text3)', fontSize:12 }}>{p.progress_pct!=null?`${p.progress_pct}%`:'—'}</td>
                  <td className="font-mono">{fmt(p.gross_amount)}</td>
                  <td className="font-mono" style={{ color:'var(--red)', fontSize:12 }}>{p.withholding_tax>0?`(${fmt(p.withholding_tax)})`:'—'}</td>
                  <td className="font-mono" style={{ color:'var(--red)', fontSize:12 }}>{p.retention_amount>0?`(${fmt(p.retention_amount)})`:'—'}</td>
                  <td className="font-mono" style={{ color:'var(--green)', fontWeight:700 }}>{fmt(p.net_amount)}</td>
                  <td>
                    <span className={`badge ${p.status==='paid'?'badge-paid':'badge-pending'}`}>{p.status==='paid'?'✅ จ่ายแล้ว':'⏳ ค้างจ่าย'}</span>
                  </td>
                  <td style={{ whiteSpace:'nowrap' }}>
                    {p.status==='pending' && (
                      <button className="btn btn-sm btn-success" onClick={() => handleMarkPaid(p.id)}>จ่ายแล้ว</button>
                    )}
                  </td>
                </tr>
              ))}
              {!(payments||[]).length && (
                <tr><td colSpan={12} style={{ textAlign:'center', color:'var(--text3)', padding:24 }}>ยังไม่มีรายการเบิก</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ── Main LaborContractors Component ──────────────────────────

export default function LaborContractors() {
  const [innerTab, setInnerTab] = useState('subcontractors')
  const INNER_TABS = [
    { id:'subcontractors', label:'🏢 ผู้รับเหมา' },
    { id:'contracts',      label:'📄 สัญญา' },
    { id:'payments',       label:'💰 การเบิก' },
  ]

  return (
    <div>
      <div className="inner-tabs" style={{ marginBottom:20 }}>
        {INNER_TABS.map(t => (
          <button key={t.id} className={`inner-tab ${innerTab===t.id?'active':''}`} onClick={() => setInnerTab(t.id)}>{t.label}</button>
        ))}
      </div>
      {innerTab==='subcontractors' && <SubcontractorTab />}
      {innerTab==='contracts'      && <ContractsTab />}
      {innerTab==='payments'       && <PaymentsTab />}
    </div>
  )
}
