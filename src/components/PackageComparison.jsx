// ============================================================
// PackageComparison — table comparing every package tier, reading
// packages/package_modules live (platform admin edits at Tenant
// Management show up here immediately). Shared between Settings.jsx
// (view-only) and UpgradeModal.jsx (adds an "เลือกแพ็กเกจนี้" row).
// ============================================================
import { fmt } from '../lib/supabase.js'
import { usePackages, usePackageModules } from '../hooks/useSupabase.js'

const packagePriceLabel = (p) =>
  p.price_monthly == null ? 'Custom' : p.price_monthly === 0 ? 'ฟรี' : `${fmt(p.price_monthly, 0)}/เดือน`
const quotaLabel = (n) => n == null ? 'ไม่จำกัด' : n
const MODULE_LABELS = {
  quotations: '📋 ใบเสนอราคา',
  invoices: '🧾 ใบแจ้งหนี้',
  purchase_orders: '🧾 ใบสั่งซื้อ',
  cheque_tracking: '🏦 จัดการเช็ค',
  client_deposits: '💰 มัดจำลูกค้า',
  payroll: '👷 Payroll / จ่ายงานช่าง',
  labor_subcontractors: '🔧 ผู้รับเหมาค่าแรง',
}

export default function PackageComparison({ currentPackageId, onApply, applyingId, allowFreeApply }) {
  const { data: packages } = usePackages()
  const { data: modules } = usePackageModules()
  if (!packages?.length) return null

  const modulesFor = (packageId) =>
    new Set((modules || []).filter(m => m.package_id === packageId).map(m => m.module_key))

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <div className="card-header"><div className="card-title">💎 เปรียบเทียบแพ็กเกจ</div></div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Package</th>
              {packages.map(p => (
                <th key={p.id} style={{ textAlign: 'center', color: p.id === currentPackageId ? 'var(--accent)' : undefined }}>
                  {p.name}{p.id === currentPackageId ? ' (ปัจจุบัน)' : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ fontWeight: 600 }}>ราคา</td>
              {packages.map(p => <td key={p.id} style={{ textAlign: 'center' }}>{packagePriceLabel(p)}</td>)}
            </tr>
            <tr>
              <td style={{ fontWeight: 600 }}>Admin/Owner สูงสุด</td>
              {packages.map(p => <td key={p.id} style={{ textAlign: 'center' }}>{quotaLabel(p.max_admins)}</td>)}
            </tr>
            <tr>
              <td style={{ fontWeight: 600 }}>พนักงานสูงสุด</td>
              {packages.map(p => <td key={p.id} style={{ textAlign: 'center' }}>{quotaLabel(p.max_workers)}</td>)}
            </tr>
            <tr>
              <td style={{ fontWeight: 600 }}>ไซท์งาน "กำลังดำเนินการ" สูงสุด</td>
              {packages.map(p => <td key={p.id} style={{ textAlign: 'center' }}>{quotaLabel(p.max_sites)}</td>)}
            </tr>
            {Object.entries(MODULE_LABELS).map(([key, label]) => (
              <tr key={key}>
                <td style={{ fontWeight: 600 }}>{label}</td>
                {packages.map(p => (
                  <td key={p.id} style={{ textAlign: 'center' }}>
                    {modulesFor(p.id).has(key) ? '✅' : '—'}
                  </td>
                ))}
              </tr>
            ))}
            {onApply && (
              <tr>
                <td></td>
                {packages.map(p => (
                  <td key={p.id} style={{ textAlign: 'center' }}>
                    {p.id === currentPackageId ? (
                      <span style={{ fontSize: 11, color: 'var(--text3)' }}>แพ็กเกจปัจจุบัน</span>
                    ) : p.price_monthly == null ? (
                      <span style={{ fontSize: 11, color: 'var(--text3)' }}>ติดต่อเรา</span>
                    ) : p.price_monthly === 0 && !allowFreeApply ? (
                      <span style={{ fontSize: 11, color: 'var(--text3)' }}>ใช้ได้ฟรีทันที</span>
                    ) : (
                      <button
                        className="btn btn-sm btn-primary"
                        disabled={applyingId === p.id}
                        onClick={() => onApply(p)}
                      >
                        {applyingId === p.id ? '⏳...' : 'เลือกแพ็กเกจนี้'}
                      </button>
                    )}
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
