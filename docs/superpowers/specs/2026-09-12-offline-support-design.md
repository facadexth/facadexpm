# Offline Support for Quotations, Invoices, Assign — Design Spec

## Overview

FacadeX is a Supabase-data-driven SPA: the installable-PWA work
(`2026-08-20-pwa-installable-app-design.md`) precaches the app *shell*
(JS/CSS/icons) so it opens instantly offline, but explicitly declared
**no offline data access** as a non-goal — every read and write is a
live network call with zero local persistence or failure handling. This
spec **reverses that non-goal** for three specific flows: this session's
brainstorm confirmed the actual need is narrower than "the whole app
offline" — a sales/ops person composing a **ใบเสนอราคา (quotation)** or
**ใบแจ้งหนี้ (invoice)**, or an admin doing **จ่ายงานช่าง (worker
assignment)**, with no signal at all for an extended period (the
motivating example: mid-flight).

The core idea: cache the small, stable **reference data** these forms
need just to render (clients, catalog items, sites, units, bank
accounts, workers) on every successful online load, and when a Save
attempt hits a real network failure, write the payload to a local
**pending-sync queue** instead of losing it — synced automatically on
reconnect (or manually) by replaying it through the *same* save
functions the live app already uses, so numbering/totals/tax logic
never has two implementations to drift apart.

## Goals

- Composing a **new** quotation, invoice, or worker assignment works
  with zero network connectivity, provided the app was opened online at
  least once recently (so reference data is cached).
- Editing an **already-loaded** quotation/invoice (the record's data is
  already in memory because its list/edit page was opened this session)
  also survives a Save attempt failing due to no signal.
- Saving offline never silently fails and never silently loses data —
  it either succeeds live, or it's visibly queued with a clear "ยังไม่ได้
  ซิงค์" state, or it visibly errors (a *real* server-side rejection, not
  a network failure, is never mistaken for "will sync later").
- Sync is automatic on reconnect, with a manual "ซิงค์ตอนนี้" fallback for
  anyone who doesn't trust automatic behavior or reconnects briefly then
  loses signal again before the automatic flush finishes.
- Quotation/invoice numbering (assigned by DB triggers at insert time)
  stays exactly as it is today — a queued document shows a placeholder
  label until it actually syncs, at which point it gets a real number
  the normal way. No client-side number generation, no renumbering.

## Non-Goals

- **Not a local-first rearchitecture.** No mirrored local database, no
  bidirectional sync engine, no IndexedDB. Reference data is a simple
  localStorage cache refreshed opportunistically; the pending queue is a
  plain localStorage array. If either grows enough to matter (large
  tenants with thousands of catalog items, say), revisit storage
  engine — not a v1 concern.
- **Not every page.** Inventory, HR/payroll, purchase orders, reports,
  tenant admin — all still require live connectivity, unchanged. This
  spec only touches the three flows named above.
- **No offline conflict prevention for Assign.** The existing
  double-booking check in the assignment wizard queries live data
  (other workers' assignments) before confirming a save. That can't run
  meaningfully offline. Offline-queued assignments skip the pre-check
  and surface any conflict **only when they sync** — the user finds out
  later, not up front, and resolves it manually. This is an accepted
  trade-off, not an oversight.
- **No offline file/photo uploads.** None of the three flows' core Save
  paths (the actual create/edit of a quotation, invoice, or assignment)
  upload to Supabase Storage. Invoices.jsx does have a separate
  "รูปประกอบการส่งงาน" feature (`WorkPhotosModal`, `invoice-photos`
  bucket) — confirmed by reading it — but it's a distinct action against
  an *already-saved* invoice, not part of creating/editing one, so it's
  cleanly out of this spec's scope rather than a gap in it. If a future
  feature adds an upload to one of these three core Save paths, it needs
  its own design — a queued Storage upload is a meaningfully different
  problem (larger payloads, no localStorage-sized answer).
- **No blending of queued items into the main list/grid UIs.** A
  pending quotation doesn't appear in the Quotations table, a pending
  assignment doesn't appear on the Assign grid — both would need every
  list/grid to understand a "fake," number-less, possibly-conflicting
  row (sorting, totals, filters, click-through all assume a real synced
  record). v1 keeps pending items in their own dedicated panel instead.
  Revisit only if that separation proves confusing in practice.
- **No real-time multi-device conflict resolution.** If the record a
  queued edit targets was changed or deleted elsewhere before this
  device reconnects, the sync attempt fails with a clear error and
  stays in the queue for manual resolution — no automatic merge.
- **Estimation is not touched** (it doesn't exist as a built feature
  yet) — the queue is generic (keyed by a `type` string) specifically so
  adding a fourth type later doesn't require redesigning the mechanism,
  but no Estimation-specific work happens now.

## Design

### 0. Gated behind a package module

Offline support is a new tenant-package module, `offline_mode` — the
same mechanism already gating `purchase_orders`, `cheque_tracking`,
`estimation`, etc. (`hasModuleAccess()` from `useTenant()`, toggled per
tenant via the existing platform-admin package management, no new
mechanism needed). Which package tier(s) actually include it is a
product/pricing decision for later, made the same way every other
module's tier assignment already is — not baked into this build.

For a tenant **without** `offline_mode`: `useCachedQuery` (§1) behaves
exactly like plain `useQuery` (no cache write, no stale fallback), a
Save failure surfaces the plain error exactly as it does today (no
enqueue), and `OfflineIndicator` (§5) doesn't render. So the feature is
fully inert, not just hidden, for tenants that don't have it — nothing
about their experience changes.

### 1. Reference-data cache

A new `useCachedQuery(cacheKey, queryFn, deps)` in `src/hooks/useSupabase.js`,
alongside (not replacing) the existing generic `useQuery`. Behavior:
- On a successful fetch, writes `{ data, cachedAt }` to
  `localStorage['offcache:' + cacheKey]` in addition to returning it
  normally — every online load opportunistically refreshes the cache.
- On a fetch that throws (network failure — see §3 for how that's
  distinguished from a real server error), falls back to reading the
  cached value instead of surfacing an error, and marks the returned
  data as `stale: true` (cachedAt exposed) so a caller *can* show "ข้อมูล
  ล่าสุดเมื่อ ..." if it wants to, without being forced to.
- `try/catch` around every localStorage access (same pattern as
  `useDraftForm` — private-mode/quota failures degrade to
  "no cache, must be online" rather than crashing).

Switched to `useCachedQuery` (the exhaustive list — deliberately not
"every hook," see Non-Goals): `useClients`, `useCatalogItems`,
`useSites`, `useUnits`, `useBankAccounts`, `useWorkers`. These are the
picker/lookup datasets the three forms need just to *render* a blank
form; they're small and change rarely, which is why they're a good fit
for a blunt whole-dataset cache rather than anything smarter.

Editing an **existing** quotation/invoice/assignment doesn't need new
caching work beyond this — if the list/edit page was opened this
session while online, the record's own data is already sitting in
React state in memory, same as it is today. The gap this spec closes
for edits is purely "the Save call fails," handled by §2. (A full
offline app restart with an empty in-memory state can't edit a record
it never loaded — documented limitation, not solved here.)

### 2. Pending-sync queue

New `src/lib/offlineQueue.js`:

```js
// getQueue() -> QueueItem[]
// enqueue(type, payload) -> QueueItem   // id: crypto.randomUUID(), status: 'pending'
// updateStatus(id, status, error?)
// removeFromQueue(id)
// subscribe(callback)  // so the badge/panel re-renders on change without polling
```

`QueueItem = { id, type: 'quotation'|'invoice'|'assign', payload, createdAt, status: 'pending'|'syncing'|'error', error?: string }`

Stored as a single JSON array at `localStorage['offline-queue']` — small
enough (a handful of pending documents at most, realistically) that a
single key with full read/rewrite on every mutation is simpler than
per-item keys, matching how `useDraftForm` already uses localStorage
elsewhere in this codebase, rather than introducing IndexedDB for what's
still a small amount of data.

### 3. Save-path change (the three forms)

Each of the three save paths gets the same shape of change: try the
real Supabase call first; only on a genuine network failure, enqueue
instead of erroring.

**Distinguishing "no network" from "the server rejected this"
matters** — queuing a real validation/RLS error would tell the user
it'll "sync later" when it never will, silently hiding a real problem.
Rule: Supabase-js's underlying `fetch` rejects the promise outright
(no HTTP response at all) on a true connectivity failure — that surfaces
as a thrown exception *before* reaching any `{ data, error }` result,
distinguishable from a normal Supabase response where `error` is a
structured PostgREST/RLS error object. Only the former (an exception
with no response — a `TypeError`-shaped network failure) gets
queued; a returned `error` object from a completed request is shown to
the user exactly as it is today, not queued.

**Reusing the exact save logic.** `Quotations.jsx`'s `handleSave` and
each of Invoices.jsx's two `handleSave` functions (confirmed there are
two — the file has more than one save flow; which invoice-related
actions each covers needs confirming at implementation time, not
assumed here) currently live as closures inside their page components,
reading component state (`editRow`, etc.) directly. For the sync engine
to replay a queued item without that component being mounted, the core
"given a form payload (+ existing-record id if editing), perform the
Supabase writes" logic needs extracting into a plain exported async
function per flow (e.g. `src/lib/quotationSave.js`,
`src/lib/invoiceSave.js`) that both the live form's `handleSave` and the
sync engine call identically. **Assign's save path is the riskiest of
the three to extract** — `AssignWizard.jsx`/`AssignOTWizard.jsx`'s save
logic is entangled with the conflict-check flow (`pendingRows`,
`conflictMsg` in `Assign.jsx`) more than a simple form; per the
Non-Goals section, the offline path skips that pre-check entirely, so
the extracted function should be the *post-confirmation* write step
only, not the whole wizard. Confirm the exact extraction boundary
during implementation rather than the spec asserting one.

On enqueue: the live form shows a "บันทึกแบบออฟไลน์แล้ว — จะซิงค์อัตโนมัติ
เมื่อกลับมาออนไลน์" confirmation (not an error styling) and closes/resets
the same way a successful live save would, since from the user's
perspective the action is done.

### 4. Numbering placeholder

A queued quotation/invoice has no `quotation_number`/`invoice_number` —
those come from `trg_quotation_number`-style DB triggers that only fire
on the real insert. Nothing client-side generates or reserves a number.
The pending-queue panel (§5) shows each item with a placeholder like
`ร่างออฟไลน์ · <client name> · <total>` instead of a document number.
Once synced, the item is simply removed from the queue and the record
appears wherever it normally would (Quotations/Invoices list, via their
existing `refetch()`) with its real trigger-assigned number — no special
"just synced" UI state to build.

### 5. Sync engine + UI

`src/lib/offlineSync.js`: `flushQueue()` — iterates pending items
**sequentially** (await each before the next; simpler reasoning than
parallel, avoids hammering the API right at the moment connectivity
returns), calling the matching extracted save function (§3) for each
`type`. Success: `removeFromQueue` + a toast naming what synced ("ซิงค์
ใบเสนอราคา บริษัท... สำเร็จ — เลขที่ QT-2026-XXX"). Failure:
`updateStatus(id, 'error', message)`, stays in the queue, **not**
retried again within the same flush — avoids a hot-loop of repeated
failures against a permanently-broken item (e.g. its client was
deleted); the next distinct trigger (a fresh `online` event, or a
manual click) gets another attempt.

Triggers: `window.addEventListener('online', flushQueue)`; once on
`App.jsx` mount if the queue is non-empty and `navigator.onLine` is
already true (covers "reconnected while the tab was closed, then
reopened online" — no `online` event fires for that case); a manual
"ซิงค์ตอนนี้" button.

New `src/components/OfflineIndicator.jsx`, mounted in the header near
the existing theme toggle:
- A connectivity badge ("🔴 ออฟไลน์") driven by `online`/`offline` window
  events — always visible when offline, so a failed action is never a
  silent surprise.
- A separate "🔄 N รอซิงค์" badge/button whenever the queue is
  non-empty (regardless of current connectivity — a synced-but-errored
  item still needs surfacing while online). Opens a small panel listing
  each pending item (type icon, the placeholder label from §4, status,
  a per-item "ลองใหม่" and "ลบ" action).

## Data / Storage

No database changes. Everything is `localStorage`, two new key
families:
- `localStorage['offcache:' + cacheKey]` — one per cached reference
  dataset (six keys total, per §1).
- `localStorage['offline-queue']` — the single pending-items array.

Both wrapped in `try/catch` (private browsing, quota) exactly like
`useDraftForm` already does — degrade to "not cached"/"nothing queued"
rather than crash.

## Testing

- Pure logic (`offlineQueue.js` enqueue/update/remove, and the
  network-failure-vs-server-error distinction in each save path) gets
  real unit tests, same as this codebase's existing `*.test.js` files
  (e.g. `quotationCalc.test.js`) — this is exactly the kind of pure,
  synchronous-once-mocked logic that pattern already covers.
- The three save-path extractions get tested by calling the extracted
  function directly with a mocked Supabase client, both for the normal
  online-success case (regression coverage for logic that's moving, not
  changing) and the network-failure-enqueues case.
- End-to-end offline behavior (actually disable network in a browser,
  confirm a queued item appears, reconnect, confirm it syncs and gets a
  real number) is a manual verification step during implementation —
  no browser automation in this codebase's test suite simulates
  connectivity loss today, and building that harness isn't worth it for
  three flows.

## Open Questions (confirm during implementation, not blocking this spec)

- Exact boundary for the Assign save extraction (§3) — depends on
  reading `AssignWizard.jsx`/`AssignOTWizard.jsx`/`CellEditPopup.jsx`
  closely, not yet done as part of this spec.
- Which of Invoices.jsx's two `handleSave` functions need offline
  support — likely both (e.g. a "simple mode" and "detailed mode" for
  the same action, per the module's own design spec's "โหมดง่าย/โหมดละเอียด"
  split), but confirm against `2026-08-24-invoice-module-design.md`
  during implementation.
