// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import PhoneDrawer from './PhoneDrawer.jsx'

afterEach(cleanup)

const tabs = [
  { id: 'dashboard', label: '📊 ภาพรวม' },
  { label: '💰 รายรับ', children: [{ id: 'income', label: '📊 ภาพรวม' }, { id: 'quotations', label: '📋 ใบเสนอราคา' }] },
  { label: '💸 รายจ่าย', children: [{ id: 'expenses', label: '📊 ภาพรวม' }, { id: 'cheques', label: '🏦 เช็ค' }] },
]
const base = () => ({
  open: true, onClose: vi.fn(), tabs, activeTab: 'quotations', byTab: { quotations: 3, cheques: 1 },
  badgeForGroup: tab => tab.children?.reduce((s, c) => s + ({ quotations: 3, cheques: 1 }[c.id] || 0), 0) || 0,
  onNavigate: vi.fn(), onManual: vi.fn(), onTheme: vi.fn(), theme: 'dark', onLogout: vi.fn(),
  email: 'a@b.c', role: 'OWNER', companyName: 'บจก. ทดสอบ',
})

// A real browser answers history.back() with a popstate; the hook's module counter relies on that, so simulate it.
beforeEach(() => vi.spyOn(window.history, 'back').mockImplementation(() => window.dispatchEvent(new PopStateEvent('popstate'))))

describe('PhoneDrawer', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<PhoneDrawer {...base()} open={false} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows who, groups, expands the active group with badges, navigates and closes', () => {
    const p = base()
    render(<PhoneDrawer {...p} />)
    expect(screen.getByText('บจก. ทดสอบ')).toBeTruthy()
    expect(screen.getByText('a@b.c · OWNER')).toBeTruthy()
    expect(screen.getByText('📋 ใบเสนอราคา')).toBeTruthy()       // active group starts expanded
    expect(screen.queryByText('🏦 เช็ค')).toBeNull()              // the other group is collapsed
    expect(screen.getAllByText('3')).toHaveLength(2)              // group badge + sub-tab badge
    fireEvent.click(screen.getByText('📋 ใบเสนอราคา'))
    expect(p.onNavigate).toHaveBeenCalledWith(tabs[1].children[1])
    expect(p.onClose).toHaveBeenCalled()
  })

  it('a collapsed group opens on tap; a plain tab navigates with the tab itself; overlay tap closes', () => {
    const p = base()
    render(<PhoneDrawer {...p} />)
    fireEvent.click(screen.getByText('💸 รายจ่าย'))
    expect(screen.getByText('🏦 เช็ค')).toBeTruthy()
    fireEvent.click(screen.getByText('📊 ภาพรวม', { selector: '.phone-drawer-tab span' }))
    expect(p.onNavigate).toHaveBeenCalledWith(tabs[0])
    fireEvent.click(screen.getByTestId('phone-drawer-overlay'))
    expect(p.onClose).toHaveBeenCalled()
  })

  it('footer buttons: manual (then close), theme, logout; back button closes', () => {
    const p = base()
    render(<PhoneDrawer {...p} />)
    fireEvent.click(screen.getByText('📖 คู่มือ'))
    expect(p.onManual).toHaveBeenCalled(); expect(p.onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('☀️ โหมดสว่าง'))
    expect(p.onTheme).toHaveBeenCalled()
    fireEvent.click(screen.getByText('ออกจากระบบ'))
    expect(p.onLogout).toHaveBeenCalled()
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(p.onClose).toHaveBeenCalledTimes(2)
  })
})
