// ============================================================
// Supplier tax invoices — ใบกำกับภาษีผู้ขาย (จับคู่กับใบสั่งซื้อ)
// Draft -> preview (server, read-only) -> confirm dialog -> post (RPC: stock in, PO receipt reversal,
// expense stamping) -> void. Every write is an RPC; nothing is posted without the confirm dialog.
// Before the migration is applied the tables do not exist: the page shows a calm "not live" state.
// ============================================================
import { useEffect, useRef, useState } from 'react'
import { fmt, fmtDate } from '../lib/supabase.js'
import {
  useSupplierTaxInvoices, useSupplierTaxInvoice, useSuppliers, useSites, useReceivedPosForSupplier,
  saveSupplierTaxInvoiceDraft, previewSupplierTaxInvoice, postSupplierTaxInvoice, voidSupplierTaxInvoice,
  deleteSupplierTaxInvoiceDraft,
} from '../hooks/useSupabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import RowActionsMenu from '../components/RowActionsMenu.jsx'
import SupplierTaxInvoiceForm from '../components/SupplierTaxInvoiceForm.jsx'
import TaxInvoicePreview, { PostConfirmOverlay, checkLine } from '../components/TaxInvoicePreview.jsx'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import { bangkokTodayIso } from '../lib/photoUpload.js'
import { toRpcPayload, formFromInvoice, emptyTaxInvoiceForm, poRowsFor } from '../lib/taxInvoiceForm.js'
import {
  CHECK_TEXT, mapTaxInvoiceRpcError, formSignature, previewIsCurrent, postSummaryLines, withinTolerance, fmtQty,
} from '../lib/supplierTaxInvoice.js'

const STATUS_BADGE = {
  draft: { cls: 'badge-check_issued', label: '📝 ร่าง' },
  posted: { cls: 'badge-check_cleared', label: '✅ บันทึกแล้ว' },
  void: { cls: 'badge-received', label: '🚫 ยกเลิก' },
}

const negText = n => `${n.item_name} @ ${n.site_name} = ${fmtQty(n.qty)}`
/** Non-blocking warning texts, de-duplicated by code. */
const warnTexts = list => {
  const seen = new Set()
  const out = []
  for (const w of list || []) {
    if (w.blocking || seen.has(w.code)) continue
    seen.add(w.code); out.push(CHECK_TEXT[w.code] || w.code)
  }
  return out
}

const linksOf = row => {
  const all = row.supplier_tax_invoice_pos || []
  return row.status === 'void' ? all : all.filter(l => l.active)
}
const poSumOf = row => linksOf(row).reduce((s, l) => s + (Number(l.po_subtotal) || 0), 0)

export default function SupplierTaxInvoices() {
  const { isAtLeast, role } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'purchase_orders')
  const [supplierFilter, setSupplierFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const { data: invoices, loading, error, refetch, notReady } = useSupplierTaxInvoices({ supplierId: supplierFilter, status: statusFilter })
  const { data: suppliers } = useSuppliers()
  const { data: sites } = useSites()

  const [editing, setEditing] = useState(null)   // { id|null (current draft), loadId|null (row being loaded), key, form|null }
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)                  // synchronous guard: setBusy alone is async, a double click could slip through
  const [preview, setPreview] = useState(null)   // { id, signature, data, form }
  const [confirm, setConfirm] = useState(null)   // { id, signature, lines }
  const confirmRef = useRef(null)
  confirmRef.current = confirm
  const previewBoxRef = useRef(null)
  const [formTick, setFormTick] = useState(0)    // re-render when the form changes (stale-preview guard)
  const latestFormRef = useRef(null)
  const [viewRow, setViewRow] = useState(null)
  const [voidRow, setVoidRow] = useState(null)
  const [voidReason, setVoidReason] = useState('')
  const [deleteId, setDeleteId] = useState(null)
  const keySeq = useRef(0)

  const rows = invoices || []
  const supplierNameById = Object.fromEntries((suppliers || []).map(s => [s.id, s.name]))
  const siteNameById = Object.fromEntries((sites || []).map(s => [s.id, s.name]))

  // the saved draft being edited (full item columns)
  const { data: loaded, error: loadError } = useSupplierTaxInvoice(editing?.loadId || null)
  // PO numbers for the preview's per-PO checks (only trusted for the previewed supplier)
  const { data: poResult } = useReceivedPosForSupplier(preview?.form?.supplier_id || '')
  const poRows = poRowsFor(poResult, preview?.form?.supplier_id || '')
  const poNumberById = new Map((poRows || []).map(p => [p.id, p.po_number]))

  const actionsFor = n => [
    ...(canEdit && n.status === 'draft' ? [
      { label: '✏️ แก้ไข', onClick: () => openEdit(n) },
      { label: '🗑️ ลบ', onClick: () => setDeleteId(n.id), danger: true },
    ] : []),
    ...(n.status !== 'draft' || !canEdit ? [{ label: '👁️ ดูรายละเอียด', onClick: () => setViewRow(n) }] : []),
    ...(canEdit && n.status === 'posted' ? [
      { label: '🚫 ยกเลิกใบกำกับ', onClick: () => { setVoidReason(''); setVoidRow(n) }, danger: true },
    ] : []),
  ]

  useEffect(() => { previewBoxRef.current?.scrollIntoView?.({ block: 'nearest' }) }, [preview])

  const guard = async fn => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)                                // set BEFORE awaiting any RPC
    try { await fn() } finally { busyRef.current = false; setBusy(false) }
  }

  const openNew = () => {
    keySeq.current += 1
    latestFormRef.current = null; setPreview(null); setConfirm(null)
    setEditing({ id: null, loadId: null, key: keySeq.current, form: emptyTaxInvoiceForm(bangkokTodayIso()) })
  }
  const openEdit = row => {
    keySeq.current += 1
    latestFormRef.current = null; setPreview(null); setConfirm(null)
    setEditing({ id: row.id, loadId: row.id, key: keySeq.current, form: null })
  }
  // Modal's back-button handler treats `false` as "refused": it re-pushes its history entry (see Modal.jsx)
  const refuseWhenBusy = fn => () => { if (busyRef.current) return false; fn() }
  const closeEditor = () => {
    if (busyRef.current) return false
    setEditing(null); setPreview(null); setConfirm(null); latestFormRef.current = null
  }

  const saveDraft = async form => {
    const { header, items, poIds } = toRpcPayload(form)
    const id = await saveSupplierTaxInvoiceDraft(editing?.id || null, header, items, poIds)
    setEditing(e => (e ? { ...e, id } : e))     // later saves update the same draft
    return id
  }
  const handleSaveDraft = form => guard(async () => {
    try { await saveDraft(form); refetch(); alert('บันทึกร่างแล้ว') }
    catch (e) { alert(mapTaxInvoiceRpcError(e)) }
  })
  const handlePreview = form => guard(async () => {
    try {
      const id = await saveDraft(form)
      const data = await previewSupplierTaxInvoice(id)
      setPreview({ id, signature: formSignature(form), data, form })
      refetch()
    } catch (e) { alert(mapTaxInvoiceRpcError(e)) }
  })

  const previewBlocking = !!preview && (preview.data?.checks || []).some(c => c.blocking)
  // compare with the LIVE form (latestFormRef), not preview.form (that would always be "current")
  const previewCurrent = !!preview && previewIsCurrent(preview, latestFormRef.current)

  const askPost = () => {
    if (busyRef.current || !preview || !previewIsCurrent(preview, latestFormRef.current)) return
    if ((preview.data?.checks || []).some(c => c.blocking)) return
    const stockLineCount = preview.form.lines.filter(l => l.inventory_item_id).length
    setConfirm({
      id: preview.id, signature: preview.signature,
      lines: postSummaryLines({ invoiceNo: preview.form.invoice_no.trim(), stockLineCount, poCount: preview.form.po_ids.length, preview: preview.data, matchNote: preview.form.match_note }),
    })
  }
  const doPost = () => guard(async () => {
    if (!confirm) return
    // the form cannot change while the overlay is open, but never post a preview that is not the current form
    if (preview?.signature !== confirm.signature || !previewIsCurrent(preview, latestFormRef.current)) {
      setConfirm(null); alert('ข้อมูลเปลี่ยนแล้ว — กด "ตรวจสอบก่อนบันทึก" อีกครั้ง'); return
    }
    try {
      const result = await postSupplierTaxInvoice(confirm.id)
      setConfirm(null); setPreview(null); setEditing(null); latestFormRef.current = null; refetch()
      const neg = (result?.negative || []).map(negText)
      const warn = warnTexts(result?.checks)
      alert(`บันทึกใบกำกับแล้ว: เพิ่มสต็อก ${result?.lines_posted} รายการ · กลับรายการ ${result?.receipts_reversed} รายการ · ประทับเลขที่ในรายจ่าย ${result?.expenses_stamped} รายการ`
        + (warn.length ? '\n⚠️ ' + warn.join('\n⚠️ ') : '')
        + (neg.length ? `\n⚠️ สต็อกติดลบ:\n${neg.join('\n')}` : ''))
    } catch (e) {
      setConfirm(null); setPreview(null); refetch()   // nothing was written (atomic RPC); the preview is no longer trusted
      alert(mapTaxInvoiceRpcError(e))
    }
  })
  const doVoid = () => guard(async () => {
    if (!voidRow) return
    if (!voidReason.trim()) { alert('กรุณากรอกเหตุผลที่ยกเลิก'); return }
    try {
      const r = await voidSupplierTaxInvoice(voidRow.id, voidReason.trim())
      setVoidRow(null); setVoidReason(''); refetch()
      const warn = warnTexts(r?.warnings)
      const neg = (r?.negative || []).map(negText)
      alert('ยกเลิกใบกำกับแล้ว' + (warn.length ? '\n⚠️ ' + warn.join('\n⚠️ ') : '') + (neg.length ? `\n⚠️ สต็อกติดลบ:\n${neg.join('\n')}` : ''))
    } catch (e) { setVoidRow(null); refetch(); alert(mapTaxInvoiceRpcError(e)) }
  })
  const doDelete = () => guard(async () => {
    if (!deleteId) return
    try { await deleteSupplierTaxInvoiceDraft(deleteId); setDeleteId(null); refetch() }
    catch (e) { setDeleteId(null); refetch(); alert(mapTaxInvoiceRpcError(e)) }
  })

  if (notReady) {
    return (
      <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text2)' }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>🧾</div>
        <div style={{ fontWeight: 600 }}>ฟีเจอร์นี้ยังไม่เปิดใช้</div>
        <div style={{ fontSize: 13, marginTop: 4 }}>ใบกำกับภาษีผู้ขายยังไม่พร้อมใช้งานในระบบนี้ — ส่วนอื่นของระบบใช้งานได้ตามปกติ</div>
      </div>
    )
  }

  const formReady = editing && (editing.form || (loaded && loaded.id === editing.loadId))
  const formInitial = editing ? (editing.form || (loaded ? formFromInvoice(loaded) : null)) : null

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        {canEdit && <button className="btn btn-primary" onClick={openNew}>+ เพิ่มใบกำกับภาษีผู้ขาย</button>}
        <select className="select select-sm" style={{ width: 200 }} value={supplierFilter} onChange={e => setSupplierFilter(e.target.value)}>
          <option value="">ทุกซัพพลายเออร์</option>
          {(suppliers || []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className="select select-sm" style={{ width: 160 }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">ทุกสถานะเอกสาร</option>
          <option value="draft">📝 ร่าง</option>
          <option value="posted">✅ บันทึกแล้ว</option>
          <option value="void">🚫 ยกเลิก</option>
        </select>
      </div>

      {error && <div style={{ color: 'var(--danger, #e55)', marginBottom: 12 }}>โหลดข้อมูลไม่สำเร็จ: {error}</div>}

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>เลขที่</th><th>วันที่</th><th>ซัพพลายเออร์</th>
                <th style={{ textAlign: 'right' }}>ก่อน VAT</th><th style={{ textAlign: 'right' }}>ใบสั่งซื้อ</th>
                <th style={{ textAlign: 'right' }}>ต่าง</th><th>สถานะ</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(n => {
                const badge = STATUS_BADGE[n.status] || STATUS_BADGE.draft
                const links = linksOf(n)
                const diffBad = n.match_diff != null && !withinTolerance(n.match_diff, poSumOf(n))
                return (
                  <tr key={n.id}>
                    <td style={{ fontWeight: 600 }}>{n.invoice_no}</td>
                    <td style={{ fontSize: 12, color: 'var(--text2)' }}>{fmtDate(n.invoice_date)}</td>
                    <td>{n.suppliers?.name || supplierNameById[n.supplier_id] || '—'}</td>
                    <td className="font-mono" style={{ textAlign: 'right' }}>{fmt(n.net_before_vat)}</td>
                    <td style={{ textAlign: 'right' }}>{links.length}</td>
                    <td className="font-mono" style={{ textAlign: 'right', ...(diffBad ? { color: 'var(--danger, #e55)', fontWeight: 600 } : null) }}>
                      {n.match_diff == null ? '—' : fmt(n.match_diff)}
                    </td>
                    <td><span className={`badge ${badge.cls}`}>{badge.label}</span></td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <div className="actions-cell">
                        {actionsFor(n).length > 0 && <RowActionsMenu items={actionsFor(n)} />}
                      </div>
                    </td>
                  </tr>
                )
              })}
              {!rows.length && (
                <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>
                  {loading ? 'กำลังโหลด...' : (supplierFilter || statusFilter) ? 'ไม่พบใบกำกับที่ตรงกับตัวกรอง' : 'ยังไม่มีใบกำกับภาษีผู้ขาย'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <Modal title={editing.id ? 'แก้ไขใบกำกับภาษีผู้ขาย' : 'เพิ่มใบกำกับภาษีผู้ขาย'} onClose={() => (confirmRef.current ? false : closeEditor())} maxWidth={980}>
          {formReady && formInitial ? (
            <>
              <SupplierTaxInvoiceForm
                key={editing.key} initial={formInitial} invoiceId={editing.loadId || null} busy={busy}
                onChange={f => { latestFormRef.current = f; setFormTick(t => t + 1) }}
                onSaveDraft={handleSaveDraft} onPreview={handlePreview} onCancel={closeEditor}>
                {preview && (
                  <div ref={previewBoxRef} data-tick={formTick} style={{ borderTop: '1px solid var(--border, #ddd)', paddingTop: 12, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, marginBottom: 8 }}>ผลตรวจสอบก่อนบันทึก</div>
                    <TaxInvoicePreview preview={preview.data} poNumberById={poNumberById} />
                    {!previewCurrent && (
                      <div style={{ color: '#b45309', marginTop: 8, fontSize: 13 }}>ข้อมูลเปลี่ยนแล้ว — กด &quot;ตรวจสอบก่อนบันทึก&quot; อีกครั้ง</div>
                    )}
                    {previewBlocking && <div style={{ color: 'var(--danger, #e55)', marginTop: 8, fontSize: 13 }}>มีรายการที่ต้องแก้ก่อน จึงจะบันทึกได้</div>}
                    <div style={{ marginTop: 10, textAlign: 'right' }}>
                      <button type="button" className="btn btn-primary" disabled={busy || previewBlocking || !previewCurrent} onClick={askPost}>
                        ✅ บันทึกใบกำกับ (ลงสต็อก)
                      </button>
                    </div>
                  </div>
                )}
              </SupplierTaxInvoiceForm>
            </>
          ) : (
            <div className="modal-body" style={{ color: 'var(--text2)' }}>
              {loadError ? <>โหลดใบกำกับไม่สำเร็จ: {loadError}</> : 'กำลังโหลด...'}
              <div style={{ marginTop: 10 }}><button type="button" className="btn btn-ghost" onClick={closeEditor}>ปิด</button></div>
            </div>
          )}
        </Modal>
      )}

      {confirm && <PostConfirmOverlay lines={confirm.lines} busy={busy} onConfirm={doPost} onCancel={() => setConfirm(null)} />}

      {viewRow && <ViewModal row={viewRow} siteNameById={siteNameById} onClose={() => setViewRow(null)} />}

      {voidRow && (
        <Modal title="ยกเลิกใบกำกับภาษี" onClose={refuseWhenBusy(() => setVoidRow(null))} maxWidth={480}>
          <div className="modal-body" style={{ display: 'grid', gap: 10 }}>
            <div>ใบกำกับ <b>{voidRow.invoice_no}</b></div>
            <div style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.6 }}>
              สต็อกจะกลับเป็นเหมือนก่อนบันทึก (รับเข้าจากใบสั่งซื้อกลับมา และนำรายการของใบกำกับออก) และรายจ่ายจะกลับเป็นเลขที่ใบกำกับเดิม
            </div>
            <label style={{ fontSize: 13 }}>เหตุผลที่ยกเลิก *
              <textarea className="input" rows={3} value={voidReason} onChange={e => setVoidReason(e.target.value)} disabled={busy} />
            </label>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setVoidRow(null)}>ยกเลิก</button>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={doVoid}>🚫 ยืนยันยกเลิกใบกำกับ</button>
          </div>
        </Modal>
      )}

      {deleteId && (
        <ConfirmDialog title="ลบใบกำกับฉบับร่าง" message="ลบใบกำกับฉบับร่างนี้? (ยังไม่กระทบสต็อก)" danger confirmDisabled={busy}
          onConfirm={doDelete} onCancel={refuseWhenBusy(() => setDeleteId(null))} />
      )}
    </div>
  )
}

// Read-only view of a posted / void invoice: full item columns via useSupplierTaxInvoice(id).
function ViewModal({ row, siteNameById, onClose }) {
  const { data: full, loading, error } = useSupplierTaxInvoice(row.id)
  const inv = full || row
  const items = [...(full?.supplier_tax_invoice_items || [])].sort((a, b) => a.sort_order - b.sort_order)
  const poNoByLinkPo = new Map((row.supplier_tax_invoice_pos || []).map(l => [l.po_id, l.purchase_orders?.po_number]))
  const links = linksOf(row)
  const pr = inv.post_result || {}
  const neg = (pr.negative || []).map(negText)
  return (
    <Modal title={`ใบกำกับภาษี ${row.invoice_no}`} onClose={onClose} maxWidth={820}>
      <div className="modal-body" style={{ display: 'grid', gap: 12, fontSize: 13 }}>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <span>วันที่ <b>{fmtDate(inv.invoice_date)}</b></span>
          <span>ก่อน VAT <b>{fmt(inv.net_before_vat)}</b></span>
          <span>VAT <b>{fmt(inv.vat)}</b></span>
          <span>รวม <b>{fmt(inv.grand_total)}</b></span>
          <span>ต่างจากใบสั่งซื้อ <b>{inv.match_diff == null ? '—' : fmt(inv.match_diff)}</b></span>
        </div>
        {inv.match_note && <div>เหตุผลที่ยอดต่าง: {inv.match_note}</div>}
        {row.status === 'void' && (
          <div style={{ color: 'var(--danger, #e55)' }}>
            🚫 ยกเลิกแล้ว: {inv.void_reason || '—'}
            <div style={{ fontSize: 12 }}>เมื่อ {inv.voided_at ? new Date(inv.voided_at).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }) : '—'} โดย {inv.voided_by || '—'}</div>
          </div>
        )}
        {error && <div style={{ color: 'var(--danger, #e55)' }}>โหลดรายการไม่สำเร็จ: {error}</div>}
        <div className="table-wrap">
          <table>
            <thead><tr><th>รายการ</th><th style={{ textAlign: 'right' }}>จำนวน</th><th>หน่วย</th><th style={{ textAlign: 'right' }}>ยอด</th><th style={{ textAlign: 'right' }}>จำนวน (หน่วยหลัก)</th><th>ไซท์งาน</th></tr></thead>
            <tbody>
              {items.map(i => (
                <tr key={i.id}>
                  <td>{i.description}</td>
                  <td className="font-mono" style={{ textAlign: 'right' }}>{fmt(i.qty, 3)}</td>
                  <td>{i.unit || ''}</td>
                  <td className="font-mono" style={{ textAlign: 'right' }}>{fmt(i.amount)}</td>
                  <td className="font-mono" style={{ textAlign: 'right' }}>{i.base_qty == null ? '—' : fmt(i.base_qty, 3)}</td>
                  <td>{i.site_id ? (siteNameById[i.site_id] || '—') : '—'}</td>
                </tr>
              ))}
              {!items.length && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text3)' }}>{loading ? 'กำลังโหลด...' : 'ไม่มีรายการ'}</td></tr>}
            </tbody>
          </table>
        </div>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>ใบสั่งซื้อที่ผูก</div>
          {links.map(l => (
            <div key={l.id}>
              {poNoByLinkPo.get(l.po_id) || l.po_id} · มูลค่าสินค้า {fmt(l.po_subtotal)}
              {l.expense_id ? <> · ประทับเลขที่ในรายจ่าย <b>{l.stamped_invoice_no || row.invoice_no}</b>{l.prev_invoice_no ? ` (เดิม ${l.prev_invoice_no})` : ''}</> : ' · ไม่มีรายจ่าย'}
            </div>
          ))}
          {!links.length && <div style={{ color: 'var(--text3)' }}>—</div>}
        </div>
        {(pr.checks || []).length > 0 && (
          <div style={{ color: '#b45309' }}>
            {(pr.checks || []).map((c, i) => <div key={i}>{c.blocking ? '⛔ ' : '⚠️ '}{checkLine(c, poNoByLinkPo)}</div>)}
          </div>
        )}
        {neg.length > 0 && <div style={{ color: 'var(--danger, #e55)' }}>⚠️ สต็อกติดลบตอนบันทึก:{neg.map((t, i) => <div key={i}>{t}</div>)}</div>}
      </div>
      <div className="modal-footer"><button type="button" className="btn btn-ghost" onClick={onClose}>ปิด</button></div>
    </Modal>
  )
}
