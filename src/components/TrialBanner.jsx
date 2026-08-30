// ============================================================
// TrialBanner — shows trial countdown, or an expired-trial notice
// ============================================================
export default function TrialBanner({ tenant, isTrialActive, trialDaysRemaining, onChoosePackage }) {
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
        padding: '8px 24px', fontSize: 13, color: 'var(--red)', textAlign: 'center',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
      }}>
        ⚠️ หมดระยะทดลองใช้แล้ว — เลือกแพ็กเกจเพื่อใช้งานต่อ
        {onChoosePackage && (
          <button className="btn btn-sm btn-danger" onClick={onChoosePackage}>เลือกแพ็กเกจ</button>
        )}
      </div>
    )
  }

  return null
}
