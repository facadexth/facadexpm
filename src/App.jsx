// ============================================================
// FACADE X Dashboard — Main App
// Router: แต่ละ tab คือ page แยกกัน ไม่ต้อง reload หน้า
// ============================================================
import { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from './lib/supabase.js'
import { useUserRole } from './hooks/useUserRole.js'
import { useTenant } from './hooks/useTenant.js'
import { usePlatformAdmin } from './hooks/useSupabase.js'
import { ProtectedPage } from './components/ProtectedPage.jsx'
import { canViewPage } from './lib/permissions.js'
import { getEffectiveTheme, toggleTheme } from './lib/theme.js'
import ChangePassword from './components/ChangePassword.jsx'
import SiteOverviewModal from './components/SiteOverviewModal.jsx'
import TrialBanner from './components/TrialBanner.jsx'
import UpgradeModal from './components/UpgradeModal.jsx'
import ChunkErrorBoundary from './components/ChunkErrorBoundary.jsx'
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
const Retention           = lazy(() => import('./pages/Retention.jsx'))
const Deposits             = lazy(() => import('./pages/Deposits.jsx'))
const Quotations   = lazy(() => import('./pages/Quotations.jsx'))
const SalesReport  = lazy(() => import('./pages/SalesReport.jsx'))
const Invoices     = lazy(() => import('./pages/Invoices.jsx'))
const CatalogItems = lazy(() => import('./pages/CatalogItems.jsx'))
const Cheques       = lazy(() => import('./pages/Cheques.jsx'))
const TenantManagement = lazy(() => import('./pages/TenantManagement.jsx'))

const TABS = [
  { id: 'dashboard',         label: '📊 ภาพรวม',              minRole: 'WORKER', module: null },
  { id: 'assign',            label: '📋 จ่ายงานช่าง',          minRole: 'WORKER', module: 'payroll' },
  { label: '🏗️ ไซท์งาน', children: [
    { id: 'sites',     label: '📊 ภาพรวม',  minRole: 'ADMIN', module: null },
    { id: 'deposits',  label: '💰 มัดจำ',   minRole: 'ADMIN', module: 'client_deposits' },
    { id: 'retention', label: '🔒 เงินประกันผลงาน', minRole: 'ADMIN', module: null },
  ] },
  { label: '💸 รายจ่าย', children: [
    { id: 'expenses',        label: '📊 ภาพรวม',       minRole: 'ADMIN', module: null },
    { id: 'purchase_orders', label: '🧾 ใบสั่งซื้อ',   minRole: 'ADMIN', module: 'purchase_orders' },
    { id: 'cheques',         label: '🏦 เช็ค',         minRole: 'ADMIN', module: 'cheque_tracking' },
  ] },
  { label: '💰 รายรับ', children: [
    { id: 'income',        label: '📊 ภาพรวม',           minRole: 'ADMIN', module: null },
    { id: 'sales_report',  label: '📊 รายงานการขาย',    minRole: 'ADMIN', module: 'quotations' },
    { id: 'quotations',    label: '📋 ใบเสนอราคา',      minRole: 'ADMIN', module: 'quotations' },
    { id: 'invoices', label: '🧾 ใบแจ้งหนี้', minRole: 'ADMIN', module: 'invoices' },
  ] },
  { id: 'labor_contractors', label: '🔧 ผู้รับเหมาค่าแรง',    minRole: 'ADMIN',  module: 'labor_subcontractors' },
  { label: '⚙️ ตั้งค่า', children: [
    { id: 'settings',        label: 'ทั่วไป',          minRole: 'OWNER', module: null },
    { id: 'hr',              label: '👷 บุคคล',        minRole: 'WORKER', module: 'payroll' },
    { id: 'categories',      label: '🏷️ หมวดหมู่',    minRole: 'ADMIN', module: null },
    { id: 'clients',         label: '🏢 ลูกค้า',      minRole: 'ADMIN', module: null },
    { id: 'suppliers',       label: '🏭 ผู้จำหน่าย',     minRole: 'ADMIN', module: null },
    { id: 'catalog_items',   label: '📦 รายการสินค้า', minRole: 'ADMIN', module: 'quotations' },
    { id: 'user_management', label: '👤 ผู้ใช้งาน',    minRole: 'OWNER', module: null },
  ] },
  { id: 'tenant_management', label: '🏢 ผู้ดูแลระบบ', minRole: 'WORKER', module: null, platformAdminOnly: true },
]

// TABS entries are either a plain tab ({id, label, minRole, module}) or a
// group ({label, children: [...plain tabs]}) for the hover dropdown. This
// flattens both shapes into one list of plain tabs, so lookups by id don't
// need to know which shape produced them.
const ALL_TAB_ENTRIES = TABS.flatMap(t => t.children ?? [t])

// Hover-triggered dropdown for a TABS group entry (e.g. "ไซท์งาน"). Portaled
// to document.body instead of position:absolute inside <nav>, because the
// nav has overflow-x:auto -- per the CSS Overflow spec, a non-visible
// overflow-x forces the default-visible overflow-y to compute as auto too,
// so an absolutely-positioned child gets clipped by the nav's scroll box
// instead of floating over the page. A portal sidesteps this: it's no
// longer a descendant of the clipping ancestor at all.
// ✅ ทำงานได้ทั้ง hover (desktop) และแตะ 1 ครั้งเพื่อเปิด/ปิด (มือถือ -- ไม่มี
//    hover ให้ใช้) พร้อมปิดเมื่อแตะนอกพื้นที่ trigger/dropdown
function NavGroup({ tab, activeTab, onNavigate }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const triggerRef = useRef(null)
  const groupRef = useRef(null)
  const dropdownRef = useRef(null)

  const updatePos = () => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) setPos({ top: rect.bottom, left: rect.left })
  }
  const handleEnter = () => { updatePos(); setOpen(true) }
  const handleLeave = () => setOpen(false)
  const handleTriggerClick = () => {
    if (open) { setOpen(false); return }
    updatePos(); setOpen(true)
  }

  // dropdown ถูก portal ไปที่ document.body จึงไม่ใช่ DOM descendant ของ
  // groupRef -- ต้องเช็ค dropdownRef แยกด้วย ไม่งั้น pointerdown บนตัวเลือกใน
  // dropdown เองจะถูกนับเป็น "แตะนอก" แล้วปิด/unmount dropdown ก่อนที่ click
  // (ซึ่งเป็นตัวเรียก onNavigate จริงๆ, เกิดทีหลัง pointerdown) จะไปถึงปุ่มได้
  useEffect(() => {
    if (!open) return
    const handleOutside = (e) => {
      if (groupRef.current?.contains(e.target)) return
      if (dropdownRef.current?.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', handleOutside)
    return () => document.removeEventListener('pointerdown', handleOutside)
  }, [open])

  const isActive = tab.children.some(c => c.id === activeTab)

  return (
    <div ref={groupRef} onMouseEnter={handleEnter} onMouseLeave={handleLeave} style={{ display: 'inline-block' }}>
      <span
        ref={triggerRef}
        onClick={handleTriggerClick}
        style={{
          padding: '13px 18px', display: 'inline-block', cursor: 'pointer',
          borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
          color: isActive ? 'var(--accent)' : 'var(--text2)',
          fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', transition: 'all 0.2s'
        }}
      >
        {tab.label}
      </span>
      {open && pos && createPortal(
        <div
          ref={dropdownRef}
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
          style={{
            position: 'fixed', top: pos.top, left: pos.left,
            background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.25)', padding: 4, minWidth: 160, zIndex: 200
          }}
        >
          {tab.children.map(child => (
            <button
              key={child.id}
              onClick={() => { onNavigate(child); setOpen(false) }}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '10px 16px', background: 'none', border: 'none', cursor: 'pointer',
                color: activeTab === child.id ? 'var(--accent)' : 'var(--text2)',
                fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap'
              }}
            >
              {child.label}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}

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
  const [overviewSiteId, setOverviewSiteId] = useState(null)
  const [theme, setTheme] = useState(getEffectiveTheme)
  const { role, isAtLeast, loading: roleLoading } = useUserRole()
  const { tenant, isTrialActive, trialDaysRemaining, hasModuleAccess, loading: tenantLoading, refetch: refetchTenant } = useTenant()
  const { data: isPlatformAdmin, loading: platformAdminLoading } = usePlatformAdmin()

  // Single source of truth for "can this user actually be on this tab" --
  // used both to decide what shows in the nav AND to gate the page itself
  // (ProtectedPage below). Previously only the nav applied module/
  // permission/platformAdminOnly checks; the page render only checked
  // minRole, so a role-satisfying user could still reach a page's full
  // content via any cross-page navigateTo() call the nav itself didn't
  // offer (e.g. Sites' "labor cost" cell linking to Assign regardless of
  // whether the tenant's package includes the payroll module -- module-
  // gated tables are still RLS-protected server-side, but the page shell
  // itself rendered). Same gap let a platformAdminOnly tab's minRole:
  // 'WORKER' float trivially past any logged-in user.
  const passesGates = (tab) =>
    isAtLeast(tab.minRole) &&
    hasModuleAccess(tab.module) &&
    (!role || canViewPage(role, tab.id)) &&
    (!tab.platformAdminOnly || isPlatformAdmin)
  // Trial ended, no paid package chosen yet -- shown automatically, but
  // dismissible (X) without consequence; only the modal's own explicit
  // "ไม่ตอนนี้" button downgrades to Free. Re-shown from TrialBanner too.
  const [showUpgradeModal, setShowUpgradeModal] = useState(false)
  const trialJustEnded = !!tenant && !isTrialActive && tenant.plan !== 'active'
  useEffect(() => { if (trialJustEnded) setShowUpgradeModal(true) }, [trialJustEnded])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => subscription.unsubscribe()
  }, [])

  // Restores the tab a chunk-load-failure reload was trying to reach (see
  // ChunkErrorBoundary). Deliberately does NOT clear the 'chunk-reload-
  // attempted' guard here -- this effect runs on every boot, including the
  // boot immediately after the automatic reload it's recovering from. If it
  // cleared the guard, a persistent failure (not just a transient blip --
  // e.g. a cached stale index.html, or a real outage) would reload forever:
  // reload -> boot -> guard cleared -> same chunk fails again -> reload ->
  // loop. The guard is only meant to survive exactly the one recovery
  // attempt it was set for; it's cleared instead on explicit user
  // navigation (tab click / navigateTo below), which is a real signal of
  // fresh intent distinct from "the page just reloaded on its own."
  useEffect(() => {
    const pending = sessionStorage.getItem('pendingTab')
    if (pending) {
      sessionStorage.removeItem('pendingTab')
      setActiveTab(pending)
    }
  }, [])

  // After role/tenant load, redirect away from a tab the user can no
  // longer (or never could) actually use -- not just a role floor miss,
  // but also a module the tenant's package doesn't include, a per-role
  // permission override set to 'none', or a platform-admin-only tab.
  // Catches losing access to the CURRENTLY OPEN tab too (e.g. the OWNER
  // downgrades the plan or revokes a permission while someone's sitting
  // on that page) -- previously only a role change was ever re-checked.
  //
  // MUST also wait on tenantLoading, not just roleLoading: hasModuleAccess
  // reads tenant/enabledModules, which start out null/[] while useTenant()
  // is still fetching -- checking passesGates before that resolves reads
  // "not entitled to anything yet" as final and wrongly bounces away from
  // a tab the tenant actually has access to (reproduced: fresh login,
  // pendingTab='quotations' on a tenant with the module -- redirected to
  // dashboard before tenant data arrived, then never navigated back since
  // nothing re-opens a tab once redirected away from it).
  useEffect(() => {
    if (roleLoading || tenantLoading || platformAdminLoading || !session) return
    const current = ALL_TAB_ENTRIES.find(t => t.id === activeTab)
    if (current && !passesGates(current)) {
      setActiveTab(isAtLeast('ADMIN') ? 'dashboard' : 'assign')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleLoading, tenantLoading, platformAdminLoading, session, activeTab, isAtLeast, hasModuleAccess, role, isPlatformAdmin])

  const navigateTo = (tab, state = {}) => {
    // Explicit navigation is fresh user intent -- safe to let a future
    // chunk-load failure trigger its own automatic reload again, unlike
    // the pendingTab restore effect above (which must NOT clear this).
    sessionStorage.removeItem('chunk-reload-attempted')
    setNavState(state)
    setActiveTab(tab)
  }

  // gate is looked up from the SAME ALL_TAB_ENTRIES the nav filters
  // against (via passesGates above), so the page can never grant more
  // than the nav offers -- previously each case only carried a minRole
  // literal here, independent of (and looser than) what the nav actually
  // enforced for that tab (module entitlement, per-role permission
  // override, platformAdminOnly).
  const renderPage = () => {
    const props = { navigateTo, navState, openSiteOverview: setOverviewSiteId, onOpenChangePassword: () => setShowChangePassword(true), onOpenChangePlan: () => setShowUpgradeModal(true) }
    const entry = ALL_TAB_ENTRIES.find(t => t.id === activeTab) ?? ALL_TAB_ENTRIES[0]
    const gate = { minRole: entry.minRole, module: entry.module, pageKey: entry.id, platformAdminOnly: entry.platformAdminOnly, hasModuleAccess, isPlatformAdmin, tenantLoading, platformAdminLoading }

    const page = (() => {
      switch (activeTab) {
        case 'dashboard':  return <Dashboard  {...props} />
        case 'assign':     return <Assign     {...props} />
        case 'hr':         return <HR        {...props} />
        case 'sites':      return <Sites      {...props} />
        case 'expenses':   return <Expenses   {...props} />
        case 'purchase_orders': return <PurchaseOrders {...props} />
        case 'cheques':    return <Cheques    {...props} />
        case 'income':     return <Income     {...props} />
        case 'retention':  return <Retention  {...props} />
        case 'deposits':   return <Deposits   {...props} />
        case 'categories': return <Categories {...props} />
        case 'clients':    return <Clients    {...props} />
        case 'suppliers':  return <Suppliers  {...props} />
        case 'labor_contractors': return <LaborContractors {...props} />
        case 'sales_report':  return <SalesReport  {...props} />
        case 'quotations':    return <Quotations   {...props} />
        case 'invoices':      return <Invoices     {...props} />
        case 'catalog_items': return <CatalogItems {...props} />
        case 'user_management': return <UserManagement {...props} />
        case 'settings':   return <Settings   {...props} />
        case 'tenant_management': return <TenantManagement {...props} />
        default:           return <Dashboard  {...props} />
      }
    })()

    return <ProtectedPage {...gate}>{page}</ProtectedPage>
  }

  // Loading auth
  if (session === undefined) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
      <div style={{ color: 'var(--text3)', fontSize: 14 }}>กำลังโหลด...</div>
    </div>
  )

  // Not logged in
  if (!session) return <Login />

  const visibleTabs = TABS
    .map(tab => tab.children ? { ...tab, children: tab.children.filter(passesGates) } : tab)
    .filter(tab => tab.children ? tab.children.length > 0 : passesGates(tab))

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TrialBanner tenant={tenant} isTrialActive={isTrialActive} trialDaysRemaining={trialDaysRemaining}
        onChoosePackage={() => setShowUpgradeModal(true)} />
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
            onClick={() => setTheme(toggleTheme())}
            title="สลับธีมสว่าง/มืด"
          >
            {theme === 'dark' ? '☀️' : '🌙'}
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
        {visibleTabs.map(tab => tab.children ? (
          <NavGroup
            key={tab.label}
            tab={tab}
            activeTab={activeTab}
            onNavigate={child => { sessionStorage.removeItem('chunk-reload-attempted'); setNavState({}); setActiveTab(child.id) }}
          />
        ) : (
          <button
            key={tab.id}
            onClick={() => { sessionStorage.removeItem('chunk-reload-attempted'); setNavState({}); setActiveTab(tab.id) }}
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
        <ChunkErrorBoundary pendingTab={activeTab}>
          <Suspense fallback={<PageLoadingFallback />}>
            {renderPage()}
          </Suspense>
        </ChunkErrorBoundary>
      </main>

      {showChangePassword && (
        <ChangePassword onClose={() => setShowChangePassword(false)} />
      )}

      {showUpgradeModal && (
        <UpgradeModal
          tenant={tenant}
          onClose={() => setShowUpgradeModal(false)}
          onResolved={() => { setShowUpgradeModal(false); refetchTenant() }}
          onRefresh={refetchTenant}
        />
      )}

      {overviewSiteId && (
        <SiteOverviewModal siteId={overviewSiteId} onClose={() => setOverviewSiteId(null)} />
      )}
    </div>
  )
}
