// ============================================================
// UpgradeModal — shown when a tenant's trial has ended and no paid
// package has been picked yet. Two steps: pick a tier (reusing
// PackageComparison with Apply buttons) -> pay via Omise PromptPay QR,
// polling payment_intents for confirmation. Declining downgrades to
// Free immediately (tenant_downgrade_to_free(), a self-service RPC --
// not the platform-admin-only platform_set_tenant_package()).
// ============================================================
import { useState, useEffect, useRef } from 'react'
import { supabase, fmt } from '../lib/supabase.js'
import { Modal } from './Modal.jsx'
import PackageComparison from './PackageComparison.jsx'

export default function UpgradeModal({ tenant, onClose, onResolved }) {
  const [step, setStep] = useState('pick') // 'pick' | 'pay'
  const [selectedPkg, setSelectedPkg] = useState(null)
  const [qrUrl, setQrUrl] = useState(null)
  const [paymentIntentId, setPaymentIntentId] = useState(null)
  const [applyingId, setApplyingId] = useState(null)
  const [downgrading, setDowngrading] = useState(false)
  const [error, setError] = useState(null)
  const pollRef = useRef(null)

  useEffect(() => () => clearInterval(pollRef.current), [])

  const handleApply = async (pkg) => {
    setApplyingId(pkg.id)
    setError(null)
    try {
      const { data, error: fnError } = await supabase.functions.invoke('omise-create-charge', {
        body: { package_id: pkg.id },
      })
      if (fnError) throw fnError
      if (data?.error) throw new Error(data.error)
      setSelectedPkg(pkg)
      setQrUrl(data.qr_image_uri)
      setPaymentIntentId(data.payment_intent_id)
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

  return (
    <Modal title="เลือกแพ็กเกจ" onClose={onClose} maxWidth={step === 'pay' ? 420 : 960}>
      <div className="modal-body">
        {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

        {step === 'pick' && (
          <>
            <p style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 12 }}>
              ระยะทดลองใช้ฟรีของคุณสิ้นสุดแล้ว เลือกแพ็กเกจที่ต้องการเพื่อใช้งานต่อ
            </p>
            <PackageComparison currentPackageId={tenant?.package_id} onApply={handleApply} applyingId={applyingId} />
            <div style={{ textAlign: 'center' }}>
              <button className="btn btn-ghost btn-sm" disabled={downgrading} onClick={handleDecline}>
                {downgrading ? '⏳...' : 'ไม่ตอนนี้ (ใช้แบบฟรี)'}
              </button>
            </div>
          </>
        )}

        {step === 'pay' && selectedPkg && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ marginBottom: 12, fontSize: 14, fontWeight: 600 }}>
              สแกน QR เพื่อชำระเงิน {selectedPkg.name} — {fmt(selectedPkg.price_monthly, 0)} บาท/เดือน
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
