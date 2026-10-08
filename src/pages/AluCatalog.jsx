// src/pages/AluCatalog.jsx
// ============================================================
// แคตตาล็อกอลูมิเนียม -- the extruder -> series -> type -> component cost
// database behind the estimation module (FacadeX only). Phase 1 of
// docs/superpowers/specs/2026-10-08-aluminium-cost-catalog-design.md.
// ============================================================
import { useState } from 'react'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import HierarchyTab from './aluCatalog/HierarchyTab.jsx'
import TypesTab from './aluCatalog/TypesTab.jsx'
import ProfilesTab from './aluCatalog/ProfilesTab.jsx'

const TABS = [
  { id: 'hierarchy', label: '🏭 โรงรีด · ซีรีส์' },
  { id: 'types',     label: '🚪 ประเภทบาน' },
  { id: 'profiles',  label: '📏 หน้าตัด · สี · ความยาว' },
]

export default function AluCatalog() {
  const { isAtLeast, role } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'estimation')
  const [tab, setTab] = useState('hierarchy')

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <button key={t.id} className={`btn btn-sm ${tab === t.id ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      {tab === 'hierarchy' && <HierarchyTab canEdit={canEdit} />}
      {tab === 'types' && <TypesTab canEdit={canEdit} />}
      {tab === 'profiles' && <ProfilesTab canEdit={canEdit} />}
    </div>
  )
}
