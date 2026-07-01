import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'

const DEFAULT_PERMISSIONS = {
  WORKER: {
    dashboard: true,
    assign: true,
    hr: true,
    sites: false,
    expenses: false,
    income: false,
    categories: false,
    clients: false,
    suppliers: false,
    labor_contractors: false,
    user_management: false,
    settings: false,
  },
  ADMIN: {
    dashboard: true,
    assign: true,
    hr: true,
    sites: true,
    expenses: true,
    income: true,
    categories: true,
    clients: true,
    suppliers: true,
    labor_contractors: true,
    user_management: false,
    settings: false,
  },
  OWNER: {
    dashboard: true,
    assign: true,
    hr: true,
    sites: true,
    expenses: true,
    income: true,
    categories: true,
    clients: true,
    suppliers: true,
    labor_contractors: true,
    user_management: true,
    settings: true,
  },
}

const PAGE_LABELS = {
  dashboard: '📊 Dashboard',
  assign: '📋 Assign ช่าง',
  hr: '👷 HR',
  sites: '🏗️ Sites',
  expenses: '💸 Expenses',
  income: '💰 Income',
  categories: '🏷️ Categories',
  clients: '🏢 Clients',
  suppliers: '🏭 Suppliers',
  labor_contractors: '🔧 Labor Contractors',
  user_management: '👤 User Management',
  settings: '⚙️ Settings',
}

export default function Settings() {
  const [permissions, setPermissions] = useState(DEFAULT_PERMISSIONS)
  const [saving, setSaving] = useState(false)

  // Load permissions from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('role_permissions')
    if (saved) {
      try {
        setPermissions(JSON.parse(saved))
      } catch (e) {
        console.error('Failed to load permissions:', e)
      }
    }
  }, [])

  const toggle = (role, page) => {
    setPermissions(prev => ({
      ...prev,
      [role]: {
        ...prev[role],
        [page]: !prev[role][page]
      }
    }))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      // Save to localStorage (could also save to Supabase if needed)
      localStorage.setItem('role_permissions', JSON.stringify(permissions))
      alert('✅ บันทึกตั้งค่าสำเร็จ')
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleReset = () => {
    if (confirm('รีเซ็ตเป็นค่าเริ่มต้น?')) {
      setPermissions(DEFAULT_PERMISSIONS)
    }
  }

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ marginBottom: 8, fontSize: 18, fontWeight: 700 }}>⚙️ ตั้งค่าสิทธิ์เข้าใช้งาน</h2>
        <p style={{ fontSize: 13, color: 'var(--text3)' }}>
          เลือกหน้าที่แต่ละ Role สามารถเข้าใช้งานได้
        </p>
      </div>

      <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'repeat(auto-fit, minmax(350px, 1fr))' }}>
        {['WORKER', 'ADMIN', 'OWNER'].map(role => (
          <div key={role} className="card" style={{
            borderTop: role === 'OWNER' ? '3px solid var(--red)' : role === 'ADMIN' ? '3px solid var(--accent)' : '3px solid var(--green)',
          }}>
            <div style={{
              padding: '12px 16px',
              background: role === 'OWNER' ? 'rgba(255,107,107,0.1)' : role === 'ADMIN' ? 'rgba(108,99,255,0.1)' : 'rgba(0,212,170,0.1)',
              borderBottom: '1px solid var(--border)',
            }}>
              <h3 style={{
                margin: 0,
                fontSize: 16,
                fontWeight: 700,
                color: role === 'OWNER' ? 'var(--red)' : role === 'ADMIN' ? 'var(--accent)' : 'var(--green)',
              }}>
                {role}
              </h3>
            </div>

            <div style={{ padding: '16px' }}>
              <div style={{ display: 'grid', gap: 10 }}>
                {Object.entries(permissions[role]).map(([page, allowed]) => (
                  <label key={page} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    cursor: 'pointer',
                    padding: '8px',
                    borderRadius: 6,
                    transition: 'background 0.2s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <input
                      type="checkbox"
                      checked={allowed}
                      onChange={() => toggle(role, page)}
                      style={{ cursor: 'pointer', width: 18, height: 18 }}
                    />
                    <span style={{ fontSize: 13, color: 'var(--text2)', fontWeight: 500 }}>
                      {PAGE_LABELS[page]}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 24, justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={handleReset}>
          🔄 รีเซ็ตค่าเริ่มต้น
        </button>
        <button
          className="btn btn-primary"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? '⏳ กำลังบันทึก...' : '✅ บันทึกตั้งค่า'}
        </button>
      </div>
    </div>
  )
}
