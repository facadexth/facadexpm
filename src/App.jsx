// ============================================================
// FACADE X Dashboard — Main App
// Router: แต่ละ tab คือ page แยกกัน ไม่ต้อง reload หน้า
// ============================================================
import { useState, useEffect, lazy, Suspense } from 'react'
import { supabase } from './lib/supabase.js'
import { useUserRole } from './hooks/useUserRole.js'
import { useTenant } from './hooks/useTenant.js'
import { ProtectedPage } from './components/ProtectedPage.jsx'
import { canViewPage } from './lib/permissions.js'
import ChangePassword from './components/ChangePassword.jsx'
import TrialBanner from './components/TrialBanner.jsx'
import Login      from './pages/Login.jsx'
import Dashboard   from './pages/Dashboard.jsx'

const Sites             = lazy(() => import('./pages/Sites.jsx'))
const Assign             = lazy(() => import('./pages/Assign.jsx'))
const Expenses           = lazy(() => import('./pages/Expenses.jsx'))
const PurchaseOrders     = lazy(() => import('./pages/PurchaseOrders.jsx'))
const Income             = lazy(() => import('./pages/Income.jsx'))
const HR                 = lazy(() => import('./pages/HR.jsx'))
const LaborContractors   = lazy(() => import('./pages/LaborContractors.jsx'))
const Categories         = lazy(() => import('./pages/Categories.jsx'))
const Clients            = lazy(() => import('./pages/Clients.jsx'))
const Suppliers          = lazy(() => import('./pages/Suppliers.jsx'))
const UserManagement     = lazy(() => import('./pages/UserManagement.jsx'))
const Settings           = lazy(() => import('./pages/Settings.jsx'))

const TABS = [
  { id: 'dashboard',         label: '📊 ภาพรวม',              minRole: 'WORKER', module: null },
  { id: 'assign',            label: '📋 Assign ช่าง',          minRole: 'WORKER', module: 'payroll' },
  { id: 'hr',                label: '👷 HR',                   minRole: 'WORKER', module: 'payroll' },
  { id: 'sites',             label: '🏗️ ไซท์งาน',            minRole: 'ADMIN',  module: null },
  { id: 'expenses',          label: '💸 รายจ่าย',              minRole: 'ADMIN',  module: null },
  { id: 'purchase_orders',   label: '🧾 ใบสั่งซื้อ',           minRole: 'ADMIN',  module: 'purchase_orders' },
  { id: 'income',            label: '💰 รายรับ',               minRole: 'ADMIN',  module: null },
  { id: 'categories',        label: '🏷️ หมวดหมู่',            minRole: 'ADMIN',  module: null },
  { id: 'clients',           label: '🏢 ลูกค้า',              minRole: 'ADMIN',  module: null },
  { id: 'suppliers',         label: '🏭 Supplier',             minRole: 'ADMIN',  module: null },
  { id: 'labor_contractors', label: '🔧 ผู้รับเหมาค่าแรง',    minRole: 'ADMIN',  module: 'labor_subcontractors' },
  { id: 'user_management',   label: '👤 ผู้ใช้งาน',           minRole: 'OWNER',  module: null },
  { id: 'settings',          label: '⚙️ ตั้งค่า',             minRole: 'OWNER',  module: null },
]

function PageLoadingFallback() {
  return (
    <div style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: 'var(--text3)', fontSize: 14 }}>กำลังโหลด...</div>
    </div>
  )
}

export default function App() {
  const [session,  setSession]  = useState(undefined) // undefined = loading
  const [activeTab, setActiveTab] = useState('dashboard')
  const [navState, setNavState] = useState({})
  const [showChangePassword, setShowChangePassword] = useState(false)
  const { role, isAtLeast, loading: roleLoading } = useUserRole()
  const { tenant, isTrialActive, trialDaysRemaining, hasModuleAccess } = useTenant()

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
      case 'assign':     return <ProtectedPage minRole="WORKER"><Assign     {...props} /></ProtectedPage>
      case 'hr':         return <ProtectedPage minRole="WORKER"><HR        {...props} /></ProtectedPage>
      case 'sites':      return <ProtectedPage minRole="ADMIN"><Sites      {...props} /></ProtectedPage>
      case 'expenses':   return <ProtectedPage minRole="ADMIN"><Expenses   {...props} /></ProtectedPage>
      case 'purchase_orders': return <ProtectedPage minRole="ADMIN"><PurchaseOrders {...props} /></ProtectedPage>
      case 'income':     return <ProtectedPage minRole="ADMIN"><Income     {...props} /></ProtectedPage>
      case 'categories': return <ProtectedPage minRole="ADMIN"><Categories {...props} /></ProtectedPage>
      case 'clients':    return <ProtectedPage minRole="ADMIN"><Clients    {...props} /></ProtectedPage>
      case 'suppliers':  return <ProtectedPage minRole="ADMIN"><Suppliers  {...props} /></ProtectedPage>
      case 'labor_contractors': return <ProtectedPage minRole="ADMIN"><LaborContractors {...props} /></ProtectedPage>
      case 'user_management': return <ProtectedPage minRole="OWNER"><UserManagement {...props} /></ProtectedPage>
      case 'settings':   return <ProtectedPage minRole="OWNER"><Settings   {...props} /></ProtectedPage>
      default:           return <ProtectedPage minRole="WORKER"><Dashboard  {...props} /></ProtectedPage>
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

  const visibleTabs = TABS.filter(tab => {
    // First check role-based access
    if (!isAtLeast(tab.minRole)) return false

    // Then check module entitlement
    if (!hasModuleAccess(tab.module)) return false

    // Then check saved per-role permission level ('none' hides the tab;
    // 'view'/'edit' both keep it visible — the view/edit distinction is
    // enforced inside each page's own canEdit, not here)
    if (role && !canViewPage(role, tab.id)) return false

    return true
  })

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TrialBanner tenant={tenant} isTrialActive={isTrialActive} trialDaysRemaining={trialDaysRemaining} />
      {/* ── Header ── */}
      <header style={{
        background: 'var(--bg2)', borderBottom: '1px solid var(--border)',
        padding: '0 24px', minHeight: 56, display: 'flex',
        alignItems: 'center', justifyContent: 'space-between',
        position: 'sticky', top: 0, zIndex: 100,
        flexWrap: 'wrap', gap: 8, rowGap: 4,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' }}>
          <span style={{ fontSize: 20, fontWeight: 800, color: 'var(--accent)', letterSpacing: 1 }}>
            FACADE X
          </span>
          <span className="header-subtitle" style={{ color: 'var(--text3)', fontSize: 13 }}>Construction Dashboard</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', padding: '8px 0' }}>
          <span className="header-email" style={{ color: 'var(--text3)', fontSize: 12, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {session.user.email}
          </span>
          <span className="header-date" style={{ color: 'var(--text3)', fontSize: 12, whiteSpace: 'nowrap' }}>
            {new Date().toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' })}
          </span>
          <button
            className="btn btn-ghost btn-sm"
            style={{ fontSize: 12 }}
            onClick={() => setShowChangePassword(true)}
          >
            🔑 เปลี่ยนรหัสผ่าน
          </button>
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
      <main className="app-main" style={{ flex: 1, padding: '20px 24px', maxWidth: 1440, margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
        <Suspense fallback={<PageLoadingFallback />}>
          {renderPage()}
        </Suspense>
      </main>

      {showChangePassword && (
        <ChangePassword onClose={() => setShowChangePassword(false)} />
      )}
    </div>
  )
}
