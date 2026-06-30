import { useState } from 'react'
import { supabase } from '../lib/supabase.js'

export default function Signup({ onSignupSuccess }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  const handleSignup = async (e) => {
    e.preventDefault()
    setError('')

    if (!email || !password || !confirmPassword) {
      setError('กรุณากรอกข้อมูลให้ครบ')
      return
    }

    if (password !== confirmPassword) {
      setError('Password ไม่ตรงกัน')
      return
    }

    if (password.length < 6) {
      setError('Password ต้องมีอย่างน้อย 6 ตัวอักษร')
      return
    }

    setLoading(true)
    try {
      // Check if email already exists
      const { data: existing } = await supabase
        .from('user_roles')
        .select('id')
        .eq('user_email', email)
        .single()

      if (existing) {
        setError('อีเมลนี้ลงทะเบียนแล้ว กรุณา Login')
        setLoading(false)
        return
      }

      const { data, error: signupError } = await supabase.auth.signUp({
        email,
        password
      })

      if (signupError) throw signupError

      if (!data.user) throw new Error('Failed to create user')

      // Create pending role record
      const { error: roleError } = await supabase
        .from('user_roles')
        .insert({
          user_email: email,
          role: 'WORKER',
          status: 'pending'
        })

      if (roleError) throw roleError

      setSuccess(true)
      setEmail('')
      setPassword('')
      setConfirmPassword('')

      setTimeout(() => {
        onSignupSuccess?.()
      }, 2000)
    } catch (e) {
      let errorMsg = e.message || 'Error creating account'

      // Better error messages
      if (errorMsg.includes('rate limit') || errorMsg.includes('rate_limit')) {
        errorMsg = 'ส่งคำขอสูงเกินไป กรุณารอ 1 นาทีแล้วลองใหม่'
      } else if (errorMsg.includes('already exists') || errorMsg.includes('user already')) {
        errorMsg = 'อีเมลนี้ลงทะเบียนแล้ว กรุณา Login หรือใช้อีเมลอื่น'
      }

      setError(errorMsg)
    } finally {
      setLoading(false)
    }
  }

  if (success) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg)',
        padding: 20
      }}>
        <div className="card" style={{ maxWidth: 400, textAlign: 'center' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
          <h2 style={{ marginBottom: 12, fontSize: 18, fontWeight: 700 }}>สมัครสำเร็จ!</h2>
          <p style={{ color: 'var(--text2)', marginBottom: 16, lineHeight: 1.5 }}>
            ระบบส่งอีเมลยืนยันไปที่ {email}
          </p>
          <p style={{ color: 'var(--text3)', marginBottom: 16, fontSize: 13, lineHeight: 1.5 }}>
            รอ Owner ยืนยันและมอบ Role ให้
          </p>
          <button
            className="btn btn-ghost"
            onClick={() => location.reload()}
            style={{ width: '100%' }}
          >
            ← กลับไปหน้า Login
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg)',
      padding: '20px'
    }}>
      <div className="card" style={{
        width: '100%',
        maxWidth: 400,
        boxSizing: 'border-box'
      }}>
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 8, color: 'var(--accent)' }}>
            FACADE X
          </h1>
          <p style={{ fontSize: 13, color: 'var(--text3)' }}>
            สร้างบัญชีใหม่
          </p>
        </div>

        <form onSubmit={handleSignup} style={{ display: 'grid', gap: 16 }}>
          {error && (
            <div style={{
              background: 'rgba(255,107,107,0.1)',
              border: '1px solid var(--red)',
              borderRadius: 6,
              padding: 12,
              fontSize: 13,
              color: 'var(--red)'
            }}>
              {error}
            </div>
          )}

          <div>
            <label className="label">Email ★</label>
            <input
              className="input"
              type="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="your@email.com"
              disabled={loading}
            />
          </div>

          <div>
            <label className="label">Password ★</label>
            <input
              className="input"
              type="password"
              required
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="อย่างน้อย 6 ตัวอักษร"
              disabled={loading}
            />
          </div>

          <div>
            <label className="label">ยืนยัน Password ★</label>
            <input
              className="input"
              type="password"
              required
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              placeholder="ยืนยัน password"
              disabled={loading}
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            disabled={loading}
            style={{ width: '100%' }}
          >
            {loading ? '⏳ กำลังสร้าง...' : '✓ สมัครสมาชิก'}
          </button>
        </form>

        <div style={{ marginTop: 16, textAlign: 'center', fontSize: 13 }}>
          <span style={{ color: 'var(--text3)' }}>มีบัญชีอยู่แล้ว? </span>
          <button
            type="button"
            className="link"
            onClick={() => location.reload()}
            style={{ color: 'var(--accent)', fontWeight: 600 }}
          >
            Login
          </button>
        </div>
      </div>
    </div>
  )
}
