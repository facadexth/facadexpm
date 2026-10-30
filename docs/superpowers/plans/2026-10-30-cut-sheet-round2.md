# Cut Sheet Round 2 (6 fixes after the live test) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix gaps 1, 2, 5, 6, 7 and 8 found in the 2026-10-28 live test of the cut sheet: section 1 nets out stock offcuts, die numbers (or a red "ไม่มีรหัส" tag) on the sheet and stickers with unclipped finish names, inline error banners instead of `alert()`, a two-tab offcut panel, stickers printed by bar range, and a 5-row length helper.

**Architecture:** All six fixes are front-end only, on data the BOM tab already loads (`alu_offcuts` and `alu_cut_plans` are loaded whole by `useOffcuts` / `useCutPlans`). New pure helpers go first (`offcutHelpers.js`; new exports in `projectBomHelpers.js`, `stickers.js`, `cutOptimizer.js`), each with unit tests; components then read them. One small shared component, `InlineError.jsx`, replaces every browser dialog in these screens.

**Tech Stack:** React 18 + Vite, vitest (`react-dom/server` SSR smoke tests and `@testing-library/react` jsdom tests), html2pdf.js for the sticker PDF.

**Spec:** The owner-approved mockup `/private/tmp/claude-501/-Users-plfx-code-FacadeXPM-facadex-app/b2f8c48c-54bd-40ef-b3cd-c4b9b6b00bea/scratchpad/fix6/project/Main.dc.html` ("ใบตัดรอบแก้ 6 ข้อ"), sections 1, 2, 5, 6, 7 and 8. Use its Thai on-screen text verbatim. Background: the gap list at the end of `docs/handover-aluminium-cost-catalog.md` (section "Cut sheet, stickers and offcut stock handover"), and the previous plan `docs/superpowers/plans/2026-10-27-cut-sheet-stickers-offcuts.md` (owner rulings 1–8 there still apply; ruling 4: best length = least kg bought, then less scrap, then fewer bars). Gaps 3, 4, 9 and 10 are out of scope.

## Global Constraints

- Work only in worktree `/Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/alu-cost-catalog`, branch `feat/alu-cost-catalog`. Use absolute paths. Do not push, do not merge, never use bare `git stash`.
- No DB migration. This plan needs none: every number comes from `alu_offcuts` / `alu_cut_plans` rows the screen already loads. If you find one is truly unavoidable, stop and report: it would go in its own task, be additive only, and the owner applies it after a rolled-back dry run. Implementers never run SQL against any database.
- All user-facing text in Thai. Lengths on screen and stickers in mm (integers); bar lengths in m with 2 decimals.
- No upsert (house rule). This plan adds no writes.
- No `alert()` / `confirm()` in the cut-sheet screens. Errors go in `InlineError` inside the card they belong to.
- TDD: each task writes its failing tests first. Keep every existing test passing; update an existing test only where this plan changes the behaviour it pins (each such edit is spelled out in the task).
- Run the full suite before each commit: `npx vitest run` from the worktree (about 2653 tests must stay green, plus the new ones).
- Match the surrounding code style: short header comment per file, a one-line comment on non-obvious helpers, compact JSX with inline styles and the existing CSS classes (`card`, `alert alert-*`, `btn btn-sm btn-ghost|btn-primary|btn-danger`, `badge`, `font-mono`, `input`, `label`, `table-wrap`).
- Commit with a heredoc (zsh mangles backticks in `-m`). The only trailer is:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Review Focus

1. Items edited after a plan was issued, so section 1 has a profile that is not in the issued plan → that row keeps its own live numbers; the rows that are in the plan show the issued plan's numbers (Task 4 test "a row missing from the issued plan keeps its own numbers").
2. A profile group whose pieces all fit on stock offcuts (0 new bars) is picked on the sticker sheet → no bar-range inputs, every sticker of that group is listed and printable (Task 6 test "a group with no new bars has no range and lists all its stickers").
3. A bar range typed backwards, beyond the last bar, or left blank → clamped to 1..N and swapped into order, never an empty sticker sheet by accident (Task 6 `clampRange` test).
4. A finish name of 60+ characters on a 50×30 label → the whole name on its own line in a smaller font, no "…" (Task 5 tests "finishFontMm" and "a long finish name wraps, never ellipsis").
5. A void refused because of a job whose project the user cannot see (not in `projectNames`) → the message still lists the offcut codes and says "งานอื่น" (Task 2 tests "a consumer whose project is not visible").

---

## File map

| File | Responsibility | Tasks |
|---|---|---|
| `src/pages/estimation/InlineError.jsx` (new) | The shared dismissible error banner | 1 |
| `src/pages/estimation/noBrowserDialogs.test.js` (new) | Guard: no `alert(` / `confirm(` in the cut-sheet screens | 1, 2 |
| `src/pages/estimation/offcutHelpers.js` (new) | Pure: offcut panel tabs, who used an offcut, why a void is refused | 2, 3 |
| `src/pages/estimation/MissingDieNotice.jsx` (new) | Warning box listing profiles without a die no. | 5 |
| `src/pages/estimation/projectBomHelpers.js` | `section1Rows`, `withLiveDieNos`, `missingDieNos`, `shortLengthRows`; `optimizerView` ranks by kg | 4, 5, 7 |
| `src/lib/stickers.js` | `NO_DIE_TEXT`, `finishFontMm`, `die`/`finish`/`barNo`/`seq` on stickers, `barChunks`, `clampRange`, `stickersInRange` | 5, 6 |
| `src/lib/cutOptimizer.js` | `compareLengths` rows gain `per_bar_min` / `per_bar_max` | 7 |
| `src/pages/estimation/CutModeField.jsx`, `CustomLengthSummary.jsx`, `BomProfilesTable.jsx`, `CutOptimizerPanel.jsx`, `StickerSheet.jsx`, `OffcutStockPanel.jsx`, `CutSheetView.jsx`, `ProjectBomView.jsx` | UI | 1–7 |
| `docs/handover-aluminium-cost-catalog.md` | Handover section for this round | 7 |

`src/lib/stickerRender.js` needs no change: it draws only the QR and end-glyph PNGs and the PDF wrapper. The sticker text (die tag, finish line) is drawn by `StickerFace` in `StickerSheet.jsx`, and the same `StickerFace` renders both the on-screen preview (`u = px`) and the hidden print container html2pdf captures (`u = mm`), so Task 5 covers the screen and the PDF with one change.

---

### Task 1: Shared inline error banner; no more `alert()` in the cut-sheet cards

**Files:**
- Create: `src/pages/estimation/InlineError.jsx`
- Create: `src/pages/estimation/InlineError.smoke.test.jsx`
- Create: `src/pages/estimation/noBrowserDialogs.test.js`
- Create: `src/pages/estimation/CutModeField.errors.smoke.test.jsx`
- Create: `src/pages/estimation/CustomLengthSummary.errors.smoke.test.jsx`
- Create: `src/pages/estimation/BomProfilesTable.smoke.test.jsx`
- Create: `src/pages/estimation/CutOptimizerPanel.smoke.test.jsx`
- Create: `src/pages/estimation/StickerSheet.errors.smoke.test.jsx`
- Modify: `src/pages/estimation/CutModeField.jsx` (whole file)
- Modify: `src/pages/estimation/CustomLengthSummary.jsx:4-26`
- Modify: `src/pages/estimation/BomProfilesTable.jsx` (StockCell + default export)
- Modify: `src/pages/estimation/CutOptimizerPanel.jsx:4-25`
- Modify: `src/pages/estimation/StickerSheet.jsx:5-7, 51-55, 81-94, 125`
- Modify: `src/pages/estimation/OffcutStockPanel.jsx:5-7, 65`

**Interfaces:**
- Consumes: nothing new.
- Produces: `InlineError` (default export of `src/pages/estimation/InlineError.jsx`): props `{ title?: string|null, children, onClose?: () => void }`; renders `<div role="alert" className="alert alert-error">`; the close button has `aria-label="ปิดข้อความ"` and text `ปิด`, only when `onClose` is given. Later tasks use it in `CutSheetView` (Task 2) and keep it in `OffcutStockPanel` (Task 3), `BomProfilesTable` (Task 4), `StickerSheet` (Tasks 5–6), `CutOptimizerPanel` (Task 7).
- Produces: `src/pages/estimation/noBrowserDialogs.test.js` with a `FILES` array; Task 2 appends `'ProjectBomView.jsx'` and `'CutSheetView.jsx'`.

The deep-link path (`Estimation.jsx`, `findOffcutByCode`) never alerts: an unknown offcut code becomes `linkNotice` / the panel's "ไม่อยู่ในหน้าตัดของโครงการนี้" line. Nothing to change there. The issue / void `alert()` in `ProjectBomView.runCut` is Task 2.

- [ ] **Step 1: Write the failing tests**

`src/pages/estimation/InlineError.smoke.test.jsx`:

```jsx
// @vitest-environment jsdom
// The shared inline error: title, text, and "ปิด" that calls onClose; no close button without onClose.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import InlineError from './InlineError.jsx'

afterEach(cleanup)

describe('InlineError', () => {
  it('shows the title and the text and closes with ปิด', () => {
    const onClose = vi.fn()
    render(<InlineError title="ยกเลิกใบตัดไม่ได้" onClose={onClose}>เศษถูกใช้แล้ว</InlineError>)
    const box = screen.getByRole('alert')
    expect(box.textContent).toContain('ยกเลิกใบตัดไม่ได้')
    expect(box.textContent).toContain('เศษถูกใช้แล้ว')
    expect(screen.getByLabelText('ปิดข้อความ').textContent).toBe('ปิด')
    fireEvent.click(screen.getByLabelText('ปิดข้อความ'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('has no close button without onClose', () => {
    render(<InlineError>ผิดพลาด</InlineError>)
    expect(screen.getByRole('alert').textContent).toContain('ผิดพลาด')
    expect(screen.queryByLabelText('ปิดข้อความ')).toBeNull()
  })
})
```

`src/pages/estimation/noBrowserDialogs.test.js`:

```js
// Guard: the cut-sheet screens show errors inline (InlineError), never with the browser's alert() / confirm().
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const FILES = ['CutModeField.jsx', 'CustomLengthSummary.jsx', 'BomProfilesTable.jsx', 'CutOptimizerPanel.jsx', 'StickerSheet.jsx', 'OffcutStockPanel.jsx']
const source = f => readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8')

describe('no browser dialogs in the cut-sheet screens', () => {
  for (const f of FILES) it(f, () => { expect(source(f)).not.toMatch(/\b(alert|confirm)\(/) })
})
```

`src/pages/estimation/CutModeField.errors.smoke.test.jsx`:

```jsx
// @vitest-environment jsdom
// The job-type switch: a failed save is shown inline under the buttons and can be closed; never alert().
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

const saveProjectCutMode = vi.fn()
vi.mock('../../hooks/useEstimation2b.js', () => ({ saveProjectCutMode: (...a) => saveProjectCutMode(...a) }))
const { default: CutModeField } = await import('./CutModeField.jsx')

afterEach(() => { cleanup(); saveProjectCutMode.mockReset() })

describe('CutModeField errors', () => {
  it('a failed save shows an inline error that closes, never alert()', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    saveProjectCutMode.mockRejectedValue(new Error('permission denied'))
    render(<CutModeField project={{ id: 'P' }} settings={{ stock_length_m: 6.4 }} canEdit onProjectSaved={async () => {}} />)
    await act(async () => { fireEvent.click(screen.getByText('งานโครงการ · สั่งความยาวพิเศษ')) })
    const box = screen.getByRole('alert')
    expect(box.textContent).toContain('บันทึกประเภทงานไม่สำเร็จ')
    expect(box.textContent).toContain('permission denied')
    fireEvent.click(screen.getByLabelText('ปิดข้อความ'))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(alertSpy).not.toHaveBeenCalled()
    alertSpy.mockRestore()
  })
})
```

`src/pages/estimation/CustomLengthSummary.errors.smoke.test.jsx`:

```jsx
// @vitest-environment jsdom
// The custom-length summary: a failed "ใช้ <length>" save is shown inline in the card; never alert().
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

vi.mock('../../lib/supabase.js', () => ({ supabase: {}, fmt: n => String(Math.round(n)) }))
const { default: CustomLengthSummary } = await import('./CustomLengthSummary.jsx')

afterEach(cleanup)

const settings = { stock_length_m: 6.4, custom_moq_kg: 1000 }
const group = { key: 'p1|f1', profile_id: 'p1', finish_id: 'f1', name: 'กรอบบน', die_no: 'D-1', finish_name: 'อบขาว', length_m: 6.4, custom: false, no_weight: false, overrideRejected: false, offcutBars: [], bars: [{}, {}], unplaced: [], kg: 12.8, newOffcuts: [] }
const compare = { 'p1|f1': { base: { length_m: 6.4, newBars: 2, kg: 12.8 }, best: { length_m: 6.25, newBars: 2, kg: 12.5 } } }

describe('CustomLengthSummary errors', () => {
  it('a failed save shows an inline error, never alert()', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    render(<CustomLengthSummary plan={{ reason: null, customKg: 0, moqMet: true, groups: [group] }} compare={compare} prices={{ 'p1|f1': 100 }} kgPerM={{ 'p1|f1': 1 }}
      settings={settings} canEdit onUse={async () => { throw new Error('denied') }} onUseAll={async () => {}} />)
    await act(async () => { fireEvent.click(screen.getByText('ใช้ 6.25')) })
    const box = screen.getByRole('alert')
    expect(box.textContent).toContain('บันทึกไม่สำเร็จ')
    expect(box.textContent).toContain('denied')
    fireEvent.click(screen.getByLabelText('ปิดข้อความ'))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(alertSpy).not.toHaveBeenCalled()
    alertSpy.mockRestore()
  })
})
```

`src/pages/estimation/BomProfilesTable.smoke.test.jsx`:

```jsx
// @vitest-environment jsdom
// Section 1 (aluminium by profile + colour): stock-length input errors are shown inline above the table.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import BomProfilesTable from './BomProfilesTable.jsx'

afterEach(cleanup)

const row = (o = {}) => ({
  key: 'p1|f1', profile_id: 'p1', finish_id: 'f1', die_no: '15100', name: 'เฟรมข้าง', finish_name: 'ขาว', openings: ['W-01'],
  cuts: [{ length_m: 1.5, quantity: 2, style: 'square' }], cut_total_m: 3, stock_length_m: 6.4, unplaced: [], count: 1, reusable_m: 3.39, scrap_m: 0, ...o,
})
const view = props => render(<BomProfilesTable profiles={[row()]} overrides={{}} canEdit onSaveStock={async () => {}} {...props} />)

describe('BomProfilesTable errors', () => {
  it('an invalid stock length is shown inline and can be closed, never alert()', () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    view()
    const input = screen.getByPlaceholderText('6.40')
    fireEvent.change(input, { target: { value: 'abc' } })
    fireEvent.blur(input)
    expect(screen.getByRole('alert').textContent).toContain('ความยาวเส้นต้องเป็นตัวเลขมากกว่า 0 และไม่เกิน 20 ม.')
    fireEvent.click(screen.getByLabelText('ปิดข้อความ'))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(alertSpy).not.toHaveBeenCalled()
    alertSpy.mockRestore()
  })
  it('a failed save is shown inline with the reason', async () => {
    view({ onSaveStock: async () => { throw new Error('denied') } })
    const input = screen.getByPlaceholderText('6.40')
    fireEvent.change(input, { target: { value: '6' } })
    await act(async () => { fireEvent.blur(input) })
    const box = screen.getByRole('alert')
    expect(box.textContent).toContain('บันทึกไม่สำเร็จ')
    expect(box.textContent).toContain('denied')
  })
})
```

`src/pages/estimation/CutOptimizerPanel.smoke.test.jsx` (Task 7 adds to this file; the fixture is the mockup's เฟรมบน case: 120 pieces of 1800 mm):

```jsx
// @vitest-environment jsdom
// The length helper (ตัวช่วยเลือกความยาวเส้น): errors inline; Task 7 adds the 5-row short list.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

vi.mock('../../lib/supabase.js', () => ({ supabase: {}, fmt: n => String(Math.round(n)) }))
const { default: CutOptimizerPanel } = await import('./CutOptimizerPanel.jsx')
const { rangeLengths } = await import('../../lib/cutPlan.js')
const { DEFAULT_SETTINGS } = await import('../../lib/estimationSettings.js')

afterEach(cleanup)

const index = {
  providers: { pr: { id: 'pr', price_basis: 'per_kg' } },
  series: { s1: { id: 's1', name: 'ทั่วไป' } },
  profiles: { p1: { id: 'p1', provider_id: 'pr', linear_weight_kg_per_m: 1, default_length_m: 6 } },
  finishes: { f1: { id: 'f1', provider_id: 'pr' } },
  variants: [{ id: 'v6', profile_id: 'p1', finish_id: 'f1', length_m: 6 }, { id: 'v5', profile_id: 'p1', finish_id: 'f1', length_m: 5 }],
  kgPrices: [{ id: 'k', provider_id: 'pr', finish_id: 'f1', series_id: null, profile_id: null, price_per_kg: 100, effective_from: '2026-01-01' }],
  piecePrices: [],
}
const group = { key: 'p1|f1', profile_id: 'p1', finish_id: 'f1', die_no: null, name: 'เฟรมบน', finish_name: 'ขาว', stock_length_m: 6.4, cuts: [{ length_m: 1.8, quantity: 120, style: 'square' }] }
const view = props => render(<CutOptimizerPanel profiles={[group]} seriesMap={{ 'p1|f1': ['s1'] }} index={index} settings={DEFAULT_SETTINGS} asOf="2026-09-01"
  rangeM={rangeLengths(DEFAULT_SETTINGS)} canEdit onUseLength={async () => {}} {...props} />)

describe('CutOptimizerPanel', () => {
  it('a failed save is shown inline, never alert()', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    view({ onUseLength: async () => { throw new Error('denied') } })
    await act(async () => { fireEvent.click(screen.getAllByText('ใช้ความยาวนี้')[0]) })
    const box = screen.getByRole('alert')
    expect(box.textContent).toContain('บันทึกไม่สำเร็จ')
    expect(box.textContent).toContain('denied')
    expect(alertSpy).not.toHaveBeenCalled()
    alertSpy.mockRestore()
  })
})
```

`src/pages/estimation/StickerSheet.errors.smoke.test.jsx`:

```jsx
// @vitest-environment jsdom
// Stickers: a PDF that cannot be built is reported inline in the sticker card; never alert().
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

vi.mock('../../lib/stickerRender.js', () => ({
  qrDataUrl: () => Promise.reject(new Error('qr boom')),
  endGlyphDataUrl: () => 'data:image/png;base64,AA',
  downloadStickersPdf: vi.fn(async () => {}),
}))
const { default: StickerSheet } = await import('./StickerSheet.jsx')

afterEach(cleanup)

const pc = len => ({ length_m: len, opening_no: 'W-01', item_id: 'i1', item_name: '', role_name: 'เฟรมบน', end_a: 'square', end_b: 'square', notch: null, kerf_style: 'square' })
const plan = { signature: 'S', groups: [{ key: 'A|F', profile_id: 'A', finish_id: 'F', die_no: '15100', name: 'เฟรมบน', finish_name: 'ขาว', length_m: 6.4, offcutBars: [],
  bars: [{ length_m: 6.4, left_m: 0.1, pieces: [pc(3), pc(3)] }], unplaced: [], newOffcuts: [] }] }
const issued = { id: 'cp1', status: 'issued', signature: 'S', issued_at: '2026-10-28T03:00:00Z', plan }

describe('StickerSheet errors', () => {
  it('a failed PDF shows an inline error, never alert()', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<StickerSheet plan={plan} issued={issued} codes={{}} projectName="P" projectId="pj1" openingIds={{}} flipped={new Set()} onFlip={() => {}} />)
    await act(async () => { fireEvent.click(screen.getByText(/ดาวน์โหลด PDF/)) })
    const box = screen.getByRole('alert')
    expect(box.textContent).toContain('สร้าง PDF ไม่สำเร็จ')
    expect(box.textContent).toContain('qr boom')
    expect(alertSpy).not.toHaveBeenCalled()
    alertSpy.mockRestore(); errSpy.mockRestore()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/pages/estimation/InlineError.smoke.test.jsx src/pages/estimation/noBrowserDialogs.test.js src/pages/estimation/CutModeField.errors.smoke.test.jsx src/pages/estimation/CustomLengthSummary.errors.smoke.test.jsx src/pages/estimation/BomProfilesTable.smoke.test.jsx src/pages/estimation/CutOptimizerPanel.smoke.test.jsx src/pages/estimation/StickerSheet.errors.smoke.test.jsx`
Expected: FAIL — `InlineError.jsx` cannot be resolved; the guard test fails for every file but `OffcutStockPanel.jsx`; the component tests find no `role="alert"`.

- [ ] **Step 3: Create `src/pages/estimation/InlineError.jsx`**

```jsx
// src/pages/estimation/InlineError.jsx
// The cut-sheet screens' error message: shown inside the card it belongs to (never the browser's alert()), with
// "ปิด" to close it when onClose is given.
const icon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ flex: '0 0 auto', marginTop: 2 }}>
    <circle cx="12" cy="12" r="10" /><path d="M12 7v6M12 17h.01" />
  </svg>
)

export default function InlineError({ title, children, onClose }) {
  return (
    <div role="alert" className="alert alert-error" style={{ display: 'flex', gap: 12, alignItems: 'flex-start', margin: 0 }}>
      {icon}
      <div style={{ flex: 1, minWidth: 0 }}>{title && <b>{title}</b>}{title && children ? <br /> : null}{children}</div>
      {onClose && <button type="button" className="btn btn-ghost btn-sm" aria-label="ปิดข้อความ" onClick={onClose}>ปิด</button>}
    </div>
  )
}
```

- [ ] **Step 4: Replace `src/pages/estimation/CutModeField.jsx` with**

```jsx
// src/pages/estimation/CutModeField.jsx
// "ประเภทงาน": a normal job buys the market stock bar only; a project job may order custom lengths
// (estimation_projects.cut_mode 'stock' | 'custom'; a project without the column yet counts as 'stock').
import { useState } from 'react'
import { saveProjectCutMode } from '../../hooks/useEstimation2b.js'
import InlineError from './InlineError.jsx'

export default function CutModeField({ project, settings, canEdit, onProjectSaved }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const mode = project.cut_mode === 'custom' ? 'custom' : 'stock'
  const choose = async next => {
    if (next === mode) return
    setBusy(true); setError(null)
    try { await saveProjectCutMode(project.id, next); await onProjectSaved() } catch (e) { setError(e.message || String(e)) } finally { setBusy(false) }
  }
  const options = [
    ['stock', `งานทั่วไป · เส้น ${Number(settings.stock_length_m).toFixed(2)} ม. หาซื้อได้เลย`],
    ['custom', 'งานโครงการ · สั่งความยาวพิเศษ'],
  ]
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {options.map(([v, label]) => (
          <button key={v} type="button" aria-pressed={mode === v} className={`btn btn-sm ${mode === v ? 'btn-primary' : 'btn-ghost'}`}
            disabled={!canEdit || busy} onClick={() => choose(v)}>{label}</button>
        ))}
      </div>
      {error && <InlineError title="บันทึกประเภทงานไม่สำเร็จ" onClose={() => setError(null)}>{error}</InlineError>}
    </div>
  )
}
```

- [ ] **Step 5: `CustomLengthSummary.jsx` — error state and banner**

Add the import after line 6 (`import { customLengthSummaryModel } ...`):

```jsx
import InlineError from './InlineError.jsx'
```

Replace lines 12–18 (`const [busy, ...` through the closing `}` of `run`) with:

```jsx
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const stockL = f2(settings.stock_length_m)
  const m = customLengthSummaryModel({ plan, compare, prices, kgPerM })
  const run = async fn => {
    setBusy(true); setError(null)
    try { await fn() } catch (e) { setError(e.message || String(e)) } finally { setBusy(false) }
  }
```

Directly after the header `<div style={{ display: 'flex', justifyContent: 'space-between', ... }}>…</div>` (ends at current line 26), insert:

```jsx
      {error && <InlineError title="บันทึกไม่สำเร็จ" onClose={() => setError(null)}>{error}</InlineError>}
```

- [ ] **Step 6: `BomProfilesTable.jsx` — errors reported to the table, shown above it**

Replace the whole file with:

```jsx
// src/pages/estimation/BomProfilesTable.jsx
// Section 1 of the project BOM: aluminium by profile + colour. Merged cut list, total metres, stock length
// (editable per profile), bars and offcut. Lengths are metres (stored rows), as in the mockup. Input and save errors
// are shown above the table (InlineError).
import { useState } from 'react'
import { parseStockLength } from './projectBomHelpers.js'
import InlineError from './InlineError.jsx'

const m2 = n => Number(n).toFixed(2)
const m3 = n => Number(n).toFixed(3)

// onError({ title, text }) shows a message above the table; onError(null) clears it.
function StockCell({ group, overridden, canEdit, onSave, onError }) {
  const [text, setText] = useState(overridden ? String(group.stock_length_m) : '')
  const [busy, setBusy] = useState(false)
  const commit = async () => {
    const v = parseStockLength(text)
    if (Number.isNaN(v)) { onError({ title: null, text: 'ความยาวเส้นต้องเป็นตัวเลขมากกว่า 0 และไม่เกิน 20 ม.' }); setText(overridden ? String(group.stock_length_m) : ''); return }
    if ((v === null && !overridden) || v === group.stock_length_m && overridden) return
    setBusy(true); onError(null)
    try { await onSave(group.profile_id, v) } catch (e) { onError({ title: 'บันทึกไม่สำเร็จ', text: e.message || String(e) }) } finally { setBusy(false) }
  }
  return (
    <div>
      <input className="input input-sm font-mono" style={{ width: 80 }} inputMode="decimal" disabled={!canEdit || busy} value={text}
        placeholder={m2(group.stock_length_m)} onChange={e => setText(e.target.value)} onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
      <div style={{ fontSize: 11, color: 'var(--text3)' }}>{overridden ? 'ตั้งเอง' : 'ใช้ค่าของโปรเจกต์/ค่ามาตรฐาน'}</div>
    </div>
  )
}

export default function BomProfilesTable({ profiles, overrides, canEdit, onSaveStock }) {
  const [error, setError] = useState(null)
  if (!profiles.length) return <div style={{ color: 'var(--text3)', fontSize: 13 }}>ยังไม่มีเส้นอลูมิเนียมที่คิดราคาได้</div>
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {error && <InlineError title={error.title} onClose={() => setError(null)}>{error.text}</InlineError>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>หน้าตัด</th><th>สี</th><th>รายการตัด (ม. × ชิ้น)</th><th>ความยาวรวม (ม.)</th><th>ความยาวเส้น (ม.)</th><th>จำนวนเส้น</th><th>เศษเก็บใช้ต่อได้ (ม.)</th><th>เศษทิ้ง (ม.)</th></tr></thead>
          <tbody>
            {profiles.map(g => (
              <tr key={g.key}>
                <td>{g.die_no ? <b>{g.die_no}</b> : null} {g.name}<div style={{ fontSize: 11, color: 'var(--text3)' }}>{g.openings.join(', ')}</div></td>
                <td>{g.finish_name || '—'}</td>
                <td style={{ fontSize: 12 }}>{g.cuts.map(c => <div key={`${c.length_m}|${c.style}`} className="font-mono">{m3(c.length_m)} × {c.quantity} <span style={{ color: 'var(--text3)' }}>{c.style === 'miter45' ? '45° (ยาวด้านนอก)' : '90°'}</span></div>)}</td>
                <td className="font-mono">{m2(g.cut_total_m)}</td>
                <td><StockCell key={`${g.key}|${g.stock_length_m}`} group={g} overridden={Object.prototype.hasOwnProperty.call(overrides, g.profile_id)} canEdit={canEdit} onSave={onSaveStock} onError={setError} /></td>
                <td className="font-mono">{g.unplaced.length ? <span style={{ color: 'var(--red)' }}>วางไม่ได้ {g.unplaced.length} ชิ้น (ยาวเกินเส้น)</span> : g.count}</td>
                <td className="font-mono">{m2(g.reusable_m)}</td>
                <td className="font-mono">{m2(g.scrap_m)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
```

- [ ] **Step 7: `CutOptimizerPanel.jsx` — error state and banner**

Add after line 6 (`import { optimizerView } ...`):

```jsx
import InlineError from './InlineError.jsx'
```

Replace lines 12 and 17–20 (`const [busy, setBusy] = useState(false)` and the `use` function) so the top of the component reads:

```jsx
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const group = profiles.find(g => g.key === key) || profiles[0] || null
  const view = useMemo(() => (group ? optimizerView({ group, index, settings, asOf, seriesIds: seriesMap[group.key] || [], rangeM }) : null), [group, index, settings, asOf, seriesMap, rangeM])
  if (!group || !view) return null

  const use = async L => {
    setBusy(true); setError(null)
    try { await onUseLength(group.profile_id, L) } catch (e) { setError(e.message || String(e)) } finally { setBusy(false) }
  }
```

Directly after the title `<div style={{ fontWeight: 700 }}>ตัวช่วยเลือกความยาวเส้น …</div>` insert:

```jsx
      {error && <InlineError title="บันทึกไม่สำเร็จ" onClose={() => setError(null)}>{error}</InlineError>}
```

- [ ] **Step 8: `StickerSheet.jsx` — PDF errors inline**

Add after line 7 (`import { qrDataUrl, ... } from '../../lib/stickerRender.js'`):

```jsx
import InlineError from './InlineError.jsx'
```

After `const [printing, setPrinting] = useState(false)` add:

```jsx
  const [error, setError] = useState(null)
```

Replace the printing effect and `download` (current lines 81–94) with:

```jsx
  useEffect(() => {
    if (!printing) return undefined
    const id = requestAnimationFrame(() => {
      downloadStickersPdf(PRINT_ID, paper, `สติกเกอร์-${projectName || 'โปรเจกต์'}.pdf`)
        .catch(e => setError(e.message || String(e)))
        .finally(() => { setPrinting(false); setBusy(false) })
    })
    return () => cancelAnimationFrame(id)
  }, [printing]) // eslint-disable-line react-hooks/exhaustive-deps

  const download = async () => {
    setBusy(true); setError(null)
    try { await ensureImages(toPrint); setPrinting(true) } catch (e) { setError(e.message || String(e)); setBusy(false) }
  }
```

Directly before `{!issued && <div style={{ fontSize: 12, color: 'var(--yellow)' }}>ยืนยันใบตัดก่อน …` insert:

```jsx
      {error && <InlineError title="สร้าง PDF ไม่สำเร็จ" onClose={() => setError(null)}>{error}</InlineError>}
```

- [ ] **Step 9: `OffcutStockPanel.jsx` — the discard error becomes the shared banner**

Add after line 7 (`import { discardOffcut } ...`):

```jsx
import InlineError from './InlineError.jsx'
```

Replace line 65:

```jsx
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
```

with:

```jsx
      {error && <InlineError onClose={() => setError(null)}>{error}</InlineError>}
```

- [ ] **Step 10: Run the new tests and the touched components' existing tests**

Run: `npx vitest run src/pages/estimation/InlineError.smoke.test.jsx src/pages/estimation/noBrowserDialogs.test.js src/pages/estimation/CutModeField.errors.smoke.test.jsx src/pages/estimation/CustomLengthSummary.errors.smoke.test.jsx src/pages/estimation/BomProfilesTable.smoke.test.jsx src/pages/estimation/CutOptimizerPanel.smoke.test.jsx src/pages/estimation/StickerSheet.errors.smoke.test.jsx src/pages/estimation/CutModeField.smoke.test.jsx src/pages/estimation/CustomLengthSummary.smoke.test.jsx src/pages/estimation/StickerSheet.smoke.test.jsx src/pages/estimation/OffcutStockPanel.smoke.test.jsx`
Expected: all PASS.

- [ ] **Step 11: Full suite, then commit**

Run: `npx vitest run` — expected: all pass.

```bash
git -C /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/alu-cost-catalog add src/pages/estimation/InlineError.jsx src/pages/estimation/InlineError.smoke.test.jsx src/pages/estimation/noBrowserDialogs.test.js src/pages/estimation/CutModeField.jsx src/pages/estimation/CutModeField.errors.smoke.test.jsx src/pages/estimation/CustomLengthSummary.jsx src/pages/estimation/CustomLengthSummary.errors.smoke.test.jsx src/pages/estimation/BomProfilesTable.jsx src/pages/estimation/BomProfilesTable.smoke.test.jsx src/pages/estimation/CutOptimizerPanel.jsx src/pages/estimation/CutOptimizerPanel.smoke.test.jsx src/pages/estimation/StickerSheet.jsx src/pages/estimation/StickerSheet.errors.smoke.test.jsx src/pages/estimation/OffcutStockPanel.jsx
git -C /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/alu-cost-catalog commit -F - <<'EOF'
feat(cut-sheet): inline error banner replaces alert() in the cut-sheet cards

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: Offcut helpers; issue / void errors inside the cut-sheet card

**Files:**
- Create: `src/pages/estimation/offcutHelpers.js`
- Create: `src/pages/estimation/offcutHelpers.test.js`
- Modify: `src/pages/estimation/CutSheetView.jsx` (imports, new `CutError`, props, banner placement)
- Modify: `src/pages/estimation/CutSheetView.smoke.test.jsx` (new tests appended)
- Modify: `src/pages/estimation/ProjectBomView.jsx:9-13, 106-115, 172`
- Modify: `src/pages/estimation/noBrowserDialogs.test.js` (`FILES`)

**Interfaces:**
- Consumes: `InlineError` (Task 1).
- Produces (all in `src/pages/estimation/offcutHelpers.js`, pure, no Supabase import):
  - `offcutTabs({ offcuts, groupInfo, issuedPlanId }) -> { use: Offcut[], made: Offcut[] }` — `Offcut` = an `alu_offcuts` row (`id, code, profile_id, finish_id, length_m, status, source_project_id, source_plan_id, used_plan_id, created_at`); both lists sorted by `code`.
  - `offcutConsumer(offcut, plans, projectNames) -> null | { projectName: string|null, issued_at: string|null, openings: string[] }` — `plans` = `alu_cut_plans` rows (`id, project_id, status, issued_at, plan`).
  - `voidBlockers({ offcuts, plans, planId, projectNames }) -> { codes: string[], consumers: { plan_id, projectName: string|null, issued_at: string|null }[] }`.
  - `codesText(codes: string[]) -> string` — `'A, B, C'` up to 3, else `'first … last'`.
- Produces: `CutSheetView` props `error: null | { action: 'issue'|'void', message: string, blockers?: { codes, consumers } }` and `onDismissError: () => void`.

The void-blocked message is built client-side, with no new query: after a failed void, `runCut` already reloads `alu_offcuts` and `alu_cut_plans` (both loaded whole). The offcuts this plan made that are now `status = 'used'` are `source_plan_id = issued.id`; each one's `used_plan_id` names the consuming plan, whose row gives `project_id` (→ `projectNames`) and `issued_at`, and whose `plan.groups[].offcutBars[]` (matched by `offcut.id`) gives the consuming items. When the consuming project is not in `projectNames` (RLS), the text says "งานอื่น".

- [ ] **Step 1: Write the failing tests**

`src/pages/estimation/offcutHelpers.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { offcutTabs, offcutConsumer, voidBlockers, codesText } from './offcutHelpers.js'

const off = (id, code, o = {}) => ({ id, code, profile_id: 'A', finish_id: 'F', length_m: 1.2, status: 'in_stock', source_project_id: 'p0', source_plan_id: 'cpX', used_plan_id: null, ...o })
const groupInfo = { 'A|F': { profile_id: 'A', finish_id: 'F', name: 'เฟรมข้าง' } }
const pc = no => ({ length_m: 0.5, opening_no: no, role_name: 'ตั้ง' })
const plans = [
  { id: 'cp9', project_id: 'p9', status: 'issued', issued_at: '2026-10-28T03:00:00Z',
    plan: { groups: [{ key: 'A|F', bars: [], offcutBars: [
      { pieces: [pc('T-01'), pc('T-01')], offcut: { id: 'm2', code: 'OC-0011' } },
      { pieces: [pc('T-02')], offcut: { id: 'm4', code: 'OC-0013' } },
    ] }] } },
  { id: 'cp8', project_id: 'hidden', status: 'issued', issued_at: '2026-10-29T03:00:00Z', plan: { groups: [] } },
]
const projectNames = { p0: 'บ้านพี่วัฒน์', p9: 'HOSPITAL' }

describe('offcutTabs', () => {
  const offcuts = [
    off('o2', 'OC-0002'),
    off('o1', 'OC-0001'),
    off('g1', 'OC-0003', { finish_id: 'G' }),                                   // not this project's group
    off('m1', 'OC-0010', { source_plan_id: 'cp1' }),                            // made by this project's plan, in stock
    off('m2', 'OC-0011', { source_plan_id: 'cp1', status: 'used', used_plan_id: 'cp9' }),
    off('m3', 'OC-0012', { source_plan_id: 'cp1', status: 'discarded' }),
    off('t1', 'OC-0009', { status: 'used', used_plan_id: 'cp1' }),              // taken by this project's plan
    off('u1', 'OC-0008', { status: 'used', used_plan_id: 'cp7' }),              // taken by another job
  ]
  it('use = other jobs\' offcuts in this project\'s groups (in stock or taken by its plan); made = what its plan made', () => {
    const t = offcutTabs({ offcuts, groupInfo, issuedPlanId: 'cp1' })
    expect(t.use.map(o => o.code)).toEqual(['OC-0001', 'OC-0002', 'OC-0009'])
    expect(t.made.map(o => o.code)).toEqual(['OC-0010', 'OC-0011', 'OC-0012'])
  })
  it('before issue nothing is "made", and the in-stock rows are the old table', () => {
    const t = offcutTabs({ offcuts, groupInfo, issuedPlanId: null })
    expect(t.made).toEqual([])
    expect(t.use.map(o => o.code)).toEqual(['OC-0001', 'OC-0002', 'OC-0010'])
  })
})

describe('offcutConsumer', () => {
  it('names the job and the items cut from a used offcut', () => {
    expect(offcutConsumer(off('m2', 'OC-0011', { status: 'used', used_plan_id: 'cp9' }), plans, projectNames))
      .toEqual({ projectName: 'HOSPITAL', issued_at: '2026-10-28T03:00:00Z', openings: ['T-01'] })
  })
  it('is null for an offcut that is not used', () => {
    expect(offcutConsumer(off('o1', 'OC-0001'), plans, projectNames)).toBeNull()
  })
  it('a consumer plan not loaded gives no names, never a crash', () => {
    expect(offcutConsumer(off('x', 'OC-0099', { status: 'used', used_plan_id: 'nope' }), plans, projectNames))
      .toEqual({ projectName: null, issued_at: null, openings: [] })
  })
})

describe('voidBlockers', () => {
  const offcuts = [
    off('m4', 'OC-0013', { source_plan_id: 'cp1', status: 'used', used_plan_id: 'cp9' }),
    off('m2', 'OC-0011', { source_plan_id: 'cp1', status: 'used', used_plan_id: 'cp9' }),
    off('m1', 'OC-0010', { source_plan_id: 'cp1' }),
    off('z1', 'OC-0001', { source_plan_id: 'cp2', status: 'used', used_plan_id: 'cp9' }),
  ]
  it('lists the used offcuts this plan made and each consuming plan once', () => {
    expect(voidBlockers({ offcuts, plans, planId: 'cp1', projectNames })).toEqual({
      codes: ['OC-0011', 'OC-0013'],
      consumers: [{ plan_id: 'cp9', projectName: 'HOSPITAL', issued_at: '2026-10-28T03:00:00Z' }],
    })
  })
  it('a consumer whose project is not visible still lists the codes, with no project name', () => {
    const b = voidBlockers({ offcuts: [off('m5', 'OC-0020', { source_plan_id: 'cp1', status: 'used', used_plan_id: 'cp8' })], plans, planId: 'cp1', projectNames })
    expect(b).toEqual({ codes: ['OC-0020'], consumers: [{ plan_id: 'cp8', projectName: null, issued_at: '2026-10-29T03:00:00Z' }] })
  })
  it('nothing used gives no codes', () => {
    expect(voidBlockers({ offcuts: [off('m1', 'OC-0010', { source_plan_id: 'cp1' })], plans, planId: 'cp1', projectNames })).toEqual({ codes: [], consumers: [] })
  })
})

describe('codesText', () => {
  it('lists up to 3 codes, then first … last', () => {
    expect(codesText(['OC-0002'])).toBe('OC-0002')
    expect(codesText(['OC-0002', 'OC-0003', 'OC-0006'])).toBe('OC-0002, OC-0003, OC-0006')
    expect(codesText(['OC-0002', 'OC-0003', 'OC-0006', 'OC-0007'])).toBe('OC-0002 … OC-0007')
    expect(codesText([])).toBe('')
  })
})
```

Append to `src/pages/estimation/CutSheetView.smoke.test.jsx`, inside the top-level `describe('CutSheetView', …)` block (before its closing `})`):

```jsx
  describe('issue / void errors in the card', () => {
    const issued = { id: 'cp1', status: 'issued', signature: 'S1', issued_at: '2026-10-27T03:00:00Z', plan: plan() }
    it('a refused void names the used offcut codes and the job that used them, with a close button', () => {
      const error = { action: 'void', message: 'เศษจากใบตัดนี้ถูกงานอื่นใช้ไปแล้ว ยกเลิกไม่ได้',
        blockers: { codes: ['OC-0002', 'OC-0003', 'OC-0006', 'OC-0007'], consumers: [{ plan_id: 'cp9', projectName: 'HOSPITAL', issued_at: '2026-10-28T03:00:00Z' }] } }
      const html = render({ issued, error, onDismissError: () => {} })
      expect(html).toContain('role="alert"')
      expect(html).toContain('ยกเลิกใบตัดไม่ได้')
      expect(html).toContain('เศษจากใบตัดนี้ถูกงานอื่นใช้ไปแล้ว: <span class="font-mono">OC-0002 … OC-0007</span> (HOSPITAL · ใบตัดยืนยัน 27 ต.ค. 2569) ต้องยกเลิกใบตัดของ HOSPITAL ก่อน')
      expect(html).toContain('aria-label="ปิดข้อความ"')
    })
    it('a consumer whose project is not visible is called งานอื่น', () => {
      const error = { action: 'void', message: 'x', blockers: { codes: ['OC-0020'], consumers: [{ plan_id: 'cp8', projectName: null, issued_at: null }] } }
      const html = render({ issued, error, onDismissError: () => {} })
      expect(html).toContain('<span class="font-mono">OC-0020</span> (งานอื่น) ต้องยกเลิกใบตัดของ งานอื่น ก่อน')
    })
    it('any other failure shows the server text under the action title', () => {
      expect(render({ error: { action: 'issue', message: 'เศษบางชิ้นถูกใช้หรือทิ้งไปแล้ว คำนวณใบตัดใหม่แล้วลองอีกครั้ง' }, onDismissError: () => {} }))
        .toContain('<b>ยืนยันใบตัดไม่ได้</b><br/>เศษบางชิ้นถูกใช้หรือทิ้งไปแล้ว คำนวณใบตัดใหม่แล้วลองอีกครั้ง')
      expect(render({ issued, error: { action: 'void', message: 'network down', blockers: { codes: [], consumers: [] } }, onDismissError: () => {} }))
        .toContain('<b>ยกเลิกใบตัดไม่ได้</b><br/>network down')
    })
    it('no error, no banner', () => {
      expect(render({})).not.toContain('role="alert"')
    })
  })
```

In `src/pages/estimation/noBrowserDialogs.test.js`, change `FILES` to:

```js
const FILES = ['CutModeField.jsx', 'CustomLengthSummary.jsx', 'BomProfilesTable.jsx', 'CutOptimizerPanel.jsx', 'StickerSheet.jsx', 'OffcutStockPanel.jsx', 'ProjectBomView.jsx', 'CutSheetView.jsx']
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/pages/estimation/offcutHelpers.test.js src/pages/estimation/CutSheetView.smoke.test.jsx src/pages/estimation/noBrowserDialogs.test.js`
Expected: FAIL — `offcutHelpers.js` not found; CutSheetView renders no `role="alert"`; the guard fails on `ProjectBomView.jsx` (`alert(e.message)`).

- [ ] **Step 3: Create `src/pages/estimation/offcutHelpers.js`**

```js
// src/pages/estimation/offcutHelpers.js
// Pure views of the offcut stock for one project's cut sheet: the two tabs of the offcut panel, which job used an
// offcut, and why a void is refused. offcuts = alu_offcuts rows (every status), plans = alu_cut_plans rows (both are
// loaded whole by useOffcuts / useCutPlans, so no query is needed here).

const groupKeyOf = o => `${o.profile_id}|${o.finish_id || ''}`
const byCode = (a, b) => String(a.code).localeCompare(String(b.code))

// use: offcuts from OTHER jobs this project's plan may take -- in stock in one of the project's profile+finish groups,
// or already taken by its issued plan -- never the ones its own issued plan made. made: every offcut the issued plan
// made, whatever its status now.
export function offcutTabs({ offcuts, groupInfo, issuedPlanId }) {
  const use = []
  const made = []
  for (const o of offcuts || []) {
    if (issuedPlanId && o.source_plan_id === issuedPlanId) { made.push(o); continue }
    if (issuedPlanId && o.status === 'used' && o.used_plan_id === issuedPlanId) { use.push(o); continue }
    if (o.status === 'in_stock' && groupInfo && groupInfo[groupKeyOf(o)]) use.push(o)
  }
  return { use: use.sort(byCode), made: made.sort(byCode) }
}

// The issued plan that took a used offcut: its project's name (null when not visible), its issue date and the items
// whose pieces were cut from the offcut. null when the offcut is not used.
export function offcutConsumer(offcut, plans, projectNames) {
  if (!offcut || offcut.status !== 'used' || !offcut.used_plan_id) return null
  const p = (plans || []).find(r => r.id === offcut.used_plan_id)
  if (!p) return { projectName: null, issued_at: null, openings: [] }
  const openings = []
  for (const g of (p.plan && p.plan.groups) || []) {
    for (const b of g.offcutBars || []) {
      if (!b.offcut || b.offcut.id !== offcut.id) continue
      for (const pc of b.pieces || []) if (!openings.includes(pc.opening_no)) openings.push(pc.opening_no)
    }
  }
  return { projectName: (projectNames || {})[p.project_id] || null, issued_at: p.issued_at || null, openings }
}

// Why void_cut_plan refuses planId: the offcuts it made that another plan has used, and those plans (once each).
export function voidBlockers({ offcuts, plans, planId, projectNames }) {
  const used = (offcuts || []).filter(o => o.source_plan_id === planId && o.status === 'used').sort(byCode)
  const consumers = []
  for (const o of used) {
    if (consumers.some(c => c.plan_id === o.used_plan_id)) continue
    const c = offcutConsumer(o, plans, projectNames)
    consumers.push({ plan_id: o.used_plan_id, projectName: c ? c.projectName : null, issued_at: c ? c.issued_at : null })
  }
  return { codes: used.map(o => o.code), consumers }
}

// "OC-0002, OC-0003" up to 3 codes; more as "OC-0002 … OC-0007" (the mockup's form).
export function codesText(codes) {
  const c = codes || []
  return c.length <= 3 ? c.join(', ') : `${c[0]} … ${c[c.length - 1]}`
}
```

- [ ] **Step 4: `CutSheetView.jsx` — the error banner in the card header**

Replace the imports block (lines 7–11) with:

```jsx
import { useState } from 'react'
import { fmtDate } from '../../lib/supabase.js'
import { groupIdenticalBars, MIN_OFFCUT_M } from '../../lib/cutPlan.js'
import { isOffcutKept, roleTh } from '../../lib/stickers.js'
import { barNosLabel, openingColorIndex, splitRowsByKeep } from './projectBomHelpers.js'
import { codesText } from './offcutHelpers.js'
import InlineError from './InlineError.jsx'
```

Insert before `export default function CutSheetView`:

```jsx
// error: { action: 'issue' | 'void', message, blockers? } from the parent. A void refused because another job used this
// plan's offcuts names those codes and jobs (blockers = offcutHelpers.voidBlockers on the reloaded data).
function CutError({ error, onClose }) {
  const b = error.blockers
  if (error.action === 'void' && b && b.codes.length) {
    const name = c => c.projectName || 'งานอื่น'
    const who = b.consumers.map(c => `${name(c)}${c.issued_at ? ` · ใบตัดยืนยัน ${fmtDate(c.issued_at)}` : ''}`).join(', ')
    const jobs = [...new Set(b.consumers.map(name))].join(', ')
    return (
      <InlineError title="ยกเลิกใบตัดไม่ได้" onClose={onClose}>
        {'เศษจากใบตัดนี้ถูกงานอื่นใช้ไปแล้ว: '}<span className="font-mono">{codesText(b.codes)}</span>{` (${who}) ต้องยกเลิกใบตัดของ ${jobs} ก่อน`}
      </InlineError>
    )
  }
  return <InlineError title={error.action === 'void' ? 'ยกเลิกใบตัดไม่ได้' : 'ยืนยันใบตัดไม่ได้'} onClose={onClose}>{error.message}</InlineError>
}
```

Change the component signature (line 85) to:

```jsx
export default function CutSheetView({ plan, issued, codes, flipped, settings, canEdit, onIssue, onVoid, busy, error = null, onDismissError }) {
```

Directly after the header `<div …><div style={{ fontWeight: 700 }}>ใบตัด — แยกตามหน้าตัด</div>…</div>` (ends at current line 103), insert:

```jsx
      {error && <CutError error={error} onClose={onDismissError} />}
```

- [ ] **Step 5: `ProjectBomView.jsx` — keep the error, build the void detail from the reloaded rows**

Add the import after line 13 (the `projectBomHelpers.js` import block):

```jsx
import { voidBlockers } from './offcutHelpers.js'
```

Replace lines 106–115 (the `runCut` comment through `const voidPlan = …`) with:

```jsx
  // Issue / void, then reload the plans and the offcut stock either way (a failed issue may mean an offcut was taken).
  // The error stays in the cut-sheet card until closed or the next try.
  const [cutError, setCutError] = useState(null) // { action: 'issue' | 'void', message }
  const runCut = async (action, fn) => {
    setCutBusy(true); setCutError(null)
    try { await fn(); setFlipped(new Set()) } catch (e) { setCutError({ action, message: e.message || String(e) }) } finally {
      await Promise.all([plansQ.refetch(), offcutsQ.refetch()])
      setCutBusy(false)
    }
  }
  const issuePlan = () => runCut('issue', () => issueCutPlan(project.id, issuePayload(plan, flipped)))
  const voidPlan = () => runCut('void', () => voidCutPlan(issued.id))
  // Built from the reloaded offcuts and plans, so the codes and the job named are the current ones.
  const cutErrorView = useMemo(() => (cutError && cutError.action === 'void' && issued
    ? { ...cutError, blockers: voidBlockers({ offcuts: offcutsQ.data, plans: plansQ.data, planId: issued.id, projectNames }) }
    : cutError), [cutError, issued, offcutsQ.data, plansQ.data, projectNames])
```

`useState` / `useMemo` must stay above the early returns: these lines are above `if (stockQ.error) return …`, keep them there.

In the `<CutSheetView … />` element (line 172) add the two props:

```jsx
            <CutSheetView plan={plan} issued={issued} codes={offcutCodes} flipped={flipped} settings={settings} canEdit={canEdit} busy={cutBusy} onIssue={issuePlan} onVoid={voidPlan}
              error={cutErrorView} onDismissError={() => setCutError(null)} />
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/pages/estimation/offcutHelpers.test.js src/pages/estimation/CutSheetView.smoke.test.jsx src/pages/estimation/noBrowserDialogs.test.js`
Expected: PASS.

- [ ] **Step 7: Full suite, then commit**

Run: `npx vitest run` — expected: all pass.

```bash
git -C /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/alu-cost-catalog add src/pages/estimation/offcutHelpers.js src/pages/estimation/offcutHelpers.test.js src/pages/estimation/CutSheetView.jsx src/pages/estimation/CutSheetView.smoke.test.jsx src/pages/estimation/ProjectBomView.jsx src/pages/estimation/noBrowserDialogs.test.js
git -C /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/alu-cost-catalog commit -F - <<'EOF'
feat(cut-sheet): issue/void errors inside the cut-sheet card; a refused void names the used offcuts and the job

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: Offcut panel in two tabs — used by this job / made by this cut plan

**Files:**
- Modify: `src/pages/estimation/OffcutStockPanel.jsx` (whole file)
- Modify: `src/pages/estimation/OffcutStockPanel.smoke.test.jsx` (new `describe` appended)
- Modify: `src/pages/estimation/ProjectBomView.jsx:153-156`

**Interfaces:**
- Consumes: `offcutTabs`, `offcutConsumer` (Task 2), `InlineError` (Task 1).
- Produces: `OffcutStockPanel` new props `issuedPlanId: string|null` (default `null`) and `plans: alu_cut_plans rows` (default `[]`). Existing props unchanged.

Tab 1 "เศษที่งานนี้ใช้ (n)" = the old table minus the offcuts this project's own issued plan made, plus the offcuts that plan already took (status `used`, `used_plan_id` = the issued plan; once issued they are no longer `in_stock`, so the old table lost them). Tab 2 "เศษที่ใบตัดนี้สร้าง (n)" = `source_plan_id` = the issued plan, with a status chip `ในสต็อก` / `ใช้แล้ว · <project> <items>` / `ทิ้ง`. "ทิ้ง" (the button) only on `in_stock` rows, in both tabs. A QR link to an offcut of tab 2 opens tab 2.

- [ ] **Step 1: Write the failing tests**

Append to `src/pages/estimation/OffcutStockPanel.smoke.test.jsx` (after the existing `describe('OffcutStockPanel', …)` block; it reuses `off`, `offcuts`, `groupInfo`, `pc`, `settings`, `view`, `bodyRows`, `discardOffcut` from the top of that file):

```jsx
describe('OffcutStockPanel tabs', () => {
  const made = [
    off('m1', 'OC-0010', { source_plan_id: 'cp1' }),
    off('m2', 'OC-0011', { source_plan_id: 'cp1', status: 'used', used_plan_id: 'cp9' }),
    off('m3', 'OC-0012', { source_plan_id: 'cp1', status: 'discarded' }),
  ]
  const taken = off('t1', 'OC-0009', { status: 'used', used_plan_id: 'cp1' })
  const issuedPlan = { groups: [{ key: 'A|F', bars: [], offcutBars: [{ length_m: 1.2, left_m: 0.2, pieces: [pc(1, 'W-03')], offcut: { id: 't1', code: 'OC-0009', length_m: 1.2 } }] }] }
  const plans = [{ id: 'cp9', project_id: 'p9', status: 'issued', issued_at: '2026-10-28T03:00:00Z',
    plan: { groups: [{ key: 'A|F', bars: [], offcutBars: [{ pieces: [pc(0.5, 'T-01')], offcut: { id: 'm2', code: 'OC-0011' } }] }] } }]
  const tabView = props => view({ offcuts: [...offcuts, ...made, taken], plan: issuedPlan, issuedPlanId: 'cp1', plans, projectNames: { p0: 'บ้านพี่วัฒน์', p9: 'HOSPITAL' }, ...props })
  const tab = name => screen.getByRole('tab', { name })

  it('tab 1 leaves out what this plan made and keeps what it already took (no discard on a used one)', () => {
    tabView()
    expect(tab('เศษที่งานนี้ใช้ (3)').getAttribute('aria-selected')).toBe('true')
    expect(tab('เศษที่ใบตัดนี้สร้าง (3)').getAttribute('aria-selected')).toBe('false')
    expect(bodyRows().map(r => r.cells[0].textContent)).toEqual(['OC-0001', 'OC-0002', 'OC-0009'])
    expect(bodyRows()[2].textContent).toContain('ใช้ตัด 1 ท่อน')
    expect(screen.getAllByRole('button', { name: 'ทิ้ง' })).toHaveLength(2)
  })
  it('tab 2 lists what this plan made with where each one is now; discard only on the one in stock', () => {
    tabView()
    fireEvent.click(tab('เศษที่ใบตัดนี้สร้าง (3)'))
    expect(bodyRows().map(r => r.cells[0].textContent)).toEqual(['OC-0010', 'OC-0011', 'OC-0012'])
    expect(bodyRows()[0].textContent).toContain('ในสต็อก')
    expect(bodyRows()[1].textContent).toContain('ใช้แล้ว · HOSPITAL T-01')
    expect(bodyRows()[2].cells[3].textContent).toBe('ทิ้ง')
    expect(screen.getAllByRole('button', { name: 'ทิ้ง' })).toHaveLength(1)
  })
  it('discarding from tab 2 asks inline and calls discardOffcut', async () => {
    discardOffcut.mockResolvedValue(undefined)
    tabView()
    fireEvent.click(tab('เศษที่ใบตัดนี้สร้าง (3)'))
    fireEvent.click(screen.getByRole('button', { name: 'ทิ้ง' }))
    expect(document.body.textContent).toContain('ทิ้งเศษ OC-0010 (1200 มม.)?')
    await act(async () => { fireEvent.click(screen.getByText('ทิ้งเศษ')) })
    expect(discardOffcut).toHaveBeenCalledWith('m1')
  })
  it('a QR link to an offcut this plan made opens tab 2 with the row highlighted', () => {
    const had = Object.prototype.hasOwnProperty.call(Element.prototype, 'scrollIntoView')
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = vi.fn()
    try {
      tabView({ highlightCode: 'OC-0011' })
      expect(tab('เศษที่ใบตัดนี้สร้าง (3)').getAttribute('aria-selected')).toBe('true')
      expect(bodyRows()[1].getAttribute('style')).toContain('outline')
      expect(document.body.textContent).not.toContain('ไม่อยู่ในหน้าตัดของโครงการนี้')
    } finally {
      if (had) Element.prototype.scrollIntoView = original
      else delete Element.prototype.scrollIntoView
    }
  })
  it('before issue tab 2 is empty and says why', () => {
    view()
    fireEvent.click(tab('เศษที่ใบตัดนี้สร้าง (0)'))
    expect(document.body.textContent).toContain('ยืนยันใบตัดก่อน จึงจะมีเศษที่ใบตัดนี้สร้าง')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/pages/estimation/OffcutStockPanel.smoke.test.jsx`
Expected: the new `describe` FAILS (no `role="tab"`); the old tests still pass.

- [ ] **Step 3: Replace `src/pages/estimation/OffcutStockPanel.jsx` with**

```jsx
// src/pages/estimation/OffcutStockPanel.jsx
// "เศษในสต็อก (หน้าตัดที่โครงการนี้ใช้)" in two tabs (offcutHelpers.offcutTabs):
//   เศษที่งานนี้ใช้ -- other jobs' offcuts of this project's profile+finish groups (in stock, or already taken by this
//     project's issued plan), with what the shown cut plan does with each (cut n pieces from it, or left in stock);
//   เศษที่ใบตัดนี้สร้าง -- the offcuts this project's issued plan stocked, with where each one is now.
// A sticker QR (#tab=estimation&offcut=<code>) lands here with that row highlighted, in its tab. "ทิ้ง" (in-stock rows
// only) is confirmed inline.
import { useEffect, useRef, useState } from 'react'
import { fmtDate } from '../../lib/supabase.js'
import { discardOffcut } from '../../hooks/useEstimation2b.js'
import { offcutTabs, offcutConsumer } from './offcutHelpers.js'
import InlineError from './InlineError.jsx'

const mm = m => String(Math.round(Number(m) * 1000))
const muted = { fontSize: 12, color: 'var(--text3)' }
const groupKeyOf = o => `${o.profile_id}|${o.finish_id || ''}`
const groupLabel = g => (g ? [[g.die_no, g.name].filter(Boolean).join(' '), g.finish_name].filter(Boolean).join(' · ') : '?')
const hlStyle = { background: 'rgba(255,209,102,0.18)', outline: '2px solid var(--yellow)', outlineOffset: -2 }

// offcuts: every alu_offcuts row (all statuses); groupInfo: cutGroupInfo of this project; plan: the plan shown on the
// cut sheet (the issued snapshot once issued); used: false when "ใช้เศษในสต็อกก่อน" is off; issuedPlanId: this
// project's issued plan (null before issue); plans: every alu_cut_plans row (who used an offcut).
export default function OffcutStockPanel({ offcuts, groupInfo, plan, used, settings, projectNames, canEdit, highlightCode, onDiscarded, issuedPlanId = null, plans = [] }) {
  const tabs = offcutTabs({ offcuts, groupInfo, issuedPlanId })
  const inMade = !!highlightCode && tabs.made.some(o => o.code === highlightCode)
  const [tab, setTab] = useState(inMade ? 'made' : 'use')
  const [confirmId, setConfirmId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const rowRefs = useRef({})
  const scrolledFor = useRef(null)
  // The QR's offcut may arrive after the first render: open the tab it is in once it does.
  useEffect(() => { if (inMade) setTab('made') }, [inMade])

  const rows = tab === 'made' ? tabs.made : tabs.use
  const groupOf = o => groupInfo[groupKeyOf(o)] || (plan ? plan.groups.find(g => g.key === groupKeyOf(o)) : null)
  const barOf = o => {
    const g = plan ? plan.groups.find(x => x.key === groupKeyOf(o)) : null
    return g ? g.offcutBars.find(b => b.offcut.id === o.id) || null : null
  }
  const minKeep = Number(settings.min_keep_offcut_m)
  const highlighted = highlightCode ? rows.find(o => o.code === highlightCode) : null
  const known = !!highlightCode && (inMade || tabs.use.some(o => o.code === highlightCode))

  useEffect(() => {
    if (!highlighted || scrolledFor.current === highlighted.code) return
    const el = rowRefs.current[highlighted.code]
    if (el && el.scrollIntoView) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); scrolledFor.current = highlighted.code }
  }, [highlighted])

  const discard = async o => {
    setBusy(true); setError(null)
    try { await discardOffcut(o.id); setConfirmId(null) } catch (e) { setError(`ทิ้ง ${o.code} ไม่สำเร็จ: ${e.message || e}`) } finally {
      try { await onDiscarded() } catch (e) { setError(prev => prev || `โหลดเศษในสต็อกใหม่ไม่สำเร็จ: ${e.message || e}`) } finally { setBusy(false) }
    }
  }

  const result = o => {
    if (!used) return <span style={muted}>ไม่ใช้</span>
    const b = barOf(o)
    if (!b) return <span style={muted}>ไม่มีท่อนที่ลงได้ — ยังอยู่ในสต็อก</span>
    return (
      <>
        <span className="badge badge-ongoing">ใช้ตัด {b.pieces.length} ท่อน</span>{' '}
        <span className="font-mono">{b.pieces.map(p => `${p.opening_no} ${mm(p.length_m)}`).join(', ')}</span>
        {Number(b.left_m) + 1e-9 >= minKeep ? ` · เหลือ ${mm(b.left_m)}` : ''}
      </>
    )
  }

  const status = o => {
    if (o.status === 'in_stock') return <span className="badge">ในสต็อก</span>
    if (o.status === 'discarded') return <span className="badge" style={{ color: 'var(--text3)' }}>ทิ้ง</span>
    const c = offcutConsumer(o, plans, projectNames)
    const who = c ? [c.projectName || 'งานอื่น', c.openings.join(', ')].filter(Boolean).join(' ') : ''
    return <span className="badge badge-ongoing">{`ใช้แล้ว${who ? ` · ${who}` : ''}`}</span>
  }

  const isMade = tab === 'made'
  const cols = (isMade ? 4 : 6) + (canEdit ? 1 : 0)
  const empty = isMade
    ? (issuedPlanId ? 'ใบตัดนี้ไม่ได้สร้างเศษที่เก็บเข้าสต็อก' : 'ยืนยันใบตัดก่อน จึงจะมีเศษที่ใบตัดนี้สร้าง')
    : 'ไม่มีเศษในสต็อกของหน้าตัดที่โครงการนี้ใช้'
  const switchTab = k => { setTab(k); setConfirmId(null) }

  return (
    <div className="card" style={{ padding: 16, display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div style={{ fontWeight: 700 }}>เศษในสต็อก (หน้าตัดที่โครงการนี้ใช้)</div>
        <span style={muted}>เศษที่ติดสติกเกอร์ไว้จากงานก่อน · {used ? 'จัดลงก่อนตัดเส้นใหม่' : 'ไม่ใช้ (ปิดอยู่)'}</span>
      </div>
      <div role="tablist" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {[['use', `เศษที่งานนี้ใช้ (${tabs.use.length})`], ['made', `เศษที่ใบตัดนี้สร้าง (${tabs.made.length})`]].map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`btn btn-sm ${tab === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => switchTab(k)}>{label}</button>
        ))}
      </div>
      {highlightCode && !known && <div style={{ fontSize: 12, color: 'var(--yellow)' }}>เศษ {highlightCode} ไม่อยู่ในหน้าตัดของโครงการนี้</div>}
      {error && <InlineError onClose={() => setError(null)}>{error}</InlineError>}
      {rows.length === 0 ? <div style={muted}>{empty}</div> : (
        <div className="table-wrap"><table>
          <thead><tr>
            <th>รหัสเศษ</th><th>หน้าตัด</th><th>ยาว (มม.)</th>
            {isMade ? <th>สถานะ</th> : <><th>มาจาก</th><th>วันที่</th><th>ผล</th></>}
            {canEdit && <th />}
          </tr></thead>
          <tbody>{rows.map(o => {
            const hl = highlighted && highlighted.id === o.id
            return [
              <tr key={o.id} ref={el => { rowRefs.current[o.code] = el }} style={hl ? hlStyle : undefined}>
                <td className="font-mono">{o.code}</td>
                <td>{groupLabel(groupOf(o))}</td>
                <td className="font-mono">{mm(o.length_m)}</td>
                {isMade ? <td>{status(o)}</td> : <>
                  <td>{(o.source_project_id && projectNames[o.source_project_id]) || '—'}</td>
                  <td>{fmtDate(o.created_at)}</td>
                  <td style={{ fontSize: 13 }}>{result(o)}</td>
                </>}
                {canEdit && <td>{o.status === 'in_stock' && confirmId !== o.id && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setConfirmId(o.id); setError(null) }}>ทิ้ง</button>}</td>}
              </tr>,
              canEdit && confirmId === o.id && (
                <tr key={`${o.id}-confirm`}><td colSpan={cols}>
                  <div className="alert alert-warning" style={{ fontSize: 13, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: 0 }}>
                    <span>ทิ้งเศษ <b className="font-mono">{o.code}</b> ({mm(o.length_m)} มม.)? จะนำออกจากสต็อก ใช้ตัดงานต่อไม่ได้อีก</span>
                    <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => discard(o)}>{busy ? 'กำลังบันทึก...' : 'ทิ้งเศษ'}</button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setConfirmId(null)}>ไม่ใช่</button>
                  </div>
                </td></tr>
              ),
            ]
          })}</tbody>
        </table></div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Pass the issued plan id and the plans from `ProjectBomView.jsx`**

Replace the `<OffcutStockPanel … />` element (lines 154–155) with:

```jsx
        <OffcutStockPanel offcuts={offcutsQ.data} groupInfo={groupInfo} plan={issued ? issued.plan : plan} used={offcutsFirst || !!issued} settings={settings}
          projectNames={projectNames} canEdit={canEdit} highlightCode={highlightOffcut} onDiscarded={offcutsQ.refetch}
          issuedPlanId={issued ? issued.id : null} plans={plansQ.data || []} />
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/pages/estimation/OffcutStockPanel.smoke.test.jsx src/pages/estimation/noBrowserDialogs.test.js`
Expected: PASS (old and new).

- [ ] **Step 6: Full suite, then commit**

Run: `npx vitest run` — expected: all pass.

```bash
git -C /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/alu-cost-catalog add src/pages/estimation/OffcutStockPanel.jsx src/pages/estimation/OffcutStockPanel.smoke.test.jsx src/pages/estimation/ProjectBomView.jsx
git -C /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/alu-cost-catalog commit -F - <<'EOF'
feat(offcuts): panel split into offcuts this job uses and offcuts this cut plan made, with their status

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: Section 1 nets out stock offcuts; after issue it follows the issued plan

**Files:**
- Modify: `src/pages/estimation/projectBomHelpers.js` (new export `section1Rows` after `bomStockBasis`)
- Modify: `src/pages/estimation/projectBomHelpers.test.js` (import + new `describe`)
- Modify: `src/pages/estimation/BomProfilesTable.jsx` (offcut column, count cell, notes, `issued` prop)
- Modify: `src/pages/estimation/BomProfilesTable.smoke.test.jsx` (new `describe`)
- Modify: `src/pages/estimation/ProjectBomView.jsx:79-83, 162-164`

**Interfaces:**
- Consumes: `buildProjectBom().profiles` rows (`key, profile_id, count, stock_length_m, unplaced: number[], reusable_m, scrap_m, …`), `buildCutPlan().groups` (`key, length_m, offcutBars[{ left_m, offcut: { code } }], bars[{ left_m }], unplaced[{ length_m }]`).
- Produces: `section1Rows(profiles, { plan, issuedPlan, minKeepM }) -> rows` — each row is the input row plus `offcut_codes: string[]`, `base_count: number` (the bars without offcuts), `fromPlan: boolean`; when `fromPlan`, `count`, `stock_length_m`, `reusable_m`, `scrap_m`, `unplaced` come from the plan group.
- Produces: `BomProfilesTable` new prop `issued: boolean` (default `false`); rows may carry `offcut_codes` / `base_count` (missing = none).

Rules: with an issued plan, every row whose group is in it takes the issued group's numbers (also fixes the parked item "after issue, section 1 follows the live plan"). Without one, only rows whose live-plan group cuts from stock offcuts change (with "ใช้เศษในสต็อกก่อนตัดเส้นใหม่" off the live plan has no offcut bars, so section 1 is unchanged). A row whose group is not in the plan keeps its own numbers. Section 1 has no kg / cost column; the kg and baht shown elsewhere (custom-length summary, cut-sheet group headers) already come from the plan's new bars, so they follow. The stock-length input is read-only after issue (the issued plan's lengths are frozen).

- [ ] **Step 1: Write the failing tests**

In `src/pages/estimation/projectBomHelpers.test.js`, add `section1Rows` to the import list from `./projectBomHelpers.js`, add `import { buildProjectBom } from '../../lib/projectBom.js'` under the existing `cutPlan.js` import, and append:

```js
describe('section1Rows', () => {
  const row = (o = {}) => ({ key: 'p1|f1', profile_id: 'p1', count: 1, stock_length_m: 6.4, unplaced: [], reusable_m: 1.2, scrap_m: 0.1, ...o })
  const ob = (code, left) => ({ length_m: 1.6, left_m: left, pieces: [{}], offcut: { id: code, code, length_m: 1.6 } })
  const live = { groups: [
    { key: 'p1|f1', length_m: 6.4, offcutBars: [ob('OC-0002', 0.4), ob('OC-0003', 0.02)], bars: [], unplaced: [] },
    { key: 'p2|f1', length_m: 6.4, offcutBars: [], bars: [{ left_m: 1 }, { left_m: 0.1 }], unplaced: [] },
  ] }
  const rows = [row(), row({ key: 'p2|f1', profile_id: 'p2', count: 2 })]

  it('live plan: a group cutting from stock offcuts takes the plan\'s new bars, codes and remainders', () => {
    const [a, b] = section1Rows(rows, { plan: live, issuedPlan: null, minKeepM: 0.5 })
    expect(a).toMatchObject({ count: 0, base_count: 1, offcut_codes: ['OC-0002', 'OC-0003'], fromPlan: true, stock_length_m: 6.4, unplaced: [] })
    expect(a.reusable_m).toBe(0)
    expect(a.scrap_m).toBeCloseTo(0.42, 9)
    expect(b).toMatchObject({ count: 2, base_count: 2, offcut_codes: [], fromPlan: false, reusable_m: 1.2 })
  })
  it('no offcuts in the plan (toggle off) leaves every row as it was', () => {
    const plain = { groups: live.groups.map(g => ({ ...g, offcutBars: [] })) }
    const out = section1Rows(rows, { plan: plain, issuedPlan: null, minKeepM: 0.5 })
    expect(out.map(r => [r.count, r.fromPlan, r.offcut_codes.length])).toEqual([[1, false, 0], [2, false, 0]])
  })
  it('issued plan: every group in it takes the issued numbers, offcuts or not', () => {
    const issuedPlan = { groups: [
      { key: 'p1|f1', length_m: 6.4, offcutBars: [ob('OC-0002', 0.4)], bars: [], unplaced: [] },
      { key: 'p2|f1', length_m: 6.0, offcutBars: [], bars: [{ left_m: 0.6 }, { left_m: 0.6 }, { left_m: 0.2 }], unplaced: [] },
    ] }
    const [a, b] = section1Rows(rows, { plan: live, issuedPlan, minKeepM: 0.5 })
    expect(a).toMatchObject({ count: 0, offcut_codes: ['OC-0002'], fromPlan: true })
    expect(b).toMatchObject({ count: 3, base_count: 2, stock_length_m: 6.0, offcut_codes: [], fromPlan: true })
    expect(b.reusable_m).toBeCloseTo(1.2, 9)
    expect(b.scrap_m).toBeCloseTo(0.2, 9)
  })
  it('a row missing from the issued plan keeps its own numbers', () => {
    const issuedPlan = { groups: [live.groups[0]] }
    const out = section1Rows([...rows, row({ key: 'p3|f1', profile_id: 'p3', count: 4 })], { plan: live, issuedPlan, minKeepM: 0.5 })
    expect(out[1]).toMatchObject({ count: 2, fromPlan: false })
    expect(out[2]).toMatchObject({ count: 4, fromPlan: false, offcut_codes: [] })
  })
  it('a plan piece that cannot be cut is reported by its length', () => {
    const issuedPlan = { groups: [{ key: 'p1|f1', length_m: 6.4, offcutBars: [], bars: [], unplaced: [{ length_m: 7.2 }] }] }
    expect(section1Rows([row()], { plan: null, issuedPlan, minKeepM: 0.5 })[0].unplaced).toEqual([7.2])
  })
  it('with the real planner: pieces placed on a stock offcut are not bought again', () => {
    const entry = { opening_no: 'W-01', item_id: 'i1', item_name: '', quantity: 1, finish_id: 'f1',
      bom: { profileLines: [line({ length_m: 1.5, quantity: 2 })], gridLines: [], hardwareLines: [] }, addonBom: null, extras: null, unresolved: [] }
    const bom = buildProjectBom({ entries: [entry], settings: DEFAULT_SETTINGS, stock: { byProfile: {}, projectM: null }, profilesById: { p1: { name: 'กรอบ' } }, finishesById: {}, partsById: {} })
    expect(bom.profiles[0].count).toBe(1)
    const plan = buildCutPlan({ entries: [entry], mode: 'stock', settings: DEFAULT_SETTINGS, kgPerM: { 'p1|f1': 1 },
      offcutsByGroup: { 'p1|f1': [{ id: 'o1', code: 'OC-0001', length_m: 3.2 }] }, overrides: {}, groupInfo: { 'p1|f1': { profile_id: 'p1', finish_id: 'f1', name: 'กรอบ' } } })
    const [r] = section1Rows(bom.profiles, { plan, issuedPlan: null, minKeepM: DEFAULT_SETTINGS.min_keep_offcut_m })
    expect(r).toMatchObject({ count: 0, base_count: 1, offcut_codes: ['OC-0001'], fromPlan: true })
  })
})
```

Append to `src/pages/estimation/BomProfilesTable.smoke.test.jsx`:

```jsx
describe('BomProfilesTable stock offcuts', () => {
  const withOffcuts = [
    row({ offcut_codes: ['OC-0002', 'OC-0003'], base_count: 1, count: 0, fromPlan: true }),
    row({ key: 'p2|f1', profile_id: 'p2', name: 'เฟรมบน', offcut_codes: [], base_count: 2, count: 2 }),
  ]
  it('shows the offcut codes per row, the old count struck through and the saving note', () => {
    render(<BomProfilesTable profiles={withOffcuts} overrides={{}} canEdit={false} onSaveStock={async () => {}} />)
    const headers = [...document.querySelectorAll('thead th')].map(th => th.textContent)
    expect(headers).toContain('ใช้เศษในสต็อก')
    expect(headers).toContain('เส้นใหม่')
    expect(headers).not.toContain('จำนวนเส้น')
    const first = document.querySelectorAll('tbody tr')[0]
    expect(first.textContent).toContain('OC-0002')
    expect(first.textContent).toContain('OC-0003')
    expect(first.querySelector('s').textContent).toBe('1')
    expect(document.querySelectorAll('tbody tr')[1].querySelector('s')).toBeNull()
    expect(document.body.textContent).toContain('ใช้เศษ 2 ชิ้น · 1 หน้าตัดนี้ไม่ต้องซื้อเส้นใหม่ · กก. และค่าอลูมิเนียมลดตาม')
  })
  it('no offcuts: the table is as before', () => {
    render(<BomProfilesTable profiles={[row()]} overrides={{}} canEdit={false} onSaveStock={async () => {}} />)
    const headers = [...document.querySelectorAll('thead th')].map(th => th.textContent)
    expect(headers).not.toContain('ใช้เศษในสต็อก')
    expect(headers).toContain('จำนวนเส้น')
    expect(document.body.textContent).not.toContain('ใช้เศษ ')
  })
  it('after issue it says the numbers are the issued plan\'s', () => {
    render(<BomProfilesTable profiles={[row({ fromPlan: true, offcut_codes: [], base_count: 1 })]} overrides={{}} canEdit={false} onSaveStock={async () => {}} issued />)
    expect(document.body.textContent).toContain('หลังยืนยันใบตัดแล้ว ตาราง 1 ใช้ตัวเลขของใบที่ยืนยัน ไม่เปลี่ยนตามสต็อกที่ขยับภายหลัง')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/pages/estimation/projectBomHelpers.test.js src/pages/estimation/BomProfilesTable.smoke.test.jsx`
Expected: FAIL — `section1Rows` is not exported; no `ใช้เศษในสต็อก` header.

- [ ] **Step 3: Add `section1Rows` to `projectBomHelpers.js`** (directly after `bomStockBasis`, before the `heaviestGroupByProfile` comment)

```js
// Section 1 rows (buildProjectBom().profiles) with the cut plan's bars. issuedPlan: every row whose group is in it
// takes the issued group's numbers (frozen; the offcut stock moving later does not change them). Otherwise only a
// group the live plan cuts from stock offcuts changes: its new bars are the plan's, and the codes it uses are listed.
// A row whose group is not in the plan keeps its own numbers. base_count = the bars without offcuts (struck through).
export function section1Rows(profiles, { plan, issuedPlan, minKeepM }) {
  const src = issuedPlan || plan
  const byKey = new Map(((src && src.groups) || []).map(g => [g.key, g]))
  return (profiles || []).map(row => {
    const g = byKey.get(row.key)
    if (!g || (!issuedPlan && !(g.offcutBars || []).length)) return { ...row, offcut_codes: [], base_count: row.count, fromPlan: false }
    let reusable_m = 0, scrap_m = 0
    for (const b of [...(g.offcutBars || []), ...(g.bars || [])]) {
      const left = Number(b.left_m)
      if (left + EPS >= minKeepM && left > 0) reusable_m += left; else scrap_m += left
    }
    return {
      ...row, stock_length_m: Number(g.length_m), count: (g.bars || []).length, base_count: row.count,
      offcut_codes: (g.offcutBars || []).map(b => b.offcut.code), reusable_m, scrap_m,
      unplaced: (g.unplaced || []).map(p => p.length_m), fromPlan: true,
    }
  })
}
```

- [ ] **Step 4: `BomProfilesTable.jsx` — the offcut column, the count cell, the notes**

Replace the default export (from `export default function BomProfilesTable` to the end of the file) with:

```jsx
const codesOf = g => g.offcut_codes || []

// The new-bar count; when stock offcuts replace bars, the count without them struck through first.
function BarCount({ g }) {
  if (g.unplaced.length) return <span style={{ color: 'var(--red)' }}>วางไม่ได้ {g.unplaced.length} ชิ้น (ยาวเกินเส้น)</span>
  const changed = codesOf(g).length > 0 && g.base_count != null && g.base_count !== g.count
  return changed ? <><s style={{ color: 'var(--text3)' }}>{g.base_count}</s> <b style={{ color: 'var(--green)' }}>{g.count}</b></> : g.count
}

// profiles: projectBomHelpers.section1Rows rows (plain buildProjectBom rows work too); issued: the numbers are the
// issued plan's.
export default function BomProfilesTable({ profiles, overrides, canEdit, onSaveStock, issued = false }) {
  const [error, setError] = useState(null)
  if (!profiles.length) return <div style={{ color: 'var(--text3)', fontSize: 13 }}>ยังไม่มีเส้นอลูมิเนียมที่คิดราคาได้</div>
  const anyOffcut = profiles.some(g => codesOf(g).length > 0)
  const usedPieces = profiles.reduce((n, g) => n + codesOf(g).length, 0)
  const freed = profiles.filter(g => codesOf(g).length > 0 && g.count === 0 && g.base_count > 0).length
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {error && <InlineError title={error.title} onClose={() => setError(null)}>{error.text}</InlineError>}
      <div className="table-wrap">
        <table>
          <thead><tr>
            <th>หน้าตัด</th><th>สี</th><th>รายการตัด (ม. × ชิ้น)</th><th>ความยาวรวม (ม.)</th><th>ความยาวเส้น (ม.)</th>
            {anyOffcut && <th>ใช้เศษในสต็อก</th>}<th>{anyOffcut ? 'เส้นใหม่' : 'จำนวนเส้น'}</th><th>เศษเก็บใช้ต่อได้ (ม.)</th><th>เศษทิ้ง (ม.)</th>
          </tr></thead>
          <tbody>
            {profiles.map(g => (
              <tr key={g.key}>
                <td>{g.die_no ? <b>{g.die_no}</b> : null} {g.name}<div style={{ fontSize: 11, color: 'var(--text3)' }}>{g.openings.join(', ')}</div></td>
                <td>{g.finish_name || '—'}</td>
                <td style={{ fontSize: 12 }}>{g.cuts.map(c => <div key={`${c.length_m}|${c.style}`} className="font-mono">{m3(c.length_m)} × {c.quantity} <span style={{ color: 'var(--text3)' }}>{c.style === 'miter45' ? '45° (ยาวด้านนอก)' : '90°'}</span></div>)}</td>
                <td className="font-mono">{m2(g.cut_total_m)}</td>
                <td><StockCell key={`${g.key}|${g.stock_length_m}`} group={g} overridden={Object.prototype.hasOwnProperty.call(overrides, g.profile_id)} canEdit={canEdit} onSave={onSaveStock} onError={setError} /></td>
                {anyOffcut && <td>{codesOf(g).length
                  ? codesOf(g).map(c => <span key={c} className="badge font-mono" style={{ background: 'var(--yellow)', color: '#1d2420', marginRight: 4 }}>{c}</span>)
                  : <span style={{ color: 'var(--text3)' }}>—</span>}</td>}
                <td className="font-mono"><BarCount g={g} /></td>
                <td className="font-mono">{m2(g.reusable_m)}</td>
                <td className="font-mono">{m2(g.scrap_m)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {usedPieces > 0 && (
        <div className="alert alert-success" style={{ fontSize: 13, margin: 0 }}>
          {`ใช้เศษ ${usedPieces} ชิ้น${freed > 0 ? ` · ${freed} หน้าตัดนี้ไม่ต้องซื้อเส้นใหม่` : ''} · กก. และค่าอลูมิเนียมลดตาม`}
        </div>
      )}
      {issued && <div style={{ fontSize: 12, color: 'var(--text3)' }}>หลังยืนยันใบตัดแล้ว ตาราง 1 ใช้ตัวเลขของใบที่ยืนยัน ไม่เปลี่ยนตามสต็อกที่ขยับภายหลัง</div>}
    </div>
  )
}
```

- [ ] **Step 5: `ProjectBomView.jsx` — section 1 from the plan**

Add `section1Rows` to the import list from `./projectBomHelpers.js` (line 12, after `bomStockBasis`).

Replace lines 79–83 (the section-1 comment, `const stock = …` and `const bom = …`) with:

```jsx
  // Section 1 buys the lengths the cut plan chose (market bar in a normal job), so it never disagrees with the summary
  // or the cut sheet; once issued, the issued plan's. A project job waits for the plan.
  const stock = useMemo(() => bomStockBasis(cutMode, issued ? issued.plan : plan), [cutMode, issued, plan])
  const bom = useMemo(() => (tooMany || !stockRows || !stock ? null : buildProjectBom({ entries, settings, stock, profilesById: index.profiles, finishesById: index.finishes, partsById: index.parts })),
    [entries, settings, stock, index, tooMany, stockRows])
  // ...and nets out the stock offcuts the plan cuts from (the issued plan's numbers once issued).
  const section1 = useMemo(() => (bom ? section1Rows(bom.profiles, { plan, issuedPlan: issued ? issued.plan : null, minKeepM: Number(settings.min_keep_offcut_m) }) : null),
    [bom, plan, issued, settings.min_keep_offcut_m])
```

Replace the `<BomProfilesTable … />` element (line 163) with:

```jsx
        <BomProfilesTable profiles={section1} overrides={isCustom ? projectStock.byProfile : {}} canEdit={canEdit && isCustom && !issued} onSaveStock={saveProfile} issued={!!issued} />
```

(`CutOptimizerPanel` keeps receiving `bom.profiles`: it compares lengths without offcuts by design.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/pages/estimation/projectBomHelpers.test.js src/pages/estimation/BomProfilesTable.smoke.test.jsx src/lib/projectBom.test.js`
Expected: PASS.

- [ ] **Step 7: Full suite, then commit**

Run: `npx vitest run` — expected: all pass.

```bash
git -C /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/alu-cost-catalog add src/pages/estimation/projectBomHelpers.js src/pages/estimation/projectBomHelpers.test.js src/pages/estimation/BomProfilesTable.jsx src/pages/estimation/BomProfilesTable.smoke.test.jsx src/pages/estimation/ProjectBomView.jsx
git -C /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/alu-cost-catalog commit -F - <<'EOF'
feat(bom): section 1 nets out stock offcuts the cut plan uses; after issue it follows the issued plan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 5: Die no. tag ("ไม่มีรหัส" when empty), missing-die warning, finish name on its own line

**Files:**
- Modify: `src/lib/stickers.js` (`NO_DIE_TEXT`, `finishFontMm`, `stickerModel` fields)
- Modify: `src/lib/stickers.test.js` (two existing assertions updated, new tests)
- Modify: `src/pages/estimation/projectBomHelpers.js` (new `withLiveDieNos`, `missingDieNos`)
- Modify: `src/pages/estimation/projectBomHelpers.test.js` (import + new `describe`)
- Create: `src/pages/estimation/MissingDieNotice.jsx`
- Modify: `src/pages/estimation/StickerSheet.jsx` (`StickerFace`, `missingDie` prop)
- Modify: `src/pages/estimation/StickerSheet.smoke.test.jsx` (new tests)
- Modify: `src/pages/estimation/CutSheetView.jsx` (`DieTag` in group headers, `missingDie` prop)
- Modify: `src/pages/estimation/CutSheetView.smoke.test.jsx` (new tests)
- Modify: `src/pages/estimation/ProjectBomView.jsx` (live die nos., `missingDie`)

**Interfaces:**
- Consumes: `InlineError` (Task 1, already in both components); `seriesByGroup` result as arrays (`seriesMap` in `ProjectBomView`), `index.series` (`{ [id]: { id, name } }`).
- Produces (`src/lib/stickers.js`): `NO_DIE_TEXT = 'ไม่มีรหัส'`; `finishFontMm(text: string) -> number` (mm on a 50×30 label: 2.2, 1.9, 1.6 or 1.4); every sticker gains `die: string|null` and `finish: string`; the old `sub` field is removed (piece: `finish` = the finish name; offcut: `finish` = `"<profile name> · <finish name>"`).
- Produces (`projectBomHelpers.js`): `withLiveDieNos(plan, groupInfo) -> plan` (same shape, `groups[].die_no` from `groupInfo` when the key is there); `missingDieNos(plan, seriesMap, seriesById) -> null | { names: string[], series: string[] }`.
- Produces: `MissingDieNotice` (default export) props `{ missing }`; `CutSheetView` and `StickerSheet` gain the prop `missingDie` (default `null`).

The code already prints `g.die_no` (= `alu_profiles.drawing_no`); series "ทั่วไป" profiles simply have none (catalogue data). An issued plan froze `die_no` at issue time, so a die no. filled in later would not show until a re-issue: `withLiveDieNos` shows the current catalogue's value. The warning's "กรอกในแคตตาล็อก" is plain text with the menu path: the app switches tabs from a hash only on first load (`App.jsx` `parseDeepLink` in a mount effect), so a link would not navigate.

Finish line: its own grid row, `white-space: normal`, wraps (max 2 lines at the chosen size), never `text-overflow: ellipsis`. The same `StickerFace` draws the preview and the PDF print container, so html2pdf captures the wrapped text; `stickerRender.js` is unchanged.

- [ ] **Step 1: Write the failing tests**

In `src/lib/stickers.test.js`, change the import to:

```js
import { stickerModel, notchText, roleTh, endLabel, issuedOffcutCodes, isOffcutKept, shortDate, stickerPages, PAPERS, NEW_OFFCUT_CODE, NO_DIE_TEXT, finishFontMm } from './stickers.js'
```

Replace the existing test `'a piece sticker carries the item, part, length, finish, ends, project and the item QR'` with:

```js
  it('a piece sticker carries the item, part, length, die no., finish, ends, project and the item QR', () => {
    const p = stickerModel(args())[2]
    expect(p).toMatchObject({ kind: 'piece', title: 'W-01 · กรอบบานตั้ง', length_mm: 3000, die: 'F7980', finish: 'อบขาว', ends: ['miter45', 'miter45'], notchText: null,
      footL: 'PARLLEL TROPICAL', qr: '#tab=estimation&project=pj1&item=i1', groupKey: 'A|F' })
    expect(p.sub).toBeUndefined()
  })
```

In the existing test `'before issue every remainder has a sticker with the placeholder code and no QR'`, replace its last two `expect` lines with:

```js
    expect(offs[2]).toMatchObject({ title: 'เศษ → เข้าสต็อก', length_mm: 2400, die: null, finish: 'ซอย · อบขาว', ends: ['miter45', 'square'], footL: 'จาก PARLLEL TROPICAL' })
    expect(offs[0]).toMatchObject({ die: 'F7980', finish: 'กรอบบาน · อบขาว' })
```

Append to `src/lib/stickers.test.js`:

```js
describe('die no. and finish line', () => {
  it('a profile without a die no. gives die null (the sticker shows NO_DIE_TEXT)', () => {
    expect(NO_DIE_TEXT).toBe('ไม่มีรหัส')
    const s = stickerModel(args()).filter(x => x.groupKey === 'B|F')
    expect(s.every(x => x.die === null)).toBe(true)
  })
  it('finishFontMm: the largest size that fits 2 lines, never under 1.4 mm', () => {
    expect(finishFontMm('')).toBe(2.2)
    expect(finishFontMm('POWDER COATING WHITE')).toBe(2.2)
    expect(finishFontMm('x'.repeat(60))).toBe(1.9)
    expect(finishFontMm('x'.repeat(80))).toBe(1.4)
    expect(finishFontMm('x'.repeat(300))).toBe(1.4)
  })
})
```

In `src/pages/estimation/projectBomHelpers.test.js`, add `withLiveDieNos, missingDieNos` to the import list, and append:

```js
describe('die numbers', () => {
  const g = (key, profile_id, die_no, name) => ({ key, profile_id, die_no, name, bars: [], offcutBars: [] })
  const plan = { signature: 'S', groups: [g('a|f1', 'a', null, 'เฟรมบน'), g('a|f2', 'a', null, 'เฟรมบน'), g('b|f1', 'b', '15100', 'เฟรมล่าง'), g('c|f1', 'c', null, 'เสากุญแจ')] }
  it('withLiveDieNos shows the catalogue\'s current die no. on a frozen plan', () => {
    const out = withLiveDieNos(plan, { 'a|f1': { die_no: 'N-1' }, 'b|f1': { die_no: '15100' } })
    expect(out.groups.map(x => x.die_no)).toEqual(['N-1', null, '15100', null])
    expect(out.signature).toBe('S')
    expect(plan.groups[0].die_no).toBeNull()             // the input is not mutated
    expect(withLiveDieNos(null, {})).toBeNull()
  })
  it('missingDieNos lists each profile once, with the series it was priced in', () => {
    const seriesMap = { 'a|f1': ['s1'], 'a|f2': ['s1'], 'c|f1': ['s1', 's2'] }
    expect(missingDieNos(plan, seriesMap, { s1: { name: 'ทั่วไป' }, s2: { name: 'MN' } }))
      .toEqual({ names: ['เฟรมบน', 'เสากุญแจ'], series: ['ทั่วไป', 'MN'] })
  })
  it('missingDieNos is null when every profile has one', () => {
    expect(missingDieNos({ groups: [g('b|f1', 'b', '15100', 'เฟรมล่าง')] }, {}, {})).toBeNull()
    expect(missingDieNos(null, {}, {})).toBeNull()
  })
})
```

Append inside `describe('StickerSheet', …)` in `src/pages/estimation/StickerSheet.smoke.test.jsx`:

```jsx
  it('the die no. leads the title; a profile without one shows the red ไม่มีรหัส tag', () => {
    expect(render({})).toMatch(/background:#111111[^>]*>F7980<\/span>W-01 · กรอบบานตั้ง/)
    const noDie = { signature: 'S', groups: [{ ...group(), die_no: null }] }
    expect(render({ plan: noDie })).toMatch(/background:#b3261e[^>]*>ไม่มีรหัส<\/span>W-01 · กรอบบานตั้ง/)
  })
  it('a long finish name wraps on its own line in a smaller font, never ellipsis', () => {
    const long = 'POWDER COATING WHITE SEMI-GLOSS FOR TROPICAL COASTAL EXPOSURE'
    const html = render({ plan: { signature: 'S', groups: [{ ...group(), finish_name: long }] } })
    const m = html.match(/<div data-role="finish" style="([^"]*)">([^<]*)<\/div>/)
    expect(m).not.toBeNull()
    expect(m[2]).toBe(long)
    expect(m[1]).toContain('white-space:normal')
    expect(m[1]).not.toContain('ellipsis')
    expect(m[1]).toContain('font-size:7.6px')        // 1.9 mm × 4 px/mm on the preview
  })
  it('shows the missing-die warning it is given', () => {
    expect(render({ missingDie: { names: ['เฟรมบน', 'เฟรมล่าง'], series: ['ทั่วไป'] } }))
      .toContain('หน้าตัด 2 ตัวยังไม่มีรหัส: เฟรมบน, เฟรมล่าง (ซีรีส์ ทั่วไป) — กรอกในแคตตาล็อก')
  })
```

Append inside `describe('CutSheetView', …)` in `src/pages/estimation/CutSheetView.smoke.test.jsx`:

```jsx
  it('group headers lead with the die no., or the red ไม่มีรหัส tag', () => {
    expect(render({})).toMatch(/background:#111111[^>]*>MN-101<\/span>กรอบ/)
    expect(render({ plan: plan({ die_no: null }) })).toMatch(/background:#b3261e[^>]*>ไม่มีรหัส<\/span>กรอบ/)
  })
  it('shows the missing-die warning it is given', () => {
    expect(render({ missingDie: { names: ['กรอบ'], series: [] } })).toContain('หน้าตัด 1 ตัวยังไม่มีรหัส: กรอบ — กรอกในแคตตาล็อก')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/stickers.test.js src/pages/estimation/projectBomHelpers.test.js src/pages/estimation/StickerSheet.smoke.test.jsx src/pages/estimation/CutSheetView.smoke.test.jsx`
Expected: FAIL — `NO_DIE_TEXT`, `finishFontMm`, `withLiveDieNos`, `missingDieNos` not exported; stickers still have `sub`; no die tag / `data-role="finish"` / warning in the HTML.

- [ ] **Step 3: `src/lib/stickers.js` — die and finish fields**

After `export const NEW_OFFCUT_CODE = 'OC-ใหม่'` add:

```js
// Printed in red in place of the die no. when the profile has none (alu_profiles.drawing_no empty).
export const NO_DIE_TEXT = 'ไม่มีรหัส'

// Font size (mm, on a 50×30 label) of the finish line: the largest that fits the text on 2 lines of the ~35 mm text
// column beside the QR (about 0.6 em per character), never under 1.4 mm. The line wraps; it is never cut with "…".
const FINISH_SIZES = [2.2, 1.9, 1.6, 1.4]
export function finishFontMm(text) {
  const n = String(text || '').length
  return FINISH_SIZES.find(fs => Math.ceil((n * 0.6 * fs) / 35) <= 2) ?? FINISH_SIZES[FINISH_SIZES.length - 1]
}
```

In `stickerModel`, replace the three lines

```js
    const finish = g.finish_name || ''
    const sub = [g.die_no || g.name || '', finish].filter(Boolean).join(' · ')
    const offSub = [[g.die_no, g.name].filter(Boolean).join(' '), finish].filter(Boolean).join(' · ')
```

with:

```js
    const finish = g.finish_name || ''
    const die = g.die_no || null
    // An offcut sticker has no part name, so its finish line names the profile too.
    const offFinish = [g.name, finish].filter(Boolean).join(' · ')
```

In the piece `out.push({…})` replace `sub,` with `die, finish,`; in the offcut `out.push({…})` replace `sub: offSub,` with `die, finish: offFinish,`.

Update the file header comment's second sentence to end: `… drawn in stickerRender.js; the text (die tag, finish line) by StickerFace in StickerSheet.jsx.`

- [ ] **Step 4: `projectBomHelpers.js` — live die nos. and the missing list** (append after `summarySource`)

```js
// The issued snapshot froze each group's die no.; the catalogue may have been filled in since. Shows the current one
// (groupInfo = cutGroupInfo of the current items); a group no longer in the items keeps the snapshot's.
export function withLiveDieNos(plan, groupInfo) {
  if (!plan) return plan
  return {
    ...plan,
    groups: (plan.groups || []).map(g => {
      const info = (groupInfo || {})[g.key]
      return info && info.die_no !== g.die_no ? { ...g, die_no: info.die_no } : g
    }),
  }
}

// Profiles of the plan without a die no., once per profile, and the series they were priced in (seriesMap: group key
// -> series ids, seriesById = index.series). null when every profile has one.
export function missingDieNos(plan, seriesMap, seriesById) {
  const names = []
  const series = []
  const seen = new Set()
  for (const g of (plan && plan.groups) || []) {
    if (g.die_no || seen.has(g.profile_id)) continue
    seen.add(g.profile_id)
    names.push(g.name || '?')
    for (const id of (seriesMap || {})[g.key] || []) {
      const s = (seriesById || {})[id]
      if (s && s.name && !series.includes(s.name)) series.push(s.name)
    }
  }
  return names.length ? { names, series } : null
}
```

- [ ] **Step 5: Create `src/pages/estimation/MissingDieNotice.jsx`**

```jsx
// src/pages/estimation/MissingDieNotice.jsx
// Warning on the cut sheet and the stickers: which profiles have no die no. yet (missing = projectBomHelpers.missingDieNos).
// The die no. is alu_profiles.drawing_no, entered in the aluminium catalogue.
export default function MissingDieNotice({ missing }) {
  if (!missing) return null
  const series = missing.series.length ? ` (ซีรีส์ ${missing.series.join(', ')})` : ''
  return (
    <div className="alert alert-warning" style={{ fontSize: 13, margin: 0 }}>
      {`หน้าตัด ${missing.names.length} ตัวยังไม่มีรหัส: ${missing.names.join(', ')}${series} — กรอกในแคตตาล็อก`}
      <span style={{ fontSize: 12 }}>{' (เมนู แคตตาล็อกอลูมิเนียม › หน้าตัด · สี · ความยาว › DIE NO.)'}</span>
    </div>
  )
}
```

- [ ] **Step 6: `StickerSheet.jsx` — die tag and finish line in `StickerFace`; the warning**

Change the stickers import to:

```jsx
import { PAPERS, stickerModel, stickerPages, endLabel, isOffcutKept, NO_DIE_TEXT, finishFontMm } from '../../lib/stickers.js'
```

and add `import MissingDieNotice from './MissingDieNotice.jsx'` after the `InlineError` import.

In `StickerFace`, after `const line = …` add:

```jsx
  const dieStyle = { background: s.die ? '#111111' : '#b3261e', color: '#ffffff', borderRadius: z(0.5), padding: `0 ${z(0.6)}`, marginRight: z(0.8) }
```

Replace the title `<div>` (first child) with:

```jsx
      <div style={{ ...line, fontWeight: 700, fontSize: z(2.5), color: off ? '#1f6f5c' : '#111111' }}><span className="font-mono" style={dieStyle}>{s.die || NO_DIE_TEXT}</span>{off ? <>{s.title} <span className="font-mono">{s.code}</span></> : s.title}</div>
```

Replace the sub line `<div style={{ ...line, fontSize: z(2.2) }}>{s.sub}</div>` with:

```jsx
      {/* The finish name: its own line, wraps, smaller when long -- never cut with "…" (screen and PDF alike). */}
      <div data-role="finish" style={{ fontSize: z(finishFontMm(s.finish)), lineHeight: 1.15, fontWeight: 600, whiteSpace: 'normal', overflowWrap: 'anywhere', minWidth: 0 }}>{s.finish}</div>
```

Change the component signature to accept the warning:

```jsx
export default function StickerSheet({ plan, issued, codes, projectName, projectId, openingIds, flipped, onFlip, missingDie = null }) {
```

and directly after the error banner line (`{error && <InlineError title="สร้าง PDF ไม่สำเร็จ" …`) add:

```jsx
      <MissingDieNotice missing={missingDie} />
```

- [ ] **Step 7: `CutSheetView.jsx` — die tag in group headers; the warning**

Change the stickers import to `import { isOffcutKept, roleTh, NO_DIE_TEXT } from '../../lib/stickers.js'` and add `import MissingDieNotice from './MissingDieNotice.jsx'`.

After the `const tag = …` line add:

```jsx
const DieTag = ({ die }) => (
  <span className="font-mono" style={{ ...tag, marginRight: 6, background: die ? '#111111' : '#b3261e', color: '#ffffff' }}>{die || NO_DIE_TEXT}</span>
)
```

In `GroupSheet`, replace

```jsx
          {g.die_no ? <b className="font-mono">{g.die_no}</b> : null}{g.die_no ? ' · ' : ''}{g.name || '?'}{g.finish_name ? ` · ${g.finish_name}` : ''} · เส้น <b className="font-mono">{f2(L)}</b> ม.
```

with:

```jsx
          <DieTag die={g.die_no} />{g.name || '?'}{g.finish_name ? ` · ${g.finish_name}` : ''} · เส้น <b className="font-mono">{f2(L)}</b> ม.
```

Add `missingDie = null` to the `CutSheetView` props (after `onDismissError`), and directly after `{error && <CutError … />}` add:

```jsx
      <MissingDieNotice missing={missingDie} />
```

- [ ] **Step 8: `ProjectBomView.jsx` — live die nos. on the issued plan, the missing list**

Add `withLiveDieNos, missingDieNos` to the import list from `./projectBomHelpers.js`.

After the `compare` / `prices` / `rangeM` memos (before `const saveProfile`) add:

```jsx
  // The cut sheet, stickers and offcut panel show the catalogue's current die no. even on a frozen issued plan.
  const issuedShown = useMemo(() => (issued ? { ...issued, plan: withLiveDieNos(issued.plan, groupInfo) } : issued), [issued, groupInfo])
  const missingDie = useMemo(() => missingDieNos(issuedShown ? issuedShown.plan : plan, seriesMap, index.series), [issuedShown, plan, seriesMap, index.series])
```

Then use `issuedShown` for the three display components (keep `issued` everywhere else):
- `OffcutStockPanel`: `plan={issuedShown ? issuedShown.plan : plan}`.
- `CutSheetView`: `issued={issuedShown}` and add `missingDie={missingDie}`.
- `StickerSheet`: `issued={issuedShown}` and add `missingDie={missingDie}`.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run src/lib/stickers.test.js src/pages/estimation/projectBomHelpers.test.js src/pages/estimation/StickerSheet.smoke.test.jsx src/pages/estimation/StickerSheet.errors.smoke.test.jsx src/pages/estimation/CutSheetView.smoke.test.jsx`
Expected: PASS. If the `font-size:7.6px` assertion fails on float formatting (e.g. `7.6000000000000005px`), change `z` in `StickerFace` to round: `const z = n => u(Math.round(n * f * 100) / 100)` and re-run — do not loosen the test.

- [ ] **Step 10: Full suite, then commit**

Run: `npx vitest run` — expected: all pass.

```bash
git -C /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/alu-cost-catalog add src/lib/stickers.js src/lib/stickers.test.js src/pages/estimation/projectBomHelpers.js src/pages/estimation/projectBomHelpers.test.js src/pages/estimation/MissingDieNotice.jsx src/pages/estimation/StickerSheet.jsx src/pages/estimation/StickerSheet.smoke.test.jsx src/pages/estimation/CutSheetView.jsx src/pages/estimation/CutSheetView.smoke.test.jsx src/pages/estimation/ProjectBomView.jsx
git -C /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/alu-cost-catalog commit -F - <<'EOF'
feat(cut-sheet): die no. tag or red ไม่มีรหัส on sheet and stickers, missing-die warning, finish name never clipped

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 6: Print stickers by bar range

**Files:**
- Modify: `src/lib/stickers.js` (`barNo`, `seq`, `total` on stickers; new `barChunks`, `clampRange`, `stickersInRange`)
- Modify: `src/lib/stickers.test.js` (new tests)
- Modify: `src/pages/estimation/StickerSheet.jsx` (range state, controls, summary, PDF label, file name)
- Modify: `src/pages/estimation/StickerSheet.smoke.test.jsx` (two existing regexes updated, new tests)
- Create: `src/pages/estimation/StickerSheet.range.smoke.test.jsx`

**Interfaces:**
- Consumes: `stickerModel` (Task 5 shape: `die`, `finish`).
- Produces (`src/lib/stickers.js`):
  - every sticker gains `barNo: number|null` (1-based new-bar number; `null` on a stock-offcut bar); piece stickers also gain `seq: number` (the project-wide k) and `total: number` (N).
  - `barChunks(n: number, size = 10) -> { from, to }[]`.
  - `clampRange(from: string|number, to: string|number, n: number) -> { from, to }` (n ≥ 1).
  - `stickersInRange(stickers, groupKey, from, to) -> stickers`.

Rules: the range is the new-bar numbers of the selected profile group (as on the cut sheet, "เส้นที่ 1–10"). Stock-offcut bars are cut before bar 1, so their pieces and remainders belong to a range that starts at bar 1. A remainder sticker goes with its own bar. Numbers k/N stay whole-project. Default range = bars 1 to min(10, N). Quick buttons per 10 bars only when the group has more than 10 bars, plus "ทั้งหมด" always. "ทุกหน้าตัด" (all groups) has no range. A group with 0 new bars has no range controls.

- [ ] **Step 1: Write the failing tests**

In `src/lib/stickers.test.js`, add `barChunks, clampRange, stickersInRange` to the import from `./stickers.js` and append:

```js
describe('bar ranges', () => {
  it('every sticker knows its new-bar number (null on a stock-offcut bar); pieces carry k and N', () => {
    const s = stickerModel(args())
    expect(s.map(x => x.barNo)).toEqual([null, null, 1, 1, 1, 2, 2, 1, 1])
    expect(s.filter(x => x.kind === 'piece').map(x => [x.seq, x.total])).toEqual([[1, 6], [2, 6], [3, 6], [4, 6], [5, 6], [6, 6]])
  })
  it('barChunks splits n bars into rounds of 10', () => {
    expect(barChunks(25)).toEqual([{ from: 1, to: 10 }, { from: 11, to: 20 }, { from: 21, to: 25 }])
    expect(barChunks(10)).toEqual([{ from: 1, to: 10 }])
    expect(barChunks(0)).toEqual([])
  })
  it('clampRange keeps whole bars inside 1..n, swaps a backwards range, fills a blank end', () => {
    expect(clampRange('3', '7', 12)).toEqual({ from: 3, to: 7 })
    expect(clampRange('12', '3', 12)).toEqual({ from: 3, to: 12 })
    expect(clampRange('0', '99', 12)).toEqual({ from: 1, to: 12 })
    expect(clampRange('', '', 12)).toEqual({ from: 1, to: 12 })
    expect(clampRange('2.7', 'abc', 12)).toEqual({ from: 2, to: 12 })
    expect(clampRange(5, 5, 12)).toEqual({ from: 5, to: 5 })
  })
  it('stickersInRange: one group, bars from..to; stock-offcut bars go with the range that starts at 1', () => {
    const s = stickerModel(args())
    expect(stickersInRange(s, 'A|F', 2, 2).map(x => x.footR)).toEqual(['เส้น 2 · 4/6', 'เส้น 2 · 5/6'])
    expect(stickersInRange(s, 'A|F', 1, 1).map(x => x.footR)).toEqual(['OC-0003 · 1/6', 'OC-0003 · 27/10/69', 'เส้น 1 · 2/6', 'เส้น 1 · 3/6', 'เส้น 1 · 27/10/69'])
    expect(stickersInRange(s, 'B|F', 1, 1).every(x => x.groupKey === 'B|F')).toBe(true)
  })
})
```

In `src/pages/estimation/StickerSheet.smoke.test.jsx` replace the two PDF-button regexes:
- `expect(html).toMatch(/disabled=""[^>]*>ดาวน์โหลด PDF สติกเกอร์/)` → `expect(html).toMatch(/disabled=""[^>]*>ดาวน์โหลด PDF \d+ ดวง/)`
- `expect(html).not.toMatch(/disabled=""[^>]*>ดาวน์โหลด PDF สติกเกอร์/)` → `expect(html).not.toMatch(/disabled=""[^>]*>ดาวน์โหลด PDF \d+ ดวง/)`

and append inside `describe('StickerSheet', …)`:

```jsx
  it('the PDF button says how many stickers it will print', () => {
    // 3 pieces + 2 remainders, of which the short one is dropped by default -> 4 to print
    expect(render({})).toContain('ดาวน์โหลด PDF 4 ดวง')
  })
  it('a group of up to 10 bars: range 1–N, no per-10 buttons, only ทั้งหมด', () => {
    const html = render({})
    expect(html).toContain('เส้นที่')
    expect(html).toContain('ทั้งหมด')
    expect(html).not.toContain('รอบละ 10 เส้น:')
    expect(html).toContain('กรอบบาน เส้น 1–2 = ท่อน 3 ดวง + เศษ 1 ดวง · ลำดับ 1/3 … 3/3')
  })
```

`src/pages/estimation/StickerSheet.range.smoke.test.jsx`:

```jsx
// @vitest-environment jsdom
// Stickers by bar range: default first 10 bars, per-10 quick buttons, typed ranges clamped, k/N stays whole-project,
// and a group cut only from stock offcuts has no range.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('../../lib/stickerRender.js', () => ({
  qrDataUrl: async () => 'data:image/png;base64,AA',
  endGlyphDataUrl: () => 'data:image/png;base64,AA',
  downloadStickersPdf: vi.fn(async () => {}),
}))
const { default: StickerSheet } = await import('./StickerSheet.jsx')

afterEach(cleanup)

const pc = (len, o = {}) => ({ length_m: len, opening_no: 'W-01', item_id: 'i1', item_name: '', role_name: 'เฟรมบน', end_a: 'square', end_b: 'square', notch: null, kerf_style: 'square', ...o })
const big = {
  key: 'A|F', profile_id: 'A', finish_id: 'F', die_no: '15100', name: 'เฟรมบน', finish_name: 'POWDER COATING WHITE', length_m: 6.4, offcutBars: [], unplaced: [],
  bars: Array.from({ length: 12 }, () => ({ length_m: 6.4, left_m: 1.0, pieces: [pc(1.8), pc(1.8), pc(1.8)] })),
  newOffcuts: Array.from({ length: 12 }, (_, i) => ({ key: `A|F#${i + 1}`, bar_ref: String(i + 1), length_m: 1.0, end_a: 'square', keep: true })),
}
const fromStock = {
  key: 'B|F', profile_id: 'B', finish_id: 'F', die_no: null, name: 'เสากุญแจ', finish_name: 'POWDER COATING WHITE', length_m: 6.4, bars: [], unplaced: [],
  offcutBars: [{ length_m: 5.6, left_m: 0.6, pieces: [pc(2.5, { opening_no: 'T-01' }), pc(2.5, { opening_no: 'T-01' })], offcut: { id: 'o6', code: 'OC-0006', length_m: 5.6 } }],
}
fromStock.newOffcuts = [{ key: 'B|F#OC-0006', bar_ref: 'OC-0006', length_m: 0.6, end_a: 'square', keep: true }]
const plan = { signature: 'S', groups: [big, fromStock] }
const view = () => render(<StickerSheet plan={plan} issued={null} codes={null} projectName="PARLLEL TROPICAL" projectId="pj1" openingIds={{}} flipped={new Set()} onFlip={() => {}} />)
const text = () => document.body.textContent

describe('StickerSheet bar range', () => {
  it('opens on bars 1–10 with per-10 buttons, the count on the PDF button and whole-project numbers', () => {
    view()
    expect(screen.getByRole('option', { name: '15100 เฟรมบน · POWDER COATING WHITE (12 เส้น)' })).toBeTruthy()
    expect(text()).toContain('รอบละ 10 เส้น:')
    expect(screen.getByRole('button', { name: '1–10' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '11–12' }).getAttribute('aria-pressed')).toBe('false')
    expect(text()).toContain('เฟรมบน เส้น 1–10 = ท่อน 30 ดวง + เศษ 10 ดวง · ลำดับ 1/38 … 30/38')
    expect(screen.getByText('ดาวน์โหลด PDF 40 ดวง')).toBeTruthy()
  })
  it('a quick button and ทั้งหมด change the range', () => {
    view()
    fireEvent.click(screen.getByRole('button', { name: '11–12' }))
    expect(text()).toContain('เฟรมบน เส้น 11–12 = ท่อน 6 ดวง + เศษ 2 ดวง · ลำดับ 31/38 … 36/38')
    expect(screen.getByText('ดาวน์โหลด PDF 8 ดวง')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'ทั้งหมด' }))
    expect(text()).toContain('เฟรมบน เส้น 1–12 = ท่อน 36 ดวง + เศษ 12 ดวง')
  })
  it('a typed range is clamped and put in order', () => {
    view()
    fireEvent.change(screen.getByLabelText('เส้นที่'), { target: { value: '12' } })
    fireEvent.change(screen.getByLabelText('ถึง'), { target: { value: '3' } })
    expect(text()).toContain('เฟรมบน เส้น 3–12 = ท่อน 30 ดวง')
    fireEvent.change(screen.getByLabelText('ถึง'), { target: { value: '99' } })
    expect(text()).toContain('เฟรมบน เส้น 12–12 = ท่อน 3 ดวง')
  })
  it('a group with no new bars has no range and lists all its stickers', () => {
    view()
    fireEvent.change(screen.getByLabelText('หน้าตัด'), { target: { value: 'B|F' } })
    expect(screen.queryByLabelText('เส้นที่')).toBeNull()
    expect(text()).not.toContain('รอบละ 10 เส้น:')
    expect(text()).toContain('2 ท่อน + เศษ 1 ชิ้น')
    expect(screen.getByText('ดาวน์โหลด PDF 3 ดวง')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/stickers.test.js src/pages/estimation/StickerSheet.smoke.test.jsx src/pages/estimation/StickerSheet.range.smoke.test.jsx`
Expected: FAIL — `barChunks` etc. not exported; no range controls; the PDF label has no count.

- [ ] **Step 3: `src/lib/stickers.js` — bar numbers and range helpers**

In `stickerModel`, change the `seq` array to carry the bar number:

```js
    const seq = [
      ...g.offcutBars.map(b => ({ bar: b, ref: b.offcut.code, label: b.offcut.code, barNo: null })),
      ...g.bars.map((b, i) => ({ bar: b, ref: String(i + 1), label: `เส้น ${i + 1}`, barNo: i + 1 })),
    ]
    for (const { bar, ref, label, barNo } of seq) {
```

In the piece `out.push({…})` add `barNo, seq: k, total,` (after `groupKey: g.key,`); in the offcut `out.push({…})` add `barNo,` (after `groupKey: g.key,`).

Append after `stickerPages`:

```js
// Print rounds of `size` bars: [{ from: 1, to: 10 }, { from: 11, to: 20 }, ...] for n new bars.
export function barChunks(n, size = 10) {
  const out = []
  for (let a = 1; a <= n; a += size) out.push({ from: a, to: Math.min(n, a + size - 1) })
  return out
}

// A typed bar range (n >= 1): whole numbers inside 1..n, swapped when typed the other way round; a blank or
// non-number end becomes 1 (from) or n (to).
export function clampRange(from, to, n) {
  const whole = (v, fallback) => {
    const x = Math.trunc(Number(v))
    return String(v ?? '').trim() !== '' && Number.isFinite(x) ? Math.min(n, Math.max(1, x)) : fallback
  }
  let a = whole(from, 1)
  let b = whole(to, n)
  if (a > b) [a, b] = [b, a]
  return { from: a, to: b }
}

// One profile group's stickers from new bar `from` to bar `to`. Stock-offcut bars are cut before bar 1, so their
// pieces and remainders belong to the range that starts at bar 1. A remainder goes with its own bar.
export function stickersInRange(stickers, groupKey, from, to) {
  return (stickers || []).filter(s => s.groupKey === groupKey && (s.barNo == null ? from <= 1 : s.barNo >= from && s.barNo <= to))
}
```

- [ ] **Step 4: `StickerSheet.jsx` — range state, controls and labels**

Extend the stickers import with `barChunks, clampRange, stickersInRange`.

After `const [error, setError] = useState(null)` add:

```jsx
  // The typed bar range belongs to one profile group; another group starts on its first 10 bars.
  const [rangeFor, setRangeFor] = useState({ key: null, from: '', to: '' })
```

Replace the two lines

```jsx
  const selected = groupKey === ALL ? ALL : (groups.some(g => g.key === groupKey) ? groupKey : (groups[0] && groups[0].key))
  const visible = useMemo(() => (selected === ALL ? all : all.filter(s => s.groupKey === selected)), [all, selected])
```

with:

```jsx
  const selected = groupKey === ALL ? ALL : (groups.some(g => g.key === groupKey) ? groupKey : (groups[0] && groups[0].key))
  const selGroup = selected === ALL ? null : groups.find(g => g.key === selected) || null
  const nBars = selGroup ? selGroup.bars.length : 0
  const rangeText = rangeFor.key === selected ? rangeFor : { key: selected, from: '1', to: String(Math.min(10, nBars)) }
  const range = nBars > 0 ? clampRange(rangeText.from, rangeText.to, nBars) : null
  const setRange = (from, to) => setRangeFor({ key: selected, from: String(from), to: String(to) })
  const rFrom = range ? range.from : null
  const rTo = range ? range.to : null
  const visible = useMemo(() => {
    if (selected === ALL) return all
    return rFrom != null ? stickersInRange(all, selected, rFrom, rTo) : all.filter(s => s.groupKey === selected)
  }, [all, selected, rFrom, rTo])
```

After `const pieceCount = …` add:

```jsx
  const seqs = visible.filter(s => s.kind === 'piece').map(s => s.seq)
  const totalPieces = all.length ? (all.find(s => s.kind === 'piece') || {}).total || 0 : 0
  const keptOffCount = visible.filter(s => s.kind === 'offcut' && kept(s)).length
```

In the printing effect change the file name to:

```jsx
      const part = range && selGroup ? `-${selGroup.name || 'หน้าตัด'}-เส้น${range.from}-${range.to}` : ''
      downloadStickersPdf(PRINT_ID, paper, `สติกเกอร์-${projectName || 'โปรเจกต์'}${part}.pdf`)
```

(the `const part` line goes inside the `requestAnimationFrame` callback, just before the `downloadStickersPdf` call).

Replace the group `<option>` line with:

```jsx
            {groups.map(g => <option key={g.key} value={g.key}>{`${groupLabel(g)} (${g.bars.length} เส้น)`}</option>)}
```

Give the select an id so its label is clickable and testable: change `<div><label className="label">หน้าตัด</label>` / `<select className="input" value={selected || ''} …>` to

```jsx
        <div><label className="label" htmlFor="stk-group">หน้าตัด</label>
          <select id="stk-group" className="input" value={selected || ''} onChange={e => setGroupKey(e.target.value)}>
```

Directly after that select's closing `</div>`, insert the range inputs:

```jsx
        {range && <>
          <div><label className="label" htmlFor="stk-from">เส้นที่</label>
            <input id="stk-from" className="input" type="number" min={1} max={nBars} style={{ width: 72 }} value={rangeText.from} onChange={e => setRangeFor({ ...rangeText, from: e.target.value })} />
          </div>
          <div><label className="label" htmlFor="stk-to">ถึง</label>
            <input id="stk-to" className="input" type="number" min={1} max={nBars} style={{ width: 72 }} value={rangeText.to} onChange={e => setRangeFor({ ...rangeText, to: e.target.value })} />
          </div>
        </>}
```

Replace the PDF button label `{busy ? 'กำลังสร้าง PDF...' : 'ดาวน์โหลด PDF สติกเกอร์'}` with:

```jsx
            {busy ? 'กำลังสร้าง PDF...' : `ดาวน์โหลด PDF ${toPrint.length} ดวง`}
```

Directly after the controls row's closing `</div>` (before `{error && <InlineError …`), insert the quick buttons and the range summary:

```jsx
      {range && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {nBars > 10 && <span style={muted}>รอบละ 10 เส้น:</span>}
          {nBars > 10 && barChunks(nBars).map(c => {
            const on = range.from === c.from && range.to === c.to
            return <button key={c.from} type="button" aria-pressed={on} className={`btn btn-sm ${on ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setRange(c.from, c.to)}>{`${c.from}–${c.to}`}</button>
          })}
          {(() => {
            const on = range.from === 1 && range.to === nBars
            return <button type="button" aria-pressed={on} className={`btn btn-sm ${on ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setRange(1, nBars)}>ทั้งหมด</button>
          })()}
        </div>
      )}
      {range && (
        <div style={muted}>
          {`${selGroup.name || '?'} เส้น ${range.from}–${range.to} = ท่อน ${pieceCount} ดวง + เศษ ${keptOffCount} ดวง`}
          {seqs.length ? ` · ลำดับ ${seqs[0]}/${totalPieces} … ${seqs[seqs.length - 1]}/${totalPieces}` : ''}
        </div>
      )}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/stickers.test.js src/pages/estimation/StickerSheet.smoke.test.jsx src/pages/estimation/StickerSheet.range.smoke.test.jsx src/pages/estimation/StickerSheet.errors.smoke.test.jsx`
Expected: PASS.

- [ ] **Step 6: Full suite, then commit**

Run: `npx vitest run` — expected: all pass.

```bash
git -C /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/alu-cost-catalog add src/lib/stickers.js src/lib/stickers.test.js src/pages/estimation/StickerSheet.jsx src/pages/estimation/StickerSheet.smoke.test.jsx src/pages/estimation/StickerSheet.range.smoke.test.jsx
git -C /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/alu-cost-catalog commit -F - <<'EOF'
feat(stickers): print by bar range with per-10 quick buttons; PDF button shows the sticker count

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 7: Length helper shows the best 5 by kg plus the 6.40 m row; handover

**Files:**
- Modify: `src/lib/cutOptimizer.js:48-61` (`compareLengths` rows gain `per_bar_min` / `per_bar_max`)
- Modify: `src/lib/cutOptimizer.test.js` (new test)
- Modify: `src/pages/estimation/projectBomHelpers.js` (`optimizerView` ranks by kg; new `shortLengthRows`)
- Modify: `src/pages/estimation/projectBomHelpers.test.js` (`optimizerView` tests updated, new tests)
- Modify: `src/pages/estimation/CutOptimizerPanel.jsx` (table, short list toggle, footer)
- Modify: `src/pages/estimation/CutOptimizerPanel.smoke.test.jsx` (Task 1's error test updated, new tests)
- Modify: `docs/handover-aluminium-cost-catalog.md` (new section at the end)

**Interfaces:**
- Consumes: `compareLengths` rows (`length_m, count, stock_m, scrap_m, reusable_m, waste_pct, cost, feasible, unplaced`), `candidateLengths`, `makeBarPrice`.
- Produces: `compareLengths` rows also carry `per_bar_min: number`, `per_bar_max: number` (pieces per bar; 0 when no bars).
- Produces: `optimizerView(...) -> { rows, hasCuts }` (its `basis` field is removed — only `CutOptimizerPanel.jsx` and `projectBomHelpers.test.js` read it; the other `.basis` hits under `src/` are `compareLengths`' and `resolveAluPrice`'s own fields, unchanged). Each row: `length_m, isCurrent, isStock, status: 'ok'|'infeasible', unplaced, count, stock_m, scrap_m, reusable_m, waste_pct, cost, per_bar_min, per_bar_max, kg: number|null, diff_kg: number|null, best: boolean`. Rows come ranked: feasible rows by least kg bought (= metres bought for one profile), then less scrap, then fewer bars, then shorter bar (owner ruling 4, the same order as `cutPlan.js` `bestLength`); infeasible rows last by length. `best` = the first feasible row. The market bar `settings.stock_length_m` is always a candidate.
- Produces: `shortLengthRows(rows, n = 5) -> rows` — the first `n` feasible rows, plus the market-bar row and the row in use when they are not among them.

The ~60-row table the owner saw is this panel (ตัวช่วยเลือกความยาวเส้น, one row per candidate length 4.00–7.00 m), not `CustomLengthSummary` (one row per profile). Columns follow the mockup — ความยาว (ม.), ท่อน/เส้น, เส้น, กก. ที่ซื้อ, เทียบ 6.40 — and keep ค่าอลูมิเนียม (฿) from today's table. The best row gets the chip "ดีที่สุด"; the row in use shows the pressed "ใช้อยู่" button; the others "ใช้"; the market-bar row is labelled "6.40 (เส้นตลาด)". "ดูทั้งหมด N ความยาว" shows every row; "แสดงเฉพาะ 5 ตัวเลือกที่ดีที่สุด" goes back.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/cutOptimizer.test.js` (it already imports `compareLengths` and defines `S` = 3 mm square kerf, 0.5 m min keep):

```js
describe('compareLengths pieces per bar', () => {
  it('reports the fewest and most pieces on one bar', () => {
    const r = compareLengths({ cuts: [{ length_m: 1.8, quantity: 4, style: 'square' }], lengths: [5.45], settings: S, barPrice: null }).rows[0]
    expect(r.count).toBe(2)
    expect([r.per_bar_min, r.per_bar_max]).toEqual([1, 3])
  })
})
```

In `src/pages/estimation/projectBomHelpers.test.js`, add `shortLengthRows` to the import list. In `describe('optimizerView', …)`: in the first test delete the line `expect(v.basis).toBe('cost') …`; replace the second test (`'compares by scrap when a feasible row has no price'`) with:

```js
  it('always includes the market bar and ranks by kg bought, then scrap, bars, length', () => {
    const g = { profile_id: 'p1', finish_id: 'f1', stock_length_m: 6, cuts: [{ length_m: 1.8, quantity: 120, style: 'square' }] }
    const v = optimizerView({ group: g, index: index('per_kg'), settings: DEFAULT_SETTINGS, asOf: '2026-09-01', seriesIds: ['s1'], rangeM: rangeLengths(DEFAULT_SETTINGS) })
    expect(v.rows).toHaveLength(61)
    expect(v.rows.slice(0, 5).map(r => r.length_m)).toEqual([5.45, 5.5, 5.55, 5.6, 5.65])
    expect(v.rows[0]).toMatchObject({ best: true, count: 40, per_bar_min: 3, per_bar_max: 3 })
    expect(v.rows[0].kg).toBeCloseTo(218, 9)
    expect(v.rows[0].diff_kg).toBeCloseTo(-38, 9)          // vs 6.40 m: 40 bars, 256 kg
    expect(v.rows.filter(r => r.best)).toHaveLength(1)
    const stock = v.rows.find(r => r.isStock)
    expect(stock).toMatchObject({ length_m: 6.4, isCurrent: false, diff_kg: 0 })
    expect(v.rows.find(r => r.isCurrent).length_m).toBe(6)
  })
  it('no weight: kg and the difference are null, the ranking still follows metres bought', () => {
    const ix = index('per_kg'); ix.profiles.p1.linear_weight_kg_per_m = null
    const g = { profile_id: 'p1', finish_id: 'f1', stock_length_m: 6.4, cuts: [{ length_m: 1.8, quantity: 6, style: 'square' }] }
    const v = optimizerView({ group: g, index: ix, settings: DEFAULT_SETTINGS, asOf: '2026-09-01', seriesIds: ['s1'], rangeM: [5.45, 7] })
    expect(v.rows[0]).toMatchObject({ length_m: 5.45, kg: null, diff_kg: null, best: true })
  })
```

and append:

```js
describe('shortLengthRows', () => {
  const r = (L, o = {}) => ({ length_m: L, status: 'ok', isStock: false, isCurrent: false, ...o })
  const rows = [r(5.45), r(5.5), r(5.55), r(5.6), r(5.65), r(5.7), r(6.0, { isCurrent: true }), r(6.4, { isStock: true }), r(4.0, { status: 'infeasible' })]
  it('top 5 feasible, then the row in use and the market bar when not among them', () => {
    expect(shortLengthRows(rows).map(x => x.length_m)).toEqual([5.45, 5.5, 5.55, 5.6, 5.65, 6.0, 6.4])
  })
  it('no duplicates when the market bar is already in the top 5', () => {
    const top = [r(6.4, { isStock: true, isCurrent: true }), r(6.45), r(6.5)]
    expect(shortLengthRows(top).map(x => x.length_m)).toEqual([6.4, 6.45, 6.5])
  })
  it('an infeasible market bar is still listed (it says ตัดไม่ได้)', () => {
    const rs = [r(7), r(6.4, { isStock: true, status: 'infeasible' })]
    expect(shortLengthRows(rs).map(x => x.length_m)).toEqual([7, 6.4])
  })
})
```

Add `rangeLengths` to the `cutPlan.js` import of that test file (`import { buildCutPlan, issuePayload, rangeLengths } from '../../lib/cutPlan.js'`).

In `src/pages/estimation/CutOptimizerPanel.smoke.test.jsx`, change the Task 1 test's click to `fireEvent.click(screen.getAllByRole('button', { name: 'ใช้' })[0])`, and append inside `describe('CutOptimizerPanel', …)`:

```jsx
  it('shows the best 5 by kg plus the 6.40 m market bar in use, with the toggle to see all 61', () => {
    view()
    const rows = [...document.querySelectorAll('tbody tr')]
    expect(rows).toHaveLength(6)
    expect(rows[0].textContent).toContain('5.45')
    expect(rows[0].textContent).toContain('ดีที่สุด')
    expect(rows[0].textContent).toContain('218.00')
    expect(rows[0].textContent).toContain('−38.00')
    expect(rows[0].cells[1].textContent).toBe('3')
    expect(rows[0].cells[2].textContent).toBe('40')
    expect(rows[5].textContent).toContain('6.40 (เส้นตลาด)')
    expect(rows[5].querySelector('button').textContent).toBe('ใช้อยู่')
    expect(rows[5].querySelector('button').getAttribute('aria-pressed')).toBe('true')
    expect([...document.querySelectorAll('thead th')].map(th => (th.childNodes[0] ? th.childNodes[0].textContent : ''))).toEqual(['ความยาว (ม.)', 'ท่อน/เส้น', 'เส้น', 'กก. ที่ซื้อ', 'เทียบ 6.40', 'ค่าอลูมิเนียม (฿)', ''])
    fireEvent.click(screen.getByText('ดูทั้งหมด 61 ความยาว'))
    expect(document.querySelectorAll('tbody tr')).toHaveLength(61)
    fireEvent.click(screen.getByText('แสดงเฉพาะ 5 ตัวเลือกที่ดีที่สุด'))
    expect(document.querySelectorAll('tbody tr')).toHaveLength(6)
  })
  it('without edit rights the other rows have no ใช้ button', () => {
    view({ canEdit: false })
    expect(screen.queryAllByRole('button', { name: 'ใช้' })).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'ใช้อยู่' })).toBeTruthy()
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/cutOptimizer.test.js src/pages/estimation/projectBomHelpers.test.js src/pages/estimation/CutOptimizerPanel.smoke.test.jsx`
Expected: FAIL — no `per_bar_min`; rows not ranked / no `kg`; `shortLengthRows` not exported; the panel renders 61 rows and no `ใช้` buttons.

- [ ] **Step 3: `cutOptimizer.js` — pieces per bar**

In `compareLengths`, replace the row `return` inside `lengths.map` with:

```js
    const per = packed.bars.map(b => b.pieces.length)
    return { length_m: L, ...s, feasible, cost: feasible && price != null ? price * s.count : null,
      per_bar_min: per.length ? Math.min(...per) : 0, per_bar_max: per.length ? Math.max(...per) : 0 }
```

- [ ] **Step 4: `projectBomHelpers.js` — rank by kg, the short list**

Replace `optimizerView` (the comment above it and the function) with:

```js
// a - b, but equal within e (float sums of bar lengths).
const near = (a, b, e) => (Math.abs(a - b) < e ? 0 : a - b)
// The cut plan's order for a length (owner ruling 4): least kg bought (= metres bought, one profile), then less scrap,
// then fewer bars, then the shorter bar.
const byBought = (a, b) => near(a.stock_m, b.stock_m, 1e-6) || near(a.scrap_m, b.scrap_m, EPS) || a.count - b.count || a.length_m - b.length_m

// View model of the cut optimizer for one profile group (an item of buildProjectBom().profiles). The market bar
// (settings.stock_length_m) is always a candidate. Rows come ranked (byBought), infeasible rows last by length;
// best = the first feasible row. kg needs the profile's kg/m (null without it); diff_kg = kg minus the market bar's.
export function optimizerView({ group, index, settings, asOf, seriesIds, rangeM }) {
  const profile = index.profiles[group.profile_id]
  const finish = group.finish_id ? index.finishes[group.finish_id] : null
  const barPrice = makeBarPrice({ index, profile, finish, seriesIds: seriesIds || [], asOf })
  const stockL = Number(settings.stock_length_m)
  const w = Number(profile && profile.linear_weight_kg_per_m)
  const kgPerM = w > 0 ? w : null
  const lengths = candidateLengths(index, group.profile_id, group.finish_id, group.stock_length_m, [stockL, ...(rangeM || [])])
  const result = compareLengths({ cuts: group.cuts, lengths, settings, barPrice })
  const rows = result.rows.map(r => {
    const infeasible = r.feasible === false
    return {
      length_m: r.length_m, isCurrent: Math.abs(r.length_m - group.stock_length_m) < EPS, isStock: Math.abs(r.length_m - stockL) < EPS,
      status: infeasible ? 'infeasible' : 'ok',
      unplaced: infeasible ? r.unplaced : [],
      count: infeasible ? null : r.count, stock_m: infeasible ? null : r.stock_m, scrap_m: infeasible ? null : r.scrap_m, reusable_m: infeasible ? null : r.reusable_m,
      waste_pct: infeasible ? null : r.waste_pct, cost: infeasible ? null : r.cost,
      per_bar_min: infeasible ? null : r.per_bar_min, per_bar_max: infeasible ? null : r.per_bar_max,
      kg: infeasible || kgPerM == null ? null : r.stock_m * kgPerM,
    }
  })
  const ok = rows.filter(r => r.status === 'ok').sort(byBought)
  const bad = rows.filter(r => r.status !== 'ok').sort((a, b) => a.length_m - b.length_m)
  const stockRow = ok.find(r => r.isStock) || null
  const ranked = [...ok, ...bad].map((r, i) => ({
    ...r, best: r.status === 'ok' && i === 0,
    diff_kg: r.kg != null && stockRow && stockRow.kg != null ? r.kg - stockRow.kg : null,
  }))
  return { rows: ranked, hasCuts: group.cuts.length > 0 }
}

// The length helper's short list: the first n feasible rows (rows come ranked), plus the market-bar row and the row
// in use when they are not among them.
export function shortLengthRows(rows, n = 5) {
  const out = (rows || []).filter(r => r.status === 'ok').slice(0, n)
  for (const r of rows || []) if ((r.isStock || r.isCurrent) && !out.includes(r)) out.push(r)
  return out
}
```

Add `shortLengthRows` nowhere else; `CutOptimizerPanel` imports it.

- [ ] **Step 5: `CutOptimizerPanel.jsx` — the short table**

Replace the whole file with:

```jsx
// src/pages/estimation/CutOptimizerPanel.jsx
// Cut optimizer (mockup screen 7), used for the WHOLE project: one profile at a time. Shows the 5 lengths that buy
// the fewest kg (then less scrap, fewer bars) plus the market bar; "ดูทั้งหมด" shows every candidate. Offcuts never
// lower a cost here. Kerf and min-keep come from the settings and are shown, not edited.
import { useState, useMemo } from 'react'
import { fmt } from '../../lib/supabase.js'
import { optimizerView, shortLengthRows } from './projectBomHelpers.js'
import InlineError from './InlineError.jsx'

const m2 = n => Number(n).toFixed(2)
const diffText = d => (d == null ? '—' : d < -1e-6 ? `−${m2(-d)}` : d > 1e-6 ? `+${m2(d)}` : '0')
const perBar = r => (r.per_bar_min === r.per_bar_max ? String(r.per_bar_max) : `${r.per_bar_min}–${r.per_bar_max}`)

export default function CutOptimizerPanel({ profiles, seriesMap, index, settings, asOf, rangeM, canEdit, onUseLength }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [showAll, setShowAll] = useState(false)
  const group = profiles.find(g => g.key === key) || profiles[0] || null
  const view = useMemo(() => (group ? optimizerView({ group, index, settings, asOf, seriesIds: seriesMap[group.key] || [], rangeM }) : null), [group, index, settings, asOf, seriesMap, rangeM])
  if (!group || !view) return null

  const use = async L => {
    setBusy(true); setError(null)
    try { await onUseLength(group.profile_id, L) } catch (e) { setError(e.message || String(e)) } finally { setBusy(false) }
  }
  const best = view.rows.find(r => r.best)
  const short = shortLengthRows(view.rows)
  const rows = showAll ? view.rows : short

  return (
    <div className="card" style={{ padding: 16, display: 'grid', gap: 10 }}>
      <div style={{ fontWeight: 700 }}>ตัวช่วยเลือกความยาวเส้น <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text3)' }}>(คิดรวมทั้งโครงการ ไม่ใช่ต่อรายการ)</span></div>
      {error && <InlineError title="บันทึกไม่สำเร็จ" onClose={() => setError(null)}>{error}</InlineError>}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div><label className="label">หน้าตัด</label>
          <select className="input" value={group.key} onChange={e => setKey(e.target.value)}>
            {profiles.map(g => <option key={g.key} value={g.key}>{g.die_no ? `${g.die_no} ` : ''}{g.name}{g.finish_name ? ` · ${g.finish_name}` : ''}</option>)}
          </select></div>
        <div style={{ fontSize: 12, color: 'var(--text2)' }}>ค่าใบเลื่อย 90°: {settings.kerf_square_mm} มม. · 45°: {settings.kerf_miter_mm} มม. (ชิ้น 45° วัดความยาวด้านนอก) · เศษขั้นต่ำที่เก็บใช้ต่อ: {settings.min_keep_offcut_m} ม. (แก้ที่ตั้งค่า)</div>
      </div>
      <div style={{ fontSize: 12 }} className="font-mono">
        {group.cuts.map(c => `${Number(c.length_m).toFixed(3)}×${c.quantity}${c.style === 'miter45' ? ' (45° ยาวด้านนอก)' : ''}`).join(' · ')}
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr>
            <th>ความยาว (ม.)</th><th>ท่อน/เส้น</th><th>เส้น</th><th>กก. ที่ซื้อ</th><th>{`เทียบ ${m2(settings.stock_length_m)}`}</th>
            <th>ค่าอลูมิเนียม (฿)<div style={{ fontWeight: 400, fontSize: 11, color: 'var(--text3)' }}>ต้นทุนซื้อเป็นเส้น ใช้เทียบความยาวเท่านั้น ไม่ใช่ยอดอลูมิเนียมในรายการ</div></th><th></th>
          </tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.length_m} style={r.status === 'infeasible' ? { color: 'var(--text3)' } : undefined}>
                <td className="font-mono">
                  {r.isStock ? <span style={{ color: 'var(--text3)' }}>{`${m2(r.length_m)} (เส้นตลาด)`}</span> : <b>{m2(r.length_m)}</b>}
                  {r.best && <> <span className="badge" style={{ color: 'var(--green)' }}>ดีที่สุด</span></>}
                </td>
                {r.status === 'infeasible' ? (
                  <td colSpan={5} style={{ color: 'var(--red)' }}>ตัดไม่ได้ — ไม่มีที่ลง {r.unplaced.length} ชิ้น ({[...new Set(r.unplaced)].map(x => Number(x).toFixed(3)).join(', ')} ม.)</td>
                ) : (
                  <>
                    <td className="font-mono">{perBar(r)}</td>
                    <td className="font-mono">{r.count}</td>
                    <td className="font-mono">{r.kg == null ? '—' : m2(r.kg)}</td>
                    <td className="font-mono" style={r.diff_kg != null && r.diff_kg < -1e-6 ? { color: 'var(--green)' } : undefined}>{diffText(r.diff_kg)}</td>
                    <td className="font-mono">{r.cost == null ? '—' : fmt(r.cost)}</td>
                  </>
                )}
                <td>
                  {r.isCurrent
                    ? <button type="button" className="btn btn-sm btn-primary" aria-pressed="true" disabled>ใช้อยู่</button>
                    : canEdit && r.status === 'ok' && <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => use(r.length_m)}>ใช้</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {view.rows.length > short.length && (
        <div><button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowAll(v => !v)}>
          {showAll ? 'แสดงเฉพาะ 5 ตัวเลือกที่ดีที่สุด' : `ดูทั้งหมด ${view.rows.length} ความยาว`}
        </button></div>
      )}
      <div style={{ fontSize: 12, color: 'var(--text2)', display: 'grid', gap: 2 }}>
        {best && <div>ดีที่สุด: {m2(best.length_m)} ม. (ซื้อน้อยกก.ที่สุด แล้วเศษทิ้งน้อย แล้วจำนวนเส้นน้อย)</div>}
        {!best && view.hasCuts && <div style={{ color: 'var(--red)' }}>ไม่มีความยาวไหนตัดได้ครบ</div>}
        {view.rows.some(r => r.status === 'infeasible') && <div>แถวที่ "ตัดไม่ได้" ไม่นำมาเทียบ และไม่เป็นความยาวที่ดีที่สุด</div>}
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/lib/cutOptimizer.test.js src/pages/estimation/projectBomHelpers.test.js src/pages/estimation/CutOptimizerPanel.smoke.test.jsx src/pages/estimation/noBrowserDialogs.test.js`
Expected: PASS.

- [ ] **Step 7: Full suite and build**

Run: `npx vitest run` — expected: all pass (about 2653 + the new tests).
Run: `npm run build` from the worktree — expected: build succeeds (it only writes `dist/` and `build-info.json`; do NOT run `npm run deploy`).

- [ ] **Step 8: Handover section**

Append to `docs/handover-aluminium-cost-catalog.md`:

```markdown
# Cut sheet round 2 handover (2026-10-30)

Plan: `docs/superpowers/plans/2026-10-30-cut-sheet-round2.md`. Spec: owner-approved mockup "ใบตัดรอบแก้ 6 ข้อ" (fix6 `Main.dc.html`). Front-end only, **no migration**. Not merged, not pushed, nothing deployed.

## What changed (gap numbers from the 2026-10-28 live check)

1. Section 1 nets out stock offcuts (`section1Rows`): codes per row, new bars = the plan's, old count struck through; after issue it uses the issued plan (fixes the deferred minor "after issue, section 1 follows the live plan"); stock-length input read-only after issue.
2. Die no. tag before the name on cut-sheet group headers and stickers, red "ไม่มีรหัส" when `alu_profiles.drawing_no` is empty; warning box listing those profiles; finish name on its own sticker line, wraps, smaller font, never "…". Issued plans show the catalogue's current die no. (`withLiveDieNos`).
5. `InlineError` replaces every `alert()` in the cut-sheet screens (guard test `noBrowserDialogs.test.js`); a refused void names the used offcut codes and the consuming job, built client-side from the reloaded `alu_offcuts` / `alu_cut_plans`.
6. Offcut panel tabs "เศษที่งานนี้ใช้ (n)" / "เศษที่ใบตัดนี้สร้าง (n)" with status chips; "ทิ้ง" only on in-stock rows.
7. Stickers by bar range (default bars 1–10, per-10 buttons, "ทั้งหมด"); PDF button shows the count; k/N stays whole-project; stock-offcut bars go with the range that starts at bar 1.
8. Length helper (`CutOptimizerPanel`) shows the best 5 by kg plus the 6.40 m row; "ดีที่สุด" now = least kg (ruling 4), no longer least cost.

## Live check still to do (owner / controller, on the dev server with a real login)

- PARLLEL TROPICAL: section 1 vs cut sheet new-bar counts agree; offcut tab 2 shows OC-0001.. with HOSPITAL usage chips.
- HOSPITAL: section 1 shows OC-0002/3/6/7 chips and 0 new bars on those profiles; try "ยกเลิกใบตัด" on PARLLEL → in-card error naming HOSPITAL.
- Stickers: download roll 50×30 and A4 PDFs for bars 1–10; check the finish line is whole and the die tag / red tag prints.
- Length helper: 6 rows, 5.45 "ดีที่สุด" on the เฟรมบน case.
```

- [ ] **Step 9: Commit**

```bash
git -C /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/alu-cost-catalog add src/lib/cutOptimizer.js src/lib/cutOptimizer.test.js src/pages/estimation/projectBomHelpers.js src/pages/estimation/projectBomHelpers.test.js src/pages/estimation/CutOptimizerPanel.jsx src/pages/estimation/CutOptimizerPanel.smoke.test.jsx docs/handover-aluminium-cost-catalog.md
git -C /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/alu-cost-catalog commit -F - <<'EOF'
feat(cut-optimizer): best 5 lengths by kg plus the market bar, show-all toggle; handover for round 2

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

## Self-review notes (resolved while writing)

- Spec coverage: gap 1 → Task 4; gap 2 → Task 5; gap 5 → Tasks 1–2 (every `alert(` found by `grep -n "alert(\|confirm(" src/pages/estimation/{ProjectBomView,BomProfilesTable,CutSheetView,StickerSheet,OffcutStockPanel,CustomLengthSummary,CutModeField,CutOptimizerPanel}.jsx`: StickerSheet ×2, ProjectBomView ×1, BomProfilesTable ×2, CutOptimizerPanel ×1, CustomLengthSummary ×1, CutModeField ×1; OffcutStockPanel already inline; deep links use a notice); gap 6 → Task 3; gap 7 → Task 6; gap 8 → Task 7.
- Names used across tasks: `InlineError`, `offcutTabs`, `offcutConsumer`, `voidBlockers`, `codesText`, `section1Rows`, `withLiveDieNos`, `missingDieNos`, `MissingDieNotice`, `NO_DIE_TEXT`, `finishFontMm`, `barChunks`, `clampRange`, `stickersInRange`, `shortLengthRows`, `per_bar_min` / `per_bar_max` — each defined once in the task listed under "Produces".
- `ProjectBomView.jsx` is edited in Tasks 2, 3, 4 and 5; each edit names the element or lines it replaces so it applies on top of the earlier ones.
