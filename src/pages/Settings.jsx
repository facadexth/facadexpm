import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { useAppSetting, saveAppSetting, useContractorTypes, useMySignature, useMySignatureUrl, saveMySignature, deleteMySignature, useBankAccounts, setDefaultBankAccount } from '../hooks/useSupabase.js'
import { useTenant } from '../hooks/useTenant.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { PAGE_LABELS, DEFAULT_PERMISSIONS, loadPermissions, savePermissions } from '../lib/permissions.js'
import { THAI_BANKS } from '../lib/thaiBanks.js'
import PackageComparison from '../components/PackageComparison.jsx'
import SignaturePad from '../components/SignaturePad.jsx'
import { DEFAULT_DOCUMENT_STYLE, resolveDocumentStyle } from '../lib/documentStyle.js'
import { QuotationPaper } from './Quotations.jsx'

const VAT_CATEGORY_LABELS = { vat: 'บัญชี VAT', non_vat: 'บัญชีไม่มี VAT' }

const LEVEL_LABELS = { none: '🚫 ซ่อน', view: '👁️ ดูอย่างเดียว', edit: '✏️ แก้ไขได้' }

// Placeholder document content for the document-style live preview -- NOT
// real tenant data. The tenant's real company_name/logo_url/etc. ARE used
// (via the real `tenant` object passed to QuotationPaper below), but the
// client/items/document-number are fake so the preview doesn't depend on
// the tenant having any real quotations.
const DOC_STYLE_PREVIEW_SAMPLE = {
  quotationNumber: 'QT-2026-000',
  date: new Date().toISOString().slice(0, 10),
  validUntil: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
  revision: 1,
  siteName: 'ตัวอย่างโครงการ',
  clientName: 'บริษัท ตัวอย่าง จำกัด',
  clientAddress: '123 ถนนตัวอย่าง แขวงตัวอย่าง เขตตัวอย่าง กรุงเทพมหานคร 10110',
  clientTaxId: '0000000000000',
  items: [
    { id: 'preview-1', description: 'งานติดตั้งระแนงอลูมิเนียม (ตัวอย่าง)', unit: 'ตร.ม.', quantity: 50, unit_price: 850, line_total: 42500 },
    { id: 'preview-2', description: 'งานสีกันสนิมโครงเหล็ก (ตัวอย่าง)', unit: 'ตร.ม.', quantity: 20, unit_price: 320, line_total: 6400 },
  ],
  hasVat: true,
  priceIncludesVat: false,
  paymentTerms: 'ตัวอย่างเงื่อนไขการชำระเงิน: มัดจำ 50% ก่อนเริ่มงาน ส่วนที่เหลือชำระเมื่องานเสร็จ',
  notes: null,
  bankAccount: null,
  clientSignature: null,
}

export default function Settings({ onOpenChangePassword, onOpenChangePlan }) {
  // This tab is now reachable by every role (src/App.jsx's minRole:'WORKER'
  // gate on 'settings') -- everything below the password card is filtered
  // by role right here instead: WORKER sees only the password card, ADMIN
  // additionally sees the signature card, OWNER sees the rest of the page
  // unchanged. Nothing here is a security boundary on its own (same caveat
  // as src/lib/permissions.js) -- the actual writes below are still bound
  // by each table's own RLS policy (e.g. owner_updates_own_tenant), so a
  // WORKER granted a wider view here still can't persist an OWNER-only
  // change.
  const { isAtLeast } = useUserRole()
  const [permissions, setPermissions] = useState(DEFAULT_PERMISSIONS)
  const [saving, setSaving] = useState(false)

  // บัญชีธนาคาร -- แยก VAT/ไม่มี VAT ต่อบัญชี ตั้ง default ได้ต่อหมวด ใช้เลือก
  // ในใบเสนอราคา/ใบแจ้งหนี้ (กรองตาม has_vat ของเอกสารนั้นๆ)
  const { data: bankAccounts, refetch: refetchBankAccounts } = useBankAccounts()
  const [addingBank, setAddingBank] = useState(false)
  const [newBank, setNewBank] = useState({ bank_name: THAI_BANKS[0], account_name: '', account_no: '', vat_category: 'vat' })
  const [savingBank, setSavingBank] = useState(false)

  const handleAddBankAccount = async () => {
    if (!newBank.account_name.trim() || !newBank.account_no.trim()) { alert('กรอกชื่อบัญชีและเลขที่บัญชี'); return }
    setSavingBank(true)
    try {
      const isFirstInCategory = !(bankAccounts || []).some(a => a.vat_category === newBank.vat_category)
      const { error } = await supabase.from('bank_accounts').insert({
        tenant_id: tenant.id, ...newBank, is_default: isFirstInCategory,
      })
      if (error) throw error
      setNewBank({ bank_name: THAI_BANKS[0], account_name: '', account_no: '', vat_category: 'vat' })
      setAddingBank(false)
      refetchBankAccounts()
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSavingBank(false) }
  }

  const handleSetDefaultBank = async (account) => {
    try {
      await setDefaultBankAccount(tenant.id, account.id, account.vat_category)
      refetchBankAccounts()
    } catch (e) { alert('Error: ' + e.message) }
  }

  const handleDeleteBankAccount = async (id) => {
    if (!confirm('ลบบัญชีนี้?')) return
    const { error } = await supabase.from('bank_accounts').delete().eq('id', id)
    if (error) { alert('Error: ' + error.message); return }
    refetchBankAccounts()
  }

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

  // จำนวนวันล่วงหน้าที่จะเตือนให้เตรียมเงินในบัญชีก่อนเช็คครบกำหนด --
  // ใช้คำนวณการ์ด "เตรียมเงินจ่ายเช็ค" ในหน้าภาพรวม (Dashboard.jsx)
  const { data: chequeReminderDaysVal, refetch: refetchChequeReminderDays } = useAppSetting('cheque_reminder_days', '3')
  const [chequeReminderDays, setChequeReminderDays] = useState('')
  const [savingChequeReminderDays, setSavingChequeReminderDays] = useState(false)
  useEffect(() => { if (chequeReminderDaysVal != null) setChequeReminderDays(String(chequeReminderDaysVal)) }, [chequeReminderDaysVal])

  const handleSaveChequeReminderDays = async () => {
    setSavingChequeReminderDays(true)
    try {
      await saveAppSetting('cheque_reminder_days', parseInt(chequeReminderDays, 10) || 0)
      refetchChequeReminderDays()
      alert('✅ บันทึกการแจ้งเตือนแล้ว')
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSavingChequeReminderDays(false)
    }
  }

  // เปิด/ปิดวิธีเซ็นรับเอกสาร (เช่นเช็ค) แยกกันสองแบบ -- เซ็นต่อหน้า (ส่งต่อ
  // อุปกรณ์ให้เซ็นเอง) กับเซ็นผ่านลิงก์ระยะไกล เก็บใน app_settings ค่า
  // default = เปิดทั้งคู่ (ค่าที่ยังไม่เคยตั้งถือว่า "true") -- Cheques.jsx
  // อ่านค่านี้ไปซ่อน/แสดงปุ่มแต่ละแบบ
  const { data: signPhysicalVal, refetch: refetchSignPhysical } = useAppSetting('sign_physical_enabled', 'true')
  const { data: signDigitalVal, refetch: refetchSignDigital } = useAppSetting('sign_digital_enabled', 'true')
  const [savingSignMethods, setSavingSignMethods] = useState(false)
  const signPhysicalEnabled = signPhysicalVal !== 'false'
  const signDigitalEnabled = signDigitalVal !== 'false'

  const handleToggleSignMethod = async (key, currentEnabled, refetch) => {
    setSavingSignMethods(true)
    try {
      await saveAppSetting(key, String(!currentEnabled))
      refetch()
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSavingSignMethods(false)
    }
  }

  // เช็คอิน/เช็คเอาท์ตำแหน่งที่ตั้ง -- ระยะที่ยอมให้เช็คอินได้ (เมตร) และเวลา
  // เลิกงานปกติ (ใช้ตัดสินว่าการเช็คเอาท์หลังจากนี้นับเป็น OT หรือไม่)
  const { data: checkinRadiusVal, refetch: refetchCheckinRadius } = useAppSetting('checkin_radius_m', '200')
  const { data: shiftEndVal, refetch: refetchShiftEnd } = useAppSetting('regular_shift_end_time', '17:00')
  const [checkinRadius, setCheckinRadius] = useState('')
  const [shiftEnd, setShiftEnd] = useState('')
  const [savingCheckin, setSavingCheckin] = useState(false)
  useEffect(() => { if (checkinRadiusVal != null) setCheckinRadius(String(checkinRadiusVal)) }, [checkinRadiusVal])
  useEffect(() => { if (shiftEndVal != null) setShiftEnd(String(shiftEndVal)) }, [shiftEndVal])

  const handleSaveCheckinSettings = async () => {
    // ตรวจก่อนบันทึกจริง -- เดิมใช้ `parseFloat(...) || 200` ซึ่งทำให้ค่า 0
    // (หรือค่าที่แปลงไม่ได้) กลายเป็น 200 เงียบๆ พร้อมข้อความว่าบันทึกสำเร็จ
    // และ min="10" บน input ก็ไม่ถูกบังคับตอน submit
    const radius = parseFloat(checkinRadius)
    if (Number.isNaN(radius) || radius < 10) {
      alert('ระยะต้องมีค่าอย่างน้อย 10 เมตร')
      return
    }
    setSavingCheckin(true)
    try {
      await saveAppSetting('checkin_radius_m', radius)
      await saveAppSetting('regular_shift_end_time', shiftEnd || '17:00')
      refetchCheckinRadius(); refetchShiftEnd()
      alert('✅ บันทึกการตั้งค่าเช็คอินแล้ว')
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSavingCheckin(false)
    }
  }

  // Contractor type — stored on tenants.contractor_type_id
  const { tenant, hasModuleAccess, refetch: refetchTenant } = useTenant()

  // Document style customizer -- resolveDocumentStyle always returns a
  // fully-populated object, so local state always starts fully populated.
  // The useEffect below re-syncs local state when the PERSISTED value
  // actually changes (e.g. after this card's own Save/Reset calls
  // refetchTenant()) -- keyed on a stringified comparison, not
  // `tenant?.document_style` object identity, because useTenant()
  // re-parses JSON on every fetch (a new object even when the underlying
  // value is unchanged), and OTHER saves on this same page (company
  // profile, logo upload) also call refetchTenant(). Keying on identity
  // would silently wipe any in-progress (unsaved) slider edits every time
  // an OWNER saved something unrelated elsewhere on this page.
  const [docStyle, setDocStyle] = useState(() => resolveDocumentStyle(tenant?.document_style))
  const [savingDocStyle, setSavingDocStyle] = useState(false)
  const tenantStyleKey = JSON.stringify(tenant?.document_style)
  useEffect(() => {
    setDocStyle(resolveDocumentStyle(tenant?.document_style))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantStyleKey])
  const setDocStyleField = (k, v) => setDocStyle(s => ({ ...s, [k]: v }))

  const handleSaveDocStyle = async () => {
    setSavingDocStyle(true)
    try {
      const { error } = await supabase.from('tenants').update({ document_style: docStyle }).eq('id', tenant.id)
      if (error) throw error
      refetchTenant()
      alert('✅ บันทึกรูปแบบเอกสารแล้ว')
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSavingDocStyle(false)
    }
  }

  const handleResetDocStyle = async () => {
    setSavingDocStyle(true)
    try {
      const { error } = await supabase.from('tenants').update({ document_style: null }).eq('id', tenant.id)
      if (error) throw error
      refetchTenant()
      setDocStyle(DEFAULT_DOCUMENT_STYLE)
      alert('✅ คืนค่าเริ่มต้นแล้ว')
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSavingDocStyle(false)
    }
  }

  // ลายเซ็นส่วนตัว -- วาดครั้งเดียว เอาไปแปะอัตโนมัติในช่องลายเซ็นฝั่งพนักงาน
  // ของทุกเอกสารที่เปิดดู/พิมพ์จากบัญชีนี้ (ดู useMySignatureUrl ใน
  // useSupabase.js) ทุก role เข้าถึงได้ ไม่ใช่แค่ ADMIN/OWNER -- เป็นลายเซ็น
  // ของตัวเอง ไม่ใช่การกระทำแทนคนอื่น
  const { data: mySignature, refetch: refetchMySignature } = useMySignature()
  const mySignatureUrl = useMySignatureUrl()
  const [signatureDraft, setSignatureDraft] = useState(null)
  const [savingSignature, setSavingSignature] = useState(false)
  const [signaturePadKey, setSignaturePadKey] = useState(0)

  const handleSaveMySignature = async () => {
    if (!signatureDraft || !tenant) return
    setSavingSignature(true)
    try {
      await saveMySignature(tenant.id, signatureDraft)
      setSignatureDraft(null)
      setSignaturePadKey(k => k + 1)
      refetchMySignature()
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSavingSignature(false)
    }
  }

  const handleDeleteMySignature = async () => {
    if (!mySignature || !confirm('ลบลายเซ็นของฉัน?')) return
    try {
      await deleteMySignature(mySignature)
      refetchMySignature()
    } catch (e) {
      alert('Error: ' + e.message)
    }
  }

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
    company_name: '', address: '', tax_id: '', phone: '', email: '', website: '',
    default_payment_terms: '', default_notes: '',
  })
  const [savingProfile, setSavingProfile] = useState(false)
  const [uploadingLogo, setUploadingLogo] = useState(false)
  useEffect(() => {
    if (tenant) {
      setProfile({
        company_name: tenant.company_name || '', address: tenant.address || '', tax_id: tenant.tax_id || '', phone: tenant.phone || '', email: tenant.email || '', website: tenant.website || '',
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

      {isAtLeast('OWNER') && <>
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

      {/* ── แจ้งเตือนเช็คใกล้ครบกำหนด ── */}
      {hasModuleAccess('cheque_tracking') && (
        <div className="card" style={{ marginBottom: 24, padding: '16px 20px' }}>
          <h2 style={{ marginBottom: 4, fontSize: 16, fontWeight: 700 }}>🏦 แจ้งเตือนเช็คใกล้ครบกำหนด</h2>
          <p style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 12 }}>
            การ์ด "เตรียมเงินจ่ายเช็ค" ในหน้าภาพรวมจะขึ้นเมื่อมีเช็คที่ยังไม่ขึ้นเงิน ครบกำหนดภายในกี่วันข้างหน้า
          </p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <label className="label">แจ้งเตือนล่วงหน้า (วัน)</label>
              <input type="number" className="input" min="0" step="1" style={{ width: 160 }}
                value={chequeReminderDays} onChange={e => setChequeReminderDays(e.target.value)} />
            </div>
            <button className="btn btn-primary" onClick={handleSaveChequeReminderDays} disabled={savingChequeReminderDays}>
              {savingChequeReminderDays ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}
            </button>
          </div>
        </div>
      )}

      {/* ── วิธีเซ็นรับเอกสาร ── */}
      {hasModuleAccess('cheque_tracking') && (
        <div className="card" style={{ marginBottom: 24, padding: '16px 20px' }}>
          <h2 style={{ marginBottom: 4, fontSize: 16, fontWeight: 700 }}>✍️ วิธีเซ็นรับเอกสาร</h2>
          <p style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 12 }}>
            เลือกวิธีเซ็นรับที่จะให้ใช้ได้ในหน้าเช็ค — ปิดวิธีไหนไว้ ปุ่มนั้นจะหายไปจากหน้าเช็ค
          </p>
          <div style={{ display: 'grid', gap: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={signPhysicalEnabled} disabled={savingSignMethods}
                onChange={() => handleToggleSignMethod('sign_physical_enabled', signPhysicalEnabled, refetchSignPhysical)} />
              🖊️ เซ็นต่อหน้า — ส่งต่ออุปกรณ์ (มือถือ/แท็บเล็ต/แล็ปท็อป) ให้เซ็นตรงนั้นเลย
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={signDigitalEnabled} disabled={savingSignMethods}
                onChange={() => handleToggleSignMethod('sign_digital_enabled', signDigitalEnabled, refetchSignDigital)} />
              🔗 เซ็นผ่านลิงก์ — ส่งลิงก์ให้เซ็นจากอุปกรณ์ของตัวเอง ไม่ต้องเจอหน้ากัน
            </label>
          </div>
        </div>
      )}

      {/* ── เช็คอินตำแหน่งที่ตั้ง ── */}
      <div className="card" style={{ marginBottom: 24, padding: '16px 20px' }}>
        <h2 style={{ marginBottom: 4, fontSize: 16, fontWeight: 700 }}>📍 เช็คอิน/เช็คเอาท์ตำแหน่งที่ตั้ง</h2>
        <p style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 12 }}>
          พนักงานต้องอยู่ในระยะที่กำหนดจากไซท์งานจึงจะเช็คอินได้ — งานปกติเช็คอินอย่างเดียวก็ยืนยันแล้ว ส่วน OT ต้องเช็คเอาท์หลังเวลาเลิกงานปกติด้วย
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <label className="label">ระยะที่ยอมให้เช็คอิน (เมตร)</label>
            <input type="number" className="input" min="10" step="10" style={{ width: 160 }}
              value={checkinRadius} onChange={e => setCheckinRadius(e.target.value)} />
          </div>
          <div>
            <label className="label">เวลาเลิกงานปกติ (ใช้ตัดสิน OT)</label>
            <input type="time" className="input" style={{ width: 160 }}
              value={shiftEnd} onChange={e => setShiftEnd(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={handleSaveCheckinSettings} disabled={savingCheckin}>
            {savingCheckin ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}
          </button>
        </div>
      </div>
      </>}

      {/* ── ลายเซ็นของฉัน -- ADMIN ขึ้นไป (WORKER เห็นแค่การ์ดรหัสผ่านด้านบน) ── */}
      {isAtLeast('ADMIN') && <>
      <div className="card" style={{ marginBottom: 24, padding: '16px 20px' }}>
        <h2 style={{ marginBottom: 4, fontSize: 16, fontWeight: 700 }}>🖊️ ลายเซ็นของฉัน</h2>
        <p style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 12 }}>
          วาดลายเซ็นเก็บไว้ครั้งเดียว ระบบจะเอาไปแปะอัตโนมัติในช่องลายเซ็นฝั่งพนักงานของทุกเอกสารที่คุณเปิดดู/พิมพ์ (เช่น ผู้เสนอราคา, ผู้ออกใบแจ้งหนี้, ผู้จัดทำ)
        </p>
        {mySignature && mySignatureUrl ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <img src={mySignatureUrl.url} alt="ลายเซ็นของฉัน" style={{ height: 60, background: '#fff', border: '1px solid var(--border)', borderRadius: 6, padding: 4 }} />
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>บันทึกล่าสุด {new Date(mySignature.updated_at).toLocaleDateString('th-TH')}</div>
            <button className="btn btn-sm btn-danger" onClick={handleDeleteMySignature}>ลบลายเซ็น</button>
          </div>
        ) : (
          <div style={{ maxWidth: 420 }}>
            <SignaturePad key={signaturePadKey} onChange={setSignatureDraft} height={140} />
            <button className="btn btn-primary btn-sm" style={{ marginTop: 8 }} disabled={!signatureDraft || savingSignature} onClick={handleSaveMySignature}>
              {savingSignature ? '⏳ กำลังบันทึก...' : '✅ บันทึกลายเซ็น'}
            </button>
          </div>
        )}
      </div>
      </>}

      {isAtLeast('OWNER') && <>
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
              <label className="label">อีเมล</label>
              <input className="input" type="email" value={profile.email} onChange={e => setProfileField('email', e.target.value)} />
            </div>
            <div>
              <label className="label">เว็บไซต์</label>
              <input className="input" value={profile.website} onChange={e => setProfileField('website', e.target.value)} placeholder="www.example.com" />
            </div>
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

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header"><div className="card-title">🎨 รูปแบบเอกสาร (ใบเสนอราคา/ใบแจ้งหนี้/ใบเสร็จ)</div></div>
        <div className="card-body" style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 20, alignItems: 'start' }}>
          <div style={{ display: 'grid', gap: 10 }}>
            <div>
              <label className="label">สีหลัก (Accent)</label>
              <input type="color" value={docStyle.accent} onChange={e => setDocStyleField('accent', e.target.value)} style={{ width: '100%', height: 32 }} />
            </div>

            <div className="label" style={{ marginTop: 8 }}>หน้ากระดาษ</div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ระยะขอบบน-ล่าง</span><span>{docStyle.pagePaddingV}px</span></label>
              <input type="range" min="16" max="64" value={docStyle.pagePaddingV} onChange={e => setDocStyleField('pagePaddingV', Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ระยะขอบซ้าย-ขวา</span><span>{docStyle.pagePaddingH}px</span></label>
              <input type="range" min="16" max="64" value={docStyle.pagePaddingH} onChange={e => setDocStyleField('pagePaddingH', Number(e.target.value))} style={{ width: '100%' }} />
            </div>

            <div className="label" style={{ marginTop: 8 }}>โลโก้</div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ความกว้าง</span><span>{docStyle.logoWidth}px</span></label>
              <input type="range" min="40" max="160" value={docStyle.logoWidth} onChange={e => setDocStyleField('logoWidth', Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ความสูงสูงสุด</span><span>{docStyle.logoMaxHeight}px</span></label>
              <input type="range" min="24" max="140" value={docStyle.logoMaxHeight} onChange={e => setDocStyleField('logoMaxHeight', Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ระยะห่างจากข้อความ</span><span>{docStyle.logoGap}px</span></label>
              <input type="range" min="0" max="30" value={docStyle.logoGap} onChange={e => setDocStyleField('logoGap', Number(e.target.value))} style={{ width: '100%' }} />
            </div>

            <div className="label" style={{ marginTop: 8 }}>ขนาดตัวอักษร</div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ชื่อบริษัท</span><span>{docStyle.nameSize}px</span></label>
              <input type="range" min="12" max="30" value={docStyle.nameSize} onChange={e => setDocStyleField('nameSize', Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ที่อยู่/ติดต่อ</span><span>{docStyle.addressSize}px</span></label>
              <input type="range" min="8" max="16" value={docStyle.addressSize} onChange={e => setDocStyleField('addressSize', Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>หัวเอกสาร (เช่น "ใบเสนอราคา")</span><span>{docStyle.titleSize}px</span></label>
              <input type="range" min="14" max="40" value={docStyle.titleSize} onChange={e => setDocStyleField('titleSize', Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ตาราง/กล่องข้อมูล</span><span>{docStyle.infoSize}px</span></label>
              <input type="range" min="9" max="16" value={docStyle.infoSize} onChange={e => setDocStyleField('infoSize', Number(e.target.value))} style={{ width: '100%' }} />
            </div>

            <div className="label" style={{ marginTop: 8 }}>ระยะห่าง</div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>แถวหัวเอกสาร</span><span>{docStyle.headerRowGap}px</span></label>
              <input type="range" min="6" max="48" value={docStyle.headerRowGap} onChange={e => setDocStyleField('headerRowGap', Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ที่อยู่ → ติดต่อ</span><span>{docStyle.contactLineGap}px</span></label>
              <input type="range" min="0" max="24" value={docStyle.contactLineGap} onChange={e => setDocStyleField('contactLineGap', Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>กล่องข้อมูลลูกค้า → เอกสาร</span><span>{docStyle.clientInfoOffset}px / {docStyle.docInfoBoxOffset}px</span></label>
              <input type="range" min="0" max="48" value={docStyle.clientInfoOffset} onChange={e => setDocStyleField('clientInfoOffset', Number(e.target.value))} style={{ width: '100%' }} />
              <input type="range" min="0" max="48" value={docStyle.docInfoBoxOffset} onChange={e => setDocStyleField('docInfoBoxOffset', Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>หัวเอกสาร → ตารางรายการ</span><span>{docStyle.tableMarginTop}px</span></label>
              <input type="range" min="6" max="48" value={docStyle.tableMarginTop} onChange={e => setDocStyleField('tableMarginTop', Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>สัดส่วนคอลัมน์ (ลูกค้า)</span><span>{docStyle.splitRatioClient}%</span></label>
              <input type="range" min="40" max="80" value={docStyle.splitRatioClient} onChange={e => setDocStyleField('splitRatioClient', Number(e.target.value))} style={{ width: '100%' }} />
            </div>

            <div className="label" style={{ marginTop: 8 }}>หัวตารางรายการ</div>
            <div>
              <label className="label">สีพื้นหลัง</label>
              <input type="color" value={docStyle.tableHeaderBg} onChange={e => setDocStyleField('tableHeaderBg', e.target.value)} style={{ width: '100%', height: 28 }} />
            </div>
            <div>
              <label className="label">สีตัวอักษร</label>
              <input type="color" value={docStyle.tableHeaderColor} onChange={e => setDocStyleField('tableHeaderColor', e.target.value)} style={{ width: '100%', height: 28 }} />
            </div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ขนาดตัวอักษร</span><span>{docStyle.tableHeaderSize}px</span></label>
              <input type="range" min="8" max="16" value={docStyle.tableHeaderSize} onChange={e => setDocStyleField('tableHeaderSize', Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ระยะขอบใน</span><span>{docStyle.tableHeaderPadding}px</span></label>
              <input type="range" min="2" max="20" value={docStyle.tableHeaderPadding} onChange={e => setDocStyleField('tableHeaderPadding', Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>เส้นขอบล่าง</span><span>{docStyle.tableHeaderBorder}px</span></label>
              <input type="range" min="0" max="6" value={docStyle.tableHeaderBorder} onChange={e => setDocStyleField('tableHeaderBorder', Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={docStyle.tableHeaderBold} onChange={e => setDocStyleField('tableHeaderBold', e.target.checked)} />
              ตัวหนา
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
              <input type="checkbox" checked={docStyle.showContactIcons} onChange={e => setDocStyleField('showContactIcons', e.target.checked)} />
              แสดงข้อมูลติดต่อ (โทร/อีเมล/เว็บไซต์)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={docStyle.showRevisionSuffix} onChange={e => setDocStyleField('showRevisionSuffix', e.target.checked)} />
              แสดงเลขแก้ไข (-R2) ที่เลขที่เอกสาร
            </label>

            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="btn btn-primary" onClick={handleSaveDocStyle} disabled={savingDocStyle} style={{ flex: 1 }}>
                {savingDocStyle ? '⏳...' : '💾 บันทึก'}
              </button>
              <button className="btn btn-ghost" onClick={handleResetDocStyle} disabled={savingDocStyle}>
                ↺ คืนค่าเริ่มต้น
              </button>
            </div>
          </div>

          <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'auto', maxHeight: '80vh' }}>
            <QuotationPaper
              elementId="doc-style-preview"
              tenant={{ ...tenant, document_style: docStyle }}
              extraRemeasureKey={JSON.stringify(docStyle)}
              quotationNumber={DOC_STYLE_PREVIEW_SAMPLE.quotationNumber}
              tag="ตัวอย่าง"
              date={DOC_STYLE_PREVIEW_SAMPLE.date}
              validUntil={DOC_STYLE_PREVIEW_SAMPLE.validUntil}
              revision={DOC_STYLE_PREVIEW_SAMPLE.revision}
              siteName={DOC_STYLE_PREVIEW_SAMPLE.siteName}
              clientName={DOC_STYLE_PREVIEW_SAMPLE.clientName}
              clientAddress={DOC_STYLE_PREVIEW_SAMPLE.clientAddress}
              clientTaxId={DOC_STYLE_PREVIEW_SAMPLE.clientTaxId}
              items={DOC_STYLE_PREVIEW_SAMPLE.items}
              hasVat={DOC_STYLE_PREVIEW_SAMPLE.hasVat}
              priceIncludesVat={DOC_STYLE_PREVIEW_SAMPLE.priceIncludesVat}
              paymentTerms={DOC_STYLE_PREVIEW_SAMPLE.paymentTerms}
              notes={DOC_STYLE_PREVIEW_SAMPLE.notes}
              bankAccount={DOC_STYLE_PREVIEW_SAMPLE.bankAccount}
              clientSignature={DOC_STYLE_PREVIEW_SAMPLE.clientSignature}
            />
          </div>
        </div>
      </div>

      {/* ── บัญชีธนาคาร ── */}
      <div className="card" style={{ marginBottom: 24, padding: '16px 20px' }}>
        <h2 style={{ marginBottom: 4, fontSize: 16, fontWeight: 700 }}>🏦 บัญชีธนาคาร</h2>
        <p style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 12 }}>
          เพิ่มได้หลายบัญชี แยกเป็นบัญชี VAT และไม่มี VAT — ใบเสนอราคา/ใบแจ้งหนี้จะเลือกจากบัญชีที่ตรงหมวดของเอกสารนั้นๆ โดยเริ่มจากบัญชี default ของหมวดนั้น
        </p>
        {['vat', 'non_vat'].map(cat => (
          <div key={cat} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text2)', marginBottom: 6 }}>{VAT_CATEGORY_LABELS[cat]}</div>
            {(bankAccounts || []).filter(a => a.vat_category === cat).length === 0 && (
              <div style={{ fontSize: 12.5, color: 'var(--text3)' }}>ยังไม่มีบัญชี</div>
            )}
            <div style={{ display: 'grid', gap: 6 }}>
              {(bankAccounts || []).filter(a => a.vat_category === cat).map(a => (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'var(--bg2, rgba(0,0,0,0.15))', borderRadius: 8, fontSize: 13 }}>
                  <div style={{ flex: 1 }}>
                    {a.bank_name} · {a.account_name} · {a.account_no}
                  </div>
                  {a.is_default
                    ? <span className="pill" style={{ fontSize: 11 }}>✅ Default</span>
                    : <button type="button" className="btn btn-sm btn-ghost" onClick={() => handleSetDefaultBank(a)}>ตั้งเป็น default</button>}
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => handleDeleteBankAccount(a.id)}>🗑️</button>
                </div>
              ))}
            </div>
          </div>
        ))}
        {addingBank ? (
          <div style={{ display: 'grid', gap: 8, padding: '10px 12px', background: 'var(--bg2, rgba(0,0,0,0.15))', borderRadius: 8 }}>
            <div className="form-grid-2">
              <div>
                <label className="label">ธนาคาร</label>
                <select className="input" value={newBank.bank_name} onChange={e => setNewBank(b => ({ ...b, bank_name: e.target.value }))}>
                  {THAI_BANKS.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
              <div>
                <label className="label">หมวด</label>
                <div style={{ display: 'flex', gap: 10, height: 38, alignItems: 'center' }}>
                  {['vat', 'non_vat'].map(cat => (
                    <label key={cat} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 13 }}>
                      <input type="radio" name="new-bank-vat-category" checked={newBank.vat_category === cat} onChange={() => setNewBank(b => ({ ...b, vat_category: cat }))} />
                      {VAT_CATEGORY_LABELS[cat]}
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="form-grid-2">
              <div>
                <label className="label">ชื่อบัญชี</label>
                <input className="input" value={newBank.account_name} onChange={e => setNewBank(b => ({ ...b, account_name: e.target.value }))} />
              </div>
              <div>
                <label className="label">เลขที่บัญชี</label>
                <input className="input" value={newBank.account_no} onChange={e => setNewBank(b => ({ ...b, account_no: e.target.value }))} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn btn-primary btn-sm" onClick={handleAddBankAccount} disabled={savingBank}>
                {savingBank ? '⏳...' : '✅ บันทึก'}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAddingBank(false)}>ยกเลิก</button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAddingBank(true)}>+ เพิ่มบัญชี</button>
        )}
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
      </>}

      {/* __APP_VERSION__/__BUILD_TIME__ are injected at build time by
          vite.config.js's `define` -- there's no other build/deploy
          metadata (no commit hash, no CI run id) reaching the client, so
          this is literally "when `vite build` last ran" for this bundle.
          Shown to every role so support can ask "what version are you on"
          without needing OWNER access. */}
      <div style={{ textAlign: 'center', fontSize: 11.5, color: 'var(--text3)', marginTop: 28 }}>
        FACADE X v{__APP_VERSION__} · อัปเดตล่าสุด {new Date(__BUILD_TIME__).toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' })}
      </div>
    </div>
  )
}
