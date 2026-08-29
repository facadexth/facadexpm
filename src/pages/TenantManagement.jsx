// ============================================================
// TenantManagement — platform-admin-only page for assigning each
// tenant a package (a named bundle of modules). See
// docs/superpowers/specs/2026-08-29-tenant-management-page-design.md.
// ✅ Phase 1: package assignment only
// ⬜ Phase 2 (separate spec later): paid status, subscription duration
// ============================================================
import { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { usePlatformTenants, usePackages } from '../hooks/useSupabase.js'
import { fmtDate } from '../lib/supabase.js'

const PLAN_LABELS = { trial: '🕓 Trial', active: '✅ Active', expired: '⛔ Expired' }

export default function TenantManagement() {
  const { data: tenants, refetch } = usePlatformTenants()
  const { data: packages } = usePackages()
  const [savingId, setSavingId] = useState(null)
  const [toast, setToast] = useState(null)

  const handlePackageChange = async (tenantId, packageId) => {
    setSavingId(tenantId)
    try {
      const { error } = await supabase.rpc('platform_set_tenant_package', {
        p_tenant_id: tenantId, p_package_id: packageId || null,
      })
      if (error) throw error
      refetch()
      setToast('บันทึกแล้ว'); setTimeout(() => setToast(null), 2000)
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSavingId(null)
    }
  }

  return (
    <div>
      {toast && <div className="alert alert-success" style={{ marginBottom: 12 }}>✅ {toast}</div>}
      <p style={{ color: 'var(--text3)', fontSize: 12, marginBottom: 16 }}>
        เปลี่ยน package จะปรับ module ที่เปิดใช้งานให้ตรงกับ package นั้นทันที (เพิ่ม module ที่ขาด ปิด module ที่ไม่อยู่ใน package ใหม่)
      </p>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>บริษัท</th>
                <th>Package</th>
                <th>Plan</th>
                <th>หมดอายุ Trial</th>
              </tr>
            </thead>
            <tbody>
              {(tenants || []).map(t => (
                <tr key={t.id}>
                  <td style={{ fontWeight: 600 }}>{t.company_name}</td>
                  <td>
                    <select className="select input-sm" style={{ width: 160 }}
                      value={t.package_id || ''} disabled={savingId === t.id}
                      onChange={e => handlePackageChange(t.id, e.target.value)}>
                      <option value="">— ไม่มี —</option>
                      {(packages || []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </td>
                  <td>{PLAN_LABELS[t.plan] || t.plan}</td>
                  <td style={{ fontSize: 12 }}>{t.trial_ends_at ? fmtDate(t.trial_ends_at) : '—'}</td>
                </tr>
              ))}
              {!(tenants || []).length && (
                <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ไม่มีข้อมูล</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
