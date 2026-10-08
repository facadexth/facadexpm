// ============================================================
// PurchaseOrders — ใบสั่งซื้อ
// ✅ Itemized PO tied to site/supplier/category
// ✅ Auto-number PO-YYYY-NNN
// ✅ Status: ordered -> received (auto-creates expense) | cancelled
// ============================================================
import { useState, useMemo, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase.js'
import { usePurchaseOrders, useSites, useSuppliers, useCategories, useUnits, useInventoryItems, useAllInventoryItems, useInventoryItemUnitFactors, useStockBalances, useAluminumProfiles, useAllAluminumProfiles, useMySignatureUrl, useMyWorkerName, useSupplierDocumentExamples, extractPoDocument, saveSupplierDocumentExample, receivePoWithDeposits, useActiveTaxInvoiceLinks, usePoMoneyIndex, usePoLedger } from '../hooks/useSupabase.js'
import { fileToExtractionPayload, buildExampleExtracted, applyScanVatBasis, clearScanVatBasis, scanLinesTotalExVat } from '../lib/poDocumentExtraction.js'
import ScanDocPreview from '../components/ScanDocPreview.jsx'
import ScanNotice from '../components/ScanNotice.jsx'
import { SCAN_REMINDER, SCAN_VAT_INCLUSIVE_NOTICE, showVatInclusiveNotice } from '../lib/scanNotice.js'
import { computeWeightedAverageCost, convertToBaseUnit, computeAluminumWeightKg, computeGlassAreaSqm, computePoItemBaseQty } from '../lib/inventoryCost.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import { useDraftForm, readDraft, saveDraft, clearDraft } from '../hooks/useDraftForm.js'

// useDraftForm already survives an Android tab-discard reload for the form's
// OWN fields (restores on next mount), but the list page's "is the add
// modal even open" state is a separate useState that reload always resets
// to false -- so a reload mid-scan silently drops you on the bare list with
// an orphaned draft nobody reopens. This flag records "the add form was
// open" alongside the draft so the list page can reopen it automatically.
const ADD_FORM_OPEN_KEY = 'purchase-order-form-open'
import { useTenant } from '../hooks/useTenant.js'
import { fmt, fmtDate } from '../lib/supabase.js'
import { auditLog } from '../lib/audit.js'
import { bangkokTodayIso } from '../lib/photoUpload.js'
import { decideScanDate, formatIsoDmy } from '../lib/scanDateGuard.js'
import { suggestStockLinks } from '../lib/poStockLinkSuggest.js'
import { calcPoTotals, poLineTotal as lineTotal } from '../lib/poTotals.js'
import { VAT_RATE } from '../lib/invoiceCalc.js'
import { poTaxInvoiceBadge, buildPoPayloadFlag, poEditLockedText, poTaxInvoiceErrorText } from '../lib/poTaxInvoiceStatus.js'
import { poMoneyLockText, poLedgerSummary, mapPoReceiptRpcError, receiveRoute, canOfferCreateDeposit, poHasMultipleBills, SWAP_MULTI_BILL_TEXT } from '../lib/poReceiptErrors.js'
import CreatePoDepositModal from '../components/CreatePoDepositModal.jsx'
import ReceivePoLinesModal from '../components/ReceivePoLinesModal.jsx'
import ReceiveDepositBlock from '../components/ReceiveDepositBlock.jsx'
import { mapReceiveRpcError, canConfirmReceive } from '../lib/receiveDeposits.js'
import { setCreditNotePrefill, poItemToCreditLine } from '../lib/creditNotePrefill.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import SearchableSelect from '../components/SearchableSelect.jsx'
import QuickAddSelect from '../components/QuickAddSelect.jsx'
import UnitSelect from '../components/UnitSelect.jsx'
import AttachmentsSection from '../components/AttachmentsSection.jsx'
import { format, startOfYear, endOfYear } from 'date-fns'
import { downloadPDF, downloadJPG } from '../lib/pdf.js'
import RowActionsMenu from '../components/RowActionsMenu.jsx'
import PendingMark from '../components/PendingMark.jsx'
import { removeBlockOrClear } from '../lib/rowEditing.js'
import { isPoDraft } from '../lib/pendingRules.js'

const siteOpts = (sites) => (sites || []).map(s => ({
  value: s.id, label: `${s.site_number} · ${s.name}`, keywords: `${s.site_number} ${s.name}`,
}))
const catOpts = (categories) => (categories || []).map(c => ({ value: c.id, label: c.name, keywords: c.name }))
const supplierOpts = (suppliers) => (suppliers || []).map(s => ({
  value: s.id, label: `${s.supplier_number} · ${s.name}`, keywords: `${s.supplier_number} ${s.name}`,
}))

const PO_STATUSES = ['draft', 'ordered', 'partially_received', 'received', 'cancelled']
const PO_STATUS_LABELS = { draft: '📝 ร่าง (รอเติมข้อมูล)', ordered: '📦 สั่งแล้ว', partially_received: '🚚 รับบางส่วน', received: '✅ รับของแล้ว', cancelled: '✕ ยกเลิก' }
const BILL_STATUS_LABELS = { awaiting_billing: '🧾 รอวางบิล', pending: '⏳ ค้างจ่าย', check_issued: '📄 ออกเช็ค', check_cleared: '🏦 เช็คผ่าน', paid: '✅ จ่ายแล้ว' }

// linked = blue, awaiting = amber (existing badge colours)
const TAX_BADGE_CLASS = { linked: 'badge-check_cleared', awaiting: 'badge-pending' }

const EMPTY_ITEM = { description: '', quantity: '1', unit: '', unit_price: '', discount_pct: '0', inventory_item_id: '', aluminum_profile_id: '', rod_length_m: '', glass_width_m: '', glass_height_m: '' }
const EMPTY_FORM = { site_id: '', supplier_id: '', category_id: '', date: '', has_vat: true, price_includes_vat: false, ordered_by: '', notes: '', deposit_deductions: [], stock_from_invoice: false, items: [{ ...EMPTY_ITEM }] }

const receiveTotals = po => { const { subtotal, vat } = calcPoTotals(po.purchase_order_items, po.has_vat, po.price_includes_vat); return { subtotal, vat } }

const inventoryItemOpts = (items) => (items || []).map(it => ({
  value: it.id, label: `${it.name} (${it.base_unit})`, keywords: it.name,
}))
const profileOpts = (profiles) => (profiles || []).map(p => ({
  value: p.id, label: `${p.name} (${p.linear_weight_kg_per_m} กก./ม.)`, keywords: p.name,
}))

function ItemsEditor({ items, onChange, inventoryItems, onInventoryItemCreated, aluminumProfiles, units, onUnitAdded, categories, defaultCategoryId }) {
  const set = (i, k, v) => onChange(items.map((it, idx) => idx === i ? { ...it, [k]: v } : it))
  const add = () => onChange([...items, { ...EMPTY_ITEM }])
  // Picking (or clearing) the stock item by hand ends the 'auto-linked, please check' hint for that line.
  const setStock = (i, v) => onChange(items.map((it, idx) => idx === i ? { ...it, inventory_item_id: v, auto_linked: false } : it))
  const remove = (i) => onChange(removeBlockOrClear(items, i, 1, () => ({ ...EMPTY_ITEM })))
  const grandTotal = items.reduce((sum, it) => sum + lineTotal(it), 0)
  const selectProfile = (i, profileId) => {
    const profile = (aluminumProfiles || []).find(p => p.id === profileId)
    onChange(items.map((it, idx) => idx === i
      ? { ...it, aluminum_profile_id: profileId, rod_length_m: profile ? String(profile.default_length_m) : it.rod_length_m }
      : it))
  }

  return (
    <div>
      <label className="label">รายการสินค้า ★</label>
      <div style={{ display: 'grid', gap: 8 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 150px 100px 70px 32px', gap: 6, fontSize: 11.5, color: 'var(--text3)', fontWeight: 600 }}>
          <span>รายละเอียดสินค้า</span>
          <span>จำนวน</span>
          <span>หน่วย</span>
          <span>ราคา/หน่วย</span>
          <span>ลด %</span>
          <span />
        </div>
        {items.map((it, i) => (
          <div key={i} style={{ display: 'grid', gap: 4 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 150px 100px 70px 32px', gap: 6, alignItems: 'center' }}>
              <input className="input input-sm" placeholder="รายละเอียดสินค้า" required
                value={it.description} onChange={e => set(i, 'description', e.target.value)} />
              <input className="input input-sm num-spin" type="number" min="0" step="any" placeholder="จำนวน"
                value={it.quantity} onChange={e => set(i, 'quantity', e.target.value)} />
              <UnitSelect value={it.unit} onChange={v => set(i, 'unit', v)} units={units} onUnitAdded={onUnitAdded} />
              <input className="input input-sm" type="number" min="0" step="0.01" placeholder="ราคา/หน่วย"
                value={it.unit_price} onChange={e => set(i, 'unit_price', e.target.value)} />
              <input className="input input-sm" type="number" min="0" max="100" step="0.01" placeholder="ลด%" title="ส่วนลดเฉพาะรายการนี้ (%)"
                value={it.discount_pct} onChange={e => set(i, 'discount_pct', e.target.value)} />
              {items.length === 1
                ? <span />
                : <button type="button" className="btn btn-sm btn-ghost" onClick={() => remove(i)}>✕</button>}
            </div>
            <div style={{ marginLeft: 4, fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: 'var(--text3)', flexShrink: 0 }}>📦 ผูกกับสต็อก:</span>
              <div style={{ flex: 1, maxWidth: 340 }}>
                <QuickAddSelect
                  value={it.inventory_item_id} onChange={v => setStock(i, v)}
                  placeholder="— ไม่ผูกกับสต็อก —" options={inventoryItemOpts(inventoryItems)}
                  table="inventory_items" namePlaceholder="ชื่อสินค้าคงคลังใหม่"
                  initialName={it.description}
                  extraPayload={{ base_unit: it.unit || 'หน่วย' }}
                  extraField={{ key: 'category_id', label: 'ประเภทสินค้า', options: catOpts(categories) }}
                  initialExtraValue={defaultCategoryId}
                  onCreated={onInventoryItemCreated}
                  addLabel="+ สร้างใหม่"
                />
              </div>
              {it.auto_linked && it.inventory_item_id && (
                <span style={{ flexShrink: 0, fontSize: 11, padding: '1px 8px', borderRadius: 10, background: 'var(--amber-bg, #fff4d6)', color: 'var(--amber, #8a5a00)', border: '1px solid var(--amber, #e0b040)' }}>เชื่อมอัตโนมัติ — ตรวจสอบ</span>
              )}
            </div>
            {(() => {
              const linkedItem = (inventoryItems || []).find(i => i.id === it.inventory_item_id)
              const mode = linkedItem?.unit_conversion_mode
              if (mode === 'aluminum_profile') {
                return (
                  <div style={{ marginLeft: 4, display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                    <span style={{ color: 'var(--text3)', flexShrink: 0 }}>🔧 หน้าตัด:</span>
                    <div style={{ width: 200 }}>
                      <SearchableSelect required value={it.aluminum_profile_id} onChange={v => selectProfile(i, v)}
                        placeholder="— เลือกหน้าตัด —" options={profileOpts(aluminumProfiles)} />
                    </div>
                    <span style={{ color: 'var(--text3)' }}>ยาว (ม.)</span>
                    <input className="input input-sm" style={{ width: 80 }} type="number" min="0" step="0.01" required
                      value={it.rod_length_m} onChange={e => set(i, 'rod_length_m', e.target.value)} />
                  </div>
                )
              }
              if (mode === 'glass_dimension') {
                return (
                  <div style={{ marginLeft: 4, display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                    <span style={{ color: 'var(--text3)', flexShrink: 0 }}>📐 ขนาด:</span>
                    <span style={{ color: 'var(--text3)' }}>กว้าง (ม.)</span>
                    <input className="input input-sm" style={{ width: 80 }} type="number" min="0" step="0.001" required
                      value={it.glass_width_m} onChange={e => set(i, 'glass_width_m', e.target.value)} />
                    <span style={{ color: 'var(--text3)' }}>ยาว (ม.)</span>
                    <input className="input input-sm" style={{ width: 80 }} type="number" min="0" step="0.001" required
                      value={it.glass_height_m} onChange={e => set(i, 'glass_height_m', e.target.value)} />
                  </div>
                )
              }
              return null
            })()}
          </div>
        ))}
      </div>
      <button type="button" className="btn btn-sm btn-ghost" style={{ marginTop: 8 }} onClick={add}>+ เพิ่มรายการ</button>
      <div style={{ marginTop: 10, textAlign: 'right', fontWeight: 700, fontSize: 15 }}>
        รวม: <span className="font-mono" style={{ color: 'var(--accent)' }}>{fmt(grandTotal)}</span> บาท
      </div>
    </div>
  )
}

function PurchaseOrderForm({ showStockFlag = false, stockFlagLocked = false, initial = EMPTY_FORM, sites, suppliers, categories, onSave, onCancel, loading, onSiteCreated, onSupplierCreated, inventoryItems, onInventoryItemCreated, aluminumProfiles, pastPoItems }) {
  const isAdd = !initial?.id
  const [form, setForm, clearFormDraft] = useDraftForm('purchase-order-form', { ...EMPTY_FORM, ...initial }, isAdd)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const formRef = useRef(form)
  formRef.current = form

  const { data: supplierExamples } = useSupplierDocumentExamples(form.supplier_id || null)
  const { data: units, refetch: refetchUnits } = useUnits()
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState(null)
  const [scanCode, setScanCode] = useState(null)
  const [scanFile, setScanFile] = useState(null)
  const [scanDateNote, setScanDateNote] = useState(null) // dd/mm/yyyy the scan read but the form did not take
  const [scanPayload, setScanPayload] = useState(null) // { base64, mimeType, reference_no_guess } after a successful scan
  const [scanVatInclusive, setScanVatInclusive] = useState(false) // scan detected VAT-inclusive unit prices
  const [saveAsExample, setSaveAsExample] = useState(false)
  const [confirmClearAll, setConfirmClearAll] = useState(false)
  // Clears every product line and whatever the scan filled in (header fields stay).
  const clearAllLines = () => {
    setForm(f => clearScanVatBasis({ ...f, items: [{ ...EMPTY_ITEM }], deposit_deductions: [] }, scanVatInclusive))
    setScanError(null); setScanCode(null); setScanPayload(null); setScanFile(null); setSaveAsExample(false); setScanDateNote(null); setScanVatInclusive(false)
    setConfirmClearAll(false)
  }

  // TEMPORARY diagnostic -- proves whether PurchaseOrderForm itself is
  // silently unmounting/remounting while the native picker is open
  // (which would orphan the input the OS callback is targeting, without
  // a full page reload the boot badge would catch). Remove once resolved.
  useEffect(() => {
    console.error('[FORM DEBUG] PurchaseOrderForm mounted, isAdd=' + isAdd)
    return () => console.error('[FORM DEBUG] PurchaseOrderForm UNMOUNTING')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleScanUpload = async (e) => {
    const file = e.target.files?.[0]
    console.error('[SCAN DEBUG] onChange fired. files.length=' + e.target.files?.length + ' file=' + (file ? `${file.name} type=${file.type} size=${file.size}` : 'none'))
    if (!file) return
    e.target.value = ''
    setScanError(null)
    setScanCode(null)
    setScanDateNote(null)
    setScanPayload(null)
    setScanVatInclusive(false)
    setSaveAsExample(false)
    setScanFile(file)
    setScanning(true)
    try {
      const { base64, mimeType } = await fileToExtractionPayload(file)
      const result = await extractPoDocument(base64, mimeType, supplierExamples || [])
      if (!result.ok) { setScanError(result.error); setScanCode(result.code || null); return }
      setScanPayload({ base64, mimeType, reference_no_guess: result.data.reference_no_guess })
      const { document_date_guess, reference_no_guess, line_items, deposit_deductions, prices_include_vat } = result.data

      // Any extracted unit that doesn't already exist in the tenant's
      // units list needs to be created first -- otherwise UnitSelect
      // (exact-match only) renders the field as blank even though the
      // real value is fine, misleading the reviewing user into "fixing"
      // a correct extraction.
      const knownUnitNames = new Set((units || []).map(u => u.name))
      const missingUnitNames = [...new Set(
        line_items.map(it => (it.unit || '').trim()).filter(name => name && !knownUnitNames.has(name))
      )]
      if (missingUnitNames.length) {
        for (const name of missingUnitNames) {
          const { error: unitErr } = await supabase.from('units').insert({ name })
          if (unitErr) throw unitErr
        }
        await refetchUnits()
      }

      // Never trust the scanned date over the user's: only an empty form date takes a plausible guess.
      const dateDecision = decideScanDate({ guess: document_date_guess, currentDate: formRef.current.date, today: bangkokTodayIso() })
      setScanDateNote(dateDecision.showNote ? formatIsoDmy(document_date_guess) : null)
      const newLines = line_items.map(it => ({ ...EMPTY_ITEM, description: it.description, quantity: String(it.quantity), unit: it.unit, unit_price: String(it.unit_price), discount_pct: String(it.discount_pct ?? 0) }))
      const suggestions = suggestStockLinks(newLines, inventoryItems, (pastPoItems || []).filter(p => p.supplier_id === formRef.current.supplier_id))
      const linkedLines = newLines.map((l, i) => suggestions[i] ? { ...l, inventory_item_id: suggestions[i], auto_linked: true } : l)

      // A detected basis (true/false) is mirrored into price_includes_vat; null keeps the user's choice. Unit prices stay as printed.
      setScanVatInclusive(prices_include_vat === true)
      setForm(f => applyScanVatBasis({
        ...f,
        date: dateDecision.apply ? dateDecision.date : f.date,
        deposit_deductions: deposit_deductions || [],
        notes: reference_no_guess ? [f.notes, `อ้างอิง: ${reference_no_guess}`].filter(Boolean).join(' ') : f.notes,
        items: line_items.length ? linkedLines : f.items,
      }, prices_include_vat))
    } catch (err) {
      setScanError(err.message)
    } finally {
      setScanning(false)
    }
  }

  return (
    <>
    <form onSubmit={e => {
      e.preventDefault()
      clearFormDraft()
      const supplierName = (suppliers || []).find(s => s.id === form.supplier_id)?.name
      const extra = saveAsExample && scanPayload
        ? { afterSave: () => saveSupplierDocumentExample(
            form.supplier_id, scanPayload.base64, scanPayload.mimeType,
            buildExampleExtracted({ supplierName, date: form.date, referenceNo: scanPayload.reference_no_guess, items: form.items }),
          ) }
        : undefined
      onSave(form, extra)
    }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div className="form-grid-2">
          <div>
            <label className="label">วันที่ ★</label>
            <input type="date" className="input" required value={form.date} onChange={e => set('date', e.target.value)} />
          </div>
          <div>
            <label className="label">หมวดค่าใช้จ่าย ★</label>
            <SearchableSelect required value={form.category_id} onChange={id => set('category_id', id)}
              placeholder="— เลือกหมวด —" options={catOpts(categories)} />
          </div>
        </div>
        {/* Site/supplier names can run long (full project names, company names) —
            stacked full-width rows instead of side-by-side so the name has room
            to breathe, on both desktop and mobile. */}
        <div style={{ display: 'grid', gap: 12 }}>
          <div>
            <label className="label">ไซท์งาน ★</label>
            <QuickAddSelect required value={form.site_id} onChange={id => set('site_id', id)}
              placeholder="— เลือกไซท์ —" options={siteOpts(sites)}
              table="sites" namePlaceholder="ชื่อไซท์งานใหม่" onCreated={onSiteCreated} />
          </div>
          <div>
            <label className="label">Supplier ★</label>
            <QuickAddSelect required value={form.supplier_id} onChange={id => set('supplier_id', id)}
              placeholder="— เลือก Supplier —" options={supplierOpts(suppliers)}
              table="suppliers" namePlaceholder="ชื่อ Supplier ใหม่" onCreated={onSupplierCreated} />
          </div>
        </div>
        <div>
          <label className="label">📷 อัพโหลดจากใบส่งของ/ใบเสนอราคา (ไม่บังคับ)</label>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <input type="file" accept="image/*,application/pdf" onChange={handleScanUpload} disabled={!form.supplier_id || scanning} />
            <button type="button" className="btn btn-sm btn-danger" disabled={scanning}
              title="ลบรายการสินค้าทั้งหมดและผลที่สแกนได้ (ข้อมูลหัวเอกสารไม่ถูกลบ)"
              onClick={() => setConfirmClearAll(true)}>🗑️ ลบข้อมูลทั้งหมด</button>
          </div>
          {!form.supplier_id && <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 4 }}>เลือก Supplier ก่อนถึงจะอัพโหลดได้</div>}
          {scanning && <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>⏳ กำลังอ่านเอกสาร...</div>}
          {scanDateNote && <div data-testid="scan-date-note" style={{ fontSize: 12, marginTop: 6, padding: '6px 10px', borderRadius: 6, background: 'var(--amber-bg, #fff4d6)', color: 'var(--amber, #8a5a00)', border: '1px solid var(--amber, #e0b040)' }}>เอกสารอ่านวันที่ได้ {scanDateNote} ไม่ตรงกับที่คาด (ใช้วันที่ในฟอร์มแทน) กรุณาตรวจวันที่</div>}
          {showVatInclusiveNotice(scanVatInclusive, form) && <div data-testid="scan-vat-inclusive-note" role="status" style={{ fontSize: 12, marginTop: 6, padding: '6px 10px', borderRadius: 6, background: 'var(--amber-bg, #fff4d6)', color: 'var(--amber, #8a5a00)', border: '1px solid var(--amber, #e0b040)' }}>{SCAN_VAT_INCLUSIVE_NOTICE}</div>}
          {scanError && <ScanNotice code={scanCode} message={scanError} />}
          {scanFile && <ScanDocPreview file={scanFile} />}
          {scanFile && !scanning && <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 4 }}>{SCAN_REMINDER}</div>}
          {scanPayload && form.supplier_id && (
            <label style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 12.5, marginTop: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={saveAsExample} onChange={e => setSaveAsExample(e.target.checked)} />
              <span>เก็บใบนี้เป็นตัวอย่างของซัพพลายเออร์ (ช่วยให้ AI อ่านเอกสารเจ้านี้แม่นขึ้น เก็บได้สูงสุด 3 ใบ ใบเก่าสุดจะถูกแทนที่)</span>
            </label>
          )}
        </div>
        <ItemsEditor items={form.items} onChange={items => set('items', items)} inventoryItems={inventoryItems} onInventoryItemCreated={onInventoryItemCreated} aluminumProfiles={aluminumProfiles} units={units} onUnitAdded={refetchUnits} categories={categories} defaultCategoryId={form.category_id} />
        <div>
          <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
              <input type="radio" name="po-has-vat" checked={form.has_vat === true} onChange={() => set('has_vat', true)} />
              รวม VAT
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
              <input type="radio" name="po-has-vat" checked={form.has_vat === false} onChange={() => set('has_vat', false)} />
              ไม่มี VAT
            </label>
          </div>
          {form.has_vat && (
            <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                <input type="radio" name="po-price-includes-vat" checked={form.price_includes_vat === false} onChange={() => set('price_includes_vat', false)} />
                ราคา/หน่วยยังไม่รวม VAT
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                <input type="radio" name="po-price-includes-vat" checked={form.price_includes_vat === true} onChange={() => set('price_includes_vat', true)} />
                ราคา/หน่วยรวม VAT แล้ว
              </label>
            </div>
          )}
          {showStockFlag && (
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: stockFlagLocked ? 'not-allowed' : 'pointer', fontSize: 13, marginBottom: 8 }}>
              <input type="checkbox" checked={!!form.stock_from_invoice} disabled={stockFlagLocked} onChange={e => set('stock_from_invoice', e.target.checked)} />
              <span>
                📦 สต็อกเข้าตอนบันทึกใบกำกับภาษี (รับของแล้วไม่ลงสต็อก)
                <div style={{ fontSize: 11.5, color: 'var(--text3)' }}>ใช้กับซัพพลายเออร์ที่ออกใบกำกับรวมรายเดือนและรายการไม่ตรงกับใบสั่งซื้อ</div>
              </span>
            </label>
          )}
          {(form.deposit_deductions || []).map((d, i) => (
            <div key={i} style={{ fontSize: 12, color: '#b45309' }}>อ่านพบการหักมัดจำ {d.ref} {fmt(d.amount)}</div>
          ))}
          {(() => {
            const { subtotal, vat, total } = calcPoTotals(form.items, form.has_vat, form.price_includes_vat)
            return (
              <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: 8, padding: '10px 14px', fontSize: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>รวมก่อน VAT</span><span className="font-mono">{fmt(subtotal)}</span></div>
                {form.has_vat && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>VAT (7%)</span><span className="font-mono">{fmt(vat)}</span></div>}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4 }}><span>รวมสุทธิ</span><span className="font-mono" style={{ color: 'var(--accent)' }}>{fmt(total)}</span></div>
              </div>
            )
          })()}
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label">ชื่อผู้สั่ง</label>
            <input className="input" value={form.ordered_by} onChange={e => set('ordered_by', e.target.value)} />
          </div>
          <div>
            <label className="label">หมายเหตุ</label>
            <input className="input" value={form.notes} onChange={e => set('notes', e.target.value)} />
          </div>
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? '⏳...' : '✅ บันทึกใบสั่งซื้อ'}
        </button>
      </div>
    </form>
    {confirmClearAll && (
      <ConfirmDialog title="ลบข้อมูลทั้งหมด"
        message={`ลบรายการสินค้าทั้งหมด ${form.items.length} รายการ รวมถึงผลที่สแกนจากเอกสารและเลขมัดจำที่อ่านได้? ข้อมูลที่กรอกไว้จะหายและกู้คืนไม่ได้ (วันที่ ไซต์ และ Supplier ยังอยู่)`}
        onConfirm={clearAllLines} onCancel={() => setConfirmClearAll(false)} danger />
    )}
    </>
  )
}

function PODetailModal({ po, tenantId, onClose, taxBadge, onViewDocument }) {
  const items = po.purchase_order_items || []
  const { subtotal, vat, total } = calcPoTotals(items, po.has_vat, po.price_includes_vat)
  const { data: ledger } = usePoLedger(po.id)          // null while loading or before the migration: sections hide
  const s = poLedgerSummary(po, ledger)
  const hasDiscountLine = items.some(it => Number(it.line_total) < 0)
  const cell = { padding: '4px 6px', borderBottom: '1px solid var(--border)' }
  return (
    <Modal title={`ใบสั่งซื้อ ${po.po_number}`} onClose={onClose} maxWidth={760}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className={`badge badge-po-${po.status}`}>{PO_STATUS_LABELS[po.status] || po.status}</span>
          {taxBadge?.kind && <span className={`badge ${TAX_BADGE_CLASS[taxBadge.kind]}`}>{taxBadge.text}</span>}
          <span style={{ fontSize: 12, color: 'var(--text3)' }}>{fmtDate(po.date)}</span>
        </div>
        <div className="form-grid-2" style={{ fontSize: 13 }}>
          <div><strong>ไซท์งาน:</strong> {po.sites?.name || '—'}</div>
          <div><strong>Supplier:</strong> {po.suppliers?.name || '—'}</div>
        </div>
        {po.ordered_by && <div style={{ fontSize: 13 }}><strong>ชื่อผู้สั่ง:</strong> {po.ordered_by}</div>}
        {po.notes && <div style={{ fontSize: 13 }}><strong>หมายเหตุ:</strong> {po.notes}</div>}
        {hasDiscountLine && po.status === 'ordered' && (
          <div data-testid="po-discount-notice" style={{ fontSize: 12.5, color: 'var(--yellow)' }}>
            ใบสั่งซื้อนี้มีรายการส่วนลด (ยอดติดลบ) จึงใช้การรับของบางส่วนแบบใหม่ไม่ได้ — ใช้การรับของแบบเดิม (รับครบทั้งใบ)
          </div>
        )}
        <div>
          <label className="label">รายการสินค้า</label>
          <div className="table-wrap">
            <table style={{ fontSize: 12.5 }}>
              <thead><tr><th>รายการ</th><th>สั่ง</th><th>รับ</th><th style={{ textAlign: 'right' }}>มูลค่า</th></tr></thead>
              <tbody>
                {s.lines.map(it => (
                  <tr key={it.id}>
                    <td style={cell}>
                      {it.description}
                      {it.aluminum_profiles?.name && <div style={{ fontSize: 11, color: 'var(--text3)' }}>หน้าตัด {it.aluminum_profiles.name} ยาว {it.rod_length_m} ม.</div>}
                      {it.glass_width_m && it.glass_height_m && <div style={{ fontSize: 11, color: 'var(--text3)' }}>ขนาด {it.glass_width_m}×{it.glass_height_m} ม.</div>}
                    </td>
                    <td style={cell}>{it.quantity} {it.unit || ''}</td>
                    <td style={cell}>{it.received
                      ? <span style={{ color: 'var(--green)' }}>✓ รับแล้ว {it.receivedDate ? fmtDate(it.receivedDate) : ''}{it.receiptSeq ? ` (R${it.receiptSeq})` : ''}</span>
                      : <span style={{ color: 'var(--yellow)' }}>ค้างรับ</span>}</td>
                    <td style={{ ...cell, textAlign: 'right' }} className="font-mono">{fmt(it.line_total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 8, textAlign: 'right', fontSize: 13 }}>
            <div>รวมก่อน VAT: <span className="font-mono">{fmt(subtotal)}</span></div>
            {po.has_vat && <div>VAT (7%): <span className="font-mono">{fmt(vat)}</span></div>}
            <div style={{ fontWeight: 700 }}>รวมสุทธิ: <span className="font-mono" style={{ color: 'var(--accent)' }}>{fmt(total)}</span></div>
          </div>
        </div>
        {s.receipts.length > 0 && (
          <div style={{ fontSize: 13 }}>
            <label className="label">การรับของ</label>
            {s.receipts.map(r => (
              <div key={r.id}>R{r.seq} · {fmtDate(r.received_date)} · ก่อน VAT <span className="font-mono">{fmt(r.goods_subtotal)}</span> · VAT <span className="font-mono">{fmt(r.goods_vat)}</span></div>
            ))}
          </div>
        )}
        {s.deposit && (
          <div style={{ fontSize: 13 }}>
            <label className="label">มัดจำ</label>
            <div>{s.deposit.no} · <span className="font-mono">{fmt(s.deposit.gross)}</span>{s.deposit.pct ? ` (${Number(s.deposit.pct)}% ของใบสั่งซื้อ)` : ''}</div>
            <div>ใช้แล้ว <span className="font-mono">{fmt(s.deposit.usedGross)}</span> · <strong>คงเหลือ <span className="font-mono">{fmt(s.deposit.remainingGross)}</span></strong></div>
          </div>
        )}
        {s.applications.length > 0 && (
          <div style={{ fontSize: 12.5, color: 'var(--text3)' }}>
            {s.applications.map((a, i) => (
              <div key={a.id || i}>หักมัดจำ {a.supplier_deposits?.deposit_invoice_no || ''}: ก่อน VAT <span className="font-mono">{fmt(a.amount_no_vat)}</span> · VAT <span className="font-mono">{fmt(a.vat)}</span></div>
            ))}
          </div>
        )}
        {s.bills.length > 0 && (
          <div style={{ fontSize: 13 }}>
            <label className="label">บิล</label>
            {s.bills.map(b => (
              <div key={b.id}>{fmtDate(b.date)} · <span className="font-mono">{fmt(b.amount)}</span> · {BILL_STATUS_LABELS[b.status] || b.status}{b.invoice_no ? ` · #${b.invoice_no}` : ''}</div>
            ))}
          </div>
        )}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, display: 'grid', gap: 8 }}>
          <div><button type="button" className="btn btn-sm btn-ghost" onClick={() => onViewDocument(po)}>📄 ดู PO</button></div>
          {tenantId && <AttachmentsSection table="purchase_order_attachments" bucket="po-attachments" foreignKey="po_id" entityId={po.id} tenantId={tenantId} />}
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
      </div>
    </Modal>
  )
}

// Same letterhead pattern as QuotationDocumentModal (src/pages/Quotations.jsx)
// — logo/company block, bordered doc-info box + ต้นฉบับ tag, light-purple
// table header, boxed notes, purple-accented (unfilled) grand total.
function PODocumentModal({ po, tenant, onClose, autoAction = null }) {
  const items = po.purchase_order_items || []
  const { subtotal, vat, total } = calcPoTotals(items, po.has_vat, po.price_includes_vat)
  const mySignature = useMySignatureUrl()
  const { data: myWorkerName } = useMyWorkerName()

  const fileBase = `${po.po_number}${po.sites?.name ? '-' + po.sites.name : ''}`
  useEffect(() => {
    if (!autoAction) return
    const t = setTimeout(() => {          // let the logo / signature images load first
      if (autoAction === 'pdf') downloadPDF(`po-doc-${po.id}`, `${fileBase}.pdf`)
      else if (autoAction === 'jpg') downloadJPG(`po-doc-${po.id}`, `${fileBase}.jpg`)
      else if (autoAction === 'print') window.print()
    }, 400)
    return () => clearTimeout(t)
  }, [autoAction]) // eslint-disable-line react-hooks/exhaustive-deps


  return (
    <Modal title={`ใบสั่งซื้อ ${po.po_number}`} onClose={onClose} maxWidth={720}>
      <div className="modal-body">
        <div className="printable-document" id={`po-doc-${po.id}`} style={{ fontFamily: 'Sarabun,sans-serif', padding: '40px 44px', background: '#fff', color: '#17181f' }}>
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
              <div style={{ fontSize: 22, fontWeight: 800 }}>ใบสั่งซื้อ</div>
            </div>
          </div>

          <div style={{ marginTop: 20, border: '1px solid #e4e6ef', borderRadius: 8, padding: '14px 16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 24px', fontSize: 12 }}>
            <div><span style={{ color: '#6a6f85' }}>เลขที่เอกสาร</span><br />{po.po_number}</div>
            <div><span style={{ color: '#6a6f85' }}>วันที่สั่งซื้อ</span><br />{new Date(po.date).toLocaleDateString('th-TH')}</div>
            <div><span style={{ color: '#6a6f85' }}>ไซท์งาน</span><br />{po.sites?.name} ({po.sites?.site_number})</div>
            <div><span style={{ color: '#6a6f85' }}>Supplier</span><br />{po.suppliers?.name}</div>
            {po.ordered_by && <div><span style={{ color: '#6a6f85' }}>ชื่อผู้สั่ง</span><br />{po.ordered_by}</div>}
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
                  <td style={{ padding: '9px 8px', borderBottom: '1px solid #eee' }}>
                    {it.description}
                    {it.aluminum_profiles?.name && (
                      <div style={{ fontSize: 10, color: '#6a6f85' }}>หน้าตัด {it.aluminum_profiles.name} ยาว {it.rod_length_m} ม.</div>
                    )}
                    {it.glass_width_m && it.glass_height_m && (
                      <div style={{ fontSize: 10, color: '#6a6f85' }}>ขนาด {it.glass_width_m}×{it.glass_height_m} ม.</div>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', padding: '9px 8px', borderBottom: '1px solid #eee' }}>{it.quantity} {it.unit || ''}</td>
                  <td style={{ textAlign: 'right', padding: '9px 8px', borderBottom: '1px solid #eee' }}>
                    {fmt(it.unit_price)}
                    {it.discount_pct > 0 && <div style={{ fontSize: 10, color: '#6a6f85' }}>ลด {it.discount_pct}%</div>}
                  </td>
                  <td style={{ textAlign: 'right', padding: '9px 8px', borderBottom: '1px solid #eee' }}>{fmt(it.line_total)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
            <table style={{ width: 260, fontSize: 12.5 }}>
              <tbody>
                <tr><td style={{ padding: '5px 4px', color: '#6a6f85' }}>รวมก่อน VAT</td><td style={{ textAlign: 'right', padding: '5px 4px' }}>{fmt(subtotal)}</td></tr>
                {po.has_vat && (
                  <tr><td style={{ padding: '5px 4px', color: '#6a6f85' }}>VAT (7%)</td><td style={{ textAlign: 'right', padding: '5px 4px' }}>{fmt(vat)}</td></tr>
                )}
                <tr>
                  <td style={{ padding: '10px 4px 4px', fontWeight: 800, fontSize: 15, color: '#6c63ff', borderTop: '2px solid #6c63ff' }}>รวมทั้งสิ้น</td>
                  <td style={{ textAlign: 'right', padding: '10px 4px 4px', fontWeight: 800, fontSize: 15, color: '#6c63ff', borderTop: '2px solid #6c63ff' }}>{fmt(total)} บาท</td>
                </tr>
              </tbody>
            </table>
          </div>

          {po.notes && (
            <div style={{ marginTop: 20, fontSize: 11.5, background: '#f9f9fc', borderRadius: 8, padding: '12px 16px', lineHeight: 1.8 }}>
              <strong style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>หมายเหตุ</strong>
              <div style={{ whiteSpace: 'pre-line' }}>{po.notes}</div>
            </div>
          )}

          <div style={{ marginTop: 44, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, textAlign: 'center', fontSize: 11.5 }}>
            <div>
              <div style={{ height: 40, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
                {mySignature && <img src={mySignature.url} alt="" crossOrigin="anonymous" style={{ height: 36, display: 'block' }} />}
              </div>
              <div style={{ borderTop: '1px solid #999', paddingTop: 8 }}>ผู้จัดทำ</div>
              {myWorkerName && (
                <div style={{ marginTop: 2, color: '#6a6f85', fontSize: 10 }}>{myWorkerName}</div>
              )}
            </div>
            <div style={{ borderTop: '1px solid #999', paddingTop: 8, alignSelf: 'end' }}>ผู้อนุมัติ</div>
          </div>
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
        <button className="btn btn-ghost" onClick={() => window.print()}>🖨️ พิมพ์</button>
        <button className="btn btn-ghost" onClick={() => downloadJPG(`po-doc-${po.id}`, `${fileBase}.jpg`)}>🖼️ ดาวน์โหลด JPG</button>
        <button className="btn btn-primary" onClick={() => downloadPDF(`po-doc-${po.id}`, `${fileBase}.pdf`)}>📄 ดาวน์โหลด PDF</button>
      </div>
    </Modal>
  )
}

// SwapTaxInvoiceModal -- for a received PO whose commercial/delivery
// invoice used a different unit than the supplier's real tax invoice
// (e.g. KC Interframe: sells/delivers by เส้น, tax-invoices by kg), lets
// an admin scan the real tax invoice and swap its reference into the
// auto-created expense WITHOUT touching stock_movements or the expense's
// amount -- receiving already posted the correct physical quantity in the
// PO's own unit; this only corrects the paperwork trail. Reuses the same
// extract-po-document AI pipeline (and its quota) as PO creation's own
// "scan from photo" upload; see docs/superpowers/specs/2026-09-10-po-
// document-scan-extraction-design.md for that pipeline's shape.
function SwapTaxInvoiceModal({ po, onClose, onSwapped }) {
  const expense = po.expenses
  const originalAmount = expense?.amount_no_vat ?? expense?.amount ?? 0

  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState(null)
  const [extracted, setExtracted] = useState(null) // { reference_no_guess, line_items, computedTotal }
  const [saving, setSaving] = useState(false)
  const { data: supplierExamples } = useSupplierDocumentExamples(po.supplier_id || null)
  const [scanCode, setScanCode] = useState(null)
  const [scanFile, setScanFile] = useState(null)
  const [manualRef, setManualRef] = useState('')
  const [manualAmount, setManualAmount] = useState('')

  const handleUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setScanError(null)
    setExtracted(null)
    setScanCode(null)
    setScanFile(file)
    setScanning(true)
    try {
      const { base64, mimeType } = await fileToExtractionPayload(file)
      const result = await extractPoDocument(base64, mimeType, supplierExamples || [])
      if (!result.ok) { setScanError(result.error); setScanCode(result.code || null); return }
      const { reference_no_guess, line_items, prices_include_vat } = result.data
      // compared against the expense's amount BEFORE VAT, so back VAT out of an inclusive document
      const computedTotal = scanLinesTotalExVat(line_items, prices_include_vat)
      setExtracted({ reference_no_guess, line_items, computedTotal })
    } catch (err) {
      setScanError(err.message)
    } finally {
      setScanning(false)
    }
  }

  // Manual path when the automatic read failed: the user types the real tax
  // invoice's number and its amount before VAT. It feeds the SAME `extracted`
  // state, so the amount-match check below still gates the swap.
  const applyManual = () => {
    const amount = parseFloat(manualAmount)
    if (!manualRef.trim() || !Number.isFinite(amount) || amount <= 0) return
    setExtracted({ reference_no_guess: manualRef.trim(), line_items: [], computedTotal: amount, manual: true })
  }

  // Tight tolerance on purpose -- this is the SAME delivery being
  // re-described, not a fuzzy cross-reference against an unrelated batch
  // of records (c.f. the ±5%/20-baht tolerance used for the Feb-Jul
  // invoice/expense backfill matching), so a real match should land
  // very close to exact; only enough slack for rounding.
  const matches = extracted != null && Math.abs(extracted.computedTotal - originalAmount) <= Math.max(originalAmount * 0.01, 5)

  const handleSave = async () => {
    if (!expense || !extracted || !matches || saving) return
    setSaving(true)
    try {
      const itemsSummary = extracted.line_items
        .map((it) => `${it.description} ${it.quantity}${it.unit ? ' ' + it.unit : ''} @ ${fmt(it.unit_price)}${it.discount_pct > 0 ? ` (ลด ${it.discount_pct}%)` : ''}`)
        .join('; ')
      const noteDetail = extracted.manual ? `กรอกเอง ยอดก่อน VAT ${fmt(extracted.computedTotal)}` : itemsSummary
      const newInvoiceNo = extracted.reference_no_guess || expense.invoice_no
      const newNotes = [expense.notes, `สลับเป็นใบกำกับภาษีจริง${extracted.reference_no_guess ? ' ' + extracted.reference_no_guess : ''}: ${noteDetail}`]
        .filter(Boolean).join(' | ')
      const { error } = await supabase.from('expenses')
        .update({ invoice_no: newInvoiceNo, notes: newNotes })
        .eq('id', expense.id)
      if (error) throw error
      await auditLog('expenses', expense.id, 'UPDATE', { invoice_no: expense.invoice_no, notes: expense.notes }, { invoice_no: newInvoiceNo, notes: newNotes })
      onSwapped()
    } catch (err) {
      alert('Error: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`สลับใบกำกับภาษี — ${po.po_number}`} onClose={onClose} maxWidth={560}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        {!expense ? (
          <div style={{ color: 'var(--red)' }}>ไม่พบรายจ่ายที่ผูกกับใบสั่งซื้อนี้</div>
        ) : (
          <>
            <div style={{ fontSize: 12.5, color: 'var(--text3)' }}>
              รายจ่ายเดิม: {expense.invoice_no || '(ไม่มีเลขที่)'} · ยอด {fmt(originalAmount)} บาท (ก่อน VAT)
            </div>
            <div>
              <label className="label">อัปโหลดรูป/PDF ใบกำกับภาษีจริง</label>
              <input type="file" accept="image/*,application/pdf" onChange={handleUpload} disabled={scanning} />
              {scanning && <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 6 }}>⏳ กำลังอ่าน...</div>}
              {scanError && <ScanNotice code={scanCode} message={scanError} />}
              {scanFile && <ScanDocPreview file={scanFile} />}
            </div>
            {(scanError || (extracted && !matches)) && (
              <div style={{ display: 'grid', gap: 8, border: '1px dashed var(--border)', borderRadius: 8, padding: 10 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700 }}>กรอกเองจากใบกำกับภาษี</div>
                <input className="input" placeholder="เลขที่ใบกำกับภาษี" value={manualRef} onChange={e => setManualRef(e.target.value)} />
                <input className="input" type="number" min="0" step="0.01" placeholder="ยอดรวมก่อน VAT (บาท)" value={manualAmount} onChange={e => setManualAmount(e.target.value)} />
                <button type="button" className="btn btn-ghost" onClick={applyManual}>ใช้ค่าที่กรอก</button>
              </div>
            )}
            {extracted && (
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>เลขที่ใบกำกับภาษี: {extracted.reference_no_guess || '(ไม่พบ)'}</div>
                <div style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                  {extracted.line_items.map((it, i) => (
                    <div key={i}>
                      {it.description} — {it.quantity} {it.unit} × {fmt(it.unit_price)}
                      {it.discount_pct > 0 ? ` (ลด ${it.discount_pct}%)` : ''} = {fmt(it.quantity * it.unit_price * (1 - (it.discount_pct || 0) / 100))}
                    </div>
                  ))}
                  {!extracted.line_items.length && !extracted.manual && <div style={{ color: 'var(--text3)' }}>ไม่พบรายการสินค้าในเอกสาร</div>}
                </div>
                <div style={{ marginTop: 8, fontWeight: 700, color: matches ? 'var(--green)' : 'var(--red)' }}>
                  ยอดรวมที่อ่านได้: {fmt(extracted.computedTotal)} บาท
                  {matches ? ' ✅ ตรงกับรายจ่ายเดิม' : ` ⚠️ ไม่ตรงกับยอดเดิม (${fmt(originalAmount)} บาท) — ตรวจสอบไฟล์ที่อัปโหลดอีกครั้ง`}
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ยกเลิก</button>
        <button className="btn btn-primary" disabled={!expense || !extracted || !matches || saving} onClick={handleSave}>
          {saving ? '⏳...' : '✅ ยืนยันสลับใบกำกับภาษี'}
        </button>
      </div>
    </Modal>
  )
}

export default function PurchaseOrders({ navigateTo, navState, openSiteOverview }) {
  const { isAtLeast, role } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'purchase_orders')
  const { tenant } = useTenant()
  const today = new Date()
  const ytdFrom = format(startOfYear(today), 'yyyy-MM-dd')
  const ytdTo   = format(endOfYear(today),   'yyyy-MM-dd')

  const [dateFrom, setDateFrom] = useState(ytdFrom)
  const [dateTo,   setDateTo]   = useState(ytdTo)
  const [siteId,     setSiteId]     = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [status,      setStatus]    = useState('')
  const [search,  setSearch]  = useState('')
  const [sortCol, setSortCol] = useState('date')
  const [sortDir, setSortDir] = useState('desc')
  const [showAdd, setShowAdd] = useState(false)
  const [editRow, setEditRow] = useState(null)
  const [deleteId, setDeleteId] = useState(null)
  const [docRow, setDocRow] = useState(null)
  const [detailRow, setDetailRow] = useState(null)
  const [receiveRow, setReceiveRow] = useState(null)
  const [receiveKind, setReceiveKind] = useState(null)   // 'new' (ReceivePoLinesModal) | 'old' (receive_po_with_deposits)
  const [depositPo, setDepositPo] = useState(null)
  const [swapInvoiceRow, setSwapInvoiceRow] = useState(null)
  const [receiving, setReceiving] = useState(false)
  const [depositSel, setDepositSel] = useState(null)
  useEffect(() => { if (!receiveRow) setDepositSel(null) }, [receiveRow])
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState(null)

  const filters = { from: dateFrom, to: dateTo, siteId, supplierId, status }
  const { data: pos, refetch } = usePurchaseOrders(filters)
  const { data: sites, refetch: refetchSites }      = useSites()
  const { data: categories } = useCategories()
  const { data: suppliers, refetch: refetchSuppliers }  = useSuppliers()
  const { data: inventoryItems, refetch: refetchInventoryItems } = useInventoryItems()
  const { data: allInventoryItems } = useAllInventoryItems()
  const { data: unitFactors } = useInventoryItemUnitFactors()
  const { data: stockBalances, refetch: refetchStock } = useStockBalances()
  const { data: aluminumProfiles } = useAluminumProfiles()
  const { data: allAluminumProfiles } = useAllAluminumProfiles()
  // data is null while loading or before the tax invoice migrations are applied: then no badges and no locks (page works as before)
  const { data: taxInvoiceLinks, refetch: refetchLinks } = useActiveTaxInvoiceLinks()
  const { data: moneyIndex, refetch: refetchMoney } = usePoMoneyIndex()
  const refetchAll = () => { refetch(); refetchLinks(); refetchMoney() }
  // One call for the receive / deposit / split dialogs (Tasks 8-10) after any mutation: PO list, links, money index,
  // stock balances, and the open popup's ledger (the popup is re-keyed so usePoLedger refetches).
  const [poDataVersion, setPoDataVersion] = useState(0)
  const refreshPoData = () => { refetchAll(); refetchStock(); setPoDataVersion(v => v + 1) }

  // เรียง/ค้นหาแบบ client-side ทับผลลัพธ์ที่กรองมาจาก server แล้ว (ช่วงวันที่/ไซท์งาน/Supplier/สถานะ)
  // -- accessor ต่อคอลัมน์ เพราะบางคอลัมน์ (ไซท์งาน, Supplier, ยอดรวม) เป็น field ที่ join มา/คำนวณ
  const SORT_ACCESSORS = {
    po_number: po => po.po_number || '',
    date:      po => po.date || '',
    site:      po => po.sites?.name || '',
    supplier:  po => po.suppliers?.name || '',
    total:     po => calcPoTotals(po.purchase_order_items, po.has_vat, po.price_includes_vat).total,
    status:    po => po.status || '',
  }
  const sortedPos = useMemo(() => {
    const q = search.toLowerCase()
    const rows = (pos || []).filter(po => !q
      || po.po_number?.toLowerCase().includes(q)
      || po.sites?.name?.toLowerCase().includes(q)
      || po.suppliers?.name?.toLowerCase().includes(q))
    const acc = SORT_ACCESSORS[sortCol]
    return [...rows].sort((a, b) => {
      const va = acc(a), vb = acc(b)
      if (typeof va === 'number') return sortDir === 'asc' ? va - vb : vb - va
      return sortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va))
    })
  }, [pos, search, sortCol, sortDir])
  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }
  const si = (col) => sortCol === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕'

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3000) }

  // Arrived via "จาก PO" click from Expenses — the PO might be outside the
  // default YTD range, so drop the date filter entirely to make sure it's
  // findable, then open its detail once the (now wider) list has loaded.
  useEffect(() => {
    if (navState?.poId) { setDateFrom(''); setDateTo('') }
  }, [navState?.poId])

  useEffect(() => {
    if (navState?.poId && pos) {
      const match = pos.find(p => p.id === navState.poId)
      if (match) {
        setDetailRow(match)
        // Consume it -- navState.poId otherwise stays set for the rest of
        // this page visit, and `pos` gets a new array reference on every
        // refetch (saving/editing/adding ANY PO), which re-ran this effect
        // and reopened this same old PO's detail every time. Reported
        // live as "every time I add a PO, a popup auto-pops like the eye
        // button was clicked."
        navigateTo('purchase_orders', {})
      }
    }
  }, [navState?.poId, pos])

  // Reopens the add-PO form after a reload that happened while it was open
  // (see ADD_FORM_OPEN_KEY above) -- runs once on mount, before the user has
  // done anything, so a mid-scan Android reload lands back in the form with
  // the draft restored instead of on the bare list.
  useEffect(() => {
    if (readDraft(ADD_FORM_OPEN_KEY)) { setEditRow(null); setShowAdd(true) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSave = async (form, opts) => {
    setSaving(true)
    try {
      const poPayload = {
        site_id: form.site_id, supplier_id: form.supplier_id, category_id: form.category_id,
        date: form.date, has_vat: form.has_vat,
        price_includes_vat: form.has_vat ? form.price_includes_vat : false,
        ordered_by: form.ordered_by || null,
        notes: form.notes || null,
      }
      // Only when the scan read deductions, so saving still works before the deposit migration.
      // Only when ticked / already on the row, so saving still works before the stock-from-invoice migration.
      Object.assign(poPayload, buildPoPayloadFlag(form, editRow))
      if ((form.deposit_deductions || []).length) poPayload.deposit_hint = form.deposit_deductions.map(d => ({ ref: d.ref, amount_no_vat: d.amount }))
      // A 'draft' PO (created hands-off from a LINE เบิกของ request, no
      // supplier yet -- see field-form Edge Function) graduates to a real
      // 'ordered' PO the moment an admin saves it with a supplier filled
      // in. Never downgrades a PO that was already further along.
      if (editRow?.status === 'draft' && form.supplier_id) poPayload.status = 'ordered'
      let poId = editRow?.id
      // The edit below is not atomic (header update, then items delete/insert): never run it on a PO a tax invoice is linked to.
      const lockedText = editRow ? (poEditLockedText(editRow, taxInvoiceLinks) || poMoneyLockText(editRow, moneyIndex)) : ''
      if (lockedText) throw new Error(lockedText)
      if (editRow) {
        const { error } = await supabase.from('purchase_orders').update(poPayload).eq('id', editRow.id)
        if (error) throw error
        const { error: delError } = await supabase.from('purchase_order_items').delete().eq('po_id', editRow.id)
        if (delError) throw delError
        await auditLog('purchase_orders', editRow.id, 'UPDATE', editRow, poPayload)
      } else {
        const { data, error } = await supabase.from('purchase_orders').insert(poPayload).select().single()
        if (error) throw error
        poId = data.id
        await auditLog('purchase_orders', poId, 'INSERT', null, poPayload)
      }

      const itemsPayload = form.items
        .filter(it => it.description.trim())
        .map((it, i) => ({
          po_id: poId, description: it.description,
          quantity: parseFloat(it.quantity) || 0, unit: it.unit || null,
          unit_price: parseFloat(it.unit_price) || 0, discount_pct: parseFloat(it.discount_pct) || 0,
          line_total: lineTotal(it), sort_order: i,
          inventory_item_id: it.inventory_item_id || null,
          aluminum_profile_id: it.aluminum_profile_id || null,
          rod_length_m: it.rod_length_m ? parseFloat(it.rod_length_m) : null,
          glass_width_m: it.glass_width_m ? parseFloat(it.glass_width_m) : null,
          glass_height_m: it.glass_height_m ? parseFloat(it.glass_height_m) : null,
        }))
      if (itemsPayload.length) {
        const { error } = await supabase.from('purchase_order_items').insert(itemsPayload)
        if (error) throw error
      }

      // The example is saved only after the PO and its items are safely
      // stored, and a failure here must never undo or hide the saved PO.
      let exampleError = null
      if (opts?.afterSave) {
        try { await opts.afterSave() } catch (e) { exampleError = e?.message || 'ไม่ทราบสาเหตุ' }
      }
      clearDraft(ADD_FORM_OPEN_KEY)
      setShowAdd(false); setEditRow(null); refetchAll()
      showToast(exampleError ? `บันทึกสำเร็จ แต่เก็บตัวอย่างไม่สำเร็จ: ${exampleError}` : 'บันทึกสำเร็จ')
    } catch (e) {
      alert('Error: ' + mapPoReceiptRpcError(e))
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = async () => {
    if (!deleteId) return
    const { error } = await supabase.from('purchase_orders').update({ status: 'cancelled' }).eq('id', deleteId)
    if (!error) { await auditLog('purchase_orders', deleteId, 'UPDATE', null, { status: 'cancelled' }); setDeleteId(null); refetchAll(); showToast('ยกเลิกแล้ว') }
    else { const m = mapPoReceiptRpcError(error); alert(m === String(error?.message || '') ? 'Error: ' + m : m) }
  }

  // Uses allInventoryItems/allAluminumProfiles (NOT the active-only
  // inventoryItems/aluminumProfiles used by ItemsEditor's pickers) --
  // an item or profile deactivated after a PO was placed but before it's
  // received must still compute correctly here (final-review Fix 1).
  // lineIds (optional): only those PO lines (ReceivePoLinesModal); the result feeds receive_po_lines' p_stock.
  const receiveStockPlan = (po, lineIds) => {
    if (!po) return []
    const only = lineIds ? new Set(lineIds) : null
    return (po.purchase_order_items || [])
      .filter(it => it.inventory_item_id && (!only || only.has(it.id)))
      .map(it => {
        const invItem = (allInventoryItems || []).find(i => i.id === it.inventory_item_id)
        const profile = it.aluminum_profile_id ? (allAluminumProfiles || []).find(p => p.id === it.aluminum_profile_id) : null
        const factor = (unitFactors || []).find(f => f.inventory_item_id === it.inventory_item_id && f.unit_name === it.unit)
        const { baseQty, unconverted } = computePoItemBaseQty(it, invItem, profile, factor)

        // Stock must be capitalized at the actual price paid, not the
        // pre-discount list price -- a discounted item that goes uncounted
        // here would overvalue that stock and inflate COGS when it's later
        // consumed.
        const netLinePrice = it.unit_price * (1 - (it.discount_pct || 0) / 100)
        let unitCostPerBase = baseQty > 0 ? (it.quantity * netLinePrice) / baseQty : netLinePrice

        // The expense is posted ex-VAT (calcPoTotals backs VAT out of a
        // VAT-inclusive price via subtotal = total / 1.07). Stock must be
        // capitalized at the same ex-VAT cost, regardless of which branch
        // above computed it (final-review Fix 3 from the Phase 1 plan).
        if (po.has_vat && po.price_includes_vat) {
          unitCostPerBase = unitCostPerBase / (1 + VAT_RATE)
        }

        return { poItemId: it.id, inventoryItemId: it.inventory_item_id, name: invItem?.name || it.description, baseUnit: invItem?.base_unit || it.unit, baseQty, unitCostPerBase, unconverted }
      })
  }

  const handleReceive = async () => {
    if (!receiveRow || receiving || !canConfirmReceive(depositSel)) return
    setReceiving(true)
    const { subtotal, vat } = calcPoTotals(receiveRow.purchase_order_items, receiveRow.has_vat, receiveRow.price_includes_vat)
    const depositApps = depositSel?.valid ? depositSel.applications : []
    let expenseId = null
    try {
      // Atomic: creates the remainder expense (none if the deposits cover it all),
      // records the deposit applications and marks the PO received.
      expenseId = await receivePoWithDeposits(receiveRow.id, depositApps, subtotal, vat)
    } catch (rpcErr) {
      // The RPC is all-or-nothing: nothing was saved, so show only the reason.
      setReceiveRow(null); setReceiving(false); refetchAll()
      alert(mapReceiveRpcError(rpcErr))
      return
    }
    try {
      if (expenseId) await auditLog('expenses', expenseId, 'INSERT', null, { po_id: receiveRow.id, via: 'receive_po_with_deposits' })
      await auditLog('purchase_orders', receiveRow.id, 'UPDATE', null, { status: 'received', received_date: bangkokTodayIso(), expense_id: expenseId, deposit_applications: depositApps })

      // A PO flagged stock_from_invoice posts no stock here: the stock comes from the supplier tax invoice.
      if (!receiveRow.stock_from_invoice) {
        for (const plan of receiveStockPlan(receiveRow)) {
          const { error: moveErr } = await supabase.rpc('record_stock_movement', {
            p_inventory_item_id: plan.inventoryItemId, p_site_id: receiveRow.site_id, p_movement_type: 'purchase_in',
            p_quantity: plan.baseQty, p_unit_cost: plan.unitCostPerBase,
            p_reference_type: 'purchase_order', p_reference_id: receiveRow.id, p_notes: null,
          })
          if (moveErr) throw moveErr
        }
        refetchInventoryItems()
      }

      setReceiveRow(null); refetchAll(); showToast('รับของแล้ว ' + (expenseId ? 'สร้างรายจ่ายอัตโนมัติ' : 'หักมัดจำครบ ไม่สร้างรายจ่าย') + (receiveRow.stock_from_invoice ? ' · สต็อกจะเข้าเมื่อบันทึกใบกำกับภาษี' : ''))
    } catch (e) {
      // Close the dialog so a stray click can't re-run this whole function
      // (same stale closure/ConfirmDialog) and re-post a second expense +
      // duplicate stock movements for whatever already succeeded before the
      // failure (final-review Fix 2). The expense insert and PO status
      // update run BEFORE the stock-posting loop, so by the time any error
      // reaches here those two may already be committed — tell the admin to
      // check the actual ledger rather than inviting a blind retry.
      setReceiveRow(null); refetchAll()
      alert(
        'Error: ' + (poTaxInvoiceErrorText(e) || e.message) +
        ' — รายจ่ายและสถานะใบสั่งซื้ออาจถูกบันทึกไปแล้วก่อนเกิดข้อผิดพลาดนี้ ' +
        'กรุณาตรวจสอบหน้ารายจ่าย และตรวจสอบประวัติการเคลื่อนไหวสต็อกที่หน้าคลังสินค้า (คลังสินค้า → ประวัติการเคลื่อนไหว) ' +
        'ว่ามีการบันทึกเข้าสต็อกไปแล้วเท่าใด ก่อนแก้ไขข้อมูลด้วยตนเอง — อย่ากดรับของซ้ำโดยไม่ตรวจสอบก่อน'
      )
    } finally {
      setReceiving(false)
    }
  }

  // Earlier PO lines, newest PO first -- feeds the scan's stock auto-link (the form keeps only the chosen supplier's).
  // Comes from the already-loaded list, so it covers whatever the list filters currently show.
  const pastPoItems = useMemo(() => [...(pos || [])]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .flatMap(po => (po.purchase_order_items || []).map(it => ({ supplier_id: po.supplier_id, description: it.description, inventory_item_id: it.inventory_item_id }))),
  [pos])

  const editFormInitial = useMemo(() => {
    if (!editRow) return null
    return {
      id: editRow.id,
      site_id: editRow.site_id, supplier_id: editRow.supplier_id, category_id: editRow.category_id,
      date: editRow.date, has_vat: editRow.has_vat, price_includes_vat: editRow.price_includes_vat || false,
      ordered_by: editRow.ordered_by || '', notes: editRow.notes || '',
      stock_from_invoice: !!editRow.stock_from_invoice,
      items: (editRow.purchase_order_items?.length ? editRow.purchase_order_items : [{ ...EMPTY_ITEM }])
        .map(it => ({
          description: it.description, quantity: String(it.quantity), unit: it.unit || '', unit_price: String(it.unit_price),
          discount_pct: String(it.discount_pct ?? 0),
          inventory_item_id: it.inventory_item_id || '',
          aluminum_profile_id: it.aluminum_profile_id || '',
          rod_length_m: it.rod_length_m != null ? String(it.rod_length_m) : '',
          glass_width_m: it.glass_width_m != null ? String(it.glass_width_m) : '',
          glass_height_m: it.glass_height_m != null ? String(it.glass_height_m) : '',
        })),
    }
  }, [editRow])

  // ฟอร์มเพิ่ม/แก้ไขใบสั่งซื้อแยกเป็นหน้าเต็มแทน popup เดิม (เหมือน Quotations.jsx
  // -- ฟอร์มยาว มีทั้งรายการสินค้าและช่องแนบไฟล์ popup แคบเกินไป) แทนที่ทั้งหน้า
  // list ไปเลยตอนเปิด แทนที่จะซ้อน Modal ทับ
  const openCreditNote = (po) => {
    setCreditNotePrefill({
      supplier_id: po.supplier_id, site_id: po.site_id, po_id: po.id, category_id: po.category_id,
      vatEnabled: po.has_vat !== false, priceIncludesVat: !!po.price_includes_vat, original_expense_id: po.expense_id || null,
      items: (po.purchase_order_items || []).map(it => {
        const invItem = it.inventory_item_id ? (allInventoryItems || []).find(i => i.id === it.inventory_item_id) : null
        const profile = it.aluminum_profile_id ? (allAluminumProfiles || []).find(p => p.id === it.aluminum_profile_id) : null
        const factor = it.inventory_item_id ? (unitFactors || []).find(f => f.inventory_item_id === it.inventory_item_id && f.unit_name === it.unit) : null
        return poItemToCreditLine(it, invItem ? { ...computePoItemBaseQty(it, invItem, profile, factor), baseUnit: invItem.base_unit } : null)
      }),
    })
    navigateTo('supplier_credit_notes', {})
  }

  const poMenuItems = (po) => {
    const lock = poEditLockedText(po, taxInvoiceLinks) || poMoneyLockText(po, moneyIndex)
    const items = []
    // new dialog once the 2026-10-09 schema is live; old receive for ordered POs before it (index null / schema missing)
    // or with a discount line; a partially received PO without the schema is disabled with the reason
    const route = canEdit ? receiveRoute(po, moneyIndex) : null
    if (route) {
      items.push(route.kind === 'disabled'
        ? { label: '📦 รับของ', disabled: true, disabledTitle: route.reason, onClick: () => {} }
        : { label: '📦 รับของ', onClick: () => { setReceiveKind(route.kind); setReceiveRow(po) } })
    }
    if (canEdit && canOfferCreateDeposit(po, moneyIndex)) {
      items.push(moneyIndex.get(po.id)?.depositId
        ? { label: '💰 สร้างใบจ่ายมัดจำ', disabled: true, disabledTitle: 'ใบสั่งซื้อนี้มีใบมัดจำแล้ว', onClick: () => {} }
        : { label: '💰 สร้างใบจ่ายมัดจำ', onClick: () => setDepositPo(po) })
    }
    if (canEdit && (po.status === 'ordered' || po.status === 'draft')) {
      items.push({ label: '✏️ แก้ไข', disabled: !!lock, disabledTitle: lock || undefined, onClick: () => { clearDraft(ADD_FORM_OPEN_KEY); setEditRow(po); setShowAdd(true) } })
      items.push({ label: '🗑️ ยกเลิกใบสั่งซื้อ', danger: true, disabled: !!lock, disabledTitle: lock || undefined, onClick: () => setDeleteId(po.id) })
    }
    items.push({ label: '👁️ ดูตัวอย่างก่อนพิมพ์', onClick: () => setDocRow({ po, action: null }) })
    items.push({ label: '🖨️ พิมพ์', onClick: () => setDocRow({ po, action: 'print' }) })
    items.push({ label: '📄 ดาวน์โหลด PDF', onClick: () => setDocRow({ po, action: 'pdf' }) })
    items.push({ label: '🖼️ ดาวน์โหลด JPEG', onClick: () => setDocRow({ po, action: 'jpg' }) })
    if (canEdit && po.status === 'received') {
      if (po.expense_id && !taxInvoiceLinks?.get(po.id)) {
        // A PO with several bills (several receipts, or a bill split by จ่ายบางส่วน) has no single bill to swap the tax invoice on.
        const multiBill = poHasMultipleBills(po, moneyIndex)
        items.push(multiBill
          ? { label: '🔄 สลับใบกำกับภาษี', disabled: true, disabledTitle: SWAP_MULTI_BILL_TEXT, onClick: () => {} }
          : { label: '🔄 สลับใบกำกับภาษี', onClick: () => setSwapInvoiceRow(po) })
      }
      items.push({ label: '↩️ สร้างใบลดหนี้', onClick: () => openCreditNote(po) })
    }
    return items
  }

  if (showAdd) {
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <button className="btn btn-ghost" onClick={() => { clearDraft(ADD_FORM_OPEN_KEY); setShowAdd(false); setEditRow(null) }}>← กลับ</button>
          <h2 style={{ margin: 0, fontSize: 18 }}>{editRow ? 'แก้ไขใบสั่งซื้อ' : 'เพิ่มใบสั่งซื้อ'}</h2>
        </div>
        <div className="card" style={{ maxWidth: 960, margin: '0 auto' }}>
          <PurchaseOrderForm
            showStockFlag={taxInvoiceLinks !== null} stockFlagLocked={editRow?.status === 'received'}
            initial={editFormInitial || EMPTY_FORM}
            sites={sites} categories={categories} suppliers={suppliers || []}
            onSave={handleSave} onCancel={() => { clearDraft(ADD_FORM_OPEN_KEY); setShowAdd(false); setEditRow(null) }} loading={saving}
            onSiteCreated={refetchSites} onSupplierCreated={refetchSuppliers}
            inventoryItems={inventoryItems} onInventoryItemCreated={refetchInventoryItems} aluminumProfiles={aluminumProfiles}
            pastPoItems={pastPoItems}
          />
          {editRow && tenant?.id && (
            <div className="modal-body" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <AttachmentsSection table="purchase_order_attachments" bucket="po-attachments" foreignKey="po_id" entityId={editRow.id} tenantId={tenant.id} />
            </div>
          )}
          {!editRow && (
            <div className="modal-body" style={{ fontSize: 12, color: 'var(--text3)', borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              บันทึกใบสั่งซื้อก่อน จึงจะแนบไฟล์ได้
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div>
      {toast && <div className="alert alert-success" style={{ marginBottom: 12 }}>✅ {toast}</div>}

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        {canEdit && <button className="btn btn-primary" onClick={() => { saveDraft(ADD_FORM_OPEN_KEY, true); setEditRow(null); setShowAdd(true) }}>+ เพิ่มใบสั่งซื้อ</button>}
        <div style={{ flex: 1 }} />
        <input type="date" className="input input-sm" style={{ width: 140 }} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        <span style={{ color: 'var(--text3)' }}>—</span>
        <input type="date" className="input input-sm" style={{ width: 140 }} value={dateTo} onChange={e => setDateTo(e.target.value)} />
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ minWidth: 200 }}>
          <SearchableSelect value={siteId} onChange={setSiteId} placeholder="ทุกไซท์งาน" options={siteOpts(sites)} />
        </div>
        <div style={{ minWidth: 190 }}>
          <SearchableSelect value={supplierId} onChange={setSupplierId} placeholder="ทุก Supplier" options={supplierOpts(suppliers)} />
        </div>
        <select className="select select-sm" style={{ width: 190 }} value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">ทุกสถานะ</option>
          {PO_STATUSES.map(s => <option key={s} value={s}>{PO_STATUS_LABELS[s]}</option>)}
        </select>
        <input className="input input-sm" style={{ width: 200 }} placeholder="ค้นหาเลขที่ / ไซท์งาน / Supplier..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="sortable" onClick={() => toggleSort('po_number')}>เลขที่{si('po_number')}</th>
                <th className="sortable" onClick={() => toggleSort('date')}>วันที่{si('date')}</th>
                <th className="sortable" onClick={() => toggleSort('site')}>ไซท์งาน{si('site')}</th>
                <th className="sortable" onClick={() => toggleSort('supplier')}>Supplier{si('supplier')}</th>
                <th>รายการ</th>
                <th className="sortable" onClick={() => toggleSort('total')}>ยอดรวม{si('total')}</th>
                <th className="sortable" onClick={() => toggleSort('status')}>สถานะ{si('status')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sortedPos.map(po => {
                const { total } = calcPoTotals(po.purchase_order_items, po.has_vat, po.price_includes_vat)
                const taxBadge = poTaxInvoiceBadge(po, taxInvoiceLinks)
                return (
                  <tr key={po.id}>
                    <td className="font-mono" style={{ fontSize: 12 }}>
                      {isPoDraft(po) && <PendingMark label="ฉบับร่าง รอดำเนินการ" />}
                      {po.po_number}
                      {po.purchase_order_attachments?.length > 0 && <span title="มีไฟล์แนบ" style={{ marginLeft: 4 }}>📎</span>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDate(po.date)}</td>
                    <td style={{ fontSize: 11, color: 'var(--accent)', cursor: po.site_id ? 'pointer' : 'default' }}
                      onClick={() => po.site_id && openSiteOverview(po.site_id)}>{po.sites?.name || '—'}</td>
                    <td style={{ fontSize: 12 }}>{po.suppliers?.name || '—'}</td>
                    <td style={{ fontSize: 11, color: 'var(--text3)' }}>{(po.purchase_order_items || []).length} รายการ</td>
                    <td className="font-mono" style={{ fontWeight: 700 }}>{fmt(total)}</td>
                    <td>
                      <span className={`badge badge-po-${po.status}`}>{PO_STATUS_LABELS[po.status] || po.status}</span>
                      {taxBadge.kind && <span className={`badge ${TAX_BADGE_CLASS[taxBadge.kind]}`} style={{ marginLeft: 4 }}>{taxBadge.text}</span>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <div className="actions-cell">
                        <button className="btn btn-sm btn-ghost" title="ดูใบสั่งซื้อ / เอกสาร" aria-label="📄 ดูใบสั่งซื้อ / เอกสาร" onClick={() => setDetailRow(po)}>📄</button>
                        <RowActionsMenu items={poMenuItems(po)} />
                      </div>
                    </td>
                  </tr>
                )
              })}
              {!sortedPos.length && (
                <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>ไม่พบใบสั่งซื้อในช่วงเวลานี้</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {deleteId && (
        <ConfirmDialog title="ยกเลิกใบสั่งซื้อ" message="ยืนยันการยกเลิกใบสั่งซื้อนี้?" onConfirm={handleCancel} onCancel={() => setDeleteId(null)} danger />
      )}

      {docRow && <PODocumentModal po={docRow.po} autoAction={docRow.action} tenant={tenant} onClose={() => setDocRow(null)} />}

      {detailRow && <PODetailModal key={`${detailRow.id}:${poDataVersion}`} po={detailRow} taxBadge={poTaxInvoiceBadge(detailRow, taxInvoiceLinks)} tenantId={tenant?.id}
        onClose={() => setDetailRow(null)}
        onViewDocument={po => { setDetailRow(null); setDocRow({ po, action: null }) }} />}

      {depositPo && (
        <CreatePoDepositModal po={depositPo} onClose={() => setDepositPo(null)}
          onDone={async res => {
            await auditLog('expenses', res.expense_id, 'INSERT', null, { po_id: depositPo.id, via: 'create_po_deposit', deposit_id: res.deposit_id, amount: res.amount })
            setDepositPo(null); refreshPoData(); showToast('สร้างใบมัดจำแล้ว ' + fmt(res.amount) + ' บาท')
          }} />
      )}
      {receiveRow && receiveKind === 'new' && (
        <ReceivePoLinesModal key={receiveRow.id} po={receiveRow} stockPlanFor={receiveStockPlan} stockBalances={stockBalances}
          onClose={() => setReceiveRow(null)}
          onDone={async res => {
            const po = receiveRow
            setReceiveRow(null)
            try {
              if (res.expense_id) await auditLog('expenses', res.expense_id, 'INSERT', null, { po_id: po.id, via: 'receive_po_lines', receipt_no: res.receipt_no })
              await auditLog('purchase_orders', po.id, 'UPDATE', null, { via: 'receive_po_lines', status: res.status, receipt_no: res.receipt_no, receipt_id: res.receipt_id, expense_id: res.expense_id })
            } catch (e) { console.warn('audit log failed:', e?.message) } finally {
              // the receipt is saved whatever the audit did: always refresh and confirm
              refreshPoData(); refetchInventoryItems()
              showToast('รับของแล้ว' + (res.receipt_no ? ` (${res.receipt_no}) ` : ' ') + (res.expense_id ? 'สร้างบิลแล้ว' : 'หักมัดจำครบ ไม่สร้างบิล') + (po.stock_from_invoice ? ' · สต็อกจะเข้าเมื่อบันทึกใบกำกับภาษี' : ''))
            }
          }} />
      )}

      {receiveRow && receiveKind === 'old' && (
        <ConfirmDialog
          title="ยืนยันรับของ"
          message={
            <div>
              {(() => {
                const t = calcPoTotals(receiveRow.purchase_order_items, receiveRow.has_vat, receiveRow.price_includes_vat)
                const plan = depositSel?.valid ? depositSel.plan : null
                return plan && !plan.createExpense
                  ? <div>รับของตามใบสั่งซื้อ {receiveRow.po_number} — ไม่สร้างรายจ่าย (หักมัดจำครบ)</div>
                  : <div>สร้างรายจ่ายอัตโนมัติจากใบสั่งซื้อ {receiveRow.po_number} ยอดรวม {fmt(plan ? plan.total : t.total)} บาท?</div>
              })()}
              <ReceiveDepositBlock
                key={receiveRow.id}
                po={receiveRow}
                totals={receiveTotals(receiveRow)}
                onChange={setDepositSel}
              />
              {receiveRow.stock_from_invoice && (
                <div style={{ marginTop: 10, fontSize: 12, borderTop: '1px solid var(--border)', paddingTop: 8, color: '#b45309' }}>
                  📦 ไม่ลงสต็อกตอนรับของ — สต็อกจะเข้าเมื่อบันทึกใบกำกับภาษีผู้ขาย
                </div>
              )}
              {!receiveRow.stock_from_invoice && receiveStockPlan(receiveRow).length > 0 && (
                <div style={{ marginTop: 10, fontSize: 12, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  <strong>จะบันทึกเข้าสต็อก:</strong>
                  {receiveStockPlan(receiveRow).map((plan, i) => {
                    if (plan.unconverted) {
                      return (
                        <div key={i} style={{ marginTop: 4, color: 'var(--red)' }}>
                          ⚠️ {plan.name}: ไม่พบข้อมูลหน้าตัด/ขนาดที่ต้องใช้แปลงหน่วย — จะบันทึกเป็น {fmt(plan.baseQty)} {plan.baseUnit} (อาจไม่ถูกต้อง) กรุณาตรวจสอบก่อนยืนยัน
                        </div>
                      )
                    }
                    const bal = (stockBalances || []).find(b => b.inventory_item_id === plan.inventoryItemId && b.site_id === receiveRow.site_id)
                    const oldQty = bal?.quantity_on_hand || 0
                    const oldWac = bal?.weighted_average_cost || 0
                    const newQty = oldQty + plan.baseQty
                    const newWac = computeWeightedAverageCost(oldQty, oldWac, plan.baseQty, plan.unitCostPerBase)
                    return (
                      <div key={i} style={{ marginTop: 4 }}>
                        📦 {plan.name}: +{fmt(plan.baseQty)} {plan.baseUnit} → คงเหลือ {fmt(newQty)} {plan.baseUnit} @ เฉลี่ย {fmt(newWac)}/{plan.baseUnit}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          }
          onConfirm={handleReceive}
          confirmDisabled={receiving || !canConfirmReceive(depositSel)}
          onCancel={() => setReceiveRow(null)}
        />
      )}

      {swapInvoiceRow && (
        <SwapTaxInvoiceModal
          po={swapInvoiceRow}
          onClose={() => setSwapInvoiceRow(null)}
          onSwapped={() => { setSwapInvoiceRow(null); refetch(); showToast('สลับใบกำกับภาษีแล้ว') }}
        />
      )}
    </div>
  )
}
