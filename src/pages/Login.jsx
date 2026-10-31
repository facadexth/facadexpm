// ============================================================
// Login — Supabase Auth (email + password), with a signup mode for
// self-serve new-company trial signup
// ============================================================
import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { classifySignup } from '../lib/signupResult.js'
import { classifyResetRequest, isExpiredLinkUrl, RESET_COOLDOWN_SECONDS } from '../lib/passwordReset.js'

export default function Login() {
  // opened from an expired / already-used reset link -> straight to the "ขอลิงก์ใหม่" form
  const linkExpired = typeof window !== 'undefined' && isExpiredLinkUrl(window.location.hash, window.location.search)
  const [mode,     setMode]     = useState(linkExpired ? 'forgot' : 'login') // 'login' | 'signup' | 'forgot'
  const [companyName, setCompanyName] = useState('')
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState(linkExpired ? 'ลิงก์นี้หมดอายุหรือถูกใช้ไปแล้ว กรุณาขอลิงก์ใหม่' : null)
  const [resetSent, setResetSent] = useState(false)
  const [cooldown,  setCooldown]  = useState(0)
  const [signupDone, setSignupDone] = useState(false)
  const [needsConfirm, setNeedsConfirm] = useState(false) // email confirmation required before first login

  const handleLogin = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(error.message)
    setLoading(false)
  }

  const handleSignup = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const result = await supabase.auth.signUp({
      email, password,
      options: { data: {
        company_name: companyName,
      } }
    })
    const outcome = classifySignup(result)
    if (outcome.kind === 'duplicate' || outcome.kind === 'error') {
      setError(outcome.message)
      setLoading(false)
      return
    }
    setNeedsConfirm(outcome.kind === 'confirm')
    setSignupDone(true)
    setLoading(false)
  }

  // forgot password: email a reset link. The result looks the same for unknown addresses (see classifyResetRequest).
  const handleForgot = async (e) => {
    if (e) e.preventDefault()
    if (cooldown > 0 || loading) return
    setLoading(true)
    setError(null)
    const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin })
    const outcome = classifyResetRequest(err)
    setLoading(false)
    if (!outcome.ok) { setError(outcome.message); return }
    setResetSent(true)
    setCooldown(RESET_COOLDOWN_SECONDS)
  }

  useEffect(() => {
    if (cooldown <= 0) return undefined
    const id = setTimeout(() => setCooldown(c => c - 1), 1000)
    return () => clearTimeout(id)
  }, [cooldown])

  // an expired-link redirect leaves error params in the address bar; clear them once we have shown the message
  useEffect(() => {
    if (linkExpired) window.history.replaceState(null, '', window.location.pathname)
  }, [linkExpired])

  const switchMode = (next) => {
    setMode(next)
    setResetSent(false)
    setError(null)
    setSignupDone(false)
    setNeedsConfirm(false)
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)', padding: 24
    }}>
      <div style={{
        background: 'var(--bg2)', border: '1px solid var(--border)',
        borderRadius: 12, padding: '40px 36px', width: '100%', maxWidth: 380,
        boxShadow: '0 8px 32px rgba(0,0,0,0.3)'
      }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: 16, color: 'var(--text3)', letterSpacing: 1 }}>
            CHANG
          </div>
        </div>

        {mode === 'forgot' ? (
          resetSent ? (
            <div style={{ display: 'grid', gap: 16 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>ตรวจอีเมลของคุณ</div>
              </div>
              <div role="status" style={{
                background: 'rgba(var(--green-rgb, 47,125,79), 0.12)', border: '1px solid rgba(var(--green-rgb, 47,125,79), 0.3)',
                borderRadius: 6, padding: '10px 14px', fontSize: 13, color: 'var(--green)', lineHeight: 1.6,
              }}>
                ถ้าอีเมล <b>{email.trim()}</b> ลงทะเบียนไว้ เราได้ส่งลิงก์ตั้งรหัสผ่านใหม่ไปให้แล้ว ลิงก์ใช้ได้ 1 ชั่วโมง
              </div>
              <div style={{ fontSize: 12, color: 'var(--text3)' }}>ไม่เห็นอีเมล? ลองดูในกล่องสแปม หรือรอสักครู่</div>
              <button type="button" className="btn btn-ghost" disabled={cooldown > 0 || loading} onClick={handleForgot}
                style={{ height: 44, fontSize: 14, fontWeight: 700 }}>
                {cooldown > 0 ? `ส่งอีกครั้งได้ใน ${cooldown} วินาที` : 'ส่งอีเมลอีกครั้ง'}
              </button>
            </div>
          ) : (
            <form data-enter-submit onSubmit={handleForgot} style={{ display: 'grid', gap: 16 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>ลืมรหัสผ่าน</div>
                <div style={{ fontSize: 12, color: 'var(--text3)' }}>กรอกอีเมลที่ลงทะเบียนไว้ เราจะส่งลิงก์ตั้งรหัสผ่านใหม่ไปให้</div>
              </div>
              <div>
                <label className="label" htmlFor="forgot-email">อีเมล</label>
                <input id="forgot-email" type="email" className="input" required autoFocus
                  value={email} onChange={e => setEmail(e.target.value)} placeholder="your@email.com" />
              </div>
              {error && (
                <div role="alert" style={{
                  background: 'rgba(var(--red-rgb), 0.1)', border: '1px solid rgba(var(--red-rgb), 0.3)',
                  borderRadius: 6, padding: '10px 14px', fontSize: 13, color: 'var(--red)',
                }}>{error}</div>
              )}
              <button type="submit" className="btn btn-primary" disabled={loading}
                style={{ height: 44, fontSize: 14, fontWeight: 700 }}>
                {loading ? '⏳ กำลังส่ง...' : 'ส่งลิงก์ตั้งรหัสผ่านใหม่'}
              </button>
            </form>
          )
        ) : signupDone ? (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 14, color: 'var(--text)', marginBottom: 20, lineHeight: 1.6 }}>
              {needsConfirm ? (
                <>📧 ส่งอีเมลยืนยันไปที่ <b>{email}</b> แล้ว<br />กรุณากดลิงก์ในอีเมลก่อน แล้วจึงเข้าสู่ระบบ<br />
                  <span style={{ fontSize: 12, color: 'var(--text3)' }}>ไม่พบอีเมล? ลองดูในจดหมายขยะ</span></>
              ) : (
                <>✅ สร้างบัญชีสำเร็จ! ทดลองใช้ฟรี 14 วัน<br />เข้าสู่ระบบด้วยอีเมล/รหัสผ่านที่ตั้งไว้ได้เลย</>
              )}
            </div>
            <button
              type="button" className="btn btn-primary"
              disabled={loading}
              style={{ height: 44, fontSize: 14, fontWeight: 700, width: '100%' }}
              onClick={() => switchMode('login')}
            >
              เข้าสู่ระบบ
            </button>
          </div>
        ) : (
          <form data-enter-submit key={mode} onSubmit={mode === 'login' ? handleLogin : handleSignup} style={{ display: 'grid', gap: 16 }}>
            {mode === 'signup' && (
              <div>
                <label className="label">ชื่อบริษัท</label>
                <input
                  type="text" className="input" required autoFocus
                  value={companyName} onChange={e => setCompanyName(e.target.value)}
                  placeholder="บริษัท ตัวอย่าง จำกัด"
                />
              </div>
            )}
            <div>
              <label className="label">อีเมล</label>
              <input
                type="email" className="input" required autoFocus={mode === 'login'}
                value={email} onChange={e => setEmail(e.target.value)}
                placeholder="your@email.com"
              />
            </div>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                <label className="label">รหัสผ่าน</label>
                {mode === 'login' && (
                  <a href="#" aria-disabled={loading}
                    onClick={e => { e.preventDefault(); if (!loading) switchMode('forgot') }}
                    style={{ fontSize: 12, color: 'var(--accent)', pointerEvents: loading ? 'none' : 'auto', opacity: loading ? 0.5 : 1 }}
                  >ลืมรหัสผ่าน?</a>
                )}
              </div>
              <input
                type="password" className="input" required minLength={6}
                value={password} onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>

            {error && (
              <div style={{
                background: 'rgba(var(--red-rgb), 0.1)', border: '1px solid rgba(var(--red-rgb), 0.3)',
                borderRadius: 6, padding: '10px 14px', fontSize: 13, color: 'var(--red)'
              }}>
                {error === 'Invalid login credentials'
                  ? 'อีเมลหรือรหัสผ่านไม่ถูกต้อง'
                  : error}
              </div>
            )}

            <button
              type="submit" className="btn btn-primary"
              disabled={loading}
              style={{ marginTop: 4, height: 44, fontSize: 14, fontWeight: 700 }}
            >
              {loading
                ? '⏳ กำลังดำเนินการ...'
                : mode === 'login' ? 'เข้าสู่ระบบ' : 'เริ่มทดลองใช้ฟรี 14 วัน'}
            </button>
          </form>
        )}

        {!signupDone && (
          <div style={{ marginTop: 24, textAlign: 'center', fontSize: 12, color: 'var(--text3)' }}>
            {mode === 'forgot' ? (
              <a href="#" aria-disabled={loading}
                onClick={e => { e.preventDefault(); if (!loading) switchMode('login') }}
                style={{ color: 'var(--accent)', pointerEvents: loading ? 'none' : 'auto', opacity: loading ? 0.5 : 1 }}
              >← กลับไปเข้าสู่ระบบ</a>
            ) : mode === 'login' ? (
              <>ยังไม่มีบัญชี? <a
                href="#" aria-disabled={loading}
                onClick={e => { e.preventDefault(); if (!loading) switchMode('signup') }}
                style={{ color: 'var(--accent)', pointerEvents: loading ? 'none' : 'auto', opacity: loading ? 0.5 : 1 }}
              >สร้างบัญชีใหม่ฟรี</a></>
            ) : (
              <>มีบัญชีอยู่แล้ว? <a
                href="#" aria-disabled={loading}
                onClick={e => { e.preventDefault(); if (!loading) switchMode('login') }}
                style={{ color: 'var(--accent)', pointerEvents: loading ? 'none' : 'auto', opacity: loading ? 0.5 : 1 }}
              >เข้าสู่ระบบ</a></>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
