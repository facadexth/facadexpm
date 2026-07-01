// ============================================================
// User Management — จัดการ Users & Roles (OWNER only)
// ============================================================
import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'

const ROLES = ['OWNER', 'ADMIN', 'WORKER']

export default function UserManagement() {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editItem, setEditItem] = useState(null)
  const [deleteId, setDeleteId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')

  const [form, setForm] = useState({ email: '', password: '', role: 'ADMIN' })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const fetchUsers = async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('user_roles')
      .select('*')
      .order('created_at', { ascending: false })
    if (!error) setUsers(data || [])
    setLoading(false)
  }

  useEffect(() => {
    fetchUsers()
  }, [])

  const filtered = useMemo(() =>
    users.filter(u =>
      !search || u.user_email.toLowerCase().includes(search.toLowerCase())
    )
  , [users, search])

  const handleOpen = (item) => {
    if (item) {
      setEditItem(item)
      setForm({ email: item.user_email, password: '', role: item.role })
    } else {
      setEditItem(null)
      setForm({ email: '', password: '', role: 'ADMIN' })
    }
    setShowForm(true)
  }

  const handleSave = async (e) => {
    e.preventDefault()

    setSaving(true)
    try {
      if (editItem) {
        // Edit mode: update role (password requires Supabase dashboard)
        const { error } = await supabase
          .from('user_roles')
          .update({ role: form.role })
          .eq('id', editItem.id)

        if (error) throw error
        alert('✅ อัปเดต role สำเร็จ')
      } else {
        // Create mode
        if (!form.email || !form.password) return alert('กรุณากรอกอีเมลและรหัสผ่าน')
        if (form.password.length < 6) return alert('รหัสผ่านต้องอย่างน้อย 6 ตัว')

        // Check if email exists
        const { data: existing } = await supabase
          .from('user_roles')
          .select('id')
          .eq('user_email', form.email)
          .single()

        if (existing) {
          alert('อีเมลนี้ลงทะเบียนแล้ว')
          setSaving(false)
          return
        }

        // Create auth user
        const { data, error: authError } = await supabase.auth.signUp({
          email: form.email,
          password: form.password
        })

        if (authError) throw authError
        if (!data.user) throw new Error('Failed to create auth user')

        // Add to user_roles
        const { error: roleError } = await supabase
          .from('user_roles')
          .insert({
            user_email: form.email,
            role: form.role
          })

        if (roleError) throw roleError
        alert('✅ สร้าง user สำเร็จ')
      }

      setShowForm(false)
      setEditItem(null)
      setForm({ email: '', password: '', role: 'ADMIN' })
      fetchUsers()
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteId) return
    const { error } = await supabase
      .from('user_roles')
      .delete()
      .eq('id', deleteId)
    if (!error) {
      setDeleteId(null)
      fetchUsers()
    } else {
      alert('Error: ' + error.message)
    }
  }

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ marginBottom: 16, fontSize: 18, fontWeight: 700 }}>👥 จัดการ Users & Roles</h2>
        <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={handleOpen}>
            + สร้าง User ใหม่
          </button>
          <input
            className="input input-sm"
            style={{ width: 220 }}
            placeholder="ค้นหา email..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <span style={{ color: 'var(--text3)', fontSize: 13 }}>
            {filtered.length} รายการ
          </span>
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', color: 'var(--text3)', padding: 40 }}>
          กำลังโหลด...
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>เพิ่มเมื่อ</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(u => (
                  <tr key={u.id}>
                    <td style={{ fontWeight: 600 }}>{u.user_email}</td>
                    <td>
                      <span
                        className="badge"
                        style={{
                          background:
                            u.role === 'OWNER'
                              ? 'rgba(255,107,107,0.2)'
                              : u.role === 'ADMIN'
                              ? 'rgba(108,99,255,0.2)'
                              : 'rgba(0,212,170,0.2)',
                          color:
                            u.role === 'OWNER'
                              ? 'var(--red)'
                              : u.role === 'ADMIN'
                              ? 'var(--accent)'
                              : 'var(--green)',
                        }}
                      >
                        {u.role}
                      </span>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text3)' }}>
                      {new Date(u.created_at).toLocaleDateString('th-TH')}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => handleOpen(u)}
                      >
                        แก้ไข
                      </button>
                      <button
                        className="btn btn-sm btn-ghost"
                        style={{ color: 'var(--red)' }}
                        onClick={() => setDeleteId(u.id)}
                      >
                        ลบ
                      </button>
                    </td>
                  </tr>
                ))}
                {!filtered.length && (
                  <tr>
                    <td colSpan={4} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>
                      ไม่พบ user
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showForm && (
        <Modal
          title={editItem ? 'แก้ไข User' : 'สร้าง User ใหม่'}
          onClose={() => setShowForm(false)}
          maxWidth={400}
        >
          <form onSubmit={handleSave}>
            <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
              <div>
                <label className="label">Email {!editItem && '★'}</label>
                <input
                  className="input"
                  type="email"
                  required={!editItem}
                  disabled={!!editItem}
                  value={form.email}
                  onChange={e => set('email', e.target.value)}
                  placeholder="user@example.com"
                />
              </div>
              {!editItem && (
                <div>
                  <label className="label">Password ★</label>
                  <input
                    className="input"
                    type="password"
                    required
                    value={form.password}
                    onChange={e => set('password', e.target.value)}
                    placeholder="อย่างน้อย 6 ตัวอักษร"
                  />
                </div>
              )}
              {editItem && (
                <div style={{ fontSize: 12, color: 'var(--text3)', background: 'rgba(108,99,255,0.1)', padding: 8, borderRadius: 6 }}>
                  💡 แก้ password ไป Supabase Dashboard → Authentication → Users → เลือก user → Reset Password
                </div>
              )}
              <div>
                <label className="label">Role ★</label>
                <select
                  className="select"
                  value={form.role}
                  onChange={e => set('role', e.target.value)}
                >
                  {ROLES.map(r => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text3)' }}>
                <strong>Role:</strong>
                <ul style={{ margin: '8px 0 0 0', paddingLeft: 16 }}>
                  <li>
                    <strong>OWNER:</strong> เข้าได้ทุกหน้า แก้ได้ทั้งหมด
                  </li>
                  <li>
                    <strong>ADMIN:</strong> เพิ่ม/แก้/ลบ ข้อมูล
                  </li>
                  <li>
                    <strong>WORKER:</strong> ดูเฉพาะ Assign + HR ของตัวเอง
                  </li>
                </ul>
              </div>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setShowForm(false)}
              >
                ยกเลิก
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={saving}
              >
                {saving ? '⏳...' : editItem ? '✅ อัปเดต' : '✅ สร้าง'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {deleteId && (
        <ConfirmDialog
          title="ลบ User"
          message="ยืนยันการลบ?"
          onConfirm={handleDelete}
          onCancel={() => setDeleteId(null)}
        />
      )}
    </div>
  )
}
