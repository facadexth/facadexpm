// ============================================================
// TenantManagement — platform-admin-only page for assigning each
// tenant a package (a named bundle of modules) and manual paid status.
// See docs/superpowers/specs/2026-08-29-tenant-management-page-design.md.
// ✅ Phase 1: package assignment
// ✅ Phase 2: paid status + expiry (manual -- no payment gateway exists)
// ✅ Phase 3: edit seat/site quota per package tier
// ============================================================
import { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { usePlatformTenants, usePackages, useTenantStatusLog } from '../hooks/useSupabase.js'
import { Modal } from '../components/Modal.jsx'
import { fmt, fmtDate } from '../lib/supabase.js'
import changelog from '../changelog.json'

const packagePriceLabel = (p) =>
  p.price_monthly == null ? 'Custom' : p.price_monthly === 0 ? 'ฟรี' : `${fmt(p.price_monthly, 0)}/ด.`

const quotaLabel = (n) => n == null ? 'ไม่จำกัด' : n

const PLAN_LABELS = { trial: '🕓 Trial', active: '✅ Active', expired: '⛔ Expired' }
const PLAN_OPTS = ['trial', 'active', 'expired']

// เว้นว่าง = ไม่จำกัด (max_* เป็น NULL ในฐานข้อมูล) -- บังคับจริงอยู่ที่
// tenant_under_seat_limit() ฝั่ง DB, แก้ที่นี่แค่ปรับตัวเลข limit ต่อ tier
function QuotaModal({ pkg, onClose, onSaved }) {
  const [maxAdmins, setMaxAdmins] = useState(pkg.max_admins ?? '')
  const [maxWorkers, setMaxWorkers] = useState(pkg.max_workers ?? '')
  const [maxSites, setMaxSites] = useState(pkg.max_sites ?? '')
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      const { error } = await supabase.from('packages').update({
        max_admins: maxAdmins === '' ? null : parseInt(maxAdmins, 10),
        max_workers: maxWorkers === '' ? null : parseInt(maxWorkers, 10),
        max_sites: maxSites === '' ? null : parseInt(maxSites, 10),
      }).eq('id', pkg.id)
      if (error) throw error
      onSaved()
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`Quota — ${pkg.name}`} onClose={onClose} maxWidth={420}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div style={{ fontSize: 12, color: 'var(--text3)' }}>เว้นว่างไว้ = ไม่จำกัด</div>
        <div>
          <label className="label">Admin/Owner สูงสุด</label>
          <input type="number" min="0" className="input" placeholder="ไม่จำกัด"
            value={maxAdmins} onChange={e => setMaxAdmins(e.target.value)} />
        </div>
        <div>
          <label className="label">พนักงาน (Workers) สูงสุด</label>
          <input type="number" min="0" className="input" placeholder="ไม่จำกัด"
            value={maxWorkers} onChange={e => setMaxWorkers(e.target.value)} />
        </div>
        <div>
          <label className="label">ไซท์งาน "กำลังดำเนินการ" สูงสุด</label>
          <input type="number" min="0" className="input" placeholder="ไม่จำกัด"
            value={maxSites} onChange={e => setMaxSites(e.target.value)} />
        </div>
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
  const { data: packages, refetch: refetchPackages } = usePackages()
  const [savingId, setSavingId] = useState(null)
  const [statusTenant, setStatusTenant] = useState(null)
  const [quotaPkg, setQuotaPkg] = useState(null)
  const [toast, setToast] = useState(null)

  // ตารางบริษัท (tenants)
  const [tenantSortCol, setTenantSortCol] = useState('company_name')
  const [tenantSortDir, setTenantSortDir] = useState('asc')
  const toggleTenantSort = (col) => {
    if (tenantSortCol === col) setTenantSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setTenantSortCol(col); setTenantSortDir('asc') }
  }
  const tsi = (col) => tenantSortCol === col ? (tenantSortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕'
  const sortedTenants = [...(tenants || [])].sort((a, b) => {
    const va = a[tenantSortCol] ?? '', vb = b[tenantSortCol] ?? ''
    if (typeof va === 'number') return tenantSortDir === 'asc' ? va - vb : vb - va
    return tenantSortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va))
  })

  // ตาราง Quota ต่อ Package
  const [pkgSortCol, setPkgSortCol] = useState('name')
  const [pkgSortDir, setPkgSortDir] = useState('asc')
  const togglePkgSort = (col) => {
    if (pkgSortCol === col) setPkgSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setPkgSortCol(col); setPkgSortDir('asc') }
  }
  const psi = (col) => pkgSortCol === col ? (pkgSortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕'
  const sortedPackages = [...(packages || [])].sort((a, b) => {
    const va = a[pkgSortCol] ?? '', vb = b[pkgSortCol] ?? ''
    if (typeof va === 'number') return pkgSortDir === 'asc' ? va - vb : vb - va
    return pkgSortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va))
  })

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
                <th className="sortable" onClick={() => toggleTenantSort('company_name')}>บริษัท{tsi('company_name')}</th>
                <th className="sortable" onClick={() => toggleTenantSort('package_name')}>Package{tsi('package_name')}</th>
                <th className="sortable" onClick={() => toggleTenantSort('plan')}>สถานะ{tsi('plan')}</th>
                <th className="sortable" onClick={() => toggleTenantSort('plan_expires_at')}>หมดอายุ{tsi('plan_expires_at')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sortedTenants.map(t => (
                <tr key={t.id}>
                  <td style={{ fontWeight: 600 }}>{t.company_name}</td>
                  <td>
                    <select className="select input-sm" style={{ width: 160 }}
                      value={t.package_id || ''} disabled={savingId === t.id}
                      onChange={e => handlePackageChange(t.id, e.target.value)}>
                      <option value="">— ไม่มี —</option>
                      {(packages || []).map(p => <option key={p.id} value={p.id}>{p.name} · {packagePriceLabel(p)}</option>)}
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

      <h3 style={{ margin: '28px 0 12px', fontSize: 15, fontWeight: 700 }}>Quota ต่อ Package</h3>
      <p style={{ color: 'var(--text3)', fontSize: 12, marginBottom: 16 }}>
        จำกัดจำนวน Admin/Owner, พนักงาน, และไซท์งาน "กำลังดำเนินการ" ต่อ tenant ตาม package —
        บังคับจริงที่ระดับฐานข้อมูล เปลี่ยนที่นี่มีผลทันทีกับทุก tenant ใน package นั้น
      </p>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="sortable" onClick={() => togglePkgSort('name')}>Package{psi('name')}</th>
                <th className="sortable" onClick={() => togglePkgSort('price_monthly')}>ราคา{psi('price_monthly')}</th>
                <th className="sortable" onClick={() => togglePkgSort('max_admins')}>Admin/Owner{psi('max_admins')}</th>
                <th className="sortable" onClick={() => togglePkgSort('max_workers')}>พนักงาน{psi('max_workers')}</th>
                <th className="sortable" onClick={() => togglePkgSort('max_sites')}>ไซท์งาน (Ongoing){psi('max_sites')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sortedPackages.map(p => (
                <tr key={p.id}>
                  <td style={{ fontWeight: 600 }}>{p.name}</td>
                  <td style={{ fontSize: 12, color: 'var(--text3)' }}>{packagePriceLabel(p)}</td>
                  <td>{quotaLabel(p.max_admins)}</td>
                  <td>{quotaLabel(p.max_workers)}</td>
                  <td>{quotaLabel(p.max_sites)}</td>
                  <td>
                    <button className="btn btn-sm btn-ghost" onClick={() => setQuotaPkg(p)}>แก้ไข Quota</button>
                  </td>
                </tr>
              ))}
              {!(packages || []).length && (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ไม่มีข้อมูล</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {quotaPkg && (
        <QuotaModal pkg={quotaPkg} onClose={() => setQuotaPkg(null)}
          onSaved={() => { setQuotaPkg(null); refetchPackages(); setToast('บันทึกแล้ว'); setTimeout(() => setToast(null), 2000) }} />
      )}

      {/* src/changelog.json คือ source เดียวกับ popup ที่ผู้ใช้เห็น (Settings +
          UpdatePrompt, ดู ChangelogModal.jsx) -- ไม่แยกไฟล์ log อีกชุด เพื่อไม่ให้
          ต้องจดสองที่ทุกครั้งที่ขึ้นเวอร์ชันใหม่ หน้านี้แค่โชว์แบบเต็ม ไม่ต้องกดเปิด */}
      <h3 style={{ margin: '28px 0 12px', fontSize: 15, fontWeight: 700 }}>ประวัติการอัปเดตระบบ (v{__APP_VERSION__} ปัจจุบัน)</h3>
      <div className="card" style={{ padding: '20px 24px', display: 'grid', gap: 20 }}>
        {changelog.map(entry => (
          <div key={entry.version}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>
              v{entry.version}
              <span style={{ fontWeight: 400, color: 'var(--text3)', fontSize: 12, marginLeft: 8 }}>
                {new Date(entry.date).toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' })}
              </span>
            </div>
            <ul style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4, fontSize: 13, color: 'var(--text2)' }}>
              {entry.notes.map((note, i) => <li key={i}>{note}</li>)}
            </ul>
          </div>
        ))}
        {!changelog.length && (
          <div style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีประวัติการอัปเดต</div>
        )}
      </div>
    </div>
  )
}
