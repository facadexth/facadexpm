// ============================================================
// ProtectedPage — wraps a page and blocks access if role is
// insufficient. minRole uses the same hierarchy as useUserRole:
//   OWNER >= ADMIN >= WORKER
// Usage: <ProtectedPage minRole="ADMIN"><Clients /></ProtectedPage>
// ============================================================
import { useUserRole } from '../hooks/useUserRole.js'

export function ProtectedPage({ minRole, children }) {
  const { loading, isAtLeast } = useUserRole()

  if (loading) {
    return (
      <div style={{ padding: 40, color: 'var(--text3)', textAlign: 'center', fontSize: 14 }}>
        กำลังโหลด...
      </div>
    )
  }

  if (!isAtLeast(minRole)) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🔒</div>
        <div style={{ color: 'var(--red)', fontWeight: 700, fontSize: 16, marginBottom: 8 }}>
          ไม่มีสิทธิ์เข้าหน้านี้
        </div>
        <div style={{ color: 'var(--text3)', fontSize: 13 }}>
          ต้องการสิทธิ์ระดับ {minRole} ขึ้นไป
        </div>
      </div>
    )
  }

  return children
}
