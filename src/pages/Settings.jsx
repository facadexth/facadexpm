import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { useAppSetting, saveAppSetting, useContractorTypes } from '../hooks/useSupabase.js'
import { useTenant } from '../hooks/useTenant.js'
import { PAGE_LABELS, DEFAULT_PERMISSIONS, loadPermissions, savePermissions } from '../lib/permissions.js'
import PackageComparison from '../components/PackageComparison.jsx'

const LEVEL_LABELS = { none: '🚫 ซ่อน', view: '👁️ ดูอย่างเดียว', edit: '✏️ แก้ไขได้' }

export default function Settings({ onOpenChangePassword, onOpenChangePlan }) {
  const [permissions, setPermissions] = useState(DEFAULT_PERMISSIONS)
  const [saving, setSaving] = useState(false)

  // Travel rate (baht/km) — stored in app_settings
  const { data: travelRateVal, refetch: refetchRate } = useAppSetting('travel_rate_per_km', '20')
  const [travelRate, setTravelRate] = useState('')
  const [savingRate, setSavingRate] = useState(false)
  useEffect(() => { if (travelRateVal != null) setTravelRate(String(travelRateVal)) }, [travelRateVal])

  const handleSaveRate = async () => {
    setSavingRate(true)
    try {
      await saveAppSetting('travel_rate_per_km', parseFloat(travelRate) || 0)
      refetchRate()
      alert('✅ บันทึกค่าเดินทางแล้ว')
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSavingRate(false)
    }
  }

  // Contractor type — stored on tenants.contractor_type_id
  const { tenant, refetch: refetchTenant } = useTenant()
  const { data: contractorTypes } = useContractorTypes()
  const [contractorTypeId, setContractorTypeId] = useState('')
  const [savingType, setSavingType] = useState(false)
  useEffect(() => { if (tenant) setContractorTypeId(tenant.contractor_type_id || '') }, [tenant])

  const handleSaveContractorType = async () => {
    setSavingType(true)
    try {
      const { error } = await supabase
        .from('tenants')
        .update({ contractor_type_id: contractorTypeId || null })
        .eq('id', tenant.id)
      if (error) throw error
      refetchTenant()
      alert('✅ บันทึกประเภทผู้รับเหมาแล้ว')
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSavingType(false)
    }
  }

  // Company profile — for the Quotation PDF letterhead (and future
  // Invoice). See docs/superpowers/specs/2026-08-22-quotation-module-design.md.
  const [profile, setProfile] = useState({
    company_name: '', address: '', tax_id: '', phone: '', bank_name: '', bank_account_name: '', bank_account_no: '',
    default_payment_terms: '', default_notes: '',
  })
  const [savingProfile, setSavingProfile] = useState(false)
  const [uploadingLogo, setUploadingLogo] = useState(false)
  useEffect(() => {
    if (tenant) {
      setProfile({
        company_name: tenant.company_name || '', address: tenant.address || '', tax_id: tenant.tax_id || '', phone: tenant.phone || '',
        bank_name: tenant.bank_name || '', bank_account_name: tenant.bank_account_name || '', bank_account_no: tenant.bank_account_no || '',
        default_payment_terms: tenant.default_payment_terms || '', default_notes: tenant.default_notes || '',
      })
    }
  }, [tenant])
  const setProfileField = (k, v) => setProfile(p => ({ ...p, [k]: v }))

  const handleSaveProfile = async () => {
    setSavingProfile(true)
    try {
      const { error } = await supabase.from('tenants').update(profile).eq('id', tenant.id)
      if (error) throw error
      refetchTenant()
      alert('✅ บันทึกข้อมูลบริษัทแล้ว')
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSavingProfile(false)
    }
  }

  const handleUploadLogo = async (file) => {
    if (!file || !tenant) return
    setUploadingLogo(true)
    try {
      const ext = file.name.split('.').pop()
      const path = `${tenant.id}/logo.${ext}`
      const { error: uploadError } = await supabase.storage.from('tenant-logos').upload(path, file, { upsert: true })
      if (uploadError) throw uploadError
      const { data: urlData } = supabase.storage.from('tenant-logos').getPublicUrl(path)
      const { error: updateError } = await supabase.from('tenants').update({ logo_url: urlData.publicUrl }).eq('id', tenant.id)
      if (updateError) throw updateError
      refetchTenant()
      alert('✅ อัปโหลดโลโก้แล้ว')
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setUploadingLogo(false)
    }
  }

  // Load permissions from localStorage (auto-upgrades legacy boolean format)
  useEffect(() => {
    setPermissions(loadPermissions())
  }, [])

  const setLevel = (role, page, level) => {
    setPermissions(prev => ({
      ...prev,
      [role]: {
        ...prev[role],
        [page]: level,
      }
    }))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      // Save to localStorage (could also save to Supabase if needed)
      savePermissions(permissions)
      alert('✅ บันทึกตั้งค่าสำเร็จ')
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleReset = () => {
    if (confirm('รีเซ็ตเป็นค่าเริ่มต้น?')) {
      setPermissions(DEFAULT_PERMISSIONS)
    }
  }

  return (
    <div>
      {/* ── บัญชีผู้ใช้ ── */}
      <div className="card" style={{ marginBottom: 24, padding: '16px 20px' }}>
        <h2 style={{ marginBottom: 4, fontSize: 16, fontWeight: 700 }}>👤 บัญชีผู้ใช้</h2>
        <p style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 12 }}>
          จัดการรหัสผ่านสำหรับเข้าสู่ระบบของคุณ
        </p>
        <button className="btn btn-ghost" onClick={onOpenChangePassword}>🔑 เปลี่ยนรหัสผ่าน</button>
      </div>

      <div className="card" style={{ marginBottom: 24, padding: '16px 20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tenant?.pending_package_id ? 8 : 0, flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h2 style={{ marginBottom: 4, fontSize: 16, fontWeight: 700 }}>💎 แพ็กเกจของคุณ</h2>
            <p style={{ fontSize: 13, color: 'var(--text3)' }}>อัปเกรด/ดาวน์เกรดแพ็กเกจปัจจุบัน</p>
          </div>
          {tenant?.plan === 'active' && (
            <button className="btn btn-ghost" onClick={onOpenChangePlan}>เปลี่ยนแพ็กเกจ</button>
          )}
        </div>
        {tenant?.pending_package_id && (
          <div className="alert" style={{ fontSize: 13 }}>
            มีการกำหนดเปลี่ยนแพ็กเกจไว้แล้ว — คลิก "เปลี่ยนแพ็กเกจ" เพื่อดูรายละเอียดหรือยกเลิก
          </div>
        )}
      </div>

      <PackageComparison currentPackageId={tenant?.package_id} />

      {/* ── ค่าเดินทาง ── */}
      <div className="card" style={{ marginBottom: 24, padding: '16px 20px' }}>
        <h2 style={{ marginBottom: 4, fontSize: 16, fontWeight: 700 }}>🚗 ค่าเดินทางต่อไซท์</h2>
        <p style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 12 }}>
          ใช้คิดค่าเดินทาง = ระยะทางไซท์ (กม.) × 2 (ไป-กลับ) × เรทนี้ ต่อวันที่มีงานที่ไซท์
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <label className="label">เรทค่าเดินทาง (บาท/กม.)</label>
            <input type="number" className="input" min="0" step="0.5" style={{ width: 160 }}
              value={travelRate} onChange={e => setTravelRate(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={handleSaveRate} disabled={savingRate}>
            {savingRate ? '⏳ กำลังบันทึก...' : '✅ บันทึกเรท'}
          </button>
        </div>
      </div>

      {/* ── ประเภทผู้รับเหมา ── */}
      <div className="card" style={{ marginBottom: 24, padding: '16px 20px' }}>
        <h2 style={{ marginBottom: 4, fontSize: 16, fontWeight: 700 }}>🏗️ ประเภทผู้รับเหมา</h2>
        <p style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 12 }}>
          เปลี่ยนได้ตลอด — ไม่กระทบหมวดค่าใช้จ่ายหรือ supplier ที่มีอยู่แล้ว
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <label className="label">ประเภทผู้รับเหมา</label>
            <select
              className="input" style={{ width: 240 }}
              value={contractorTypeId} onChange={e => setContractorTypeId(e.target.value)}
            >
              <option value="">— ไม่ระบุ —</option>
              {(contractorTypes || []).map(t => (
                <option key={t.id} value={t.id}>{t.label_th}</option>
              ))}
            </select>
          </div>
          <button className="btn btn-primary" onClick={handleSaveContractorType} disabled={savingType || !tenant}>
            {savingType ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header"><div className="card-title">🏢 ข้อมูลบริษัท (สำหรับใบเสนอราคา)</div></div>
        <div className="card-body" style={{ display: 'grid', gap: 12 }}>
          <div>
            <label className="label">ชื่อบริษัท ★</label>
            <input className="input" required value={profile.company_name} onChange={e => setProfileField('company_name', e.target.value)} />
          </div>
          <div>
            <label className="label">โลโก้บริษัท</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {tenant?.logo_url && <img src={tenant.logo_url} alt="" style={{ height: 40 }} />}
              <input type="file" accept="image/*" disabled={uploadingLogo} onChange={e => handleUploadLogo(e.target.files?.[0])} />
              {uploadingLogo && <span style={{ fontSize: 12, color: 'var(--text3)' }}>⏳ กำลังอัปโหลด...</span>}
            </div>
          </div>
          <div className="form-grid-2">
            <div>
              <label className="label">ที่อยู่บริษัท</label>
              <input className="input" value={profile.address} onChange={e => setProfileField('address', e.target.value)} />
            </div>
            <div>
              <label className="label">เลขประจำตัวผู้เสียภาษี</label>
              <input className="input" value={profile.tax_id} onChange={e => setProfileField('tax_id', e.target.value)} />
            </div>
          </div>
          <div>
            <label className="label">เบอร์โทร</label>
            <input className="input" style={{ maxWidth: 240 }} value={profile.phone} onChange={e => setProfileField('phone', e.target.value)} />
          </div>
          <div className="form-grid-2">
            <div>
              <label className="label">ธนาคาร</label>
              <input className="input" value={profile.bank_name} onChange={e => setProfileField('bank_name', e.target.value)} />
            </div>
            <div>
              <label className="label">ชื่อบัญชี</label>
              <input className="input" value={profile.bank_account_name} onChange={e => setProfileField('bank_account_name', e.target.value)} />
            </div>
          </div>
          <div>
            <label className="label">เลขที่บัญชี</label>
            <input className="input" style={{ maxWidth: 240 }} value={profile.bank_account_no} onChange={e => setProfileField('bank_account_no', e.target.value)} />
          </div>
          <div>
            <label className="label">เงื่อนไขการชำระเงิน (ค่าเริ่มต้นสำหรับใบเสนอราคาใหม่)</label>
            <textarea className="textarea" rows={4} value={profile.default_payment_terms}
              onChange={e => setProfileField('default_payment_terms', e.target.value)}
              placeholder={'เช่น\n1. มัดจำก่อนเริ่มงาน 30%\n2. ส่วนที่เหลือแบ่งจ่ายตาม Progress งาน\n3. ราคานี้รวมค่าวัสดุ ค่าแรง และค่าทำความสะอาดสุดท้าย 1 รอบ'} />
          </div>
          <div>
            <label className="label">หมายเหตุ (ค่าเริ่มต้นสำหรับใบเสนอราคาใหม่)</label>
            <textarea className="textarea" rows={4} value={profile.default_notes}
              onChange={e => setProfileField('default_notes', e.target.value)}
              placeholder={'เช่น\n1. ไม่รวมนั่งร้าน\n2. รับประกันสินค้าที่เสียหาย 1 ปี นับจากวันส่งมอบ\n3. กำหนดยืนราคา 60 วัน'} />
          </div>
          <div>
            <button className="btn btn-primary" onClick={handleSaveProfile} disabled={savingProfile}>
              {savingProfile ? '⏳...' : '✅ บันทึกข้อมูลบริษัท'}
            </button>
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 24 }}>
        <h2 style={{ marginBottom: 8, fontSize: 18, fontWeight: 700 }}>⚙️ ตั้งค่าสิทธิ์เข้าใช้งาน</h2>
        <p style={{ fontSize: 13, color: 'var(--text3)' }}>
          เลือกระดับการเข้าใช้งานแต่ละหน้าต่อ Role — ซ่อน / ดูอย่างเดียว (เข้าดูได้แต่แก้ไข-เพิ่มไม่ได้) / แก้ไขได้เต็มสิทธิ์
        </p>
      </div>

      <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'repeat(auto-fit, minmax(350px, 1fr))' }}>
        {['WORKER', 'ADMIN', 'OWNER'].map(role => (
          <div key={role} className="card" style={{
            borderTop: role === 'OWNER' ? '3px solid var(--red)' : role === 'ADMIN' ? '3px solid var(--accent)' : '3px solid var(--green)',
          }}>
            <div style={{
              padding: '12px 16px',
              background: role === 'OWNER' ? 'rgba(255,107,107,0.1)' : role === 'ADMIN' ? 'rgba(108,99,255,0.1)' : 'rgba(0,212,170,0.1)',
              borderBottom: '1px solid var(--border)',
            }}>
              <h3 style={{
                margin: 0,
                fontSize: 16,
                fontWeight: 700,
                color: role === 'OWNER' ? 'var(--red)' : role === 'ADMIN' ? 'var(--accent)' : 'var(--green)',
              }}>
                {role}
              </h3>
            </div>

            <div style={{ padding: '16px' }}>
              <div style={{ display: 'grid', gap: 10 }}>
                {Object.entries(permissions[role]).map(([page, level]) => (
                  <div key={page} style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    padding: '8px',
                    borderRadius: 6,
                  }}>
                    <span style={{ fontSize: 13, color: 'var(--text2)', fontWeight: 500 }}>
                      {PAGE_LABELS[page]}
                    </span>
                    <select
                      className="select select-sm"
                      style={{ width: 150 }}
                      value={level}
                      onChange={e => setLevel(role, page, e.target.value)}
                    >
                      {Object.entries(LEVEL_LABELS).map(([val, lbl]) => (
                        <option key={val} value={val}>{lbl}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 24, justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={handleReset}>
          🔄 รีเซ็ตค่าเริ่มต้น
        </button>
        <button
          className="btn btn-primary"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? '⏳ กำลังบันทึก...' : '✅ บันทึกตั้งค่า'}
        </button>
      </div>
    </div>
  )
}
