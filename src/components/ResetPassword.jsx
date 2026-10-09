// ============================================================
// ResetPassword -- full-screen "ตั้งรหัสผ่านใหม่" shown when the app was opened from a password-recovery email link
// (the link signs the user into a temporary recovery session; updateUser sets the new password on it).
// ============================================================
import { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { validateNewPassword, MIN_PASSWORD_LENGTH } from '../lib/passwordReset.js'

export default function ResetPassword({ onDone }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const handleSave = async (e) => {
    e.preventDefault()
    const problem = validateNewPassword(password, confirm)
    if (problem) { setError(problem); return }
    setSaving(true)
    setError(null)
    const { error: err } = await supabase.auth.updateUser({ password })
    setSaving(false)
    if (err) { setError(err.message || 'ตั้งรหัสผ่านไม่สำเร็จ กรุณาขอลิงก์ใหม่'); return }
    onDone()
  }

  // leave without choosing a password: end the temporary session so the link can't be reused from this browser
  const handleCancel = async () => {
    await supabase.auth.signOut()
    onDone()
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', padding: 24 }}>
      <div style={{
        background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: '40px 36px',
        width: '100%', maxWidth: 380, boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
      }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 16, color: 'var(--text3)', letterSpacing: 1 }}>CHANG</div>
        </div>
        <form data-enter-submit onSubmit={handleSave} style={{ display: 'grid', gap: 16 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>ตั้งรหัสผ่านใหม่</div>
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>อย่างน้อย {MIN_PASSWORD_LENGTH} ตัวอักษร</div>
          </div>
          <div>
            <label className="label" htmlFor="rp-new">รหัสผ่านใหม่</label>
            <input id="rp-new" type="password" className="input" required autoFocus autoComplete="new-password"
              value={password} onChange={e => setPassword(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="rp-confirm">พิมพ์รหัสผ่านใหม่อีกครั้ง</label>
            <input id="rp-confirm" type="password" className="input" required autoComplete="new-password"
              value={confirm} onChange={e => setConfirm(e.target.value)} />
          </div>
          {error && (
            <div role="alert" style={{
              background: 'rgba(var(--red-rgb), 0.1)', border: '1px solid rgba(var(--red-rgb), 0.3)',
              borderRadius: 6, padding: '10px 14px', fontSize: 13, color: 'var(--red)',
            }}>{error}</div>
          )}
          <button type="submit" className="btn btn-primary" disabled={saving} style={{ height: 44, fontSize: 14, fontWeight: 700 }}>
            {saving ? '⏳ กำลังบันทึก...' : 'บันทึกและเข้าสู่ระบบ'}
          </button>
          <button type="button" className="btn btn-ghost" disabled={saving} onClick={handleCancel}>ยกเลิก</button>
        </form>
      </div>
    </div>
  )
}
