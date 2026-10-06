// ============================================================
// TaxInvoicePreview -- result of previewSupplierTaxInvoice(): checks, stock changes, match.
// PostConfirmOverlay -- plain overlay (NOT <Modal>) because it opens over the form modal
// (Modal's popstate handling is not safe for stacked modals; see SupplierCreditNotes.jsx).
// ============================================================
import { useEffect } from 'react'
import { fmt } from '../lib/supabase.js'
import { CHECK_TEXT } from '../lib/supplierTaxInvoice.js'

const num = v => (v == null || v === '' ? null : Number(v))
const q = v => fmt(v, 3)

export function checkLine(c, poNumberById) {
  const po = c.po_id ? (poNumberById?.get?.(c.po_id) || null) : null
  return (CHECK_TEXT[c.code] || c.code) + (po ? ` (${po})` : '')
}

export default function TaxInvoicePreview({ preview, poNumberById }) {
  if (!preview) return null
  const checks = preview.checks || []
  const rows = preview.rows || []
  return (
    <div style={{ display: 'grid', gap: 10, fontSize: 13 }}>
      {checks.length > 0 && (
        <div style={{ display: 'grid', gap: 4 }}>
          {checks.map((c, i) => (
            <div key={i} style={c.blocking
              ? { color: 'var(--danger, #e55)', fontWeight: 600 }
              : { color: '#b45309' }}>
              {c.blocking ? '⛔ ' : '⚠️ '}{checkLine(c, poNumberById)}
            </div>
          ))}
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>สินค้า</th><th>ไซท์งาน</th>
              <th style={{ textAlign: 'right' }}>คงเหลือก่อน</th>
              <th style={{ textAlign: 'right' }}>+ จากใบกำกับ</th>
              <th style={{ textAlign: 'right' }}>− กลับรายการใบสั่งซื้อ</th>
              <th style={{ textAlign: 'right' }}>คงเหลือหลัง</th>
              <th style={{ textAlign: 'right' }}>ต้นทุนเฉลี่ยหลัง</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const neg = num(r.after_qty) < 0
              return (
                <tr key={i}>
                  <td>{r.item_name}</td>
                  <td>{r.site_name}</td>
                  <td className="font-mono" style={{ textAlign: 'right' }}>{q(r.before_qty)}</td>
                  <td className="font-mono" style={{ textAlign: 'right' }}>{q(r.add_qty)}</td>
                  <td className="font-mono" style={{ textAlign: 'right' }}>{q(r.remove_qty)}</td>
                  <td className="font-mono" style={{ textAlign: 'right', ...(neg ? { color: 'var(--danger, #e55)', fontWeight: 700 } : null) }}>
                    {q(r.after_qty)} {r.base_unit || ''}
                  </td>
                  <td className="font-mono" style={{ textAlign: 'right' }}>{fmt(r.after_wac)}</td>
                </tr>
              )
            })}
            {!rows.length && <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text3)' }}>ไม่มีการเปลี่ยนแปลงสต็อก</td></tr>}
          </tbody>
        </table>
      </div>
      <div>
        มูลค่าสินค้าใบสั่งซื้อ {fmt(preview.po_sum)} · ต่าง {fmt(preview.diff)} (เกณฑ์ ±{fmt(preview.tolerance)})
      </div>
    </div>
  )
}

export function PostConfirmOverlay({ lines, busy, onConfirm, onCancel }) {
  useEffect(() => {
    // capture + stopImmediatePropagation: the form <Modal> underneath also listens for Escape and must stay open
    const h = e => { if (e.key !== 'Escape') return; e.stopImmediatePropagation(); if (!busy) onCancel() }
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [onCancel, busy])
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" style={{ zIndex: 1100 }}>
      <div className="modal" style={{ maxWidth: 'min(520px, 94vw)' }}>
        <div className="modal-header">
          <span className="modal-title">ยืนยันบันทึกใบกำกับภาษี — โปรดตรวจสอบ</span>
          <button type="button" className="modal-close" disabled={busy} onClick={onCancel}>✕</button>
        </div>
        <div className="modal-body">
          <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6, fontSize: 13, color: 'var(--text2)', lineHeight: 1.6 }}>
            {lines.map((l, i) => <li key={i} style={l.startsWith('⚠️') ? { color: '#b45309', fontWeight: 600 } : undefined}>{l}</li>)}
          </ul>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onCancel}>ยกเลิก</button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={onConfirm}>✅ ยืนยันบันทึก</button>
        </div>
      </div>
    </div>
  )
}
