// ============================================================
// PeakExportModal — ส่งออกรายจ่าย + ใบลดหนี้ซัพพลายเออร์เป็นไฟล์ .xlsx
// สำหรับนำเข้า PEAK. ⚠️ ยังไม่ได้ทดสอบนำเข้าใน PEAK จริง
// ============================================================
import { useMemo, useState } from 'react'
import { Modal } from './Modal.jsx'
import { useExpenses, useSupplierCreditNotes, useCategories, useSuppliers } from '../hooks/useSupabase.js'
import { bangkokTodayIso } from '../lib/photoUpload.js'
import {
  PEAK_EXPENSE_HEADERS, PEAK_JOURNAL_HEADERS,
  buildPeakExpenseRows, buildPeakJournalRows, downloadPeakSheet, summarizeExport,
} from '../lib/peakExport.js'

function summaryLine(s, unit) {
  const parts = [`ส่งออก ${s.exported} ${unit}`]
  if (s.skippedNegative) parts.push(`ข้าม ${s.skippedNegative} ใบ (ยอดติดลบ)`)
  if (s.skippedNoAccount) parts.push(`${s.skippedNoAccount} รายการไม่มีรหัสบัญชี PEAK`)
  if (s.noContact) parts.push(`${s.noContact} รายการไม่มีผู้ติดต่อ (PEAK จะเว้นว่าง)`)
  return parts.join(' · ')
}

function Section({ title, unit, built, filename, onDownload }) {
  const s = summarizeExport(built)
  const empty = s.exported === 0
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.6, marginBottom: 6 }}>{summaryLine(s, unit)}</div>
      <button className="btn btn-primary" disabled={empty} onClick={onDownload}>{filename}</button>
      {empty && (
        <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 4 }}>
          ดาวน์โหลดไม่ได้: ไม่มีรายการที่ส่งออกได้ในช่วงวันที่นี้
        </div>
      )}
    </div>
  )
}

export default function PeakExportModal({ onClose }) {
  const today = bangkokTodayIso()
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`)
  const [to, setTo] = useState(today)

  const { data: expenses, loading: l1, error: e1 } = useExpenses({ from, to })
  const { data: notes, loading: l2, error: e2 } = useSupplierCreditNotes({ status: 'confirmed' })
  const { data: categories } = useCategories()
  const { data: suppliers } = useSuppliers()

  const ctx = useMemo(() => ({
    accountByCategoryId: Object.fromEntries((categories || []).filter(c => c.peak_account_code).map(c => [c.id, c.peak_account_code])),
    supplierById: Object.fromEntries((suppliers || []).map(s => [s.id, s])),
  }), [categories, suppliers])

  const built = useMemo(() => {
    const inRange = d => d && d >= from && d <= to
    const exp = (expenses || []).filter(r => inRange(r.date))
    const cns = (notes || []).filter(n => n.status === 'confirmed' && inRange(n.doc_date))
    return { exp: buildPeakExpenseRows(exp, ctx), cn: buildPeakJournalRows(cns, ctx) }
  }, [expenses, notes, ctx, from, to])

  const loading = l1 || l2
  const error = e1 || e2

  return (
    <Modal title="ส่งออกไฟล์สำหรับ PEAK" onClose={onClose} maxWidth={460}>
      <div className="modal-body">
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label className="label">ตั้งแต่วันที่</label>
            <input type="date" className="input" value={from} max={to} onChange={e => setFrom(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <label className="label">ถึงวันที่</label>
            <input type="date" className="input" value={to} min={from} onChange={e => setTo(e.target.value)} />
          </div>
        </div>
        {error && <div className="alert alert-error" style={{ marginTop: 12 }}>โหลดข้อมูลไม่สำเร็จ: {error}</div>}
        {loading && <div style={{ marginTop: 12, color: 'var(--text2)' }}>กำลังโหลด...</div>}
        {!loading && !error && (
          <>
            <Section
              title="รายจ่าย" unit="รายการ" built={built.exp}
              filename="ดาวน์โหลดไฟล์รายจ่าย"
              onDownload={() => downloadPeakSheet(PEAK_EXPENSE_HEADERS, built.exp.rows, 'Import_Expenses', 'PEAK_expenses')}
            />
            <Section
              title="ใบลดหนี้ (ยืนยันแล้ว)" unit="แถว" built={built.cn}
              filename="ดาวน์โหลดไฟล์ใบลดหนี้ (journal)"
              onDownload={() => downloadPeakSheet(PEAK_JOURNAL_HEADERS, built.cn.rows, 'Import Multiple Journal', 'PEAK_credit_notes')}
            />
          </>
        )}
        <div className="alert alert-warning" style={{ marginTop: 16, fontSize: 13 }}>ตรวจไฟล์ก่อนนำเข้า PEAK ทุกครั้ง</div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
      </div>
    </Modal>
  )
}
