// PhoneDrawer — phone-only navigation (mobile-view spec §3). Rendered by App.jsx ONLY when useIsPhone()
// is true, so the desktop header / nav strip are untouched. Shows the same `visibleTabs` as the desktop nav
// (gates already applied), group accordions with sub-tabs and pending badges, then guide / theme / logout.
// Overlay tap, ✕, and the phone back button (useBackToClose, shared with Modal) close it.
import { useState } from 'react'
import { useBackToClose } from '../hooks/useBackToClose.js'
import { formatBadge } from '../lib/pendingItems.js'

function Badge({ n }) {
  return n > 0 ? <span className="phone-badge">{formatBadge(n)}</span> : null
}

function DrawerBody({ onClose, tabs, activeTab, byTab, badgeForGroup, onNavigate, onManual, onTheme, theme, onLogout, email, role, companyName }) {
  useBackToClose(onClose)
  const [openGroup, setOpenGroup] = useState(() => tabs.find(t => t.children?.some(c => c.id === activeTab))?.label || null)
  const go = tab => { onNavigate(tab); onClose() }
  return (
    <div className="phone-drawer-overlay" data-testid="phone-drawer-overlay" onClick={onClose}>
      <div className="phone-drawer" role="dialog" aria-label="เมนู" onClick={e => e.stopPropagation()}>
        <div className="phone-drawer-who">
          <div className="phone-drawer-company">{companyName}</div>
          <div className="phone-drawer-user">{email}{role ? ` · ${role}` : ''}</div>
          <button type="button" className="phone-drawer-close" aria-label="ปิดเมนู" onClick={onClose}>✕</button>
        </div>
        {tabs.map(tab => tab.children ? (
          <div key={tab.label} className="phone-drawer-group">
            <button
              type="button"
              className={`phone-drawer-tab${tab.children.some(c => c.id === activeTab) ? ' on' : ''}`}
              aria-expanded={openGroup === tab.label}
              onClick={() => setOpenGroup(g => (g === tab.label ? null : tab.label))}
            >
              <span>{tab.label}</span>
              <span><Badge n={badgeForGroup(tab)} /> {openGroup === tab.label ? '▾' : '▸'}</span>
            </button>
            {openGroup === tab.label && (
              <div className="phone-drawer-subs">
                {tab.children.map(c => (
                  <button key={c.id} type="button" className={`phone-drawer-sub${c.id === activeTab ? ' on' : ''}`} onClick={() => go(c)}>
                    <span>{c.label}</span><Badge n={byTab[c.id]} />
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <button key={tab.id} type="button" className={`phone-drawer-tab${tab.id === activeTab ? ' on' : ''}`} onClick={() => go(tab)}>
            <span>{tab.label}</span><Badge n={byTab[tab.id]} />
          </button>
        ))}
        <div className="phone-drawer-foot">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { onManual(); onClose() }}>📖 คู่มือ</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onTheme}>{theme === 'dark' ? '☀️ โหมดสว่าง' : '🌙 โหมดมืด'}</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onLogout}>ออกจากระบบ</button>
        </div>
      </div>
    </div>
  )
}

export default function PhoneDrawer({ open, byTab = {}, badgeForGroup = () => 0, ...rest }) {
  if (!open) return null
  return <DrawerBody byTab={byTab} badgeForGroup={badgeForGroup} {...rest} />
}
