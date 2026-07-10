# Form Draft Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop "add new" popup forms from losing typed data when the page unexpectedly reloads (most likely Chrome discarding an inactive background tab), by persisting form contents to `localStorage` and auto-restoring them.

**Architecture:** One new module, `src/hooks/useDraftForm.js`, exports both a `useDraftForm()` hook (drop-in replacement for `useState` in components that freshly mount per modal-open) and raw `readDraft`/`saveDraft`/`clearDraft` functions (for the two LaborContractors.jsx sub-tabs whose form state lives in an always-mounted parent component instead). Applied to 8 forms across 6 files.

**Tech Stack:** React (existing), browser `localStorage` — no new dependency.

## Global Constraints

- Draft persistence applies **only to "add new" mode**, never to editing an existing record. The add-vs-edit signal is `!initial?.id` for the 5 simple form components (parent always passes an object — either the real record being edited, which has an `id`, or `EMPTY_FORM`, which never does) — never use `!initial` alone, since `initial` is truthy in both modes.
- `UserManagement.jsx` is explicitly excluded — its add-user form includes a `password` field, which must never be written to `localStorage`.
- Drafts are cleared: (1) immediately when Cancel is clicked, (2) optimistically the moment Save/Submit is clicked (not after confirmed server success — if the save fails, the in-memory form is untouched and can be retried, only the localStorage backup is gone).
- No new npm dependencies. All `localStorage` access wrapped in `try/catch` so a full/blocked storage (private browsing, quota) degrades to "no persistence" rather than crashing the form.
- Restoration is silent/automatic — no "restore draft?" confirmation prompt.

---

### Task 1: `useDraftForm` module

**Files:**
- Create: `src/hooks/useDraftForm.js`

**Interfaces:**
- Produces: `readDraft(key) -> object|null`, `saveDraft(key, data) -> void`, `clearDraft(key) -> void`, `useDraftForm(key, initialForm, enabled=true) -> [form, setForm, clear]` — consumed by Tasks 2-7.

- [ ] **Step 1: Write the module**

`src/hooks/useDraftForm.js`:

```js
// ============================================================
// useDraftForm — persist "add new" form contents to localStorage
// so an unexpected page reload (e.g. Chrome discarding an inactive
// background tab) doesn't wipe out unsaved typing.
//
// Two ways to use this module, matching two different component
// shapes found in this codebase:
//
// 1. useDraftForm(key, initialForm, enabled) — a drop-in useState
//    replacement, for components that freshly MOUNT each time their
//    modal opens (e.g. <SiteForm> rendered as {showForm && <SiteForm/>}).
//    Restoration happens naturally via the mount-time lazy initializer.
//
// 2. readDraft/saveDraft/clearDraft — raw primitives, for components
//    whose form state lives in an always-mounted parent (e.g.
//    LaborContractors.jsx's SubcontractorTab/ContractsTab, where the
//    modal is just conditional JSX inside a tab that never unmounts).
//    Wire these in manually at the points where the form is opened,
//    changed, saved, and cancelled.
// ============================================================
import { useEffect, useState } from 'react'

const PREFIX = 'draft:'

function safeGet(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // Private browsing, quota exceeded, etc. — persistence is a
    // nice-to-have; fail silently rather than break the form.
  }
}

function safeRemove(key) {
  try {
    localStorage.removeItem(PREFIX + key)
  } catch {
    // ignore
  }
}

/** Read a previously-saved draft for `key`, or null if none exists. */
export function readDraft(key) {
  return safeGet(key)
}

/** Persist `data` as the current draft for `key`. */
export function saveDraft(key, data) {
  safeSet(key, data)
}

/** Remove any saved draft for `key`. */
export function clearDraft(key) {
  safeRemove(key)
}

/**
 * Drop-in replacement for `useState(initialForm)` that also persists
 * to localStorage while `enabled` is true, restoring from any existing
 * draft at mount time. Pass `enabled=false` (e.g. when editing an
 * existing record) to behave exactly like plain useState with zero
 * persistence.
 */
export function useDraftForm(key, initialForm, enabled = true) {
  const [form, setForm] = useState(() => {
    if (!enabled) return initialForm
    const saved = readDraft(key)
    return saved ? { ...initialForm, ...saved } : initialForm
  })

  useEffect(() => {
    if (!enabled) return
    saveDraft(key, form)
  }, [form, enabled, key])

  const clear = () => clearDraft(key)

  return [form, setForm, clear]
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 3: Hand-verify the hook's restore logic against a worked example**

Given `localStorage` already contains `draft:test-form = '{"name":"สมชาย"}'`, and `useDraftForm('test-form', {name: '', phone: ''}, true)` is called: the lazy initializer calls `readDraft('test-form')` → `{name: 'สมชาย'}` (truthy) → returns `{...{name:'',phone:''}, ...{name:'สมชาย'}}` = `{name: 'สมชาย', phone: ''}`. This correctly merges the restored field over the empty-form defaults, keeping any fields the draft didn't have (`phone`) at their default. If `enabled` were `false` instead, the initializer returns `initialForm` unchanged, ignoring any existing draft — matching the "never restore in edit mode" requirement. No code changes needed — this is a manual trace to catch merge-order mistakes.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useDraftForm.js
git commit -m "Add useDraftForm module for form draft persistence"
```

---

### Task 2: Wire into `Sites.jsx` (`SiteForm`)

**Files:**
- Modify: `src/pages/Sites.jsx`

**Interfaces:**
- Consumes: `useDraftForm` from `../hooks/useDraftForm.js` (Task 1).

- [ ] **Step 1: Add the import**

In `src/pages/Sites.jsx`, add after the existing `import SearchableSelect from '../components/SearchableSelect.jsx'` line:

```js
import { useDraftForm } from '../hooks/useDraftForm.js'
```

- [ ] **Step 2: Replace the form state**

Change:

```js
function SiteForm({ initial = EMPTY_FORM, clients = [], onSave, onCancel, loading }) {
  const [form, setForm] = useState({ ...EMPTY_FORM, ...initial })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
```

to:

```js
function SiteForm({ initial = EMPTY_FORM, clients = [], onSave, onCancel, loading }) {
  const isAdd = !initial?.id
  const [form, setForm, clearDraft] = useDraftForm('sites-form', { ...EMPTY_FORM, ...initial }, isAdd)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
```

- [ ] **Step 3: Clear the draft on submit and on cancel**

Change:

```js
    <form onSubmit={e => { e.preventDefault(); onSave(form) }}>
```

to:

```js
    <form onSubmit={e => { e.preventDefault(); clearDraft(); onSave(form) }}>
```

Change:

```js
        <button type="button" className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
```

to:

```js
        <button type="button" className="btn btn-ghost" onClick={() => { clearDraft(); onCancel() }}>ยกเลิก</button>
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Sites.jsx
git commit -m "Persist Sites add-form draft to survive unexpected reloads"
```

---

### Task 3: Wire into `Clients.jsx` (`ClientForm`)

**Files:**
- Modify: `src/pages/Clients.jsx`

**Interfaces:**
- Consumes: `useDraftForm` from `../hooks/useDraftForm.js` (Task 1).

- [ ] **Step 1: Add the import**

In `src/pages/Clients.jsx`, add after the existing `import ExcelUpload from '../components/ExcelUpload.jsx'` line:

```js
import { useDraftForm } from '../hooks/useDraftForm.js'
```

- [ ] **Step 2: Replace the form state**

Change:

```js
function ClientForm({ initial = EMPTY_FORM, onSave, onCancel, loading }) {
  const [form, setForm] = useState({ ...EMPTY_FORM, ...initial })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
```

to:

```js
function ClientForm({ initial = EMPTY_FORM, onSave, onCancel, loading }) {
  const isAdd = !initial?.id
  const [form, setForm, clearDraft] = useDraftForm('clients-form', { ...EMPTY_FORM, ...initial }, isAdd)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
```

- [ ] **Step 3: Clear the draft on submit and on cancel**

Change:

```js
    <form onSubmit={e => { e.preventDefault(); onSave(form) }}>
```

to:

```js
    <form onSubmit={e => { e.preventDefault(); clearDraft(); onSave(form) }}>
```

Change:

```js
        <button type="button" className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
```

to:

```js
        <button type="button" className="btn btn-ghost" onClick={() => { clearDraft(); onCancel() }}>ยกเลิก</button>
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Clients.jsx
git commit -m "Persist Clients add-form draft to survive unexpected reloads"
```

---

### Task 4: Wire into `Suppliers.jsx` (`SupplierForm`)

**Files:**
- Modify: `src/pages/Suppliers.jsx`

**Interfaces:**
- Consumes: `useDraftForm` from `../hooks/useDraftForm.js` (Task 1).

- [ ] **Step 1: Add the import**

In `src/pages/Suppliers.jsx`, add after the existing `import ExcelUpload from '../components/ExcelUpload.jsx'` line:

```js
import { useDraftForm } from '../hooks/useDraftForm.js'
```

- [ ] **Step 2: Replace the form state**

This file's initial-form computation includes a `normCategory(...)` transform not present in the other files — preserve it exactly. Change:

```js
function SupplierForm({ initial = EMPTY_FORM, onSave, onCancel, loading }) {
  const [form, setForm] = useState({ ...EMPTY_FORM, ...initial, category: normCategory(initial.category) })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
```

to:

```js
function SupplierForm({ initial = EMPTY_FORM, onSave, onCancel, loading }) {
  const isAdd = !initial?.id
  const [form, setForm, clearDraft] = useDraftForm(
    'suppliers-form',
    { ...EMPTY_FORM, ...initial, category: normCategory(initial.category) },
    isAdd
  )
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
```

- [ ] **Step 3: Clear the draft on submit and on cancel**

Change:

```js
    <form onSubmit={e => { e.preventDefault(); onSave(form) }}>
```

to:

```js
    <form onSubmit={e => { e.preventDefault(); clearDraft(); onSave(form) }}>
```

Change:

```js
        <button type="button" className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
```

to:

```js
        <button type="button" className="btn btn-ghost" onClick={() => { clearDraft(); onCancel() }}>ยกเลิก</button>
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Suppliers.jsx
git commit -m "Persist Suppliers add-form draft to survive unexpected reloads"
```

---

### Task 5: Wire into `Categories.jsx` (`CatForm`)

**Files:**
- Modify: `src/pages/Categories.jsx`

**Interfaces:**
- Consumes: `useDraftForm` from `../hooks/useDraftForm.js` (Task 1).

- [ ] **Step 1: Add the import**

In `src/pages/Categories.jsx`, add after the existing `import { Modal, ConfirmDialog } from '../components/Modal.jsx'` line:

```js
import { useDraftForm } from '../hooks/useDraftForm.js'
```

- [ ] **Step 2: Replace the form state**

Change:

```js
function CatForm({ initial = EMPTY_FORM, onSave, onCancel, loading }) {
  const [form, setForm] = useState({ ...EMPTY_FORM, ...initial })
```

to:

```js
function CatForm({ initial = EMPTY_FORM, onSave, onCancel, loading }) {
  const isAdd = !initial?.id
  const [form, setForm, clearDraft] = useDraftForm('categories-form', { ...EMPTY_FORM, ...initial }, isAdd)
```

(The line directly after — `const set = (k, v) => setForm(f => ({ ...f, [k]: v }))` — is unchanged, just now sits below the new line instead of the old one.)

- [ ] **Step 3: Clear the draft on submit and on cancel**

Change:

```js
    <form onSubmit={e => { e.preventDefault(); onSave(form) }}>
```

to:

```js
    <form onSubmit={e => { e.preventDefault(); clearDraft(); onSave(form) }}>
```

Change:

```js
        <button type="button" className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
```

to:

```js
        <button type="button" className="btn btn-ghost" onClick={() => { clearDraft(); onCancel() }}>ยกเลิก</button>
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Categories.jsx
git commit -m "Persist Categories add-form draft to survive unexpected reloads"
```

---

### Task 6: Wire into `Payroll.jsx` (`SalaryForm`)

**Files:**
- Modify: `src/pages/Payroll.jsx`

**Interfaces:**
- Consumes: `useDraftForm` from `../hooks/useDraftForm.js` (Task 1).

- [ ] **Step 1: Add the import**

In `src/pages/Payroll.jsx`, add after the existing `import SearchableSelect from '../components/SearchableSelect.jsx'` line:

```js
import { useDraftForm } from '../hooks/useDraftForm.js'
```

- [ ] **Step 2: Replace the form state**

Change:

```js
function SalaryForm({ initial = EMPTY_FORM, workers, onSave, onCancel, loading }) {
  const [form, setForm] = useState({ ...EMPTY_FORM, ...initial })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
```

to:

```js
function SalaryForm({ initial = EMPTY_FORM, workers, onSave, onCancel, loading }) {
  const isAdd = !initial?.id
  const [form, setForm, clearDraft] = useDraftForm('payroll-form', { ...EMPTY_FORM, ...initial }, isAdd)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
```

- [ ] **Step 3: Clear the draft on submit and on cancel**

This file's submit handler builds a slightly different payload (`{ ...form, net_pay: form.net_pay || netCalc }`) than the other files — preserve that, just add `clearDraft()`. Change:

```js
    <form onSubmit={e => { e.preventDefault(); onSave({ ...form, net_pay: form.net_pay || netCalc }) }}>
```

to:

```js
    <form onSubmit={e => { e.preventDefault(); clearDraft(); onSave({ ...form, net_pay: form.net_pay || netCalc }) }}>
```

Change:

```js
        <button type="button" className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
```

to:

```js
        <button type="button" className="btn btn-ghost" onClick={() => { clearDraft(); onCancel() }}>ยกเลิก</button>
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Payroll.jsx
git commit -m "Persist Payroll add-form draft to survive unexpected reloads"
```

---

### Task 7: Wire into `LaborContractors.jsx` (3 forms: `SubcontractorTab`, `ContractsTab`, `PaymentModal`)

**Files:**
- Modify: `src/pages/LaborContractors.jsx`

**Interfaces:**
- Consumes: `readDraft`, `saveDraft`, `clearDraft`, `useDraftForm` from `../hooks/useDraftForm.js` (Task 1).

**Context:** unlike the 5 forms in Tasks 2-6, none of this file's three forms are separately-mounted components that reset on each open — except `PaymentModal`, which *is* separately mounted (rendered as `{showPayModal && <PaymentModal .../>}`) and has no edit mode at all, so it uses the `useDraftForm` hook exactly like Tasks 2-6. `SubcontractorTab` and `ContractsTab`, however, keep their form state in the always-mounted tab component itself — their modal is just conditional JSX inside it, and `handleOpen(item)` resets `form` to an `EMPTY`-style constant every time "+ เพิ่ม..." is clicked, which would immediately overwrite any hook-restored draft. These two use the raw `readDraft`/`saveDraft`/`clearDraft` functions instead, wired in manually at the four points that matter: initial state, the persisting effect, `handleOpen`, and save/cancel.

- [ ] **Step 1: Add the import**

In `src/pages/LaborContractors.jsx`, add after the existing `import { useUserRole } from '../hooks/useUserRole.js'` line:

```js
import { readDraft, saveDraft, clearDraft, useDraftForm } from '../hooks/useDraftForm.js'
```

Also add `useEffect` to the existing React import — change:

```js
import { useState, useMemo } from 'react'
```

to:

```js
import { useState, useMemo, useEffect } from 'react'
```

- [ ] **Step 2: `SubcontractorTab` — seed initial state from any existing draft**

Change:

```js
  const EMPTY = { name:'', contact_person:'', phone:'', email:'', notes:'' }
  const [form, setForm] = useState(EMPTY)
  const set = (k,v) => setForm(f => ({...f, [k]:v}))
```

to:

```js
  const EMPTY = { name:'', contact_person:'', phone:'', email:'', notes:'' }
  const [form, setForm] = useState(() => readDraft('labor-contractors-subcontractor-form') || EMPTY)
  const set = (k,v) => setForm(f => ({...f, [k]:v}))

  useEffect(() => {
    if (!editItem) saveDraft('labor-contractors-subcontractor-form', form)
  }, [form, editItem])
```

- [ ] **Step 3: `SubcontractorTab` — restore draft (not `EMPTY`) when opening the add form, clear on save/cancel**

Change:

```js
  const handleOpen = (item) => {
    setEditItem(item||null)
    setForm(item ? { name:item.name, contact_person:item.contact_person||'', phone:item.phone||'', email:item.email||'', notes:item.notes||'' } : EMPTY)
    setShowForm(true)
  }

  const handleSave = async (e) => {
    e.preventDefault(); setSaving(true)
    try {
```

to:

```js
  const handleOpen = (item) => {
    setEditItem(item||null)
    setForm(item ? { name:item.name, contact_person:item.contact_person||'', phone:item.phone||'', email:item.email||'', notes:item.notes||'' } : (readDraft('labor-contractors-subcontractor-form') || EMPTY))
    setShowForm(true)
  }

  const handleSave = async (e) => {
    e.preventDefault()
    if (!editItem) clearDraft('labor-contractors-subcontractor-form')
    setSaving(true)
    try {
```

This button's line is textually identical to `ContractsTab`'s Cancel button (handled in Step 4) — target it using the surrounding block, which is unique to `SubcontractorTab`. Change:

```js
              <div><label className="label">หมายเหตุ</label>
                <textarea className="textarea" rows={2} value={form.notes} onChange={e => set('notes', e.target.value)} /></div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-ghost" onClick={() => setShowForm(false)}>ยกเลิก</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving?'⏳...':'✅ บันทึก'}</button>
```

to:

```js
              <div><label className="label">หมายเหตุ</label>
                <textarea className="textarea" rows={2} value={form.notes} onChange={e => set('notes', e.target.value)} /></div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-ghost" onClick={() => { if (!editItem) clearDraft('labor-contractors-subcontractor-form'); setShowForm(false) }}>ยกเลิก</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving?'⏳...':'✅ บันทึก'}</button>
```

- [ ] **Step 4: `ContractsTab` — same pattern with its own draft key**

Change:

```js
  const EMPTY_C = { subcontractor_id:'', site_id:'', work_description:'', contract_amount:'', retention_pct:'5', withholding_tax_pct:'3', site_note:'', start_date:'' }
  const [form, setForm] = useState(EMPTY_C)
  const set = (k,v) => setForm(f => ({...f,[k]:v}))

  const handleOpen = (item) => {
    setEditItem(item||null)
    setForm(item ? { subcontractor_id:item.subcontractor_id, site_id:item.site_id, work_description:item.work_description||'', contract_amount:item.contract_amount||'', retention_pct:item.retention_pct||5, withholding_tax_pct:item.withholding_tax_pct||3, site_note:item.site_note||'', start_date:item.start_date||'' } : EMPTY_C)
    setShowForm(true)
  }

  const handleSave = async (e) => {
    e.preventDefault(); setSaving(true)
    try {
```

to:

```js
  const EMPTY_C = { subcontractor_id:'', site_id:'', work_description:'', contract_amount:'', retention_pct:'5', withholding_tax_pct:'3', site_note:'', start_date:'' }
  const [form, setForm] = useState(() => readDraft('labor-contractors-contract-form') || EMPTY_C)
  const set = (k,v) => setForm(f => ({...f,[k]:v}))

  useEffect(() => {
    if (!editItem) saveDraft('labor-contractors-contract-form', form)
  }, [form, editItem])

  const handleOpen = (item) => {
    setEditItem(item||null)
    setForm(item ? { subcontractor_id:item.subcontractor_id, site_id:item.site_id, work_description:item.work_description||'', contract_amount:item.contract_amount||'', retention_pct:item.retention_pct||5, withholding_tax_pct:item.withholding_tax_pct||3, site_note:item.site_note||'', start_date:item.start_date||'' } : (readDraft('labor-contractors-contract-form') || EMPTY_C))
    setShowForm(true)
  }

  const handleSave = async (e) => {
    e.preventDefault()
    if (!editItem) clearDraft('labor-contractors-contract-form')
    setSaving(true)
    try {
```

Now find `ContractsTab`'s Cancel button. Its Cancel-button line is textually identical to `SubcontractorTab`'s (already changed in Step 3), so target it using the surrounding block, which is unique to `ContractsTab`. Change:

```js
              <div><label className="label">หมายเหตุเฉพาะงานนี้</label>
                <textarea className="textarea" rows={2} value={form.site_note} onChange={e => set('site_note',e.target.value)} /></div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-ghost" onClick={() => setShowForm(false)}>ยกเลิก</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving?'⏳...':'✅ บันทึก'}</button>
            </div>
```

to:

```js
              <div><label className="label">หมายเหตุเฉพาะงานนี้</label>
                <textarea className="textarea" rows={2} value={form.site_note} onChange={e => set('site_note',e.target.value)} /></div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-ghost" onClick={() => { if (!editItem) clearDraft('labor-contractors-contract-form'); setShowForm(false) }}>ยกเลิก</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving?'⏳...':'✅ บันทึก'}</button>
            </div>
```

- [ ] **Step 5: `PaymentModal` — this one fits the hook pattern (always add-mode, freshly mounted per open)**

Change:

```js
  const [form, setForm] = useState({
    payment_date: new Date().toISOString().slice(0,10),
    work_description: isRetentionRelease ? 'คืนประกันผลงาน' : '',
    progress_pct: '',
    gross_amount: isRetentionRelease ? netRetention.toFixed(2) : '',
    notes: '',
  })
  const set = (k,v) => setForm(f => ({...f,[k]:v}))
```

to:

```js
  const [form, setForm, clearDraft] = useDraftForm('labor-contractors-payment-form', {
    payment_date: new Date().toISOString().slice(0,10),
    work_description: isRetentionRelease ? 'คืนประกันผลงาน' : '',
    progress_pct: '',
    gross_amount: isRetentionRelease ? netRetention.toFixed(2) : '',
    notes: '',
  })
  const set = (k,v) => setForm(f => ({...f,[k]:v}))
```

- [ ] **Step 6: `PaymentModal` — clear draft on save (after validation passes) and on cancel**

Change:

```js
  const handleSave = async () => {
    if (!form.gross_amount || gross <= 0) return alert('กรุณากรอกยอดเบิก')
    setSaving(true)
    try {
```

to:

```js
  const handleSave = async () => {
    if (!form.gross_amount || gross <= 0) return alert('กรุณากรอกยอดเบิก')
    clearDraft()
    setSaving(true)
    try {
```

Change:

```js
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ยกเลิก</button>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving?'⏳...':'✅ บันทึกและดู PDF'}
        </button>
      </div>
```

to:

```js
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={() => { clearDraft(); onClose() }}>ยกเลิก</button>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving?'⏳...':'✅ บันทึกและดู PDF'}
        </button>
      </div>
```

(This is the "ยกเลิก" button in `PaymentModal`'s main form footer — not the "ปิด"/Download PDF footer shown after a successful save, which is a different `modal-footer` block earlier in the same function and must be left unchanged.)

- [ ] **Step 7: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 8: Verify no leftover unguarded draft writes**

```bash
grep -n "saveDraft\|readDraft\|clearDraft" src/pages/LaborContractors.jsx
```
Expected: 12 occurrences total — 4 `readDraft` (initial state + `handleOpen`, for each of `SubcontractorTab`/`ContractsTab`), 2 `saveDraft` (one persisting `useEffect` per tab), 6 `clearDraft` (`handleSave` + Cancel button for `SubcontractorTab` and `ContractsTab`, plus `handleSave` + Cancel button for `PaymentModal`) — exact count isn't the point, just confirm every one you expect is present and none are missing.

- [ ] **Step 9: Commit**

```bash
git add src/pages/LaborContractors.jsx
git commit -m "Persist LaborContractors add-form drafts (subcontractor, contract, payment)"
```

---

### Task 8: End-to-end manual verification

**Files:** none

- [ ] **Step 1: Verify persistence survives a real reload**

Start `npm run dev`. Open the Sites page → "+ เพิ่มไซท์งาน" → type a name and some other fields → **without saving**, hard-refresh the browser tab (Cmd+Shift+R / Ctrl+Shift+R, simulating the kind of full reload a tab-discard-and-restore would cause). Reopen "+ เพิ่มไซท์งาน" — confirm the previously-typed values are still there.

- [ ] **Step 2: Verify Cancel clears the draft**

With a draft restored from Step 1 still showing, click "ยกเลิก". Reopen "+ เพิ่มไซท์งาน" — confirm the form is now blank (draft was cleared, not just visually reset).

- [ ] **Step 3: Verify a successful save clears the draft**

Open "+ เพิ่มไซท์งาน", type a valid name, click "✅ บันทึก" and confirm it saves successfully (new site appears in the table). Reopen "+ เพิ่มไซท์งาน" — confirm the form is blank (no leftover draft from the just-saved data).

- [ ] **Step 4: Verify editing an existing record never shows or creates a draft**

Click "✏️" to edit an existing site. Change a field but don't save; close via "ยกเลิก". Open "+ เพิ่มไซท์งาน" (add, not edit) — confirm it's blank, i.e. the edit-mode typing never leaked into the add-mode draft.

- [ ] **Step 5: Spot-check one other simple form and the LaborContractors manual-integration forms**

Repeat Step 1's reload check on: Clients ("+ เพิ่มลูกค้า"), and LaborContractors → ผู้รับเหมา tab ("+ เพิ่มผู้รับเหมา") and สัญญา tab ("+ เพิ่มสัญญา") — these last two use the manual `readDraft`/`saveDraft` wiring from Task 7, distinct code path from the hook-based forms, worth confirming independently.

- [ ] **Step 6: Confirm `UserManagement.jsx` was correctly left untouched**

```bash
grep -n "useDraftForm\|readDraft\|saveDraft\|clearDraft" src/pages/UserManagement.jsx
```
Expected: no output (empty) — confirms the password-security exclusion holds.

- [ ] **Step 7: Final build check**

Run: `npm run build`
Expected: built, no errors.
