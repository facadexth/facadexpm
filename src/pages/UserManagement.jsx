// ============================================================
// User Management — จัดการ Users & Roles (OWNER only)
// ============================================================
import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import { useSeatStatus, useCheckinLocations } from '../hooks/useSupabase.js'
import { linkHint, linkHintMessage } from '../lib/userLinkHint.js'

const ROLES = ['OWNER', 'ADMIN', 'WORKER']
// WORKER stays a valid role in the database (lowest access, and the default for
// anyone invited), but crew use LINE, not the web app, so it is not offered
// when creating a login. Existing WORKER rows can still be edited.
const CREATE_ROLES = ['ADMIN', 'OWNER']
const EMPTY_FORM = { email: '', password: '', display_name: '', role: 'ADMIN', assigned_checkin_location_id: '' }

const friendlyError = (e) => {
  if (e.message?.includes('row-level security policy'))
    return 'บันทึกไม่สำเร็จ: อาจเกินจำนวน Admin ที่ package ปัจจุบันอนุญาต กรุณาติดต่อผู้ดูแลระบบเพื่ออัปเกรด package'
  return 'Error: ' + e.message
}

export default function UserManagement() {
  // editItem === null → CREATE mode | editItem !== null → EDIT mode
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editItem, setEditItem] = useState(null)
  const [deleteId, setDeleteId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [form, setForm] = useState(EMPTY_FORM)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const { data: seat, refetch: refetchSeat } = useSeatStatus()
  const { data: checkinLocations } = useCheckinLocations()
  const [workerList, setWorkerList] = useState([])
  const linkedWorkerEmails = useMemo(
    () => new Set(workerList.map(w => w.email).filter(Boolean)),
    [workerList]
  )

  useEffect(() => {
    supabase.from('workers').select('name, nickname, email').then(({ data }) => setWorkerList(data || []))
  }, [])
  const [sortCol, setSortCol] = useState('user_email')
  const [sortDir, setSortDir] = useState('asc')
  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }
  const si = (col) => sortCol === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕'

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

  const filtered = useMemo(() => {
    const rows = users.filter(u =>
      !search || u.user_email.toLowerCase().includes(search.toLowerCase())
    )
    return [...rows].sort((a, b) => {
      const va = a[sortCol] ?? '', vb = b[sortCol] ?? ''
      if (typeof va === 'number') return sortDir === 'asc' ? va - vb : vb - va
      return sortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va))
    })
  }, [users, search, sortCol, sortDir])

  const handleCreate = () => {
    setEditItem(null)
    setForm(EMPTY_FORM)
    setShowForm(true)
  }

  const handleEdit = (item) => {
    setEditItem(item)
    setForm({ email: item.user_email, password: '', display_name: item.display_name || '', role: item.role, assigned_checkin_location_id: item.assigned_checkin_location_id || '' })
    setShowForm(true)
  }

  const handleClose = () => {
    setShowForm(false)
    setEditItem(null)
    setForm(EMPTY_FORM)
  }

  const handleSave = async (e) => {
    e.preventDefault()

    setSaving(true)
    try {
      if (editItem) {
        // Edit mode: update role (password requires Supabase dashboard)
        const { error } = await supabase
          .from('user_roles')
          .update({ role: form.role, display_name: form.display_name.trim() || null, assigned_checkin_location_id: form.assigned_checkin_location_id || null })
          .eq('id', editItem.id)

        if (error) throw error
        alert('✅ อัปเดต role สำเร็จ')
      } else {
        // Create mode
        if (!form.email || !form.password) return alert('กรุณากรอกอีเมลและรหัสผ่าน')
        if (!form.display_name.trim()) return alert('กรุณากรอกชื่อ')
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

        // Create the login through the create-user function: it confirms the
        // email on the spot (crew don't use email) and joins the new user to
        // this OWNER's tenant. The role is set below with our own session so
        // the seat-limit trigger still applies.
        const { data, error: fnError } = await supabase.functions.invoke('create-user', {
          body: { email: form.email, password: form.password },
        })
        if (fnError) {
          let message = fnError.message
          try { message = (await fnError.context.json()).error || message } catch { /* keep generic message */ }
          throw new Error(message)
        }
        if (!data?.user) throw new Error('Failed to create auth user')

        // Upsert role (DB trigger may have already inserted WORKER row)
        const { error: roleError } = await supabase
          .from('user_roles')
          .upsert(
            { user_email: form.email, role: form.role, display_name: form.display_name.trim() },
            { onConflict: 'user_email' }
          )

        if (roleError) throw roleError
        const hint = linkHintMessage(linkHint({ email: form.email, name: form.display_name, workers: workerList }))
        alert('✅ สร้าง user สำเร็จ' + (hint ? '\n\nℹ️ ' + hint : ''))
      }

      setShowForm(false)
      setEditItem(null)
      setForm({ email: '', password: '', role: 'ADMIN', assigned_checkin_location_id: '' })
      fetchUsers()
      refetchSeat()
    } catch (e) {
      alert(friendlyError(e))
    } finally {
      setSaving(false)
    }
  }

  // เตือนก่อนกดบันทึกถ้ากำลังจะเพิ่ม Admin/Owner คนใหม่ขณะเต็ม quota แล้ว
  // (การบังคับจริงอยู่ที่ RLS -- นี่แค่กันเสียเวลากรอกฟอร์มแล้วโดน error)
  const isPromotingToAdmin =
    ['OWNER', 'ADMIN'].includes(form.role) && (!editItem || !['OWNER', 'ADMIN'].includes(editItem.role))
  const adminsFull = seat?.admins?.max != null && seat.admins.used >= seat.admins.max
  const showAdminLimitWarning = isPromotingToAdmin && adminsFull

  const handleDelete = async () => {
    if (!deleteId) return
    const { error } = await supabase
      .from('user_roles')
      .delete()
      .eq('id', deleteId)
    if (!error) {
      setDeleteId(null)
      fetchUsers()
      refetchSeat()
    } else {
      alert('Error: ' + error.message)
    }
  }

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ marginBottom: 16, fontSize: 18, fontWeight: 700 }}>👥 จัดการ Users & Roles</h2>
        <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={handleCreate}>
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
                  <th className="sortable" onClick={() => toggleSort('display_name')}>ชื่อ{si('display_name')}</th>
                  <th className="sortable" onClick={() => toggleSort('user_email')}>Email{si('user_email')}</th>
                  <th className="sortable" onClick={() => toggleSort('role')}>Role{si('role')}</th>
                  <th className="sortable" onClick={() => toggleSort('created_at')}>เพิ่มเมื่อ{si('created_at')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(u => (
                  <tr key={u.id}>
                    <td style={{ fontWeight: 600 }}>{u.display_name || <span style={{ color: 'var(--text3)', fontWeight: 400 }}>—</span>}</td>
                    <td>{u.user_email}</td>
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
                        onClick={() => handleEdit(u)}
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
                    <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>
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
          onClose={handleClose}
          maxWidth={400}
        >
          <form onSubmit={handleSave} autoComplete="off">
            {/* Dummy fields to absorb browser autofill */}
            <input type="text" name="username" autoComplete="username" style={{ display: 'none' }} />
            <input type="password" name="password" autoComplete="current-password" style={{ display: 'none' }} />
            <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
              <div>
                <label className="label">Email ★</label>
                <input
                  className="input"
                  type="email"
                  required
                  disabled={!!editItem}
                  value={form.email}
                  onChange={e => set('email', e.target.value)}
                  placeholder="user@example.com"
                  autoComplete="off"
                />
              </div>
              <div>
                <label className="label">ชื่อ {!editItem && '★'}</label>
                <input
                  className="input"
                  type="text"
                  required={!editItem}
                  value={form.display_name}
                  onChange={e => set('display_name', e.target.value)}
                  placeholder="ชื่อ-นามสกุล หรือชื่อเล่น"
                  autoComplete="off"
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
                    autoComplete="new-password"
                  />
                </div>
              )}
              {editItem && (
                <div style={{ fontSize: 12, color: 'var(--text3)', background: 'rgba(108,99,255,0.1)', padding: 8, borderRadius: 6 }}>
                  💡 แก้ password ไป Supabase Dashboard
                </div>
              )}
              <div>
                <label className="label">Role ★</label>
                <select
                  className="select"
                  value={form.role}
                  onChange={e => set('role', e.target.value)}
                >
                  {(editItem ? ROLES : CREATE_ROLES).map(r => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
              {editItem && (form.role === 'ADMIN' || form.role === 'OWNER') && (
                <div>
                  <label className="label">ตำแหน่งเช็คอินที่กำหนด</label>
                  <select
                    className="select"
                    value={form.assigned_checkin_location_id}
                    disabled={!linkedWorkerEmails.has(form.email)}
                    onChange={e => set('assigned_checkin_location_id', e.target.value)}
                  >
                    <option value="">-- ไม่กำหนด --</option>
                    {(checkinLocations || []).filter(l => l.active).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                  {!linkedWorkerEmails.has(form.email) && (
                    <p style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 4 }}>
                      ต้องเพิ่มเป็นพนักงานในหน้าบุคคลก่อน (ใช้อีเมลเดียวกัน) จึงจะกำหนดตำแหน่งเช็คอินได้
                    </p>
                  )}
                </div>
              )}
              {showAdminLimitWarning && (
                <div className="alert alert-warning" style={{ fontSize: 12 }}>
                  ⚠️ Package ปัจจุบันอนุญาต Admin/Owner สูงสุด {seat.admins.max} คน (ใช้ไปแล้ว {seat.admins.used})
                  หากบันทึกอาจไม่สำเร็จ — ติดต่อผู้ดูแลระบบเพื่ออัปเกรด package
                </div>
              )}
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
                onClick={handleClose}
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
