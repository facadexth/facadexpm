# Mobile view — round 1 (shell + primitives + 4 pages) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phones (≤ 900 px) get a drawer menu, card lists, a filter sheet, full-screen modals and usable forms on Dashboard, Sites, Quotations, while laptop and landscape-tablet rendering stays byte-identical.

**Architecture:** One hook (`useIsPhone`), one CSS file wrapped in a single `@media (max-width: 900px)` block, and wrapper components whose desktop branch returns `children` untouched. Tables keep their markup; `CardTable` decorates cells with `data-label` and role classes at phone width only, and CSS renders them as cards. The drawer and sheets reuse the Modal's back-button mechanism.

**Tech Stack:** React 18, plain CSS (src/index.css tokens), vitest + jsdom, Playwright only for the existing smoke test.

**Spec:** `docs/superpowers/specs/2026-10-15-mobile-view-design.md` (sections 2–6, 8 round 1).

## Global Constraints

- Every new CSS rule lives in `src/mobile.css` inside the one `@media (max-width: 900px) { … }` block; `src/index.css` is not edited.
- Every JSX change is gated: `isPhone ? <phone/> : <original/>`, or a wrapper whose desktop branch returns `children` (Fragment). Desktop DOM must stay identical (no new elements, classes or inline styles on desktop). Only `inputMode`, `aria-*`, `data-*` attributes may be added to shared elements.
- Breakpoint is exactly `(max-width: 900px)`; constant `PHONE_QUERY` exported from `src/hooks/useIsPhone.js`.
- Thai UI text; commit messages via `git commit -F <file>`; every commit ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_0139hUNtVFb4DkimmJ3YCSGW`.
- `npx vitest run` green before every commit.

## Review Focus

1. A table whose first row is the empty-state row (`<td colSpan>`): the card view must not turn it into a labelled card (Task 4 test).
2. Header text with a sort glyph (`รหัส ↑`): `data-label` must strip ` ↑`, ` ↓`, ` ↕`, ` ⇅` (Task 4 test).
3. Drawer open + browser back: closes the drawer, does not leave the page (Task 2 test on the hook, Task 3 manual).
4. `PhoneFilters` on desktop must render children with no wrapper element, or desktop layout changes (Task 5 test asserts `container.firstChild` is the child itself).
5. Modal on phone with a long form: footer buttons must stay reachable (sticky footer, Task 6 CSS) and `ConfirmDialog` must stay small (`modal-confirm` class).

---

### Task 1: `useIsPhone` hook, `mobile.css` skeleton, static CSS test

**Files:**
- Create: `src/hooks/useIsPhone.js`
- Create: `src/hooks/useIsPhone.test.js`
- Create: `src/mobile.css`
- Create: `src/mobile.css.test.js`
- Modify: `src/main.jsx` (import after `./index.css`)

**Interfaces:**
- Produces: `useIsPhone(): boolean`, `PHONE_QUERY = '(max-width: 900px)'`, `isPhoneNow(): boolean` (non-hook helper for effects).

- [ ] **Step 1: Write the failing hook test**

```js
// src/hooks/useIsPhone.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useIsPhone, PHONE_QUERY, isPhoneNow } from './useIsPhone.js'

function mockMatchMedia(matches) {
  const listeners = new Set()
  const mql = {
    matches, media: PHONE_QUERY,
    addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn),
    fire(next) { mql.matches = next; listeners.forEach(fn => fn({ matches: next })) },
  }
  window.matchMedia = q => { if (q !== PHONE_QUERY) throw new Error('unexpected query ' + q); return mql }
  return mql
}

describe('useIsPhone', () => {
  let saved
  beforeEach(() => { saved = window.matchMedia })
  afterEach(() => { window.matchMedia = saved })
  it('reads the media query and follows changes', () => {
    const mql = mockMatchMedia(false)
    const { result } = renderHook(() => useIsPhone())
    expect(result.current).toBe(false)
    act(() => mql.fire(true))
    expect(result.current).toBe(true)
    expect(isPhoneNow()).toBe(true)
  })
  it('is false when matchMedia is missing (SSR / old browsers)', () => {
    window.matchMedia = undefined
    const { result } = renderHook(() => useIsPhone())
    expect(result.current).toBe(false)
    expect(isPhoneNow()).toBe(false)
  })
})
```

- [ ] **Step 2: Run it, expect "Failed to resolve import ./useIsPhone.js"**

Run: `npx vitest run src/hooks/useIsPhone.test.js`

- [ ] **Step 3: Implement the hook**

```js
// src/hooks/useIsPhone.js
// Phone layout gate. ONE breakpoint for the whole app; src/mobile.css uses the same query.
// Desktop (> 900px) renders the original JSX untouched, so laptop / landscape tablet never change.
import { useEffect, useState } from 'react'

export const PHONE_QUERY = '(max-width: 900px)'

export function isPhoneNow() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches
}

export function useIsPhone() {
  const [phone, setPhone] = useState(isPhoneNow)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(PHONE_QUERY)
    const onChange = e => setPhone(e.matches)
    setPhone(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return phone
}
```

- [ ] **Step 4: Write the failing static CSS test**

```js
// src/mobile.css.test.js
// Guarantees constraint 1 of the spec: every rule in mobile.css is inside ONE `@media (max-width: 900px)` block.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('./mobile.css', import.meta.url), 'utf8')
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')

describe('mobile.css is phone-only', () => {
  it('has exactly one @media block, with the phone query', () => {
    const medias = stripped.match(/@media[^{]*\{/g) || []
    expect(medias).toHaveLength(1)
    expect(medias[0].replace(/\s+/g, ' ')).toBe('@media (max-width: 900px) {')
  })
  it('has no rule outside that block', () => {
    const start = stripped.indexOf('@media')
    const before = stripped.slice(0, start).trim()
    expect(before).toBe('')
    // find the matching close brace of the media block
    let depth = 0, i = stripped.indexOf('{', start)
    for (; i < stripped.length; i++) {
      if (stripped[i] === '{') depth++
      else if (stripped[i] === '}') { depth--; if (depth === 0) break }
    }
    expect(stripped.slice(i + 1).trim()).toBe('')
  })
  it('does not use !important on desktop-shared selectors by accident', () => {
    expect(stripped).not.toMatch(/@media\s*\(min-width/)
  })
})
```

- [ ] **Step 5: Create the CSS skeleton and import it**

```css
/* src/mobile.css — PHONE ONLY. Everything here is inside one @media block; src/mobile.css.test.js enforces it.
   Laptop and landscape tablet (> 900px) never read a rule from this file. Tokens come from index.css. */
@media (max-width: 900px) {
  :root { --phone-tap: 44px; }
}
```

`src/main.jsx`: add `import './mobile.css'` on the line after `import './index.css'`.

- [ ] **Step 6: Run both tests, expect PASS; run the whole suite**

Run: `npx vitest run src/hooks/useIsPhone.test.js src/mobile.css.test.js && npx vitest run`

- [ ] **Step 7: Commit**

`feat(mobile): useIsPhone hook, phone-only mobile.css with static guard`

---

### Task 2: Extract `useBackToClose` from `Modal` (behaviour unchanged)

**Files:**
- Create: `src/hooks/useBackToClose.js`
- Create: `src/hooks/useBackToClose.test.js`
- Modify: `src/components/Modal.jsx:9-83` (replace the inline effect with the hook; keep the comments)

**Interfaces:**
- Produces: `useBackToClose(onClose)` — pushes a history entry on mount, closes on popstate (honours `onClose() === false` by re-pushing), pops its own entry on unmount when closed another way; module-level `suppressPopstateCount` moves into the hook file.

- [ ] **Step 1: Write the failing test (jsdom history)**

```js
// src/hooks/useBackToClose.test.js
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useBackToClose } from './useBackToClose.js'

describe('useBackToClose', () => {
  it('pushes an entry on mount and calls onClose on popstate', () => {
    const onClose = vi.fn()
    const before = window.history.length
    renderHook(() => useBackToClose(onClose))
    expect(window.history.state).toEqual({ modalOpen: true })
    expect(window.history.length).toBe(before + 1)
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('re-pushes when onClose returns false (refused close)', () => {
    const onClose = vi.fn(() => false)
    renderHook(() => useBackToClose(onClose))
    window.history.replaceState(null, '')          // simulate the browser having consumed the entry
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(window.history.state).toEqual({ modalOpen: true })
  })
  it('pops its own entry on unmount when not closed by back', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { unmount } = renderHook(() => useBackToClose(() => {}))
    unmount()
    expect(back).toHaveBeenCalledTimes(1)
    back.mockRestore()
  })
})
```

- [ ] **Step 2: Run, expect import failure**

Run: `npx vitest run src/hooks/useBackToClose.test.js`

- [ ] **Step 3: Create the hook by moving the code out of Modal.jsx**

Move `let suppressPopstateCount = 0` and the first `useEffect` of `Modal` (lines 43–75) verbatim into:

```js
// src/hooks/useBackToClose.js
import { useEffect, useRef } from 'react'
// (keep the long Thai comments from Modal.jsx above this line)
let suppressPopstateCount = 0

/** Phone back button closes an overlay instead of leaving the page. Same contract as Modal: onClose() === false keeps it open. */
export function useBackToClose(onClose) {
  const closedByBackRef = useRef(false)
  useEffect(() => {
    window.history.pushState({ modalOpen: true }, '')
    const handlePopState = () => {
      if (suppressPopstateCount > 0) { suppressPopstateCount -= 1; return }
      closedByBackRef.current = true
      if (onClose() === false) { closedByBackRef.current = false; window.history.pushState({ modalOpen: true }, ''); return }
    }
    window.addEventListener('popstate', handlePopState)
    return () => {
      window.removeEventListener('popstate', handlePopState)
      if (!closedByBackRef.current && window.history.state?.modalOpen) {
        suppressPopstateCount += 1
        window.history.back()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
```

In `Modal.jsx`: `import { useBackToClose } from '../hooks/useBackToClose.js'`, delete the moved code, call `useBackToClose(onClose)` where the effect was. Keep the Escape effect and JSX untouched.

- [ ] **Step 4: Run the hook test and the whole suite, expect PASS**

- [ ] **Step 5: Commit** `refactor(modal): extract useBackToClose (no behaviour change)`

---

### Task 3: Phone header, breadcrumb and `PhoneDrawer` in App.jsx

**Files:**
- Create: `src/components/PhoneDrawer.jsx`
- Create: `src/components/PhoneDrawer.test.jsx`
- Modify: `src/App.jsx` (header block lines ~486–541, nav block ~543–571)
- Modify: `src/mobile.css`

**Interfaces:**
- Consumes: `useIsPhone`, `useBackToClose`, `visibleTabs`, `pendingByTab`, `badgeForTab`, `NavBadge`, `activeTab`, the nav click handler, `setShowManual`, `toggleTheme`/`setTheme`, `supabase.auth.signOut`, `session.user.email`, `role`, `tenant.company_name`.
- Produces: `<PhoneDrawer open onClose tabs activeTab byTab onNavigate onManual onTheme theme onLogout email role companyName />`.

- [ ] **Step 1: Write the failing component test**

```jsx
// src/components/PhoneDrawer.test.jsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import PhoneDrawer from './PhoneDrawer.jsx'

const tabs = [
  { id: 'dashboard', label: '📊 ภาพรวม' },
  { label: '💰 รายรับ', children: [{ id: 'income', label: '📊 ภาพรวม' }, { id: 'quotations', label: '📋 ใบเสนอราคา' }] },
]
const base = { open: true, onClose: vi.fn(), tabs, activeTab: 'quotations', byTab: { quotations: 3 }, onNavigate: vi.fn(),
  onManual: vi.fn(), onTheme: vi.fn(), theme: 'dark', onLogout: vi.fn(), email: 'a@b.c', role: 'OWNER', companyName: 'บจก. ทดสอบ' }

describe('PhoneDrawer', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<PhoneDrawer {...base} open={false} />)
    expect(container.firstChild).toBeNull()
  })
  it('shows groups, expands the active group, navigates and closes', () => {
    render(<PhoneDrawer {...base} />)
    expect(screen.getByText('บจก. ทดสอบ')).toBeTruthy()
    expect(screen.getByText('📋 ใบเสนอราคา')).toBeTruthy()      // active group starts expanded
    expect(screen.getByText('3')).toBeTruthy()                    // badge
    fireEvent.click(screen.getByText('📋 ใบเสนอราคา'))
    expect(base.onNavigate).toHaveBeenCalledWith(tabs[1].children[1])
    expect(base.onClose).toHaveBeenCalled()
  })
  it('a plain tab navigates with the tab itself; overlay tap closes', () => {
    render(<PhoneDrawer {...base} />)
    fireEvent.click(screen.getByText('📊 ภาพรวม', { selector: '.phone-drawer-tab' }))
    expect(base.onNavigate).toHaveBeenCalledWith(tabs[0])
    fireEvent.click(screen.getByTestId('phone-drawer-overlay'))
    expect(base.onClose).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run, expect failure**

- [ ] **Step 3: Implement `PhoneDrawer`**

```jsx
// src/components/PhoneDrawer.jsx — phone-only navigation (spec §3). Never rendered on desktop.
import { useState } from 'react'
import { useBackToClose } from '../hooks/useBackToClose.js'

function Badge({ n }) { return n > 0 ? <span className="phone-badge">{n}</span> : null }

function DrawerBody({ onClose, tabs, activeTab, byTab, onNavigate, onManual, onTheme, theme, onLogout, email, role, companyName, badgeForGroup }) {
  useBackToClose(onClose)
  const [openGroup, setOpenGroup] = useState(() => tabs.find(t => t.children?.some(c => c.id === activeTab))?.label || null)
  const go = tab => { onNavigate(tab); onClose() }
  return (
    <div className="phone-drawer-overlay" data-testid="phone-drawer-overlay" onClick={onClose}>
      <div className="phone-drawer" onClick={e => e.stopPropagation()} role="dialog" aria-label="เมนู">
        <div className="phone-drawer-who">
          <div className="phone-drawer-company">{companyName}</div>
          <div className="phone-drawer-user">{email}{role ? ` · ${role}` : ''}</div>
          <button type="button" className="phone-drawer-close" onClick={onClose} aria-label="ปิดเมนู">✕</button>
        </div>
        {tabs.map(tab => tab.children ? (
          <div key={tab.label} className="phone-drawer-group">
            <button type="button" className={`phone-drawer-tab${tab.children.some(c => c.id === activeTab) ? ' on' : ''}`}
              onClick={() => setOpenGroup(g => (g === tab.label ? null : tab.label))}>
              <span>{tab.label}</span><span><Badge n={badgeForGroup(tab)} /> {openGroup === tab.label ? '▾' : '▸'}</span>
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

export default function PhoneDrawer({ open, badgeForGroup = () => 0, ...rest }) {
  if (!open) return null
  return <DrawerBody badgeForGroup={badgeForGroup} {...rest} />
}
```

- [ ] **Step 4: Gate the shell in App.jsx**

In the main `App` component add `const isPhone = useIsPhone()` and `const [drawerOpen, setDrawerOpen] = useState(false)`. Define once, above the return:

```jsx
const navTo = tab => { sessionStorage.removeItem('chunk-reload-attempted'); setNavState({}); setActiveTab(tab.id) }
const activeEntry = visibleTabs.flatMap(t => t.children ? t.children.map(c => ({ group: t.label, tab: c })) : [{ group: null, tab: t }]).find(e => e.tab.id === activeTab)
```

Replace the `<header …>` element with `{isPhone ? (phone header) : (the existing header JSX, unchanged)}` where the phone header is:

```jsx
<header className="phone-header">
  <button type="button" className="phone-iconbtn" aria-label="เมนู" onClick={() => setDrawerOpen(true)}>☰</button>
  {tenant?.logo_url ? <img src={tenant.logo_url} alt="" className="phone-logo" /> : null}
  <span className="phone-title">{tenant?.company_name || 'CHANG'}</span>
  <NotificationBell items={pendingItems} onRefresh={refetchPending} onOpenItem={item => navigateTo(item.tab, { pending: item.key, pendingCount: item.count })} />
</header>
```

Replace the `<nav …>` element with `{isPhone ? (breadcrumb) : (existing nav JSX, unchanged)}`:

```jsx
<div className="phone-crumb">{activeEntry?.group ? <>{activeEntry.group} › <b>{activeEntry.tab.label}</b></> : <b>{activeEntry?.tab.label || ''}</b>}</div>
```

After `</StickyChrome>` add (phone only):

```jsx
{isPhone && <PhoneDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} tabs={visibleTabs} activeTab={activeTab} byTab={pendingByTab}
  badgeForGroup={tab => badgeForTab(tab, pendingByTab)} onNavigate={navTo} onManual={() => setShowManual(true)}
  onTheme={() => setTheme(toggleTheme())} theme={theme} onLogout={() => supabase.auth.signOut()}
  email={session.user.email} role={role} companyName={tenant?.company_name || ''} />}
```

The desktop nav's inline handlers stay as they are (do not replace them with `navTo`, to keep the desktop diff empty).

- [ ] **Step 5: CSS (inside the media block)**

```css
  .phone-header { display:flex; align-items:center; gap:8px; min-height:52px; padding:6px 12px; background:var(--bg2); border-bottom:1px solid var(--border); }
  .phone-iconbtn { width:40px; height:40px; border-radius:10px; border:1px solid var(--border); background:var(--bg3); color:var(--text); font-size:18px; display:grid; place-items:center; }
  .phone-logo { height:28px; width:auto; display:block; }
  .phone-title { flex:1; min-width:0; font-weight:700; font-size:15px; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .phone-crumb { font-size:12px; color:var(--text2); padding:6px 12px; background:var(--bg2); border-bottom:1px solid var(--border); }
  .phone-crumb b { color:var(--accent); }
  .phone-drawer-overlay { position:fixed; inset:0; background:rgba(0,0,0,.55); z-index:300; }
  .phone-drawer { position:absolute; top:0; bottom:0; left:0; width:min(82vw, 340px); background:var(--bg2); border-right:1px solid var(--border); overflow-y:auto; padding:12px 10px calc(16px + env(safe-area-inset-bottom, 0px)); }
  .phone-drawer-who { position:relative; padding:4px 8px 10px; border-bottom:1px solid var(--border); margin-bottom:6px; }
  .phone-drawer-company { font-weight:700; color:var(--text); }
  .phone-drawer-user { font-size:12px; color:var(--text2); }
  .phone-drawer-close { position:absolute; top:0; right:0; width:36px; height:36px; background:none; border:none; color:var(--text2); font-size:16px; }
  .phone-drawer-tab, .phone-drawer-sub { display:flex; justify-content:space-between; align-items:center; width:100%; min-height:var(--phone-tap); padding:8px 10px; background:none; border:none; border-radius:10px; color:var(--text2); font-weight:700; font-size:14px; text-align:left; }
  .phone-drawer-sub { padding-left:26px; font-weight:600; }
  .phone-drawer-tab.on, .phone-drawer-sub.on { background:var(--bg3); color:var(--accent); }
  .phone-badge { background:var(--red); color:#000; font-size:10px; font-weight:700; border-radius:999px; padding:0 6px; line-height:16px; }
  .phone-drawer-foot { display:flex; flex-wrap:wrap; gap:8px; margin-top:14px; padding-top:10px; border-top:1px solid var(--border); }
  .app-main { padding:12px !important; }
```

- [ ] **Step 6: Run tests + build, then look at 390 px through the iframe harness (header, drawer open/close, breadcrumb)**

- [ ] **Step 7: Commit** `feat(mobile): phone header, breadcrumb and drawer menu`

---

### Task 4: `CardTable` with role inference

**Files:**
- Create: `src/components/CardTable.jsx`
- Create: `src/lib/cardTable.js` (pure: role inference + label cleanup)
- Create: `src/lib/cardTable.test.js`
- Create: `src/components/CardTable.test.jsx`
- Modify: `src/mobile.css`

**Interfaces:**
- Produces: `<CardTable map? className?>` — desktop: `<div className={className || 'table-wrap'}>{children}</div>`; phone: same div + `card-table` class + decoration.
- Produces (pure): `inferRoles(headers: string[], sampleRow: {text, numeric, hasBadge, hasButton}[], map?) → string[]` (one of `title|amount|status|actions|sub|row|hide` per column), `cleanLabel(text)`.

- [ ] **Step 1: Pure tests**

```js
// src/lib/cardTable.test.js
import { describe, it, expect } from 'vitest'
import { inferRoles, cleanLabel } from './cardTable.js'

const cell = (o = {}) => ({ text: 'x', numeric: false, hasBadge: false, hasButton: false, ...o })

describe('cleanLabel', () => {
  it('strips sort glyphs and trims', () => {
    expect(cleanLabel('รหัส ↑')).toBe('รหัส'); expect(cleanLabel('ชื่อ ↕ ')).toBe('ชื่อ'); expect(cleanLabel('ยอด ⇅')).toBe('ยอด'); expect(cleanLabel(' สถานะ↓')).toBe('สถานะ')
  })
})

describe('inferRoles', () => {
  it('quotation-like table', () => {
    const headers = ['เลขที่', 'วันที่', 'ลูกค้า', 'ไซท์งาน', 'รายการ', 'ยอดรวม', 'สถานะ', '']
    const row = [cell({ text: 'QT1' }), cell({ text: '14 ต.ค.' }), cell({ text: 'คุณบิ๊ก' }), cell({ text: 'บ้าน' }), cell({ text: '6 รายการ' }),
      cell({ text: '186,500.00', numeric: true }), cell({ text: 'รออนุมัติ', hasBadge: true }), cell({ text: '', hasButton: true })]
    expect(inferRoles(headers, row)).toEqual(['title', 'sub', 'sub', 'row', 'row', 'amount', 'status', 'actions'])
  })
  it('skips # / ลำดับ for the title, map overrides', () => {
    const headers = ['#', 'ชื่อ', 'จำนวน']
    const row = [cell({ text: '1', numeric: true }), cell({ text: 'a' }), cell({ text: '5', numeric: true })]
    expect(inferRoles(headers, row)).toEqual(['hide', 'title', 'row'])
    expect(inferRoles(headers, row, { amount: 'จำนวน', hide: [] })).toEqual(['row', 'title', 'amount'])
  })
  it('last numeric column with a money header wins as amount; others stay rows', () => {
    const headers = ['ชื่อ', 'จำนวน', 'ราคา/หน่วย', 'รวม']
    const row = [cell(), cell({ numeric: true }), cell({ numeric: true }), cell({ numeric: true })]
    expect(inferRoles(headers, row)).toEqual(['title', 'row', 'row', 'amount'])
  })
  it('no sample row (empty table) → title only from headers', () => {
    expect(inferRoles(['รหัส', 'ชื่อ'], null)).toEqual(['title', 'sub'])
  })
})
```

- [ ] **Step 2: Implement the pure part**

```js
// src/lib/cardTable.js — pure helpers for CardTable (phone card view of a desktop table). Tested in cardTable.test.js.
const SORT_GLYPHS = /[\s ]*[↑↓↕⇅▲▼]+[\s ]*$/
export function cleanLabel(text) { return String(text || '').replace(SORT_GLYPHS, '').trim() }

const MONEY = /ยอด|มูลค่า|ราคา|รวม|จำนวนเงิน|บาท|คงเหลือ|ค้าง|amount|total|value/i
const INDEX = /^(#|ลำดับ|no\.?)$/i

/** map: { title, amount, status, actions, sub: [], hide: [] } with header text (cleaned) or column index. */
export function inferRoles(headers, sampleRow, map = {}) {
  const n = headers.length
  const roles = new Array(n).fill('row')
  const labels = headers.map(cleanLabel)
  const idx = ref => (typeof ref === 'number' ? ref : labels.indexOf(ref))
  const used = new Set()
  const setRole = (ref, role) => { const i = idx(ref); if (i >= 0 && i < n) { roles[i] = role; used.add(i) } }
  const hide = map.hide ?? labels.map((l, i) => (INDEX.test(l) ? i : -1)).filter(i => i >= 0)
  hide.forEach(h => setRole(h, 'hide'))
  if (map.title !== undefined) setRole(map.title, 'title')
  if (map.amount !== undefined) setRole(map.amount, 'amount')
  if (map.status !== undefined) setRole(map.status, 'status')
  if (map.actions !== undefined) setRole(map.actions === 'last' ? n - 1 : map.actions, 'actions')
  ;(map.sub || []).forEach(s => setRole(s, 'sub'))
  const row = sampleRow || []
  const free = i => !used.has(i)
  if (map.actions === undefined && n > 0 && free(n - 1) && (row[n - 1]?.hasButton || labels[n - 1] === '')) setRole(n - 1, 'actions')
  if (map.status === undefined) { const i = row.findIndex((c, k) => free(k) && c.hasBadge); if (i >= 0) setRole(i, 'status') }
  if (map.amount === undefined) {
    for (let i = n - 1; i >= 0; i--) if (free(i) && (row[i]?.numeric || !sampleRow) && MONEY.test(labels[i])) { setRole(i, 'amount'); break }
  }
  if (map.title === undefined) { const i = labels.findIndex((l, k) => free(k) && !(row[k]?.numeric)); if (i >= 0) setRole(i, 'title') }
  if (!map.sub) {
    let left = 2
    for (let i = 0; i < n && left > 0; i++) if (free(i) && !(row[i]?.numeric) && !row[i]?.hasBadge && !row[i]?.hasButton) { setRole(i, 'sub'); left-- }
  }
  return roles
}
```

- [ ] **Step 3: Component tests (jsdom)**

```jsx
// src/components/CardTable.test.jsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import CardTable from './CardTable.jsx'
import * as phone from '../hooks/useIsPhone.js'

const Table = () => (
  <table><thead><tr><th>เลขที่ ↑</th><th>ลูกค้า</th><th>ยอดรวม</th><th>สถานะ</th><th></th></tr></thead>
    <tbody>
      <tr><td>QT1</td><td>คุณบิ๊ก</td><td>186,500.00</td><td><span className="badge badge-pending">รอ</span></td><td><button>⋮</button></td></tr>
    </tbody></table>
)

describe('CardTable', () => {
  beforeEach(() => vi.restoreAllMocks())
  it('desktop: renders exactly the table-wrap div, no attributes added', () => {
    vi.spyOn(phone, 'useIsPhone').mockReturnValue(false)
    const { container } = render(<CardTable><Table /></CardTable>)
    const wrap = container.firstChild
    expect(wrap.className).toBe('table-wrap')
    expect(wrap.getAttribute('data-phone')).toBeNull()
    expect(container.querySelector('td[data-label]')).toBeNull()
  })
  it('phone: decorates cells with data-label and roles', () => {
    vi.spyOn(phone, 'useIsPhone').mockReturnValue(true)
    const { container } = render(<CardTable><Table /></CardTable>)
    expect(container.firstChild.className).toBe('table-wrap card-table')
    const tds = container.querySelectorAll('tbody td')
    expect([...tds].map(td => td.dataset.label)).toEqual(['เลขที่', 'ลูกค้า', 'ยอดรวม', 'สถานะ', ''])
    expect([...tds].map(td => td.dataset.role)).toEqual(['title', 'sub', 'amount', 'status', 'actions'])
    expect(container.querySelector('thead th').dataset.sortable).toBe('true')
  })
  it('phone: empty-state row is marked, not decorated', () => {
    vi.spyOn(phone, 'useIsPhone').mockReturnValue(true)
    const { container } = render(<CardTable><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td colSpan={2}>ไม่พบข้อมูล</td></tr></tbody></table></CardTable>)
    const td = container.querySelector('tbody td')
    expect(td.dataset.empty).toBe('true'); expect(td.dataset.role).toBeUndefined()
  })
})
```

- [ ] **Step 4: Implement the component**

```jsx
// src/components/CardTable.jsx — phone card view for a plain <table>. Desktop = the old `.table-wrap` div, nothing else.
import { useLayoutEffect, useRef } from 'react'
import { useIsPhone } from '../hooks/useIsPhone.js'
import { inferRoles, cleanLabel } from '../lib/cardTable.js'

const NUMERIC = /^[-+]?[\d,]+(\.\d+)?\s*(บาท|%)?$/

function decorate(wrap, map) {
  const table = wrap.querySelector('table'); if (!table) return
  const ths = [...table.querySelectorAll('thead th')]
  const headers = ths.map(th => th.textContent)
  ths.forEach(th => { th.dataset.sortable = th.classList.contains('sortable') || !!th.onclick ? 'true' : 'false' })
  const rows = [...table.querySelectorAll('tbody tr')]
  const sampleTr = rows.find(tr => tr.children.length === headers.length)
  const sample = sampleTr ? [...sampleTr.children].map(td => ({
    text: td.textContent.trim(), numeric: NUMERIC.test(td.textContent.trim()),
    hasBadge: !!td.querySelector('[class*="badge"]'), hasButton: !!td.querySelector('button, a, [role="button"]'),
  })) : null
  const roles = inferRoles(headers, sample, map)
  rows.forEach(tr => {
    const tds = [...tr.children]
    if (tds.length !== headers.length) { tds.forEach(td => { td.dataset.empty = 'true'; delete td.dataset.role; delete td.dataset.label }); return }
    tds.forEach((td, i) => { td.dataset.label = cleanLabel(headers[i]); td.dataset.role = roles[i]; delete td.dataset.empty })
  })
}

export default function CardTable({ map, className = 'table-wrap', children }) {
  const isPhone = useIsPhone()
  const ref = useRef(null)
  useLayoutEffect(() => {
    if (!isPhone || !ref.current) return
    const el = ref.current
    decorate(el, map)
    const mo = new MutationObserver(() => decorate(el, map))
    mo.observe(el, { childList: true, subtree: true, characterData: false })
    return () => mo.disconnect()
  }, [isPhone, map])
  if (!isPhone) return <div className={className}>{children}</div>
  return <div ref={ref} className={`${className} card-table`}>{children}</div>
}
```

(The observer re-runs `decorate` after React re-renders rows; `decorate` only writes `data-*` attributes, which do not trigger childList mutations, so there is no loop.)

- [ ] **Step 5: CSS**

```css
  .card-table { max-height:none; overflow:visible; }
  .card-table table, .card-table tbody { display:block; width:100%; }
  .card-table thead { display:block; overflow-x:auto; white-space:nowrap; scrollbar-width:none; border-bottom:1px solid var(--border); margin-bottom:6px; }
  .card-table thead tr { display:flex; gap:6px; padding:4px 0; }
  .card-table thead th { display:none; }
  .card-table thead th[data-sortable="true"] { display:inline-block; padding:6px 10px; border:1px solid var(--border); border-radius:999px; background:var(--bg2); font-size:12px; }
  .card-table tbody tr { display:grid; grid-template-columns:1fr auto; gap:2px 10px; align-items:start; background:var(--bg2); border:1px solid var(--border); border-radius:12px; padding:10px 12px; margin:8px 0; }
  .card-table tbody td { display:block; padding:0; border:0; font-size:13px; }
  .card-table td[data-role="title"] { grid-column:1; font-weight:700; color:var(--text); font-size:14px; }
  .card-table td[data-role="amount"] { grid-column:2; grid-row:1; font-weight:700; font-size:15px; text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
  .card-table td[data-role="sub"] { grid-column:1 / -1; color:var(--text2); font-size:12px; }
  .card-table td[data-role="row"] { grid-column:1 / -1; display:grid; grid-template-columns:38% 1fr; gap:8px; font-size:12px; }
  .card-table td[data-role="row"]::before { content:attr(data-label); color:var(--text3); }
  .card-table td[data-role="hide"] { display:none; }
  .card-table td[data-role="status"] { grid-column:1; margin-top:6px; }
  .card-table td[data-role="actions"] { grid-column:2; justify-self:end; margin-top:6px; }
  .card-table td[data-empty="true"] { grid-column:1 / -1; text-align:center; color:var(--text3); padding:10px 0; }
```

- [ ] **Step 6: Run tests, commit** `feat(mobile): CardTable card view with role inference`

---

### Task 5: `PhoneFilters` and `MoreActions`

**Files:**
- Create: `src/components/PhoneFilters.jsx`, `src/components/PhoneFilters.test.jsx`
- Create: `src/components/MoreActions.jsx`, `src/components/MoreActions.test.jsx`
- Modify: `src/mobile.css`

**Interfaces:**
- `<PhoneFilters count summary onClear>{filter controls}</PhoneFilters>`; `summary = [{ label, onRemove }]`.
- `<MoreActions>{secondary buttons}</MoreActions>`.

- [ ] **Step 1: Tests**

```jsx
// src/components/PhoneFilters.test.jsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import PhoneFilters from './PhoneFilters.jsx'
import * as phone from '../hooks/useIsPhone.js'

describe('PhoneFilters', () => {
  beforeEach(() => vi.restoreAllMocks())
  it('desktop: children only, no wrapper', () => {
    vi.spyOn(phone, 'useIsPhone').mockReturnValue(false)
    const { container } = render(<PhoneFilters count={2}><select id="s" /></PhoneFilters>)
    expect(container.firstChild.tagName).toBe('SELECT')
    expect(container.childNodes).toHaveLength(1)
  })
  it('phone: button with count, chips, sheet opens with the children', () => {
    vi.spyOn(phone, 'useIsPhone').mockReturnValue(true)
    const onRemove = vi.fn(), onClear = vi.fn()
    render(<PhoneFilters count={2} summary={[{ label: 'ต.ค. 69', onRemove }]} onClear={onClear}><select id="s" /></PhoneFilters>)
    expect(screen.getByText('2')).toBeTruthy()
    expect(document.getElementById('s')).toBeNull()
    fireEvent.click(screen.getByText('ต.ค. 69').nextSibling)
    expect(onRemove).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /ตัวกรอง/ }))
    expect(document.getElementById('s')).toBeTruthy()
    fireEvent.click(screen.getByText('ล้างทั้งหมด'))
    expect(onClear).toHaveBeenCalled()
  })
})
```

```jsx
// src/components/MoreActions.test.jsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import MoreActions from './MoreActions.jsx'
import * as phone from '../hooks/useIsPhone.js'

describe('MoreActions', () => {
  beforeEach(() => vi.restoreAllMocks())
  it('desktop: children only', () => {
    vi.spyOn(phone, 'useIsPhone').mockReturnValue(false)
    const { container } = render(<MoreActions><button>A</button><button>B</button></MoreActions>)
    expect([...container.childNodes].map(n => n.textContent)).toEqual(['A', 'B'])
  })
  it('phone: ⋯ opens a menu with the children', () => {
    vi.spyOn(phone, 'useIsPhone').mockReturnValue(true)
    render(<MoreActions><button>A</button></MoreActions>)
    expect(screen.queryByText('A')).toBeNull()
    fireEvent.click(screen.getByLabelText('เพิ่มเติม'))
    expect(screen.getByText('A')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Implement**

```jsx
// src/components/PhoneFilters.jsx — desktop: children as-is. Phone: "ตัวกรอง (n)" button + chips + bottom sheet (spec §5).
import { useState } from 'react'
import { useIsPhone } from '../hooks/useIsPhone.js'
import { useBackToClose } from '../hooks/useBackToClose.js'

function Sheet({ onClose, onClear, children }) {
  useBackToClose(onClose)
  return (
    <div className="phone-sheet-overlay" onClick={onClose}>
      <div className="phone-sheet" onClick={e => e.stopPropagation()} role="dialog" aria-label="ตัวกรอง">
        <div className="phone-sheet-grab" />
        <div className="phone-sheet-head"><b>ตัวกรอง</b>{onClear && <button type="button" className="btn btn-ghost btn-sm" onClick={onClear}>ล้างทั้งหมด</button>}</div>
        <div className="phone-sheet-body">{children}</div>
        <div className="phone-sheet-foot"><button type="button" className="btn btn-primary" onClick={onClose}>ปิด</button></div>
      </div>
    </div>
  )
}

export default function PhoneFilters({ count = 0, summary = [], onClear, children }) {
  const isPhone = useIsPhone()
  const [open, setOpen] = useState(false)
  if (!isPhone) return children
  return (
    <div className="phone-filters">
      <button type="button" className="btn btn-ghost phone-filters-btn" onClick={() => setOpen(true)}>ตัวกรอง{count > 0 && <span className="phone-badge">{count}</span>}</button>
      {summary.length > 0 && (
        <div className="phone-chips">
          {summary.map((s, i) => <span key={i} className="phone-chip">{s.label}<button type="button" aria-label={`เอา ${s.label} ออก`} onClick={s.onRemove}>✕</button></span>)}
        </div>
      )}
      {open && <Sheet onClose={() => setOpen(false)} onClear={onClear}>{children}</Sheet>}
    </div>
  )
}
```

```jsx
// src/components/MoreActions.jsx — desktop: children as-is. Phone: a ⋯ button that opens the children in a small menu.
import { useEffect, useRef, useState } from 'react'
import { useIsPhone } from '../hooks/useIsPhone.js'

export default function MoreActions({ children }) {
  const isPhone = useIsPhone()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const h = e => { if (!ref.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('pointerdown', h)
    return () => document.removeEventListener('pointerdown', h)
  }, [open])
  if (!isPhone) return children
  return (
    <div className="phone-more" ref={ref}>
      <button type="button" className="btn btn-ghost phone-more-btn" aria-label="เพิ่มเติม" onClick={() => setOpen(o => !o)}>⋯</button>
      {open && <div className="phone-more-menu" onClick={() => setOpen(false)}>{children}</div>}
    </div>
  )
}
```

- [ ] **Step 3: CSS**

```css
  .phone-filters { display:contents; }
  .phone-filters-btn { min-height:var(--phone-tap); display:inline-flex; gap:6px; align-items:center; }
  .phone-chips { display:flex; gap:6px; overflow-x:auto; padding:6px 0; scrollbar-width:none; flex-basis:100%; }
  .phone-chip { flex:none; display:inline-flex; gap:4px; align-items:center; font-size:12px; border:1px solid var(--border); background:var(--bg2); border-radius:999px; padding:4px 8px 4px 10px; color:var(--text2); }
  .phone-chip button { background:none; border:none; color:var(--text3); font-size:12px; padding:0 2px; }
  .phone-sheet-overlay { position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:300; display:flex; align-items:flex-end; }
  .phone-sheet { width:100%; max-height:85vh; overflow-y:auto; background:var(--bg2); border-top:1px solid var(--border); border-radius:18px 18px 0 0; padding:10px 14px calc(14px + env(safe-area-inset-bottom, 0px)); }
  .phone-sheet-grab { width:40px; height:4px; border-radius:2px; background:var(--text3); margin:0 auto 10px; }
  .phone-sheet-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
  .phone-sheet-body { display:grid; gap:10px; }
  .phone-sheet-body .input, .phone-sheet-body .select, .phone-sheet-body input, .phone-sheet-body select { width:100%; min-height:var(--phone-tap); font-size:16px; }
  .phone-sheet-foot { display:flex; gap:8px; margin-top:12px; }
  .phone-sheet-foot .btn { flex:1; min-height:var(--phone-tap); }
  .phone-more { position:relative; }
  .phone-more-btn { min-width:var(--phone-tap); min-height:var(--phone-tap); font-size:18px; }
  .phone-more-menu { position:absolute; right:0; top:100%; z-index:250; display:grid; gap:4px; min-width:200px; padding:6px; background:var(--bg2); border:1px solid var(--border); border-radius:10px; box-shadow:var(--shadow); }
  .phone-more-menu .btn { width:100%; justify-content:flex-start; }
```

- [ ] **Step 4: Run tests, commit** `feat(mobile): PhoneFilters sheet and MoreActions menu`

---

### Task 6: Modal, forms and inputs on phone (CSS) + `modal-confirm`

**Files:**
- Modify: `src/components/Modal.jsx` (ConfirmDialog passes `className="modal-confirm"` → Modal accepts an optional `className` appended to `modal`; desktop CSS has no rule for it, so desktop is unchanged)
- Modify: `src/mobile.css`

- [ ] **Step 1: Modal prop**

`export function Modal({ title, onClose, children, maxWidth = 600, className = '' })` and `<div className={`modal${className ? ' ' + className : ''}`} …>`; in `ConfirmDialog` pass `className="modal-confirm"`.

- [ ] **Step 2: CSS**

```css
  .modal-overlay { align-items:stretch; padding:0; }
  .modal:not(.modal-confirm) { max-width:none !important; width:100vw; height:100dvh; max-height:none; border-radius:0; display:flex; flex-direction:column; }
  .modal:not(.modal-confirm) .modal-header { position:sticky; top:0; z-index:2; background:var(--bg2); }
  .modal:not(.modal-confirm) .modal-body { flex:1; overflow-y:auto; padding:14px 16px; }
  .modal:not(.modal-confirm) .modal-footer { position:sticky; bottom:0; z-index:2; background:var(--bg2); padding:10px 16px calc(10px + env(safe-area-inset-bottom, 0px)); display:flex; gap:8px; }
  .modal:not(.modal-confirm) .modal-footer .btn { flex:1; min-height:var(--phone-tap); }
  .modal-confirm { margin:auto 16px; }
  .form-grid-2, .form-grid-3, .form-grid-4 { grid-template-columns:1fr; }
  .input, .select, .textarea { font-size:16px; min-height:var(--phone-tap); }
  .input-sm { min-height:40px; }
  .btn { min-height:var(--phone-tap); }
  .btn-sm { min-height:36px; }
  .toolbar .btn-primary, .page-actions .btn-primary { flex:1; }
  .line-items .line-item { display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px; background:var(--bg3); border:1px solid var(--border); border-radius:10px; padding:10px; margin:8px 0; }
  .line-items .line-item > .li-desc { grid-column:1 / -1; }
  .line-items .line-item > .li-total { grid-column:1 / -1; text-align:right; font-weight:700; }
  .line-items .line-item > .li-remove { grid-column:1 / -1; justify-self:end; }
```

- [ ] **Step 3: Run the suite + build; look at 390 px: open "เพิ่มไซท์งาน" modal and the ConfirmDialog**

- [ ] **Step 4: Commit** `feat(mobile): full-screen modals, 44px targets, line-item cards (CSS)`

---

### Task 7: Apply to Dashboard, Sites, Quotations

**Files:**
- Modify: `src/pages/Dashboard.jsx` (period buttons wrapper gets `className="phone-chips-row"`; cards grid already 2-col)
- Modify: `src/pages/Sites.jsx:638` (`<div className="table-wrap">` → `<CardTable>`; view-mode buttons row `className="phone-chips-row"`; toolbar primary button row gets `className="toolbar"` if it has none; Template/Import buttons inside `<MoreActions>`)
- Modify: `src/pages/Quotations.jsx` (list `table-wrap` → `<CardTable map={{ amount: 'ยอดรวม', status: 'สถานะ' }}>`; filters (date range, site, status, search) stay in a `<PhoneFilters count summary onClear>`; secondary buttons in `<MoreActions>`; `QuotationForm` line-item rows get `line-items` / `line-item` / `li-desc` / `li-total` / `li-remove` class names (class additions only, no desktop CSS for them))
- Modify: `src/mobile.css` (`.phone-chips-row { display:flex; gap:6px; overflow-x:auto; white-space:nowrap; scrollbar-width:none; } .phone-chips-row .btn { flex:none; }`)

- [ ] **Step 1: Make each change, run `npx vitest run` and `npm run build`**
- [ ] **Step 2: Look at 390 px through the iframe harness: dashboard, sites table, quotations list + filter sheet + form**
- [ ] **Step 3: Commit** `feat(mobile): dashboard, sites, quotations on phone`

---

### Task 8: Fingerprint guard, baseline, version

**Files:**
- Create: `scripts/layout-fingerprint.browser.js` (snippet pasted into the Chrome tool: for each iframe width in [1440, 1024] and each tab id, records `{tag, class, rect:[x,y,w,h], styles:[...]}` for every element under `header, nav, main` with tbody rows after the third skipped; returns JSON)
- Create: `scripts/layout-fingerprint-diff.mjs` (`node scripts/layout-fingerprint-diff.mjs before.json after.json` → prints per page/width the first 20 differing elements; exit 1 on any diff)
- Modify: `package.json` version `1.20.47`, `src/changelog.json` (Thai note: "ใช้บนมือถือ: เมนูลิ้นชัก รายการเป็นการ์ด ตัวกรองในแผ่นล่าง ฟอร์มเต็มจอ (ภาพรวม ไซท์งาน ใบเสนอราคา) หน้าคอม/iPad แนวนอนเหมือนเดิม")

- [ ] **Step 1: Capture the baseline from the LIVE site (main) at 1440/1024 for the 4 pages before merging anything to main; store in the scratchpad**
- [ ] **Step 2: Run `npm run build`, serve `vite preview --port 4179` and capture the same from the preview via a tab in the owner's profile (same origin trick is not available cross-origin: use the preview URL directly, logging in is the owner's; if the preview cannot log in, run the fingerprint against the live site after deploy instead and compare with the baseline)**
- [ ] **Step 3: `node scripts/layout-fingerprint-diff.mjs` → must be empty**
- [ ] **Step 4: Commit** `chore(mobile): fingerprint guard, version 1.20.47`
