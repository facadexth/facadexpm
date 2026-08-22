// src/pages/Quotations.jsx
// ============================================================
// Quotations — ใบเสนอราคา
// ✅ Itemized, client-required, site optional until accepted
// ✅ Auto-number QT-YYYY-NNN
// ✅ Status: draft -> sent -> accepted (creates/links a Site) | rejected | expired
// ✅ Items optionally drawn from the catalog_items price list, always
//    freely editable afterward (autofill, not enforce)
// ============================================================
import { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { useQuotations, useCatalogItems, useClients, useSites } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { useTenant } from '../hooks/useTenant.js'
import { canEditPage } from '../lib/permissions.js'
import { useDraftForm } from '../hooks/useDraftForm.js'
import { fmt, fmtDate } from '../lib/supabase.js'
import { auditLog } from '../lib/audit.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import SearchableSelect from '../components/SearchableSelect.jsx'
import { format, startOfYear, endOfYear } from 'date-fns'
import { lineTotal, calcQuotationTotals } from '../lib/quotationCalc.js'
import { SiteForm, siteFormToPayload } from './Sites.jsx'
import { downloadPDF, downloadJPG } from '../lib/pdf.js'

const clientOpts = (clients) => (clients || []).map(c => ({
  value: c.id, label: `${c.client_number} · ${c.name}`, keywords: `${c.client_number} ${c.name}`,
}))
const catalogOpts = (items) => (items || []).filter(i => i.active).map(i => ({
  value: i.id, label: i.unit ? `${i.name} (${i.unit})` : i.name, keywords: i.name,
}))

const QT_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired']
const QT_STATUS_LABELS = {
  draft: '✏️ ร่าง', sent: '📤 ส่งแล้ว', accepted: '✅ ยอมรับ', rejected: '✕ ปฏิเสธ', expired: '⏰ หมดอายุ',
}

const EMPTY_ITEM = { catalog_item_id: null, description: '', quantity: '1', unit: '', unit_price: '' }
const EMPTY_FORM = {
  client_id: '', date: '', valid_until: '', has_vat: true, price_includes_vat: false,
  discount_mode: 'none', discount_amount: '', discount_pct: '',
  payment_terms: '', notes: '', items: [{ ...EMPTY_ITEM }],
}

function QuotationItemsEditor({ items, onChange, catalogItems }) {
  const set = (i, k, v) => onChange(items.map((it, idx) => idx === i ? { ...it, [k]: v } : it))
  const add = () => onChange([...items, { ...EMPTY_ITEM }])
  const remove = (i) => onChange(items.length > 1 ? items.filter((_, idx) => idx !== i) : items)
  const addFromCatalog = (catalogId) => {
    const found = (catalogItems || []).find(c => c.id === catalogId)
    if (!found) return
    onChange([...items, {
      catalog_item_id: found.id, description: found.name, unit: found.unit || '',
      quantity: '1', unit_price: String(found.default_unit_price),
    }])
  }
  const grandTotal = items.reduce((sum, it) => sum + lineTotal(it), 0)

  return (
    <div>
      <label className="label">รายการ ★</label>
      <div style={{ display: 'grid', gap: 8 }}>
        {items.map((it, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 80px 100px 32px', gap: 6, alignItems: 'center' }}>
            <input className="input input-sm" placeholder="รายละเอียดรายการ" required
              value={it.description} onChange={e => set(i, 'description', e.target.value)} />
            <input className="input input-sm" type="number" min="0" step="0.01" placeholder="จำนวน"
              value={it.quantity} onChange={e => set(i, 'quantity', e.target.value)} />
            <input className="input input-sm" placeholder="หน่วย"
              value={it.unit} onChange={e => set(i, 'unit', e.target.value)} />
            <input className="input input-sm" type="number" min="0" step="0.01" placeholder="ราคา/หน่วย"
              value={it.unit_price} onChange={e => set(i, 'unit_price', e.target.value)} />
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => remove(i)} disabled={items.length === 1}>✕</button>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-sm btn-ghost" onClick={add}>+ เพิ่มรายการว่าง</button>
        <div style={{ minWidth: 220 }}>
          <SearchableSelect value={null} onChange={addFromCatalog} placeholder="+ เพิ่มจากรายการสินค้า" options={catalogOpts(catalogItems)} />
        </div>
      </div>
      <div style={{ marginTop: 10, textAlign: 'right', fontWeight: 700, fontSize: 15 }}>
        รวม: <span className="font-mono" style={{ color: 'var(--accent)' }}>{fmt(grandTotal)}</span> บาท
      </div>
    </div>
  )
}

function QuotationForm({ initial = EMPTY_FORM, clients, catalogItems, onSave, onCancel, loading }) {
  const isAdd = !initial?.id
  const [form, setForm, clearFormDraft] = useDraftForm('quotation-form', { ...EMPTY_FORM, ...initial }, isAdd)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const totals = calcQuotationTotals(form.items, {
    hasVat: form.has_vat, priceIncludesVat: form.price_includes_vat,
    discountAmount: form.discount_mode === 'amount' ? form.discount_amount : 0,
    discountPct: form.discount_mode === 'pct' ? form.discount_pct : 0,
  })

  return (
    <form onSubmit={e => { e.preventDefault(); clearFormDraft(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div className="form-grid-2">
          <div>
            <label className="label">วันที่ ★</label>
            <input type="date" className="input" required value={form.date} onChange={e => set('date', e.target.value)} />
          </div>
          <div>
            <label className="label">ราคานี้มีผลถึงวันที่</label>
            <input type="date" className="input" value={form.valid_until} onChange={e => set('valid_until', e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label">ลูกค้า ★</label>
          <SearchableSelect required value={form.client_id} onChange={id => set('client_id', id)}
            placeholder="— เลือกลูกค้า —" options={clientOpts(clients)} />
        </div>
        <QuotationItemsEditor items={form.items} onChange={items => set('items', items)} catalogItems={catalogItems} />
        <div>
          <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
              <input type="radio" name="qt-has-vat" checked={form.has_vat === true} onChange={() => set('has_vat', true)} />
              รวม VAT
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
              <input type="radio" name="qt-has-vat" checked={form.has_vat === false} onChange={() => set('has_vat', false)} />
              ไม่มี VAT
            </label>
          </div>
          {form.has_vat && (
            <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                <input type="radio" name="qt-price-includes-vat" checked={form.price_includes_vat === false} onChange={() => set('price_includes_vat', false)} />
                ราคา/หน่วยยังไม่รวม VAT
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                <input type="radio" name="qt-price-includes-vat" checked={form.price_includes_vat === true} onChange={() => set('price_includes_vat', true)} />
                ราคา/หน่วยรวม VAT แล้ว
              </label>
            </div>
          )}
          <div style={{ display: 'flex', gap: 16, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
              <input type="radio" name="qt-discount-mode" checked={form.discount_mode === 'none'} onChange={() => set('discount_mode', 'none')} />
              ไม่มีส่วนลด
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
              <input type="radio" name="qt-discount-mode" checked={form.discount_mode === 'amount'} onChange={() => set('discount_mode', 'amount')} />
              ส่วนลด (บาท)
            </label>
            {form.discount_mode === 'amount' && (
              <input type="number" min="0" step="0.01" className="input input-sm" style={{ width: 120 }}
                value={form.discount_amount} onChange={e => set('discount_amount', e.target.value)} />
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
              <input type="radio" name="qt-discount-mode" checked={form.discount_mode === 'pct'} onChange={() => set('discount_mode', 'pct')} />
              ส่วนลด (%)
            </label>
            {form.discount_mode === 'pct' && (
              <input type="number" min="0" max="100" step="0.01" className="input input-sm" style={{ width: 100 }}
                value={form.discount_pct} onChange={e => set('discount_pct', e.target.value)} />
            )}
          </div>
          <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: 8, padding: '10px 14px', fontSize: 13 }}>
            {totals.discount > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>ก่อนหักส่วนลด</span><span className="font-mono">{fmt(totals.rawTotal)}</span></div>}
            {totals.discount > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>ส่วนลด</span><span className="font-mono">-{fmt(totals.discount)}</span></div>}
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>รวมก่อน VAT</span><span className="font-mono">{fmt(totals.subtotal)}</span></div>
            {form.has_vat && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>VAT (7%)</span><span className="font-mono">{fmt(totals.vat)}</span></div>}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4 }}><span>รวมสุทธิ</span><span className="font-mono" style={{ color: 'var(--accent)' }}>{fmt(totals.total)}</span></div>
          </div>
        </div>
        <div>
          <label className="label">เงื่อนไขการชำระเงิน</label>
          <textarea className="textarea" rows={2} value={form.payment_terms} onChange={e => set('payment_terms', e.target.value)} placeholder="เช่น มัดจำ 30% เมื่อเซ็นสัญญา ส่วนที่เหลือแบ่งจ่ายตามงวดงาน" />
        </div>
        <div>
          <label className="label">หมายเหตุ</label>
          <input className="input" value={form.notes} onChange={e => set('notes', e.target.value)} />
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? '⏳...' : '✅ บันทึกใบเสนอราคา'}
        </button>
      </div>
    </form>
  )
}

function AcceptQuotationModal({ quotation, totals, clients, sites, hasModuleAccess, onLinkExisting, onCreateNew, onClose, loading }) {
  const [mode, setMode] = useState('create') // 'create' | 'existing'
  const [existingSiteId, setExistingSiteId] = useState('')

  const siteFormInitial = {
    name: quotation.clients?.name ? `${quotation.clients.name} — ${quotation.quotation_number}` : quotation.quotation_number,
    client_id: quotation.client_id,
    has_vat: quotation.has_vat,
    contract_value_no_vat: String(totals.subtotal),
  }

  return (
    <Modal title={`รับใบเสนอราคา ${quotation.quotation_number}`} onClose={onClose} maxWidth={700}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <p style={{ color: 'var(--text2)', fontSize: 13 }}>
          ใบเสนอราคานี้ยังไม่ผูกกับไซท์งาน — สร้างไซท์งานใหม่จากใบเสนอราคานี้ หรือเลือกไซท์งานที่มีอยู่แล้ว
        </p>
        <div style={{ display: 'flex', gap: 16 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
            <input type="radio" name="accept-mode" checked={mode === 'create'} onChange={() => setMode('create')} />
            สร้างไซท์งานใหม่
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
            <input type="radio" name="accept-mode" checked={mode === 'existing'} onChange={() => setMode('existing')} />
            เลือกไซท์งานที่มีอยู่แล้ว
          </label>
        </div>
      </div>
      {mode === 'existing' ? (
        <>
          <div className="modal-body">
            <label className="label">ไซท์งาน ★</label>
            <SearchableSelect
              value={existingSiteId} onChange={setExistingSiteId} placeholder="— เลือกไซท์งาน —"
              options={(sites || []).map(s => ({ value: s.id, label: `${s.site_number} · ${s.name}`, keywords: `${s.site_number} ${s.name}` }))}
            />
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={onClose}>ยกเลิก</button>
            <button type="button" className="btn btn-primary" disabled={loading || !existingSiteId} onClick={() => onLinkExisting(existingSiteId)}>
              {loading ? '⏳...' : '✅ ผูกกับไซท์งานนี้'}
            </button>
          </div>
        </>
      ) : (
        <SiteForm initial={siteFormInitial} clients={clients} hasModuleAccess={hasModuleAccess} onSave={onCreateNew} onCancel={onClose} loading={loading} draftKey="quotation-accept-site-form" />
      )}
    </Modal>
  )
}

// Shared "professional" document look (design option A) — logo/company
// block left, bordered doc-info box + ต้นฉบับ tag right, light-purple
// table header, boxed notes/terms, purple-accented (unfilled) grand total.
// Intended to become the one letterhead pattern every printable document
// in the app uses (Quotation now; PurchaseOrders' own PODocumentModal is
// a separate file and not migrated to this shape yet — a follow-up, not
// part of this change).
function QuotationDocumentModal({ qt, tenant, onClose }) {
  const items = qt.quotation_items || []
  const totals = calcQuotationTotals(items, { hasVat: qt.has_vat, priceIncludesVat: qt.price_includes_vat, discountAmount: qt.discount_amount, discountPct: qt.discount_pct })

  return (
    <Modal title={`ใบเสนอราคา ${qt.quotation_number}`} onClose={onClose} maxWidth={720}>
      <div className="modal-body">
        <div id={`qt-doc-${qt.id}`} style={{ fontFamily: 'Sarabun,sans-serif', padding: '40px 44px', background: '#fff', color: '#17181f' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 20 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              {tenant?.logo_url
                ? <img src={tenant.logo_url} alt="" style={{ width: 40, height: 40, objectFit: 'contain', flexShrink: 0 }} crossOrigin="anonymous" />
                : <div style={{ width: 40, height: 40, borderRadius: 8, background: '#6c63ff', flexShrink: 0 }} />}
              <div>
                <div style={{ fontSize: 17, fontWeight: 800 }}>{tenant?.company_name}</div>
                <div style={{ fontSize: 11, color: '#6a6f85', lineHeight: 1.6, marginTop: 2 }}>
                  {tenant?.address}
                  {tenant?.address && <br />}
                  {tenant?.tax_id && `เลขผู้เสียภาษี ${tenant.tax_id}`}
                  {tenant?.tax_id && tenant?.phone && ' · '}
                  {tenant?.phone && `โทร ${tenant.phone}`}
                </div>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#6c63ff', border: '1px solid #6c63ff', borderRadius: 4, padding: '2px 8px', display: 'inline-block', marginBottom: 6 }}>ต้นฉบับ</div>
              <div style={{ fontSize: 22, fontWeight: 800 }}>ใบเสนอราคา</div>
            </div>
          </div>

          <div style={{ marginTop: 20, border: '1px solid #e4e6ef', borderRadius: 8, padding: '14px 16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 24px', fontSize: 12 }}>
            <div><span style={{ color: '#6a6f85' }}>เลขที่เอกสาร</span><br />{qt.quotation_number}</div>
            <div><span style={{ color: '#6a6f85' }}>วันที่ออก</span><br />{new Date(qt.date).toLocaleDateString('th-TH')}</div>
            <div><span style={{ color: '#6a6f85' }}>ใช้ได้ถึง</span><br />{qt.valid_until ? new Date(qt.valid_until).toLocaleDateString('th-TH') : '—'}</div>
            <div><span style={{ color: '#6a6f85' }}>แก้ไขครั้งที่</span><br />{qt.revision || 1}</div>
          </div>

          <div style={{ marginTop: 16, fontSize: 12.5, lineHeight: 1.8 }}>
            <strong style={{ fontSize: 13 }}>ลูกค้า:</strong> {qt.clients?.name}
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 18 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '9px 8px', fontSize: 11, color: '#4a4d63', background: '#f4f3ff', borderBottom: '2px solid #6c63ff' }}>รายการ</th>
                <th style={{ textAlign: 'right', padding: '9px 8px', fontSize: 11, color: '#4a4d63', background: '#f4f3ff', borderBottom: '2px solid #6c63ff' }}>จำนวน</th>
                <th style={{ textAlign: 'right', padding: '9px 8px', fontSize: 11, color: '#4a4d63', background: '#f4f3ff', borderBottom: '2px solid #6c63ff' }}>ราคา/หน่วย</th>
                <th style={{ textAlign: 'right', padding: '9px 8px', fontSize: 11, color: '#4a4d63', background: '#f4f3ff', borderBottom: '2px solid #6c63ff' }}>รวม</th>
              </tr>
            </thead>
            <tbody>
              {items.map(it => (
                <tr key={it.id}>
                  <td style={{ padding: '9px 8px', borderBottom: '1px solid #eee' }}>{it.description}</td>
                  <td style={{ textAlign: 'right', padding: '9px 8px', borderBottom: '1px solid #eee' }}>{it.quantity} {it.unit || ''}</td>
                  <td style={{ textAlign: 'right', padding: '9px 8px', borderBottom: '1px solid #eee' }}>{fmt(it.unit_price)}</td>
                  <td style={{ textAlign: 'right', padding: '9px 8px', borderBottom: '1px solid #eee' }}>{fmt(it.line_total)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
            <table style={{ width: 260, fontSize: 12.5 }}>
              <tbody>
                {totals.discount > 0 && (
                  <tr><td style={{ padding: '5px 4px', color: '#6a6f85' }}>ส่วนลด</td><td style={{ textAlign: 'right', padding: '5px 4px' }}>-{fmt(totals.discount)}</td></tr>
                )}
                <tr><td style={{ padding: '5px 4px', color: '#6a6f85' }}>รวมก่อน VAT</td><td style={{ textAlign: 'right', padding: '5px 4px' }}>{fmt(totals.subtotal)}</td></tr>
                {qt.has_vat && (
                  <tr><td style={{ padding: '5px 4px', color: '#6a6f85' }}>VAT (7%)</td><td style={{ textAlign: 'right', padding: '5px 4px' }}>{fmt(totals.vat)}</td></tr>
                )}
                <tr>
                  <td style={{ padding: '10px 4px 4px', fontWeight: 800, fontSize: 15, color: '#6c63ff', borderTop: '2px solid #6c63ff' }}>รวมทั้งสิ้น</td>
                  <td style={{ textAlign: 'right', padding: '10px 4px 4px', fontWeight: 800, fontSize: 15, color: '#6c63ff', borderTop: '2px solid #6c63ff' }}>{fmt(totals.total)} บาท</td>
                </tr>
              </tbody>
            </table>
          </div>

          {(qt.payment_terms || qt.notes || tenant?.bank_name || tenant?.bank_account_no) && (
            <div style={{ marginTop: 20, fontSize: 11.5, background: '#f9f9fc', borderRadius: 8, padding: '12px 16px', lineHeight: 1.8 }}>
              {qt.payment_terms && (
                <>
                  <strong style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>เงื่อนไขการชำระเงิน</strong>
                  <div style={{ marginBottom: qt.notes ? 10 : 0, whiteSpace: 'pre-line' }}>{qt.payment_terms}</div>
                </>
              )}
              {qt.notes && (
                <>
                  <strong style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>หมายเหตุ</strong>
                  <div style={{ whiteSpace: 'pre-line' }}>{qt.notes}</div>
                </>
              )}
              {(tenant?.bank_name || tenant?.bank_account_no) && (
                <div style={{ marginTop: 10 }}>
                  <strong>ชำระเงินไปที่:</strong> {tenant?.bank_name} {tenant?.bank_account_name ? `ชื่อบัญชี ${tenant.bank_account_name}` : ''} {tenant?.bank_account_no ? `เลขที่ ${tenant.bank_account_no}` : ''}
                </div>
              )}
            </div>
          )}

          <div style={{ marginTop: 44, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, textAlign: 'center', fontSize: 11.5 }}>
            <div style={{ borderTop: '1px solid #999', paddingTop: 8 }}>ผู้เสนอราคา</div>
            <div style={{ borderTop: '1px solid #999', paddingTop: 8 }}>ผู้ยอมรับ (ลูกค้า)</div>
          </div>
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
        <button className="btn btn-ghost" onClick={() => downloadJPG(`qt-doc-${qt.id}`, `${qt.quotation_number}.jpg`)}>🖼️ ดาวน์โหลด JPG</button>
        <button className="btn btn-primary" onClick={() => downloadPDF(`qt-doc-${qt.id}`, `${qt.quotation_number}.pdf`)}>📄 ดาวน์โหลด PDF</button>
      </div>
    </Modal>
  )
}

export default function Quotations({ navigateTo, navState, openSiteOverview }) {
  const { isAtLeast, role } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'quotations')
  const today = new Date()
  const ytdFrom = format(startOfYear(today), 'yyyy-MM-dd')
  const ytdTo   = format(endOfYear(today),   'yyyy-MM-dd')

  const [dateFrom, setDateFrom] = useState(ytdFrom)
  const [dateTo,   setDateTo]   = useState(ytdTo)
  const [clientId, setClientId] = useState('')
  const [status,   setStatus]   = useState('')
  const [showAdd,  setShowAdd]  = useState(false)
  const [editRow,  setEditRow]  = useState(null)
  const [deleteId, setDeleteId] = useState(null)
  const [saving,   setSaving]   = useState(false)
  const [toast,    setToast]    = useState(null)

  const filters = { from: dateFrom, to: dateTo, clientId, status }
  const { data: quotations, refetch } = useQuotations(filters)
  const { data: clients }      = useClients()
  const { data: sites }        = useSites()
  const { data: catalogItems } = useCatalogItems()

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3000) }

  const handleSave = async (form) => {
    setSaving(true)
    try {
      const qtPayload = {
        client_id: form.client_id,
        date: form.date,
        valid_until: form.valid_until || null,
        has_vat: form.has_vat,
        price_includes_vat: form.has_vat ? form.price_includes_vat : false,
        discount_amount: form.discount_mode === 'amount' ? (parseFloat(form.discount_amount) || null) : null,
        discount_pct: form.discount_mode === 'pct' ? (parseFloat(form.discount_pct) || null) : null,
        payment_terms: form.payment_terms || null,
        notes: form.notes || null,
      }
      let quotationId = editRow?.id
      if (editRow) {
        const { error } = await supabase.from('quotations').update({ ...qtPayload, revision: (editRow.revision || 1) + 1 }).eq('id', editRow.id)
        if (error) throw error
        const { error: delError } = await supabase.from('quotation_items').delete().eq('quotation_id', editRow.id)
        if (delError) throw delError
        await auditLog('quotations', editRow.id, 'UPDATE', editRow, qtPayload)
      } else {
        const { data, error } = await supabase.from('quotations').insert(qtPayload).select().single()
        if (error) throw error
        quotationId = data.id
        await auditLog('quotations', quotationId, 'INSERT', null, qtPayload)
      }

      const itemsPayload = form.items
        .filter(it => it.description.trim())
        .map((it, i) => ({
          quotation_id: quotationId, catalog_item_id: it.catalog_item_id || null,
          description: it.description, quantity: parseFloat(it.quantity) || 0,
          unit: it.unit || null, unit_price: parseFloat(it.unit_price) || 0,
          line_total: lineTotal(it), sort_order: i,
        }))
      if (itemsPayload.length) {
        const { error } = await supabase.from('quotation_items').insert(itemsPayload)
        if (error) throw error
      }

      setShowAdd(false); setEditRow(null); refetch(); showToast('บันทึกสำเร็จ')
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteId) return
    const { error } = await supabase.from('quotations').delete().eq('id', deleteId)
    if (!error) { setDeleteId(null); refetch(); showToast('ลบแล้ว') }
    else alert('Error: ' + error.message)
  }

  const [acceptRow, setAcceptRow] = useState(null)
  const [accepting, setAccepting] = useState(false)
  const [docRow, setDocRow] = useState(null)
  const { hasModuleAccess, tenant } = useTenant()

  const handleSetStatus = async (id, newStatus) => {
    const { error } = await supabase.from('quotations').update({ status: newStatus }).eq('id', id)
    if (!error) { await auditLog('quotations', id, 'UPDATE', null, { status: newStatus }); refetch(); showToast('อัปเดตสถานะแล้ว') }
    else alert('Error: ' + error.message)
  }

  const handleLinkExistingSite = async (siteId) => {
    if (!acceptRow) return
    setAccepting(true)
    try {
      const update = { status: 'accepted', site_id: siteId }
      const { error } = await supabase.from('quotations').update(update).eq('id', acceptRow.id)
      if (error) throw error
      await auditLog('quotations', acceptRow.id, 'UPDATE', null, update)
      setAcceptRow(null); refetch(); showToast('รับใบเสนอราคาและผูกไซท์งานแล้ว')
    } catch (e) { alert('Error: ' + e.message) }
    finally { setAccepting(false) }
  }

  const handleCreateSiteFromQuotation = async (siteForm) => {
    if (!acceptRow) return
    setAccepting(true)
    try {
      const sitePayload = siteFormToPayload(siteForm)
      const { data: newSite, error: siteError } = await supabase.from('sites').insert(sitePayload).select().single()
      if (siteError) throw siteError
      await auditLog('sites', newSite.id, 'INSERT', null, sitePayload)

      const qtUpdate = { status: 'accepted', site_id: newSite.id }
      const { error: qtError } = await supabase.from('quotations').update(qtUpdate).eq('id', acceptRow.id)
      if (qtError) throw qtError
      await auditLog('quotations', acceptRow.id, 'UPDATE', null, qtUpdate)

      setAcceptRow(null); refetch(); showToast('สร้างไซท์งานและรับใบเสนอราคาแล้ว')
    } catch (e) { alert('Error: ' + e.message) }
    finally { setAccepting(false) }
  }

  const editFormInitial = useMemo(() => {
    if (!editRow) return null
    return {
      id: editRow.id, client_id: editRow.client_id,
      date: editRow.date, valid_until: editRow.valid_until || '',
      has_vat: editRow.has_vat, price_includes_vat: editRow.price_includes_vat || false,
      discount_mode: editRow.discount_pct != null ? 'pct' : editRow.discount_amount != null ? 'amount' : 'none',
      discount_amount: editRow.discount_amount != null ? String(editRow.discount_amount) : '',
      discount_pct: editRow.discount_pct != null ? String(editRow.discount_pct) : '',
      payment_terms: editRow.payment_terms || '', notes: editRow.notes || '',
      items: (editRow.quotation_items?.length ? editRow.quotation_items : [{ ...EMPTY_ITEM }])
        .map(it => ({ catalog_item_id: it.catalog_item_id, description: it.description, quantity: String(it.quantity), unit: it.unit || '', unit_price: String(it.unit_price) })),
    }
  }, [editRow])

  // Pre-fills a brand-new quotation's payment_terms/notes from the tenant's
  // saved defaults (Settings → company profile) — existing quotations are
  // untouched, this only applies when editFormInitial is null (add mode).
  const newQuotationInitial = useMemo(() => ({
    ...EMPTY_FORM,
    payment_terms: tenant?.default_payment_terms || '',
    notes: tenant?.default_notes || '',
  }), [tenant])

  return (
    <div>
      {toast && <div className="alert alert-success" style={{ marginBottom: 12 }}>✅ {toast}</div>}

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        {canEdit && <button className="btn btn-primary" onClick={() => { setEditRow(null); setShowAdd(true) }}>+ เพิ่มใบเสนอราคา</button>}
        <div style={{ flex: 1 }} />
        <input type="date" className="input input-sm" style={{ width: 140 }} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        <span style={{ color: 'var(--text3)' }}>—</span>
        <input type="date" className="input input-sm" style={{ width: 140 }} value={dateTo} onChange={e => setDateTo(e.target.value)} />
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ minWidth: 200 }}>
          <SearchableSelect value={clientId} onChange={setClientId} placeholder="ทุกลูกค้า" options={clientOpts(clients)} />
        </div>
        <select className="select select-sm" style={{ width: 160 }} value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">ทุกสถานะ</option>
          {QT_STATUSES.map(s => <option key={s} value={s}>{QT_STATUS_LABELS[s]}</option>)}
        </select>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>เลขที่</th><th>วันที่</th><th>ลูกค้า</th><th>ไซท์งาน</th><th>รายการ</th><th>ยอดรวม</th><th>สถานะ</th><th></th>
              </tr>
            </thead>
            <tbody>
              {(quotations || []).map(qt => {
                const totals = calcQuotationTotals(qt.quotation_items, {
                  hasVat: qt.has_vat, priceIncludesVat: qt.price_includes_vat,
                  discountAmount: qt.discount_amount, discountPct: qt.discount_pct,
                })
                return (
                  <tr key={qt.id}>
                    <td className="font-mono" style={{ fontSize: 12 }}>{qt.quotation_number}</td>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDate(qt.date)}</td>
                    <td style={{ fontSize: 12 }}>{qt.clients?.name || '—'}</td>
                    <td style={{ fontSize: 11, color: 'var(--accent)', cursor: qt.site_id ? 'pointer' : 'default' }}
                      onClick={() => qt.site_id && openSiteOverview(qt.site_id)}>{qt.sites?.name || '—'}</td>
                    <td style={{ fontSize: 11, color: 'var(--text3)' }}>{(qt.quotation_items || []).length} รายการ</td>
                    <td className="font-mono" style={{ fontWeight: 700 }}>{fmt(totals.total)}</td>
                    <td><span className={`badge badge-${qt.status}`}>{QT_STATUS_LABELS[qt.status] || qt.status}</span></td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm btn-ghost" onClick={() => setDocRow(qt)}>📄</button>
                      {canEdit && qt.status === 'draft' && (
                        <>
                          <button className="btn btn-sm btn-primary" onClick={() => handleSetStatus(qt.id, 'sent')}>📤 ส่ง</button>
                          <button className="btn btn-sm btn-ghost" onClick={() => { setEditRow(qt); setShowAdd(true) }}>✏️</button>
                          <button className="btn btn-sm btn-danger" onClick={() => setDeleteId(qt.id)}>✕</button>
                        </>
                      )}
                      {canEdit && qt.status === 'sent' && (
                        <>
                          <button className="btn btn-sm btn-primary" onClick={() => setAcceptRow(qt)}>✅ ยอมรับ</button>
                          <button className="btn btn-sm btn-ghost" onClick={() => handleSetStatus(qt.id, 'rejected')}>ปฏิเสธ</button>
                          <button className="btn btn-sm btn-ghost" onClick={() => handleSetStatus(qt.id, 'expired')}>หมดอายุ</button>
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
              {!(quotations || []).length && (
                <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>ไม่พบใบเสนอราคาในช่วงเวลานี้</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showAdd && (
        <Modal title={editRow ? 'แก้ไขใบเสนอราคา' : 'เพิ่มใบเสนอราคา'} onClose={() => { setShowAdd(false); setEditRow(null) }} maxWidth={700}>
          <QuotationForm
            initial={editFormInitial || newQuotationInitial}
            clients={clients} catalogItems={catalogItems}
            onSave={handleSave} onCancel={() => { setShowAdd(false); setEditRow(null) }} loading={saving}
          />
        </Modal>
      )}

      {deleteId && (
        <ConfirmDialog title="ลบใบเสนอราคา" message="ยืนยันการลบใบเสนอราคานี้?" onConfirm={handleDelete} onCancel={() => setDeleteId(null)} danger />
      )}

      {acceptRow && (
        <AcceptQuotationModal
          quotation={acceptRow}
          totals={calcQuotationTotals(acceptRow.quotation_items, { hasVat: acceptRow.has_vat, priceIncludesVat: acceptRow.price_includes_vat, discountAmount: acceptRow.discount_amount, discountPct: acceptRow.discount_pct })}
          clients={clients} sites={sites} hasModuleAccess={hasModuleAccess}
          onLinkExisting={handleLinkExistingSite} onCreateNew={handleCreateSiteFromQuotation}
          onClose={() => setAcceptRow(null)} loading={accepting}
        />
      )}

      {docRow && <QuotationDocumentModal qt={docRow} tenant={tenant} onClose={() => setDocRow(null)} />}
    </div>
  )
}
