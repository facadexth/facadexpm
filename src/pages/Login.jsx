// ============================================================
// Login — Supabase Auth (email + password)
// ============================================================
import { useState } from 'react'
import { supabase } from '../lib/supabase.js'

export default function Login() {
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState(null)

  const handleLogin = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(error.message)
    setLoading(false)
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

        <form onSubmit={handleLogin} style={{ display: 'grid', gap: 16 }}>
          <div>
            <label className="label">อีเมล</label>
            <input
              type="email" className="input" required autoFocus
              value={email} onChange={e => setEmail(e.target.value)}
              placeholder="your@email.com"
            />
          </div>
          <div>
            <label className="label">รหัสผ่าน</label>
            <input
              type="password" className="input" required
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
            {loading ? '⏳ กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}
          </button>
        </form>

        <div style={{ marginTop: 24, textAlign: 'center', fontSize: 12, color: 'var(--text3)' }}>
          ติดต่อผู้ดูแลระบบเพื่อขอสิทธิ์เข้าใช้งาน
        </div>
      </div>
    </div>
  )
}
