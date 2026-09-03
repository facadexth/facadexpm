// src/pages/Quotations.jsx
// ============================================================
// Quotations — ใบเสนอราคา
// ✅ Itemized, client-required, site optional until accepted
// ✅ Auto-number QT-YYYY-NNN
// ✅ Status: draft -> sent -> accepted (creates/links a Site) | rejected | expired
// ✅ Items optionally drawn from the catalog_items price list, always
//    freely editable afterward (autofill, not enforce)
// ============================================================
import { useState, useMemo, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { useQuotations, useCatalogItems, useClients, useSites, useQuotationRevisions, useDocumentReceipt, useMySignatureUrl, useBankAccounts, logDocumentPrint } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { useTenant } from '../hooks/useTenant.js'
import { canEditPage } from '../lib/permissions.js'
import { useDraftForm } from '../hooks/useDraftForm.js'
import { fmt, fmtDate } from '../lib/supabase.js'
import { auditLog } from '../lib/audit.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import SearchableSelect from '../components/SearchableSelect.jsx'
import QuickAddSelect from '../components/QuickAddSelect.jsx'
import { format, startOfYear, endOfYear } from 'date-fns'
import { lineTotal, calcQuotationTotals } from '../lib/quotationCalc.js'
import { SiteForm, siteFormToPayload } from './Sites.jsx'
import { downloadPDF, downloadJPG } from '../lib/pdf.js'
import SignLinkModal from '../components/SignLinkModal.jsx'
import DocumentReceiptModal from '../components/DocumentReceiptModal.jsx'
import RowActionsMenu from '../components/RowActionsMenu.jsx'

const clientOpts = (clients) => (clients || []).map(c => ({
  value: c.id, label: `${c.client_number} · ${c.name}`, keywords: `${c.client_number} ${c.name}`,
}))
const catalogOpts = (items) => (items || []).filter(i => i.active).map(i => ({
  value: i.id, label: i.unit ? `${i.name} (${i.unit})` : i.name, keywords: i.name,
}))

const VAT_CATEGORY_LABELS = { vat: 'VAT', non_vat: 'ไม่มี VAT' }
const QT_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired']
const QT_STATUS_LABELS = {
  draft: '✏️ ร่าง', sent: '📤 ส่งแล้ว', accepted: '✅ ยอมรับ', rejected: '✕ ปฏิเสธ', expired: '⏰ หมดอายุ',
}

const EMPTY_ITEM = { catalog_item_id: null, description: '', quantity: '1', unit: '', unit_price: '', item_type: 'item' }
const EMPTY_NOTE = { catalog_item_id: null, description: '', quantity: '0', unit: '', unit_price: '0', item_type: 'note' }
// 'item_description' is glued to the item immediately before it (by
// position, not FK) -- only ever created via addFromCatalog below, or by
// being reordered by the user right after some item. Distinct from
// EMPTY_NOTE (a standalone/section note) so a future estimate system can
// query "this item's description" cleanly.
const EMPTY_ITEM_DESCRIPTION = { catalog_item_id: null, description: '', quantity: '0', unit: '', unit_price: '0', item_type: 'item_description' }
const EMPTY_FORM = {
  client_id: '', date: '', valid_until: '', has_vat: true, price_includes_vat: false,
  discount_mode: 'none', discount_amount: '', discount_pct: '',
  payment_terms: '', notes: '', bank_account_id: null, items: [{ ...EMPTY_ITEM }],
}

function QuotationItemsEditor({ items, onChange, catalogItems, onCatalogRefetch }) {
  const set = (i, k, v) => onChange(items.map((it, idx) => idx === i ? { ...it, [k]: v } : it))
  const add = () => onChange([...items, { ...EMPTY_ITEM }])
  const addNote = () => onChange([...items, { ...EMPTY_NOTE }])
  const remove = (i) => onChange(items.length > 1 ? items.filter((_, idx) => idx !== i) : items)
  const addFromCatalog = (catalogId) => {
    const found = (catalogItems || []).find(c => c.id === catalogId)
    if (!found) return
    onChange([...items, {
      catalog_item_id: found.id, description: found.name, unit: found.unit || '',
      quantity: '1', unit_price: String(found.default_unit_price), item_type: 'item',
    }, { ...EMPTY_ITEM_DESCRIPTION }])
  }
  // Lets a free-typed line become a reusable catalog entry without leaving
  // the quotation — inserts it, then links this row to the new entry the
  // same way picking from the catalog does (so it won't offer to save
  // twice), and refetches so the picker dropdown includes it right away.
  const saveToCatalog = async (i) => {
    const it = items[i]
    if (!it.description.trim()) return
    const { data, error } = await supabase.from('catalog_items').insert({
      name: it.description, unit: it.unit || null, default_unit_price: parseFloat(it.unit_price) || 0,
    }).select().single()
    if (error) { alert('Error: ' + error.message); return }
    set(i, 'catalog_item_id', data.id)
    onCatalogRefetch?.()
  }
  const grandTotal = items.reduce((sum, it) => sum + lineTotal(it), 0)

  return (
    <div>
      <label className="label">รายการ ★</label>
      <div style={{ display: 'grid', gap: 8 }}>
        {items.map((it, i) => (
          it.item_type === 'note' || it.item_type === 'item_description' ? (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 32px', gap: 6, alignItems: 'center', paddingLeft: it.item_type === 'item_description' ? 20 : 0 }}>
              <input className="input input-sm"
                placeholder={it.item_type === 'item_description' ? 'คำอธิบายรายการ (ของรายการด้านบน — ไม่มีราคา)' : 'ข้อมูลเพิ่มเติม (ไม่มีราคา — เช่น หมายเหตุ, หัวข้อคั่น)'}
                style={{ fontStyle: 'italic' }}
                value={it.description} onChange={e => set(i, 'description', e.target.value)} />
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => remove(i)} disabled={items.length === 1}>✕</button>
            </div>
          ) : (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 80px 100px 32px 32px', gap: 6, alignItems: 'center' }}>
              <input className="input input-sm" placeholder="รายละเอียดรายการ" required
                value={it.description} onChange={e => set(i, 'description', e.target.value)} />
              <input className="input input-sm" type="number" min="0" step="0.01" placeholder="จำนวน"
                value={it.quantity} onChange={e => set(i, 'quantity', e.target.value)} />
              <input className="input input-sm" placeholder="หน่วย"
                value={it.unit} onChange={e => set(i, 'unit', e.target.value)} />
              <input className="input input-sm" type="number" min="0" step="0.01" placeholder="ราคา/หน่วย"
                value={it.unit_price} onChange={e => set(i, 'unit_price', e.target.value)} />
              {!it.catalog_item_id && it.description.trim()
                ? <button type="button" className="btn btn-sm btn-ghost" title="บันทึกเป็นรายการสินค้าใหม่" onClick={() => saveToCatalog(i)}>💾</button>
                : <span title={it.catalog_item_id ? 'อยู่ในรายการสินค้าแล้ว' : undefined} style={{ textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>{it.catalog_item_id ? '📦' : ''}</span>}
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => remove(i)} disabled={items.length === 1}>✕</button>
            </div>
          )
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-sm btn-ghost" onClick={add}>+ เพิ่มรายการว่าง</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={addNote}>+ เพิ่มข้อมูลเพิ่มเติม</button>
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

function QuotationForm({ initial = EMPTY_FORM, clients, catalogItems, onCatalogRefetch, onSave, onCancel, loading, onClientCreated }) {
  const isAdd = !initial?.id
  const [form, setForm, clearFormDraft] = useDraftForm('quotation-form', { ...EMPTY_FORM, ...initial }, isAdd)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  // บัญชีธนาคารที่เลือกได้ต้องอยู่หมวดเดียวกับ has_vat ของเอกสารนี้เท่านั้น
  // -- ถ้าบัญชีที่เลือกไว้ (หรือยังไม่เลือก) ไม่ตรงหมวดหลัง has_vat เปลี่ยน
  // ให้ auto สลับไปบัญชี default ของหมวดใหม่ให้เลย
  const { data: allBankAccounts } = useBankAccounts()
  const bankCategory = form.has_vat ? 'vat' : 'non_vat'
  const bankAccountsInCategory = (allBankAccounts || []).filter(a => a.vat_category === bankCategory)
  useEffect(() => {
    const stillValid = bankAccountsInCategory.some(a => a.id === form.bank_account_id)
    if (!stillValid) {
      const def = bankAccountsInCategory.find(a => a.is_default) || bankAccountsInCategory[0]
      set('bank_account_id', def?.id || null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bankCategory, allBankAccounts])

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
          <QuickAddSelect required value={form.client_id} onChange={id => set('client_id', id)}
            placeholder="— เลือกลูกค้า —" options={clientOpts(clients)}
            table="clients" namePlaceholder="ชื่อลูกค้าใหม่" onCreated={onClientCreated} />
        </div>
        <QuotationItemsEditor items={form.items} onChange={items => set('items', items)} catalogItems={catalogItems} onCatalogRefetch={onCatalogRefetch} />
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
          <label className="label">หมายเหตุ</label>
          <textarea className="textarea" rows={2} value={form.notes} onChange={e => set('notes', e.target.value)} />
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label">บัญชีธนาคารสำหรับรับชำระเงิน ({VAT_CATEGORY_LABELS[bankCategory]})</label>
            {bankAccountsInCategory.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--text3)' }}>ยังไม่มีบัญชี{VAT_CATEGORY_LABELS[bankCategory]} — เพิ่มได้ที่หน้าตั้งค่า</div>
            ) : (
              <select className="input" value={form.bank_account_id || ''} onChange={e => set('bank_account_id', e.target.value || null)}>
                {bankAccountsInCategory.map(a => (
                  <option key={a.id} value={a.id}>{a.bank_name} · {a.account_name} · {a.account_no}{a.is_default ? ' (default)' : ''}</option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className="label">เงื่อนไขการชำระเงิน</label>
            <textarea className="textarea" rows={2} value={form.payment_terms} onChange={e => set('payment_terms', e.target.value)} placeholder="เช่น มัดจำ 30% เมื่อเซ็นสัญญา ส่วนที่เหลือแบ่งจ่ายตามงวดงาน" />
          </div>
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

function AcceptQuotationModal({ quotation, totals, clients, sites, hasModuleAccess, onLinkExisting, onCreateNew, onClose, loading, onClientCreated }) {
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
        <SiteForm initial={siteFormInitial} clients={clients} hasModuleAccess={hasModuleAccess} onSave={onCreateNew} onCancel={onClose} loading={loading} draftKey="quotation-accept-site-form" onClientCreated={onClientCreated} />
      )}
    </Modal>
  )
}

// Shared "professional" document look (design option A) — logo/company
// block left, bordered doc-info box + ต้นฉบับ tag right, light-purple
// table header, boxed notes/terms, purple-accented (unfilled) grand total.
// Extracted so a past revision's snapshot can render through the exact
// same markup as the live document, not a separate summary — the only
// difference is which data feeds it and the doc-info tag.
function QuotationPaper({ elementId, tenant, quotationNumber, tag, date, validUntil, revision, clientName, clientAddress, clientTaxId, items, hasVat, priceIncludesVat, discountAmount, discountPct, paymentTerms, notes, bankAccount, clientSignature }) {
  const totals = calcQuotationTotals(items, { hasVat, priceIncludesVat, discountAmount, discountPct })
  const mySignature = useMySignatureUrl()

  return (
    <div id={elementId} className="printable-document" style={{ fontFamily: 'Sarabun,sans-serif', padding: '40px 44px', background: '#fff', color: '#17181f' }}>
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
          <div style={{ fontSize: 11, fontWeight: 700, color: '#6c63ff', border: '1px solid #6c63ff', borderRadius: 4, padding: '2px 8px', display: 'inline-block', marginBottom: 6 }}>{tag || 'ต้นฉบับ'}</div>
          <div style={{ fontSize: 22, fontWeight: 800 }}>ใบเสนอราคา</div>
        </div>
      </div>

      <div style={{ marginTop: 20, border: '1px solid #e4e6ef', borderRadius: 8, padding: '14px 16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 24px', fontSize: 12 }}>
        <div><span style={{ color: '#6a6f85' }}>เลขที่เอกสาร</span><br />{quotationNumber}</div>
        <div><span style={{ color: '#6a6f85' }}>วันที่ออก</span><br />{date ? new Date(date).toLocaleDateString('th-TH') : '—'}</div>
        <div><span style={{ color: '#6a6f85' }}>ใช้ได้ถึง</span><br />{validUntil ? new Date(validUntil).toLocaleDateString('th-TH') : '—'}</div>
        <div><span style={{ color: '#6a6f85' }}>แก้ไขครั้งที่</span><br />{revision || 1}</div>
      </div>

      <div style={{ marginTop: 16, fontSize: 12.5, lineHeight: 1.9, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px' }}>
        <span style={{ color: '#6a6f85' }}>ลูกค้า</span><strong>{clientName || '—'}</strong>
        {clientTaxId && <><span style={{ color: '#6a6f85' }}>เลขประจำตัวผู้เสียภาษี</span><span>{clientTaxId}</span></>}
        {clientAddress && <><span style={{ color: '#6a6f85' }}>ที่อยู่</span><span>{clientAddress}</span></>}
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
          {items.map((it, i) => (
            it.item_type === 'note' || it.item_type === 'item_description' ? (
              <tr key={it.id || i}>
                <td colSpan={4} style={{ padding: `6px 8px 6px ${it.item_type === 'item_description' ? 20 : 8}px`, borderBottom: '1px solid #eee', fontStyle: 'italic', color: '#666', whiteSpace: 'pre-line' }}>{it.description}</td>
              </tr>
            ) : (
              <tr key={it.id || i}>
                <td style={{ padding: '9px 8px', borderBottom: '1px solid #eee' }}>{it.description}</td>
                <td style={{ textAlign: 'right', padding: '9px 8px', borderBottom: '1px solid #eee' }}>{it.quantity} {it.unit || ''}</td>
                <td style={{ textAlign: 'right', padding: '9px 8px', borderBottom: '1px solid #eee' }}>{fmt(it.unit_price)}</td>
                <td style={{ textAlign: 'right', padding: '9px 8px', borderBottom: '1px solid #eee' }}>{fmt(it.line_total)}</td>
              </tr>
            )
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
            {hasVat && (
              <tr><td style={{ padding: '5px 4px', color: '#6a6f85' }}>VAT (7%)</td><td style={{ textAlign: 'right', padding: '5px 4px' }}>{fmt(totals.vat)}</td></tr>
            )}
            <tr>
              <td style={{ padding: '10px 4px 4px', fontWeight: 800, fontSize: 15, color: '#6c63ff', borderTop: '2px solid #6c63ff' }}>รวมทั้งสิ้น</td>
              <td style={{ textAlign: 'right', padding: '10px 4px 4px', fontWeight: 800, fontSize: 15, color: '#6c63ff', borderTop: '2px solid #6c63ff' }}>{fmt(totals.total)} บาท</td>
            </tr>
          </tbody>
        </table>
      </div>

      {(paymentTerms || notes || bankAccount) && (
        <div style={{ marginTop: 20, fontSize: 11.5, background: '#f9f9fc', borderRadius: 8, padding: '12px 16px', lineHeight: 1.8 }}>
          {(paymentTerms || notes) && (
            <>
              <strong style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>หมายเหตุ</strong>
              <div style={{ marginBottom: bankAccount ? 10 : 0, whiteSpace: 'pre-line' }}>
                {[paymentTerms, notes].filter(Boolean).join('\n\n')}
              </div>
            </>
          )}
          {bankAccount && (
            <div style={{ marginTop: 10 }}>
              <strong>ชำระเงินไปที่:</strong> {bankAccount.bank_name} ชื่อบัญชี {bankAccount.account_name} เลขที่ {bankAccount.account_no}
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: 44, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, textAlign: 'center', fontSize: 11.5 }}>
        <div>
          <div style={{ height: 40, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
            {mySignature && <img src={mySignature.url} alt="" crossOrigin="anonymous" style={{ height: 36, display: 'block' }} />}
          </div>
          <div style={{ borderTop: '1px solid #999', paddingTop: 8 }}>ผู้เสนอราคา</div>
        </div>
        <div>
          <div style={{ height: 40, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
            {clientSignature && <img src={clientSignature.url} alt="" crossOrigin="anonymous" style={{ height: 36, display: 'block' }} />}
          </div>
          <div style={{ borderTop: '1px solid #999', paddingTop: 8 }}>ผู้ยอมรับ (ลูกค้า)</div>
          {clientSignature && (
            <div style={{ marginTop: 2, color: '#6a6f85', fontSize: 10 }}>
              {clientSignature.signerName} · เซ็นเมื่อ {new Date(clientSignature.signedAt).toLocaleDateString('th-TH')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function QuotationDocumentModal({ qt, tenant, onClose }) {
  const elementId = `qt-doc-${qt.id}`
  const { data: receipt } = useDocumentReceipt('quotation', qt.id)
  const [signatureUrl, setSignatureUrl] = useState(null)
  useEffect(() => {
    if (!receipt) { setSignatureUrl(null); return }
    let cancelled = false
    supabase.storage.from('document-receipts').createSignedUrl(receipt.signature_path, 300)
      .then(({ data }) => { if (!cancelled) setSignatureUrl(data?.signedUrl) })
    return () => { cancelled = true }
  }, [receipt])

  // ผู้ใช้เลือกเองว่าจะบันทึก/พิมพ์เป็น "ต้นฉบับ" หรือ "สำเนา" -- ไม่ auto
  // นับจากประวัติการพิมพ์อีกต่อไป (เคยนับอัตโนมัติจาก document_prints แต่
  // ผู้ใช้อยากตัดสินใจเอง) document_prints ยังบันทึกไว้เป็น audit log ว่า
  // ใครพิมพ์ฟอร์แมตไหนเมื่อไหร่ แค่ไม่ได้ใช้มากำหนดแท็กแล้ว
  const [printTag, setPrintTag] = useState('ต้นฉบับ')

  const handleDownload = async (format, exportFn) => {
    await logDocumentPrint(tenant?.id, 'quotation', qt.id, format)
    await exportFn(elementId, `${printTag}-${qt.quotation_number}`)
  }

  return (
    <Modal title={`ใบเสนอราคา ${qt.quotation_number}`} onClose={onClose} maxWidth={720}>
      <div className="modal-body">
        <QuotationPaper
          elementId={elementId} tenant={tenant} quotationNumber={qt.quotation_number} tag={printTag}
          date={qt.date} validUntil={qt.valid_until} revision={qt.revision || 1}
          clientName={qt.clients?.name} clientAddress={qt.clients?.address} clientTaxId={qt.clients?.tax_id} items={qt.quotation_items || []}
          hasVat={qt.has_vat} priceIncludesVat={qt.price_includes_vat}
          discountAmount={qt.discount_amount} discountPct={qt.discount_pct}
          paymentTerms={qt.payment_terms} notes={qt.notes} bankAccount={qt.bank_accounts}
          clientSignature={receipt && signatureUrl ? { url: signatureUrl, signerName: receipt.signer_name, signedAt: receipt.signed_at } : null}
        />
      </div>
      <div className="modal-footer" style={{ alignItems: 'center' }}>
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          {['ต้นฉบับ', 'สำเนา'].map(t => (
            <button key={t} type="button" className={`btn btn-sm ${printTag === t ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setPrintTag(t)}>{t}</button>
          ))}
        </div>
        <RowActionsMenu
          trigger="💾 บันทึกเอกสาร ▾" triggerClassName="btn btn-primary"
          items={[
            { label: '🖨️ พิมพ์', onClick: () => window.print() },
            { label: '📄 บันทึกเป็น PDF', onClick: () => handleDownload('pdf', downloadPDF) },
            { label: '🖼️ บันทึกเป็น JPG', onClick: () => handleDownload('jpg', downloadJPG) },
          ]}
        />
      </div>
    </Modal>
  )
}

// Shows a past revision as the real document (via QuotationPaper), not a
// content list — a compact picker across the top switches which revision
// is rendered, and it's downloadable the same way the live document is.
function QuotationHistoryModal({ quotation, tenant, onClose }) {
  const { data: revisions } = useQuotationRevisions(quotation.id)
  const [selectedId, setSelectedId] = useState(null)
  const selected = (revisions || []).find(r => r.id === selectedId) || revisions?.[0]
  const elementId = selected ? `qt-hist-doc-${selected.id}` : null
  const s = selected?.snapshot

  return (
    <Modal title={`ประวัติการแก้ไข ${quotation.quotation_number}`} onClose={onClose} maxWidth={760}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div style={{ fontSize: 12, color: 'var(--text3)' }}>
          ฉบับปัจจุบันคือแก้ไขครั้งที่ {quotation.revision || 1} — เลือกฉบับก่อนหน้าด้านล่างเพื่อดูเอกสารตอนนั้น
        </div>
        {!revisions?.length && (
          <div style={{ color: 'var(--text3)', fontSize: 13, padding: 16, textAlign: 'center' }}>ยังไม่มีประวัติ</div>
        )}
        {revisions?.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {revisions.map(rev => (
              <button
                key={rev.id} type="button"
                className={`btn btn-sm ${rev.id === selected?.id ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setSelectedId(rev.id)}
              >
                แก้ไขครั้งที่ {rev.revision} · {fmtDate(rev.created_at)}
              </button>
            ))}
          </div>
        )}
        {selected && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
            <QuotationPaper
              elementId={elementId} tenant={tenant} quotationNumber={quotation.quotation_number}
              tag={`ฉบับแก้ไขครั้งที่ ${selected.revision} (ประวัติ)`}
              date={s.date} validUntil={s.valid_until} revision={selected.revision}
              clientName={s.client_name} items={s.items || []}
              hasVat={s.has_vat} priceIncludesVat={s.price_includes_vat}
              discountAmount={s.discount_amount} discountPct={s.discount_pct}
              paymentTerms={s.payment_terms} notes={s.notes} bankAccount={s.bank_account}
            />
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
        {selected && (
          <RowActionsMenu
            trigger="💾 บันทึกเอกสาร ▾" triggerClassName="btn btn-primary"
            items={[
              { label: '🖨️ พิมพ์', onClick: () => window.print() },
              { label: '📄 บันทึกเป็น PDF', onClick: () => downloadPDF(elementId, `${quotation.quotation_number}-rev${selected.revision}.pdf`) },
              { label: '🖼️ บันทึกเป็น JPG', onClick: () => downloadJPG(elementId, `${quotation.quotation_number}-rev${selected.revision}.jpg`) },
            ]}
          />
        )}
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
  const { data: clients, refetch: refetchClients }      = useClients()
  const { data: sites }        = useSites()
  const { data: catalogItems, refetch: refetchCatalogItems } = useCatalogItems()

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
        bank_account_id: form.bank_account_id || null,
      }
      let quotationId = editRow?.id
      if (editRow) {
        // Only a document that's been sent at least once (ever_sent —
        // stays true even after a pull-back-to-edit) gets a revision
        // snapshot + counter bump. Editing a quotation that's never been
        // sent is normal draft iteration, not a revision.
        if (editRow.ever_sent) {
          // Snapshot the pre-edit state (this revision's content) before
          // overwriting it — editRow.quotation_items is what's still live
          // at this point, so it's the accurate "before" picture.
          const snapshot = {
            client_id: editRow.client_id, client_name: editRow.clients?.name || null,
            date: editRow.date, valid_until: editRow.valid_until,
            has_vat: editRow.has_vat, price_includes_vat: editRow.price_includes_vat,
            discount_amount: editRow.discount_amount, discount_pct: editRow.discount_pct,
            payment_terms: editRow.payment_terms, notes: editRow.notes,
            bank_account: editRow.bank_accounts || null,
            items: (editRow.quotation_items || []).map(it => ({
              description: it.description, unit: it.unit, quantity: it.quantity, unit_price: it.unit_price, line_total: it.line_total,
            })),
          }
          const { error: snapError } = await supabase.from('quotation_revisions').insert({
            quotation_id: editRow.id, revision: editRow.revision || 1, snapshot,
          })
          if (snapError) throw snapError
        }

        const revisionUpdate = editRow.ever_sent ? { revision: (editRow.revision || 1) + 1 } : {}
        const { error } = await supabase.from('quotations').update({ ...qtPayload, ...revisionUpdate }).eq('id', editRow.id)
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
          line_total: lineTotal(it), sort_order: i, item_type: it.item_type || 'item',
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
  const [historyRow, setHistoryRow] = useState(null)
  const [linkTarget, setLinkTarget] = useState(null)
  const [signTarget, setSignTarget] = useState(null)
  const { hasModuleAccess, tenant } = useTenant()

  // เซ็นรับต่อหน้า (มือถือ/แท็บเล็ตของพนักงานส่งให้ลูกค้าเซ็นตรงนั้น) --
  // เหมือนกับเซ็นผ่านลิงก์ระยะไกล (sign-link Edge Function): เซ็นก็คือ
  // ยอมรับทันที ไม่ต้องกดยอมรับแยกอีกที ส่วนการผูกไซท์งานยังคงเป็นขั้นตอน
  // แยกเสมอ (ต้องมีคนเลือก/สร้างไซท์งานจริง) -- ปุ่ม "🔗 ผูกไซท์งาน" ที่มีอยู่
  // แล้วจะโผล่มาเองหลังเซ็น เพราะ status เป็น accepted แต่ site_id ยังว่าง
  const handleQuotationSigned = async () => {
    if (!signTarget) return
    const { error } = await supabase.from('quotations').update({ status: 'accepted' }).eq('id', signTarget.id)
    if (error) { alert('Error: ' + error.message); return }
    await auditLog('quotations', signTarget.id, 'UPDATE', null, { status: 'accepted' })
    setSignTarget(null)
    refetch()
    showToast('เซ็นรับและยอมรับใบเสนอราคาแล้ว')
  }

  const handleSetStatus = async (id, newStatus) => {
    // ever_sent ติดค้างเป็น true ตลอดไปตั้งแต่ครั้งแรกที่กด "ส่ง" -- ไม่รีเซ็ต
    // แม้ดึงกลับเป็นร่างทีหลัง (handlePullBackToEdit) ใช้แยกว่าการแก้ไข
    // ครั้งต่อไปควรนับเป็น revision จริงหรือแค่แก้ร่างธรรมดา (ดูจุดบันทึก
    // ด้านล่าง)
    const payload = newStatus === 'sent' ? { status: newStatus, ever_sent: true } : { status: newStatus }
    const { error } = await supabase.from('quotations').update(payload).eq('id', id)
    if (!error) { await auditLog('quotations', id, 'UPDATE', null, payload); refetch(); showToast('อัปเดตสถานะแล้ว') }
    else alert('Error: ' + error.message)
  }

  // ดึงใบเสนอราคาที่ "ส่งแล้ว" กลับมาเป็น "ร่าง" เพื่อแก้ไข -- ทำทั้งสองอย่าง
  // ในคลิกเดียว (เปลี่ยนสถานะ + เปิดฟอร์มแก้ไขทันที) แทนที่จะให้กดสองครั้ง
  // ต้องเปลี่ยนสถานะกลับไปร่างก่อน เพราะปุ่มแก้ไข (ดินสอ) เดิมโชว์เฉพาะ
  // status==='draft' เท่านั้น -- จำกัดไว้แค่ status==='sent' เพราะใบที่
  // "ยอมรับ" แล้วอาจมีไซท์งาน/ใบแจ้งหนี้ผูกอยู่แล้ว ดึงกลับไม่ปลอดภัยเท่า
  const handlePullBackToEdit = async (qt) => {
    const { error } = await supabase.from('quotations').update({ status: 'draft' }).eq('id', qt.id)
    if (error) { alert('Error: ' + error.message); return }
    await auditLog('quotations', qt.id, 'UPDATE', null, { status: 'draft' })
    setEditRow({ ...qt, status: 'draft' })
    setShowAdd(true)
    refetch()
  }

  // Recomputes sites.contract_value/contract_value_no_vat as the sum of
  // every accepted quotation attached to this site -- not a one-time set,
  // so the site stays correct as more quotations attach later (e.g. a
  // change order accepted into an existing site). Reuses each quotation's
  // own calcQuotationTotals (already VAT/discount-branched per quotation)
  // rather than re-deriving VAT from a blended no-vat figure, so mixed VAT
  // settings across attached quotations still sum correctly.
  const recalcSiteContractValue = async (siteId) => {
    const { data: siteQuotations, error } = await supabase
      .from('quotations')
      .select('has_vat, price_includes_vat, discount_amount, discount_pct, quotation_items(line_total, quantity, unit_price)')
      .eq('site_id', siteId)
      .eq('status', 'accepted')
    if (error) throw error

    const sums = (siteQuotations || []).reduce((acc, q) => {
      const totals = calcQuotationTotals(q.quotation_items, {
        hasVat: q.has_vat, priceIncludesVat: q.price_includes_vat,
        discountAmount: q.discount_amount, discountPct: q.discount_pct,
      })
      return { noVat: acc.noVat + totals.subtotal, total: acc.total + totals.total }
    }, { noVat: 0, total: 0 })

    const { error: updateError } = await supabase.from('sites').update({
      contract_value_no_vat: Math.round(sums.noVat * 100) / 100,
      contract_value: Math.round(sums.total * 100) / 100,
    }).eq('id', siteId)
    if (updateError) throw updateError
  }

  const handleLinkExistingSite = async (siteId) => {
    if (!acceptRow) return
    setAccepting(true)
    try {
      const update = { status: 'accepted', site_id: siteId }
      const { error } = await supabase.from('quotations').update(update).eq('id', acceptRow.id)
      if (error) throw error
      await auditLog('quotations', acceptRow.id, 'UPDATE', null, update)
      await recalcSiteContractValue(siteId)
      setAcceptRow(null); refetch(); showToast('รับใบเสนอราคาและผูกไซท์งานแล้ว (มูลค่าสัญญาของไซท์งานอัปเดตแล้ว)')
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
      // Recompute rather than trust sitePayload's one-time contract_value --
      // keeps this path and the existing-site path on the exact same source
      // of truth, so a site is never wrong even if more quotations attach later.
      await recalcSiteContractValue(newSite.id)

      setAcceptRow(null); refetch(); showToast('สร้างไซท์งานและรับใบเสนอราคาแล้ว')
    } catch (e) {
      alert(e.message?.includes('row-level security policy')
        ? 'สร้างไซท์งานไม่สำเร็จ: อาจเกินจำนวนไซท์งานที่ package ปัจจุบันอนุญาต กรุณาติดต่อผู้ดูแลระบบเพื่ออัปเกรด package'
        : 'Error: ' + e.message)
    }
    finally { setAccepting(false) }
  }

  const editFormInitial = useMemo(() => {
    if (!editRow) return null
    return {
      id: editRow.id, client_id: editRow.client_id,
      // Defaults to today, not the original/last-saved date — each saved
      // edit is a new revision, so the document's issue date should read
      // as the day *this* revision was produced. Still editable if a
      // specific backdate is genuinely needed.
      date: format(new Date(), 'yyyy-MM-dd'), valid_until: editRow.valid_until || '',
      has_vat: editRow.has_vat, price_includes_vat: editRow.price_includes_vat || false,
      discount_mode: editRow.discount_pct != null ? 'pct' : editRow.discount_amount != null ? 'amount' : 'none',
      discount_amount: editRow.discount_amount != null ? String(editRow.discount_amount) : '',
      discount_pct: editRow.discount_pct != null ? String(editRow.discount_pct) : '',
      payment_terms: editRow.payment_terms || '', notes: editRow.notes || '',
      bank_account_id: editRow.bank_account_id || null,
      items: (editRow.quotation_items?.length ? editRow.quotation_items : [{ ...EMPTY_ITEM }])
        .map(it => ({ catalog_item_id: it.catalog_item_id, description: it.description, quantity: String(it.quantity), unit: it.unit || '', unit_price: String(it.unit_price), item_type: it.item_type || 'item' })),
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
                      <div className="actions-cell">
                        <button className="btn btn-sm btn-ghost" onClick={() => setDocRow(qt)}>📄</button>
                        {(qt.revision || 1) > 1 && (
                          <button className="btn btn-sm btn-ghost" title="ประวัติการแก้ไข" onClick={() => setHistoryRow(qt)}>🕓</button>
                        )}
                        {canEdit && qt.status === 'draft' && (
                          <>
                            <button className="btn btn-sm btn-primary" onClick={() => handleSetStatus(qt.id, 'sent')}>📤 ส่ง</button>
                            <RowActionsMenu items={[
                              { label: '✏️ แก้ไข', onClick: () => { setEditRow(qt); setShowAdd(true) } },
                              { label: '🗑️ ลบ', onClick: () => setDeleteId(qt.id), danger: true },
                            ]} />
                          </>
                        )}
                        {canEdit && qt.status === 'sent' && (
                          <>
                            <button className="btn btn-sm btn-primary" onClick={() => setSignTarget(qt)} title="เซ็นรับต่อหน้า (ส่งอุปกรณ์ให้ลูกค้าเซ็นตรงนี้)">🖊️ เซ็นรับ</button>
                            <RowActionsMenu items={[
                              { label: '🔗 ลิงก์เซ็นรับ', onClick: () => setLinkTarget(qt) },
                              { label: '↩️ แก้ไข (ดึงกลับเป็นร่าง)', onClick: () => handlePullBackToEdit(qt) },
                              { label: 'ปฏิเสธ', onClick: () => handleSetStatus(qt.id, 'rejected') },
                              { label: 'หมดอายุ', onClick: () => handleSetStatus(qt.id, 'expired') },
                            ]} />
                          </>
                        )}
                        {canEdit && qt.status === 'accepted' && !qt.site_id && (
                          <button className="btn btn-sm btn-primary" onClick={() => setAcceptRow(qt)} title="ลูกค้าเซ็นรับแล้ว เหลือแค่ผูกไซท์งาน">🔗 ผูกไซท์งาน</button>
                        )}
                      </div>
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
            clients={clients} catalogItems={catalogItems} onCatalogRefetch={refetchCatalogItems}
            onSave={handleSave} onCancel={() => { setShowAdd(false); setEditRow(null) }} loading={saving}
            onClientCreated={refetchClients}
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
          onClientCreated={refetchClients}
        />
      )}

      {docRow && <QuotationDocumentModal qt={docRow} tenant={tenant} onClose={() => setDocRow(null)} />}

      {linkTarget && (
        <SignLinkModal documentType="quotation" documentId={linkTarget.id} onClose={() => setLinkTarget(null)} />
      )}

      {signTarget && (
        <DocumentReceiptModal
          documentType="quotation"
          documentId={signTarget.id}
          tenantId={tenant?.id}
          title={`เซ็นรับใบเสนอราคา ${signTarget.quotation_number}`}
          onClose={() => setSignTarget(null)}
          onSaved={handleQuotationSigned}
        />
      )}

      {historyRow && <QuotationHistoryModal quotation={historyRow} tenant={tenant} onClose={() => setHistoryRow(null)} />}
    </div>
  )
}
