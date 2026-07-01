export default function Settings() {
  const permissions = {
    WORKER: [
      { page: 'Dashboard', icon: '📊' },
      { page: 'Assign ช่าง', icon: '📋' },
      { page: 'HR', icon: '👷' },
    ],
    ADMIN: [
      { page: 'ทุกอย่างของ WORKER +', icon: '⭐' },
      { page: 'Sites', icon: '🏗️' },
      { page: 'Expenses', icon: '💸' },
      { page: 'Income', icon: '💰' },
      { page: 'Categories', icon: '🏷️' },
      { page: 'Clients', icon: '🏢' },
      { page: 'Suppliers', icon: '🏭' },
      { page: 'Labor Contractors', icon: '🔧' },
    ],
    OWNER: [
      { page: 'ทุกอย่างของ ADMIN +', icon: '⭐' },
      { page: 'User Management', icon: '👤' },
      { page: 'Settings', icon: '⚙️' },
    ],
  }

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ marginBottom: 8, fontSize: 18, fontWeight: 700 }}>⚙️ ตั้งค่าระบบ</h2>
        <p style={{ fontSize: 13, color: 'var(--text3)' }}>
          กำหนดสิทธิ์เข้าใช้งานสำหรับแต่ละ Role
        </p>
      </div>

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(350px, 1fr))' }}>
        {Object.entries(permissions).map(([role, pages]) => (
          <div key={role} className="card" style={{
            borderTop: role === 'OWNER' ? '3px solid var(--red)' : role === 'ADMIN' ? '3px solid var(--accent)' : '3px solid var(--green)',
            overflow: 'hidden'
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
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
                {pages.map((item, idx) => (
                  <li key={idx} style={{
                    padding: '10px 0',
                    borderBottom: idx < pages.length - 1 ? '1px solid var(--border)' : 'none',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    fontSize: 13,
                  }}>
                    <span style={{ fontSize: 18 }}>{item.icon}</span>
                    <span style={{ color: 'var(--text2)', fontWeight: item.page.includes('+') ? 600 : 400 }}>
                      {item.page}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ))}
      </div>

      <div className="card" style={{ marginTop: 24 }}>
        <div style={{ padding: 16 }}>
          <h3 style={{ marginTop: 0, marginBottom: 12, fontSize: 14, fontWeight: 700 }}>📌 หมายเหตุ</h3>
          <ul style={{ margin: '8px 0', paddingLeft: 20, fontSize: 13, color: 'var(--text3)', lineHeight: 1.6 }}>
            <li><strong>WORKER:</strong> ดูเฉพาะข้อมูลของตัวเอง (Assign งานกับ HR)</li>
            <li><strong>ADMIN:</strong> เพิ่ม/แก้/ลบข้อมูลโครงการ ลูกค้า ซัพพลายเออร์ ค่าใช้จ่าย ฯลฯ</li>
            <li><strong>OWNER:</strong> จัดการ Users และเข้าถึงทุกหน้า</li>
          </ul>
        </div>
      </div>
    </div>
  )
}
