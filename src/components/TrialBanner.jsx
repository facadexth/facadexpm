// ============================================================
// TrialBanner — shows trial countdown, or an expired-trial notice
// ============================================================
export default function TrialBanner({ tenant, isTrialActive, trialDaysRemaining }) {
  if (!tenant) return null

  if (isTrialActive) {
    return (
      <div style={{
        background: 'rgba(74,158,255,0.12)', borderBottom: '1px solid rgba(74,158,255,0.3)',
        padding: '8px 24px', fontSize: 13, color: 'var(--accent)', textAlign: 'center'
      }}>
        🎉 ทดลองใช้ฟรี เหลืออีก {trialDaysRemaining} วัน — ใช้งานได้ทุกฟีเจอร์ระหว่างทดลองใช้
      </div>
    )
  }

  if (tenant.plan !== 'active') {
    return (
      <div style={{
        background: 'rgba(255,107,107,0.12)', borderBottom: '1px solid rgba(255,107,107,0.3)',
        padding: '8px 24px', fontSize: 13, color: 'var(--red)', textAlign: 'center'
      }}>
        ⚠️ หมดระยะทดลองใช้แล้ว — ติดต่อเราเพื่ออัปเกรดแพ็กเกจและใช้งานต่อ
      </div>
    )
  }

  return null
}
