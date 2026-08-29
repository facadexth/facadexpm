// ============================================================
// TenantManagement — platform-admin-only page for assigning each
// tenant a package (a named bundle of modules) and manual paid status.
// See docs/superpowers/specs/2026-08-29-tenant-management-page-design.md.
// ✅ Phase 1: package assignment
// ✅ Phase 2: paid status + expiry (manual -- no payment gateway exists)
// ============================================================
import { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { usePlatformTenants, usePackages, useTenantStatusLog } from '../hooks/useSupabase.js'
import { Modal } from '../components/Modal.jsx'
import { fmtDate } from '../lib/supabase.js'

const PLAN_LABELS = { trial: '🕓 Trial', active: '✅ Active', expired: '⛔ Expired' }
const PLAN_OPTS = ['trial', 'active', 'expired']

function addMonths(dateStr, months) {
  const d = dateStr ? new Date(dateStr) : new Date()
  d.setMonth(d.getMonth() + months)
  return d.toISOString().slice(0, 10)
}

// จ่ายแล้ว/เปลี่ยนสถานะ + ดูประวัติ -- ไม่มีระบบรับเงินอัตโนมัติ จึงเป็น
// การกดมือทั้งหมด, tenant_status_log เก็บแค่ "ใครเปลี่ยนอะไรเมื่อไหร่"
// ไม่มีจำนวนเงิน/ช่องทางจ่าย (ตามที่ตกลงกัน)
function StatusModal({ tenant, onClose, onSaved }) {
  const [plan, setPlan] = useState(tenant.plan)
  const [expiresAt, setExpiresAt] = useState(tenant.plan_expires_at ? tenant.plan_expires_at.slice(0, 10) : '')
  const [saving, setSaving] = useState(false)
  const { data: log } = useTenantStatusLog(tenant.id)

  const handleSave = async () => {
    setSaving(true)
    try {
      const { error } = await supabase.rpc('platform_set_tenant_status', {
        p_tenant_id: tenant.id, p_plan: plan, p_plan_expires_at: expiresAt || null,
      })
      if (error) throw error
      onSaved()
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`สถานะ — ${tenant.company_name}`} onClose={onClose} maxWidth={480}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div>
          <label className="label">สถานะ</label>
          <select className="select" value={plan} onChange={e => setPlan(e.target.value)}>
            {PLAN_OPTS.map(p => <option key={p} value={p}>{PLAN_LABELS[p]}</option>)}
          </select>
        </div>
        <div>
          <label className="label">วันหมดอายุ</label>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="date" className="input" style={{ maxWidth: 180 }}
              value={expiresAt} onChange={e => setExpiresAt(e.target.value)} />
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setExpiresAt(addMonths(expiresAt, 1))}>+1 เดือน</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setExpiresAt(addMonths(expiresAt, 12))}>+1 ปี</button>
          </div>
        </div>
        {log?.length > 0 && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', marginBottom: 6, textTransform: 'uppercase' }}>ประวัติ</div>
            <div style={{ display: 'grid', gap: 4, maxHeight: 160, overflowY: 'auto' }}>
              {log.map(l => (
                <div key={l.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, background: 'var(--bg3)', borderRadius: 7, padding: '6px 10px', fontSize: 11 }}>
                  <div>
                    {PLAN_LABELS[l.plan] || l.plan} {l.plan_expires_at ? `· หมดอายุ ${fmtDate(l.plan_expires_at)}` : ''}
                    <div style={{ color: 'var(--text3)' }}>{l.changed_by}</div>
                  </div>
                  <div style={{ color: 'var(--text3)', whiteSpace: 'nowrap' }}>{fmtDate(l.created_at)}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ยกเลิก</button>
        <button className="btn btn-primary" disabled={saving} onClick={handleSave}>
          {saving ? '⏳...' : '✅ บันทึก'}
        </button>
      </div>
    </Modal>
  )
}

export default function TenantManagement() {
  const { data: tenants, refetch } = usePlatformTenants()
  const { data: packages } = usePackages()
  const [savingId, setSavingId] = useState(null)
  const [statusTenant, setStatusTenant] = useState(null)
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
                <th>สถานะ</th>
                <th>หมดอายุ</th>
                <th></th>
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
                  <td style={{ fontSize: 12 }}>{t.plan_expires_at ? fmtDate(t.plan_expires_at) : (t.trial_ends_at ? `Trial: ${fmtDate(t.trial_ends_at)}` : '—')}</td>
                  <td>
                    <button className="btn btn-sm btn-ghost" onClick={() => setStatusTenant(t)}>จัดการสถานะ</button>
                  </td>
                </tr>
              ))}
              {!(tenants || []).length && (
                <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ไม่มีข้อมูล</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {statusTenant && (
        <StatusModal tenant={statusTenant} onClose={() => setStatusTenant(null)}
          onSaved={() => { setStatusTenant(null); refetch(); setToast('บันทึกแล้ว'); setTimeout(() => setToast(null), 2000) }} />
      )}
    </div>
  )
}
