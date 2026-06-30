// ============================================================
// FACADE X Dashboard — Main App
// Router: แต่ละ tab คือ page แยกกัน ไม่ต้อง reload หน้า
// ============================================================
import { useState, useEffect } from 'react'
import { supabase } from './lib/supabase.js'
import { useUserRole } from './hooks/useUserRole.js'
import { ProtectedPage } from './components/ProtectedPage.jsx'
import Login      from './pages/Login.jsx'
import Dashboard   from './pages/Dashboard.jsx'
import Sites       from './pages/Sites.jsx'
import Assign      from './pages/Assign.jsx'
import Expenses    from './pages/Expenses.jsx'
import Income      from './pages/Income.jsx'
import HR                from './pages/HR.jsx'
import LaborContractors  from './pages/LaborContractors.jsx'
import Categories      from './pages/Categories.jsx'
import Clients        from './pages/Clients.jsx'
import Suppliers      from './pages/Suppliers.jsx'
import UserManagement from './pages/UserManagement.jsx'

const TABS = [
  { id: 'dashboard',         label: '📊 ภาพรวม',              minRole: 'WORKER' },
  { id: 'sites',             label: '🏗️ ไซท์งาน',            minRole: 'WORKER' },
  { id: 'assign',            label: '📋 Assign ช่าง',          minRole: 'WORKER' },
  { id: 'expenses',          label: '💸 รายจ่าย',              minRole: 'WORKER' },
  { id: 'income',            label: '💰 รายรับ',               minRole: 'WORKER' },
  { id: 'hr',                label: '👷 HR',                   minRole: 'WORKER' },
  { id: 'categories',        label: '🏷️ หมวดหมู่',            minRole: 'WORKER' },
  { id: 'clients',           label: '🏢 ลูกค้า',              minRole: 'WORKER' },
  { id: 'suppliers',         label: '🏭 Supplier',             minRole: 'WORKER' },
  { id: 'labor_contractors', label: '🔧 ผู้รับเหมาค่าแรง',    minRole: 'WORKER' },
  { id: 'user_management',   label: '👤 ผู้ใช้งาน',           minRole: 'WORKER' },
]

export default function App() {
  const [session,  setSession]  = useState(undefined) // undefined = loading
  const [activeTab, setActiveTab] = useState('dashboard')
  const [navState, setNavState] = useState({})
  const { isAtLeast, loading: roleLoading } = useUserRole()

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => subscription.unsubscribe()
  }, [])

  // After role loads, redirect WORKER away from ADMIN-only tabs
  useEffect(() => {
    if (roleLoading || !session) return
    const current = TABS.find(t => t.id === activeTab)
    if (current && !isAtLeast(current.minRole)) {
      setActiveTab(isAtLeast('ADMIN') ? 'dashboard' : 'assign')
    }
  }, [roleLoading, session, activeTab, isAtLeast])

  const navigateTo = (tab, state = {}) => {
    setNavState(state)
    setActiveTab(tab)
  }

  const renderPage = () => {
    const props = { navigateTo, navState }
    switch (activeTab) {
      case 'dashboard':  return <ProtectedPage minRole="WORKER"><Dashboard  {...props} /></ProtectedPage>
      case 'sites':      return <ProtectedPage minRole="WORKER"><Sites      {...props} /></ProtectedPage>
      case 'assign':     return <ProtectedPage minRole="WORKER"><Assign     {...props} /></ProtectedPage>
      case 'expenses':   return <ProtectedPage minRole="WORKER"><Expenses   {...props} /></ProtectedPage>
      case 'income':     return <ProtectedPage minRole="WORKER"><Income     {...props} /></ProtectedPage>
      case 'hr':         return <ProtectedPage minRole="WORKER"><HR        {...props} /></ProtectedPage>
      case 'labor_contractors': return <ProtectedPage minRole="WORKER"><LaborContractors {...props} /></ProtectedPage>
      case 'categories': return <ProtectedPage minRole="WORKER"><Categories {...props} /></ProtectedPage>
      case 'clients':    return <ProtectedPage minRole="WORKER"><Clients    {...props} /></ProtectedPage>
      case 'suppliers':      return <ProtectedPage minRole="WORKER"><Suppliers      {...props} /></ProtectedPage>
      case 'user_management': return <ProtectedPage minRole="WORKER"><UserManagement {...props} /></ProtectedPage>
      default:               return <ProtectedPage minRole="WORKER"><Dashboard      {...props} /></ProtectedPage>
    }
  }

  // Loading auth
  if (session === undefined) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
      <div style={{ color: 'var(--text3)', fontSize: 14 }}>กำลังโหลด...</div>
    </div>
  )

  // Not logged in
  if (!session) return <Login />

  const visibleTabs = TABS.filter(tab => isAtLeast(tab.minRole))

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* ── Header ── */}
      <header style={{
        background: 'var(--bg2)', borderBottom: '1px solid var(--border)',
        padding: '0 24px', height: 56, display: 'flex',
        alignItems: 'center', justifyContent: 'space-between',
        position: 'sticky', top: 0, zIndex: 100
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 20, fontWeight: 800, color: 'var(--accent)', letterSpacing: 1 }}>
            FACADE X
          </span>
          <span style={{ color: 'var(--text3)', fontSize: 13 }}>Construction Dashboard</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ color: 'var(--text3)', fontSize: 12 }}>
            {session.user.email}
          </span>
          <span style={{ color: 'var(--text3)', fontSize: 12 }}>
            {new Date().toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' })}
          </span>
          <button
            className="btn btn-ghost btn-sm"
            style={{ fontSize: 12 }}
            onClick={() => supabase.auth.signOut()}
          >
            ออกจากระบบ
          </button>
        </div>
      </header>

      {/* ── Tab Bar ── */}
      <nav style={{
        background: 'var(--bg2)', borderBottom: '1px solid var(--border)',
        padding: '0 20px', display: 'flex', gap: 2, overflowX: 'auto'
      }}>
        {visibleTabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => { setNavState({}); setActiveTab(tab.id) }}
            style={{
              padding: '13px 18px', background: 'none', border: 'none',
              borderBottom: activeTab === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
              color: activeTab === tab.id ? 'var(--accent)' : 'var(--text2)',
              fontWeight: 600, fontSize: 13, cursor: 'pointer',
              whiteSpace: 'nowrap', transition: 'all 0.2s'
            }}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* ── Page Content ── */}
      <main style={{ flex: 1, padding: '20px 24px', maxWidth: 1440, margin: '0 auto', width: '100%' }}>
        {renderPage()}
      </main>
    </div>
  )
}
