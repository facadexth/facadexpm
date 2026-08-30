// ============================================================
// UpgradeModal — two contexts:
// 1. Trial-end trigger (App.jsx): pick a paid tier -> pay via Omise
//    PromptPay QR, polling payment_intents for confirmation. Declining
//    downgrades to Free immediately (tenant_downgrade_to_free()).
// 2. Change-plan (Settings.jsx, active paying tenants): a higher-priced
//    pick goes through the same prorated pay flow; a same-or-lower-priced
//    pick (including Free) is a scheduled, no-charge downgrade instead
//    (tenant_schedule_downgrade()) -- no reimbursement for the days
//    already paid for, effective at the next renewal, tenant explicitly
//    warned before confirming.
// Which context applies is derived from `tenant` itself (plan==='active'
// with package_id + time remaining), not a separate prop -- Free is only
// ever an immediate, no-warning switch in context 1 (nothing paid to
// lose yet); in context 2 it must go through the same warned/scheduled
// path as any other downgrade, so the ghost "decline" button is hidden
// there and Free becomes a normal pickable row instead.
// ============================================================
import { useState, useEffect, useRef } from 'react'
import { supabase, fmt } from '../lib/supabase.js'
import { usePackages } from '../hooks/useSupabase.js'
import { Modal } from './Modal.jsx'
import PackageComparison from './PackageComparison.jsx'

export default function UpgradeModal({ tenant, onClose, onResolved, onRefresh }) {
  const [step, setStep] = useState('pick') // 'pick' | 'pay'
  const [selectedPkg, setSelectedPkg] = useState(null)
  const [qrUrl, setQrUrl] = useState(null)
  const [paymentIntentId, setPaymentIntentId] = useState(null)
  const [chargeAmount, setChargeAmount] = useState(null) // actual amount after proration -- may be less than the list price
  const [applyingId, setApplyingId] = useState(null)
  const [downgrading, setDowngrading] = useState(false)
  const [cancelingPending, setCancelingPending] = useState(false)
  const [error, setError] = useState(null)
  const pollRef = useRef(null)
  const { data: packages } = usePackages()

  useEffect(() => () => clearInterval(pollRef.current), [])

  const currentPkg = packages?.find(p => p.id === tenant?.package_id) ?? null
  const isActivePaidWithTime = !!(
    tenant?.plan === 'active' && tenant?.package_id && currentPkg &&
    tenant?.plan_expires_at && new Date(tenant.plan_expires_at) > new Date()
  )
  const pendingPkg = packages?.find(p => p.id === tenant?.pending_package_id) ?? null

  const handleApply = async (pkg) => {
    // Same-or-cheaper than what's already active -> scheduled downgrade,
    // no charge, no immediate switch. Ask first: no reimbursement for the
    // days already paid on the current tier.
    if (isActivePaidWithTime && currentPkg && pkg.price_monthly != null && pkg.price_monthly <= currentPkg.price_monthly) {
      const effectiveDate = new Date(tenant.plan_expires_at).toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' })
      const ok = confirm(
        `เปลี่ยนเป็นแพ็กเกจ ${pkg.name} ในวันที่ ${effectiveDate}?\n\n` +
        `แพ็กเกจปัจจุบัน (${currentPkg.name}) จะยังใช้งานได้จนถึงวันนั้น และจะไม่มีการคืนเงินสำหรับวันที่เหลือ`
      )
      if (!ok) return

      setApplyingId(pkg.id)
      setError(null)
      try {
        const { error: rpcError } = await supabase.rpc('tenant_schedule_downgrade', { p_package_id: pkg.id })
        if (rpcError) throw rpcError
        onRefresh?.()
      } catch (e) {
        setError(e.message)
      } finally {
        setApplyingId(null)
      }
      return
    }

    setApplyingId(pkg.id)
    setError(null)
    try {
      const { data, error: fnError } = await supabase.functions.invoke('omise-create-charge', {
        body: { package_id: pkg.id },
      })
      if (fnError) throw fnError
      if (data?.error) throw new Error(data.error)

      // Proration credit fully covered the new tier -- already activated
      // server-side, no QR/payment step needed.
      if (data.activated_immediately) {
        onResolved?.()
        return
      }

      setSelectedPkg(pkg)
      setQrUrl(data.qr_image_uri)
      setPaymentIntentId(data.payment_intent_id)
      setChargeAmount(data.amount ?? pkg.price_monthly)
      setStep('pay')

      pollRef.current = setInterval(async () => {
        const { data: intent } = await supabase
          .from('payment_intents').select('status').eq('id', data.payment_intent_id).single()
        if (intent?.status === 'successful') {
          clearInterval(pollRef.current)
          onResolved?.()
        } else if (intent?.status === 'failed' || intent?.status === 'expired') {
          clearInterval(pollRef.current)
          setError('การชำระเงินไม่สำเร็จหรือหมดเวลา กรุณาลองใหม่')
          setStep('pick')
        }
      }, 3000)
    } catch (e) {
      setError(e.message)
    } finally {
      setApplyingId(null)
    }
  }

  const handleBack = () => {
    clearInterval(pollRef.current)
    setStep('pick')
    setSelectedPkg(null)
    setQrUrl(null)
    setPaymentIntentId(null)
  }

  const handleDecline = async () => {
    if (!confirm('ยืนยันใช้แพ็กเกจฟรีต่อไป? ฟีเจอร์บางส่วนจะถูกปิดใช้งานทันที')) return
    setDowngrading(true)
    setError(null)
    try {
      const { error: rpcError } = await supabase.rpc('tenant_downgrade_to_free')
      if (rpcError) throw rpcError
      onResolved?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setDowngrading(false)
    }
  }

  const handleCancelPendingDowngrade = async () => {
    setCancelingPending(true)
    setError(null)
    try {
      const { error: rpcError } = await supabase.rpc('tenant_cancel_pending_downgrade')
      if (rpcError) throw rpcError
      onRefresh?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setCancelingPending(false)
    }
  }

  return (
    <Modal title={isActivePaidWithTime ? 'เปลี่ยนแพ็กเกจ' : 'เลือกแพ็กเกจ'} onClose={onClose} maxWidth={step === 'pay' ? 420 : 960}>
      <div className="modal-body">
        {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

        {step === 'pick' && (
          <>
            <p style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 12 }}>
              {isActivePaidWithTime
                ? 'อัปเกรดมีผลทันที (คิดค่าบริการตามสัดส่วนวันที่เหลือ) — ดาวน์เกรดไม่มีการคืนเงินสำหรับวันที่เหลือ และจะมีผลเมื่อรอบบิลปัจจุบันสิ้นสุด'
                : 'ระยะทดลองใช้ฟรีของคุณสิ้นสุดแล้ว เลือกแพ็กเกจที่ต้องการเพื่อใช้งานต่อ'}
            </p>

            {pendingPkg && tenant?.plan_expires_at && (
              <div className="alert" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <span>
                  กำหนดเปลี่ยนเป็น <strong>{pendingPkg.name}</strong> ในวันที่{' '}
                  {new Date(tenant.plan_expires_at).toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' })}
                </span>
                <button className="btn btn-ghost btn-sm" disabled={cancelingPending} onClick={handleCancelPendingDowngrade}>
                  {cancelingPending ? '⏳...' : 'ยกเลิก'}
                </button>
              </div>
            )}

            <PackageComparison
              currentPackageId={tenant?.package_id}
              onApply={handleApply}
              applyingId={applyingId}
              allowFreeApply={isActivePaidWithTime}
            />
            {!isActivePaidWithTime && (
              <div style={{ textAlign: 'center' }}>
                <button className="btn btn-ghost btn-sm" disabled={downgrading} onClick={handleDecline}>
                  {downgrading ? '⏳...' : 'ไม่ตอนนี้ (ใช้แบบฟรี)'}
                </button>
              </div>
            )}
          </>
        )}

        {step === 'pay' && selectedPkg && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ marginBottom: 12, fontSize: 14, fontWeight: 600 }}>
              สแกน QR เพื่อชำระเงิน {selectedPkg.name} — {fmt(chargeAmount ?? selectedPkg.price_monthly, 0)} บาท
            </div>
            {qrUrl
              ? <img src={qrUrl} alt="PromptPay QR" style={{ width: 260, height: 260, borderRadius: 8 }} />
              : <div style={{ padding: 40, color: 'var(--text3)' }}>กำลังโหลด QR...</div>}
            <div style={{ marginTop: 14, fontSize: 12, color: 'var(--text3)' }}>
              ⏳ รอการชำระเงิน — หน้าจอจะอัปเดตอัตโนมัติเมื่อชำระสำเร็จ
            </div>
            <button className="btn btn-ghost btn-sm" style={{ marginTop: 14 }} onClick={handleBack}>
              ← กลับไปเลือกแพ็กเกจ
            </button>
          </div>
        )}
      </div>
    </Modal>
  )
}
