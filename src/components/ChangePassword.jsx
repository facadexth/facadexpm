// ============================================================
// ChangePassword — user เปลี่ยนรหัสผ่านตัวเอง (ทุก role ใช้ได้)
// ============================================================
import { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { Modal } from './Modal.jsx'

export default function ChangePassword({ onClose }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const handleSave = async (e) => {
    e.preventDefault()
    setError('')

    if (password.length < 6) {
      setError('รหัสผ่านต้องอย่างน้อย 6 ตัวอักษร')
      return
    }
    if (password !== confirm) {
      setError('รหัสผ่านไม่ตรงกัน')
      return
    }

    setSaving(true)
    try {
      const { error: err } = await supabase.auth.updateUser({ password })
      if (err) throw err
      setDone(true)
    } catch (e) {
      setError(e.message || 'เปลี่ยนรหัสผ่านไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="🔑 เปลี่ยนรหัสผ่าน" onClose={onClose} maxWidth={380}>
      {done ? (
        <div className="modal-body" style={{ textAlign: 'center', padding: '24px 16px' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
          <p style={{ color: 'var(--text2)', marginBottom: 20 }}>เปลี่ยนรหัสผ่านสำเร็จ</p>
          <button className="btn btn-primary" style={{ width: '100%' }} onClick={onClose}>
            ปิด
          </button>
        </div>
      ) : (
        <form onSubmit={handleSave} autoComplete="off">
          <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
            {error && (
              <div style={{
                background: 'rgba(255,107,107,0.1)', border: '1px solid var(--red)',
                borderRadius: 6, padding: 10, fontSize: 13, color: 'var(--red)'
              }}>
                {error}
              </div>
            )}
            <div>
              <label className="label">รหัสผ่านใหม่ ★</label>
              <input
                className="input"
                type="password"
                required
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="อย่างน้อย 6 ตัวอักษร"
                autoComplete="new-password"
              />
            </div>
            <div>
              <label className="label">ยืนยันรหัสผ่านใหม่ ★</label>
              <input
                className="input"
                type="password"
                required
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder="พิมพ์รหัสผ่านอีกครั้ง"
                autoComplete="new-password"
              />
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={onClose}>ยกเลิก</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? '⏳...' : '✅ บันทึก'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  )
}
