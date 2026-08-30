// ============================================================
// ProtectedPage — wraps a page and blocks access unless ALL of:
//   - role floor (minRole, same hierarchy as useUserRole: OWNER >= ADMIN >= WORKER)
//   - module entitlement (module: the tenant's package must include it,
//     via hasModuleAccess -- pass the same fn App.jsx already gets from
//     useTenant(), never call useTenant() again here, it has a side
//     effect (tenant_apply_pending_downgrade))
//   - per-role page permission (pageKey: OWNER-configurable in Settings,
//     stored in localStorage -- NOT itself an RLS-backed security
//     boundary, but this is the only place that was ever supposed to
//     enforce it, so a page must not render past it)
//   - platform-admin-only (platformAdminOnly + isPlatformAdmin)
// all hold. These MUST mirror the exact same gates App.jsx's nav uses to
// decide what's visible (see passesGates in App.jsx) -- this component
// is what actually stops a page from rendering when a cross-page link,
// stale state, or a tab losing entitlement while it's the open one would
// otherwise let it through on a role check alone.
// Usage: <ProtectedPage minRole="ADMIN" module="invoices" pageKey="invoices"
//          hasModuleAccess={hasModuleAccess}><Invoices /></ProtectedPage>
// ============================================================
import { useUserRole } from '../hooks/useUserRole.js'
import { canViewPage } from '../lib/permissions.js'

function Denied({ text }) {
  return (
    <div style={{ padding: 40, textAlign: 'center' }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>🔒</div>
      <div style={{ color: 'var(--red)', fontWeight: 700, fontSize: 16, marginBottom: 8 }}>
        ไม่มีสิทธิ์เข้าหน้านี้
      </div>
      <div style={{ color: 'var(--text3)', fontSize: 13 }}>{text}</div>
    </div>
  )
}

export function ProtectedPage({ minRole, module, pageKey, platformAdminOnly, hasModuleAccess, isPlatformAdmin, children }) {
  const { loading, isAtLeast, role } = useUserRole()

  if (loading) {
    return (
      <div style={{ padding: 40, color: 'var(--text3)', textAlign: 'center', fontSize: 14 }}>
        กำลังโหลด...
      </div>
    )
  }

  if (!isAtLeast(minRole)) {
    return <Denied text={`ต้องการสิทธิ์ระดับ ${minRole} ขึ้นไป`} />
  }

  if (platformAdminOnly && !isPlatformAdmin) {
    return <Denied text="หน้านี้สำหรับผู้ดูแลระบบเท่านั้น" />
  }

  if (module && hasModuleAccess && !hasModuleAccess(module)) {
    return <Denied text="ฟีเจอร์นี้ไม่ได้เปิดใช้งานสำหรับแพ็กเกจปัจจุบันของคุณ" />
  }

  if (pageKey && role && !canViewPage(role, pageKey)) {
    return <Denied text="ถูกจำกัดสิทธิ์เข้าหน้านี้โดยผู้ดูแลระบบของบริษัท" />
  }

  return children
}
