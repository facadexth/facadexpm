// ============================================================
// FACADE X Dashboard — Main App
// Router: แต่ละ tab คือ page แยกกัน ไม่ต้อง reload หน้า
// ============================================================
import { useState, useEffect } from 'react'
import { supabase } from './lib/supabase.js'
import Login      from './pages/Login.jsx'
import Dashboard   from './pages/Dashboard.jsx'
import Sites       from './pages/Sites.jsx'
import Assign      from './pages/Assign.jsx'
import Expenses    from './pages/Expenses.jsx'
import Income      from './pages/Income.jsx'
import Payroll     from './pages/Payroll.jsx'
import Categories  from './pages/Categories.jsx'
import Clients   from './pages/Clients.jsx'
import Suppliers from './pages/Suppliers.jsx'

const TABS = [
  { id: 'dashboard', label: '📊 ภาพรวม' },
  { id: 'sites',     label: '🏗️ ไซท์งาน' },
  { id: 'assign',    label: '👷 Assign ช่าง' },
  { id: 'expenses',  label: '💸 รายจ่าย' },
  { id: 'income',    label: '💰 รายรับ' },
  { id: 'payroll',   label: '💼 เงินเดือน' },
  { id: 'categories',label: '🏷️ หมวดหมู่' },
  { id: 'clients',   label: '🏢 ลูกค้า' },
  { id: 'suppliers', label: '🏭 Supplier' },
]

export default function App() {
  const [session,  setSession]  = useState(undefined) // undefined = loading
  const [activeTab, setActiveTab] = useState('dashboard')
  const [navState, setNavState] = useState({})

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => subscription.unsubscribe()
  }, [])

  const navigateTo = (tab, state = {}) => {
    setNavState(state)
    setActiveTab(tab)
  }

  const renderPage = () => {
    const props = { navigateTo, navState }
    switch (activeTab) {
      case 'dashboard':  return <Dashboard  {...props} />
      case 'sites':      return <Sites      {...props} />
      case 'assign':     return <Assign     {...props} />
      case 'expenses':   return <Expenses   {...props} />
      case 'income':     return <Income     {...props} />
      case 'payroll':    return <Payroll    {...props} />
      case 'categories': return <Categories {...props} />
      case 'clients':   return <Clients   {...props} />
      case 'suppliers': return <Suppliers {...props} />
      default:           return <Dashboard  {...props} />
    }
  }

  // Loading
  if (session === undefined) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
      <div style={{ color: 'var(--text3)', fontSize: 14 }}>กำลังโหลด...</div>
    </div>
  )

  // Not logged in
  if (!session) return <Login />

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
        {TABS.map(tab => (
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
