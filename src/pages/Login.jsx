// ============================================================
// Login — Supabase Auth (email + password), with a signup mode for
// self-serve new-company trial signup
// ============================================================
import { useState } from 'react'
import { supabase } from '../lib/supabase.js'

export default function Login() {
  const [mode,     setMode]     = useState('login') // 'login' | 'signup'
  const [companyName, setCompanyName] = useState('')
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState(null)
  const [signupDone, setSignupDone] = useState(false)

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
    const { error } = await supabase.auth.signUp({
      email, password,
      options: { data: { company_name: companyName } }
    })
    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }
    setSignupDone(true)
    setLoading(false)
  }

  const switchMode = (next) => {
    setMode(next)
    setError(null)
    setSignupDone(false)
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
          <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--accent)', letterSpacing: 2, marginBottom: 6 }}>
            FACADE X
          </div>
          <div style={{ fontSize: 12, color: 'var(--text3)', letterSpacing: 1 }}>
            Construction Dashboard
          </div>
        </div>

        {signupDone ? (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 14, color: 'var(--text)', marginBottom: 20, lineHeight: 1.6 }}>
              ✅ สร้างบัญชีสำเร็จ! ทดลองใช้ฟรี 14 วัน<br />เข้าสู่ระบบด้วยอีเมล/รหัสผ่านที่ตั้งไว้ได้เลย
            </div>
            <button
              type="button" className="btn btn-primary"
              style={{ height: 44, fontSize: 14, fontWeight: 700, width: '100%' }}
              onClick={() => switchMode('login')}
            >
              เข้าสู่ระบบ
            </button>
          </div>
        ) : (
          <form onSubmit={mode === 'login' ? handleLogin : handleSignup} style={{ display: 'grid', gap: 16 }}>
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
              <label className="label">รหัสผ่าน</label>
              <input
                type="password" className="input" required minLength={6}
                value={password} onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>

            {error && (
              <div style={{
                background: 'rgba(255,107,107,0.1)', border: '1px solid rgba(255,107,107,0.3)',
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
            {mode === 'login' ? (
              <>ยังไม่มีบัญชี? <a href="#" onClick={e => { e.preventDefault(); switchMode('signup') }} style={{ color: 'var(--accent)' }}>สร้างบัญชีใหม่ฟรี</a></>
            ) : (
              <>มีบัญชีอยู่แล้ว? <a href="#" onClick={e => { e.preventDefault(); switchMode('login') }} style={{ color: 'var(--accent)' }}>เข้าสู่ระบบ</a></>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
