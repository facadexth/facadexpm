# Kanban Photo Upload & Assignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the web app upload photos to `line_site_photos` (today LINE-bot-only) and assign unassigned photos to Kanban cards, via two surfaces: an admin drag-and-drop triage tray, and a lightweight per-task upload for field-crew WORKERs.

**Architecture:** No schema changes — `line_site_photos` and the `line-site-photos` Storage bucket already have every column needed. Add RLS policies mirroring the existing `phase_tasks`/`phase_task_workers` admin-vs-worker split (`my_assigned_phase_task_ids()`), a shared client-side downscale-then-upload helper, and two independent UI additions.

**Tech Stack:** React, Supabase (Postgres RLS + Storage), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-kanban-photo-upload-design.md`

## Global Constraints

- Photo path convention (must match exactly, both surfaces): `<tenant_id>/<site_id>/<timestamp>-<worker_id>.jpg` — same as `supabase/functions/line-webhook/index.ts` already uses, so LINE- and web-originated photos stay indistinguishable.
- Downscale every uploaded image client-side before upload: JPEG, longest edge ≤1600px, quality 0.8, never upscale.
- Every upload failure in a multi-file batch must not abort the rest of the batch — each file's upload+insert is independent.
- A failed DB insert after a successful storage upload must remove the just-uploaded storage object (no orphaned files).
- No `alert()` on a successful upload in Surface 2 (MySchedule.jsx) — brief inline text instead, since a multi-file batch succeeding would otherwise stack several blocking alerts.

---

### Task 1: RLS policies for web-based photo upload/assignment

**Files:**
- Create: `supabase/migrations/2026-09-30-01-line-site-photos-upload-rls.sql`

**Interfaces:**
- Produces: `my_worker_id()` — SQL function, `RETURNS UUID`, resolves the caller's own linked `workers.id` via `auth.email()` (or `NULL` if none), `SECURITY DEFINER STABLE`, granted to `authenticated`. Both later tasks' client code call this via `supabase.rpc('my_worker_id')`.
- Produces: 4 new policies on `line_site_photos` (`admin_inserts`, `worker_inserts_own`, `admin_updates`, `worker_updates_own`) and 1 new policy on `storage.objects` (`line_site_photos_uploads`), added alongside the existing `admin_reads`/`line_site_photos_tenant_access` SELECT-only policies (never dropped or replaced).

Current state confirmed live via direct query this session — `line_site_photos` has exactly one policy:
```
admin_reads: FOR SELECT TO authenticated USING (is_admin_or_owner() AND tenant_id = current_tenant_id())
```
`storage.objects` has exactly one policy scoped to this bucket:
```
line_site_photos_tenant_access: FOR SELECT TO authenticated
  USING (bucket_id = 'line-site-photos' AND (storage.foldername(name))[1] = current_tenant_id()::text AND is_admin_or_owner())
```
Neither table nor bucket has any INSERT/UPDATE policy today — every existing row was written by the LINE webhook's service-role client, which bypasses RLS.

**Design note (storage vs. table split):** the object path only has `tenant_id` and `site_id` as real folder segments — `worker_id` is baked into the *filename*, which `storage.foldername()` cannot see. So the storage policy only gates by tenant + "is this caller allowed to upload at all" (admin, or has a linked worker row); the real per-worker/per-task ownership check lives on the table's policies, which can reference `worker_id`/`task_id` as real columns.

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/2026-09-30-01-line-site-photos-upload-rls.sql
-- Kanban Photo Upload & Assignment (docs/superpowers/specs/2026-09-29-kanban-photo-upload-design.md)
--
-- line_site_photos and the line-site-photos storage bucket currently have
-- exactly one RLS policy each (SELECT, ADMIN/OWNER only) -- every row
-- today is written by the LINE webhook's service-role client, which
-- bypasses RLS entirely. This adds INSERT/UPDATE so the web app can
-- write too, mirroring the existing admin-vs-worker split phase_tasks/
-- phase_task_workers already use (my_assigned_phase_task_ids(), see
-- 2026-09-17-05-fix-phase-tasks-rls-recursion.sql) rather than a new
-- model. Does not touch the existing SELECT policies at all.
--
-- Storage vs table split (deliberate): the object path
-- (<tenant_id>/<site_id>/<timestamp>-<worker_id>.jpg) only has tenant_id
-- and site_id as real FOLDER segments -- storage.foldername() can't see
-- worker_id, it's baked into the filename. So the storage policy below
-- only gates by tenant + "is this caller allowed to upload at all"; the
-- REAL per-worker ownership and per-task-assignment checks live on the
-- table's own INSERT/UPDATE policies, which can reference those as real
-- columns.

CREATE OR REPLACE FUNCTION my_worker_id()
RETURNS UUID
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT id FROM workers WHERE email = (select auth.email()) AND tenant_id = current_tenant_id() LIMIT 1;
$$;
REVOKE EXECUTE ON FUNCTION my_worker_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_worker_id() TO authenticated;

-- ── line_site_photos: INSERT ──
CREATE POLICY admin_inserts ON line_site_photos FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

-- task_id, if set, must be one of the worker's own assigned tasks --
-- closes the loophole of attaching to an unauthorized task at INSERT
-- time instead of via the (separately restricted) UPDATE path below.
CREATE POLICY worker_inserts_own ON line_site_photos FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = current_tenant_id() AND tenant_can_write()
    AND worker_id = my_worker_id()
    AND (task_id IS NULL OR task_id IN (SELECT my_assigned_phase_task_ids()))
  );

-- ── line_site_photos: UPDATE (setting/changing task_id after upload) ──
CREATE POLICY admin_updates ON line_site_photos FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

CREATE POLICY worker_updates_own ON line_site_photos FOR UPDATE TO authenticated
  USING (tenant_id = current_tenant_id() AND worker_id = my_worker_id())
  WITH CHECK (
    tenant_id = current_tenant_id() AND tenant_can_write()
    AND worker_id = my_worker_id()
    AND (task_id IS NULL OR task_id IN (SELECT my_assigned_phase_task_ids()))
  );

-- ── storage.objects (line-site-photos bucket): INSERT ──
CREATE POLICY line_site_photos_uploads ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'line-site-photos'
    AND (storage.foldername(name))[1] = current_tenant_id()::text
    AND (is_admin_or_owner() OR my_worker_id() IS NOT NULL)
  );
```

- [ ] **Step 2: Apply the migration**

Use the `apply_migration` tool (name: `2026-09-30-01-line-site-photos-upload-rls`, the file content above as `query`) against the FacadeX project (`yyzbgdmgyvvypfcjuhtr`).

- [ ] **Step 3: Verify the policies landed correctly**

Run via `execute_sql`:
```sql
select tablename, policyname, cmd from pg_policies
where tablename = 'line_site_photos' or (tablename = 'objects' and policyname = 'line_site_photos_uploads')
order by tablename, policyname;
```
Expected: 6 rows — `line_site_photos`'s `admin_inserts`, `admin_reads` (pre-existing), `admin_updates`, `worker_inserts_own`, `worker_updates_own`, plus `objects`'s `line_site_photos_uploads`.

```sql
select proname from pg_proc where proname = 'my_worker_id';
```
Expected: 1 row.

- [ ] **Step 4: Manual RLS smoke test via simulated sessions**

Pick one real WORKER-role account's email from `workers`/`user_roles` in this tenant (or use the throwaway-account pattern from earlier in this session: insert a test `auth.users` row + `workers` row, matching email, clean up afterward). Using `execute_sql` with `SET LOCAL request.jwt.claim.email = '<that email>'` inside one transaction (same technique used earlier this session to test `auth.email()`-based RPCs without a real browser session), confirm:
- `SELECT my_worker_id()` returns that worker's real id.
- An `INSERT INTO line_site_photos (...)` with `worker_id` set to a DIFFERENT worker's id fails (RLS rejects it).
- An `INSERT` with `worker_id` = their own id and `task_id` = a task NOT in their `phase_task_workers` rows fails.
- An `INSERT` with `worker_id` = their own id and `task_id` = a task that IS in their `phase_task_workers` rows succeeds; clean up the test row afterward.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-09-30-01-line-site-photos-upload-rls.sql
git commit -m "feat: RLS policies for web-based Kanban photo upload/assignment"
```

---

### Task 2: Shared client-side photo upload helper

**Files:**
- Create: `src/lib/photoUpload.js`
- Test: `src/lib/photoUpload.test.js`

**Interfaces:**
- Consumes: `supabase` client from `../lib/supabase.js` (same import every other file in this codebase uses).
- Produces: `computePhotoDownscaledSize(width, height, maxDim = 1600)` — pure function, `{ width, height }`. `uploadSitePhoto({ file, tenantId, workerId, siteId, taskId = null, date })` — async, returns the inserted `line_site_photos` row. `uploadSitePhotos(files, opts)` — async, `files` a `FileList` or array, `opts` the same shape as `uploadSitePhoto` minus `file`; returns `{ succeeded: [row, ...], failed: [{ file, error }, ...] }`. Both Task 3 and Task 4 import `uploadSitePhotos` (and Task 4 may use `uploadSitePhoto` directly for its single-task, still-multi-file case — either works since a `taskId` fixed across a whole batch is exactly what `uploadSitePhotos(files, { ...opts, taskId })` already does).

- [ ] **Step 1: Write the failing test for the pure sizing function**

```js
// src/lib/photoUpload.test.js
import { describe, it, expect } from 'vitest'
import { computePhotoDownscaledSize } from './photoUpload.js'

describe('computePhotoDownscaledSize', () => {
  it('leaves an image already under maxDim unchanged', () => {
    expect(computePhotoDownscaledSize(800, 600, 1600)).toEqual({ width: 800, height: 600 })
  })
  it('scales down a landscape image so the longest side hits maxDim', () => {
    expect(computePhotoDownscaledSize(3200, 1600, 1600)).toEqual({ width: 1600, height: 800 })
  })
  it('scales down a portrait image so the longest side hits maxDim', () => {
    expect(computePhotoDownscaledSize(1200, 4000, 1600)).toEqual({ width: 480, height: 1600 })
  })
  it('never upscales a small image', () => {
    expect(computePhotoDownscaledSize(400, 300, 1600)).toEqual({ width: 400, height: 300 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/photoUpload.test.js`
Expected: FAIL — `photoUpload.js` doesn't exist yet.

- [ ] **Step 3: Write the module**

```js
// src/lib/photoUpload.js
// ============================================================
// photoUpload -- shared client-side helper for uploading photos to the
// line-site-photos bucket + inserting their line_site_photos row, used
// by both the admin triage tray (PhaseKanbanBoard.jsx) and the WORKER
// per-task upload (MySchedule.jsx). Downscales every image before
// upload (a raw phone photo can be 5-10MB, a bulk selection a dozen at
// once) and follows the LINE webhook's own path convention exactly
// (<tenant_id>/<site_id>/<timestamp>-<worker_id>.jpg) so LINE- and
// web-originated photos stay indistinguishable to the rest of the app.
// See docs/superpowers/specs/2026-09-29-kanban-photo-upload-design.md.
// ============================================================
import { supabase } from './supabase.js'

/** Target size for an image before upload -- never upscales, only
 *  shrinks the longest side down to maxDim. Same math as
 *  poDocumentExtraction.js's computeDownscaledSize (kept as its own
 *  copy here since that module is PO-scan-specific and this one has no
 *  reason to depend on it). */
export function computePhotoDownscaledSize(width, height, maxDim = 1600) {
  if (width <= maxDim && height <= maxDim) return { width, height }
  const scale = width >= height ? maxDim / width : maxDim / height
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

async function downscaleToJpegBlob(file, maxDim = 1600, quality = 0.8) {
  const bitmap = await createImageBitmap(file, { resizeWidth: maxDim, resizeQuality: 'medium', imageOrientation: 'from-image' })
  try {
    const { width, height } = computePhotoDownscaledSize(bitmap.width, bitmap.height, maxDim)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height)
    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('แปลงรูปไม่สำเร็จ'))), 'image/jpeg', quality)
    })
  } finally {
    bitmap.close()
  }
}

/**
 * Uploads one File to line-site-photos + inserts its line_site_photos
 * row. Removes the just-uploaded storage object if the DB insert fails,
 * so a partial failure never leaves an orphaned file with no DB row
 * (same shape as AttachmentsSection.jsx's own upload-then-insert
 * pattern). taskId may be null (an unassigned tray upload) or a fixed
 * value (a worker uploading straight to one task).
 */
export async function uploadSitePhoto({ file, tenantId, workerId, siteId, taskId = null, date }) {
  const blob = await downscaleToJpegBlob(file)
  const photoPath = `${tenantId}/${siteId}/${Date.now()}-${workerId}.jpg`
  const { error: uploadError } = await supabase.storage.from('line-site-photos').upload(photoPath, blob, { contentType: 'image/jpeg' })
  if (uploadError) throw uploadError
  const { data, error: insertError } = await supabase.from('line_site_photos')
    .insert({ tenant_id: tenantId, worker_id: workerId, site_id: siteId, date, photo_path: photoPath, task_id: taskId })
    .select().single()
  if (insertError) {
    await supabase.storage.from('line-site-photos').remove([photoPath])
    throw insertError
  }
  return data
}

/**
 * Uploads every file in a FileList/array, continuing past individual
 * failures rather than aborting the whole batch. Returns which files
 * made it and which didn't (with their errors) so the caller can report
 * a single end-of-batch summary instead of one alert per file.
 */
export async function uploadSitePhotos(files, opts) {
  const succeeded = []
  const failed = []
  for (const file of Array.from(files)) {
    try {
      succeeded.push(await uploadSitePhoto({ file, ...opts }))
    } catch (error) {
      failed.push({ file, error })
    }
  }
  return { succeeded, failed }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/photoUpload.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/photoUpload.js src/lib/photoUpload.test.js
git commit -m "feat: add shared client-side photo upload helper"
```

---

### Task 3: Admin/office triage tray (PhaseKanbanBoard.jsx)

**Files:**
- Modify: `src/pages/sites/PhaseKanbanBoard.jsx`

**Interfaces:**
- Consumes: `uploadSitePhotos` from `../../lib/photoUpload.js` (Task 2). `supabase.rpc('my_worker_id')` (Task 1) to resolve the current admin's own linked worker id (uploads still need a non-null `worker_id`; `PhaseKanbanBoard.jsx` today has no concept of "my own worker" at all, unlike `MySchedule.jsx`'s `useAllActiveWorkers()`-based `me`, and `useWorkers()` here is filtered by `show_in_assign=true` so it isn't safe to reuse for this — an office-based ADMIN/OWNER may well have that flag off since they're never assigned to a site. The RPC queries `workers` directly with no such filter). `useTenant()` from `../../hooks/useTenant.js` to resolve `tenant.id` — **verified via schema query that neither `site` (from `useSiteOverview`, backed by the `site_financial_summary` view) nor any other prop this file already has carries a `tenant_id` field** (confirmed empty on `information_schema.columns` for that view); `useTenant()` is the pattern `Sites.jsx`/`PurchaseOrders.jsx` already use for exactly this (e.g. `Sites.jsx:735`'s `tenantId={tenant.id}` passed into `AttachmentsSection`).
- Produces: nothing new consumed elsewhere — this task is self-contained UI.

The file currently fetches `taskPhotoCounts` (task_id → count, for the 📷 badge on cards) in a `useEffect` at mount (lines 66-76 of the current file). This task extracts that into a reusable fetch alongside a new "unassigned photos" fetch, so both can be re-run together after an upload or a drag-assign.

- [ ] **Step 1: Add state and the my_worker_id resolution**

In `PhaseKanbanBoard.jsx`, add to the imports:
```js
import { uploadSitePhotos } from '../../lib/photoUpload.js'
import { useTenant } from '../../hooks/useTenant.js'
```

Inside the component function, add (near the top, alongside the other hook calls):
```js
  const { tenant } = useTenant()
```

Add new state alongside the existing photo-related state (after the existing `taskPhotoCounts`/`viewingPhotos` block):
```js
const [unassignedPhotos, setUnassignedPhotos] = useState([])
const [loadingPhotos, setLoadingPhotos] = useState(true)
const [uploadingBulk, setUploadingBulk] = useState(false)
const [assigningPhotoId, setAssigningPhotoId] = useState(null)
const [myWorkerId, setMyWorkerId] = useState(null)

useEffect(() => {
  let cancelled = false
  supabase.rpc('my_worker_id').then(({ data }) => { if (!cancelled) setMyWorkerId(data || null) })
  return () => { cancelled = true }
}, [])
```

- [ ] **Step 2: Replace the taskPhotoCounts-only fetch with a combined fetch + refresh function**

Replace the existing block:
```js
  const [taskPhotoCounts, setTaskPhotoCounts] = useState({})
  const [viewingPhotosTaskId, setViewingPhotosTaskId] = useState(null)
  const [viewingPhotosTaskName, setViewingPhotosTaskName] = useState('')
  const [viewingPhotos, setViewingPhotos] = useState([])
  const [loadingViewPhotos, setLoadingViewPhotos] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data } = await supabase.from('line_site_photos').select('task_id').eq('site_id', site.id).not('task_id', 'is', null)
      if (cancelled) return
      const counts = {}
      ;(data || []).forEach((r) => { counts[r.task_id] = (counts[r.task_id] || 0) + 1 })
      setTaskPhotoCounts(counts)
    })()
    return () => { cancelled = true }
  }, [site.id])
```
with:
```js
  const [taskPhotoCounts, setTaskPhotoCounts] = useState({})
  const [viewingPhotosTaskId, setViewingPhotosTaskId] = useState(null)
  const [viewingPhotosTaskName, setViewingPhotosTaskName] = useState('')
  const [viewingPhotos, setViewingPhotos] = useState([])
  const [loadingViewPhotos, setLoadingViewPhotos] = useState(false)

  // Per-task photo counts (📷 badge) AND the site's unassigned-photo tray
  // both come from line_site_photos -- fetched together so one refresh
  // (after an upload or a drag-assign) keeps both in sync. fetchPhotos
  // itself does no state writes so the mount effect below can guard
  // against a stale write after site.id changes; refreshPhotos (called
  // after a user action, when the component is definitely still mounted)
  // just applies the result directly.
  const fetchPhotos = async () => {
    const [{ data: assignedRows }, { data: unassignedRows }] = await Promise.all([
      supabase.from('line_site_photos').select('task_id').eq('site_id', site.id).not('task_id', 'is', null),
      supabase.from('line_site_photos').select('id, photo_path, workers(name, nickname), created_at').eq('site_id', site.id).is('task_id', null).order('created_at'),
    ])
    const counts = {}
    ;(assignedRows || []).forEach((r) => { counts[r.task_id] = (counts[r.task_id] || 0) + 1 })
    const rows = unassignedRows || []
    const paths = rows.map((p) => p.photo_path)
    let urlByPath = {}
    if (paths.length) {
      const { data: signed } = await supabase.storage.from('line-site-photos').createSignedUrls(paths, 3600)
      urlByPath = Object.fromEntries((signed || []).filter((s) => !s.error).map((s) => [s.path, s.signedUrl]))
    }
    return { counts, unassigned: rows.map((p) => ({ ...p, url: urlByPath[p.photo_path] })) }
  }

  useEffect(() => {
    let cancelled = false
    setLoadingPhotos(true)
    fetchPhotos().then(({ counts, unassigned }) => {
      if (cancelled) return
      setTaskPhotoCounts(counts)
      setUnassignedPhotos(unassigned)
      setLoadingPhotos(false)
    })
    return () => { cancelled = true }
  }, [site.id])

  const refreshPhotos = async () => {
    const { counts, unassigned } = await fetchPhotos()
    setTaskPhotoCounts(counts)
    setUnassignedPhotos(unassigned)
  }
```

- [ ] **Step 3: Add bulk-upload and drag-assign handlers**

Add after `handleViewPhotos`:
```js
  const handleBulkUpload = async (e) => {
    const files = e.target.files
    if (!files || !files.length) return
    if (!myWorkerId) { alert('ไม่พบข้อมูลพนักงานที่ผูกกับบัญชีนี้ — กรุณาติดต่อผู้ดูแลระบบ'); e.target.value = ''; return }
    if (!tenant?.id) { alert('กำลังโหลดข้อมูลบริษัท กรุณาลองใหม่อีกครั้ง'); e.target.value = ''; return }
    setUploadingBulk(true)
    try {
      const { failed } = await uploadSitePhotos(files, {
        tenantId: tenant.id, workerId: myWorkerId, siteId: site.id, taskId: null,
        date: new Date().toISOString().slice(0, 10),
      })
      if (failed.length) alert(`อัปโหลดไม่สำเร็จ ${failed.length} ไฟล์: ${failed.map((f) => f.file.name).join(', ')}`)
      await refreshPhotos()
    } finally {
      setUploadingBulk(false)
      e.target.value = ''
    }
  }

  // Called from a task card's onDrop when a photo (not another card) was
  // dropped on it -- see the PHOTO_DRAG_MIME check in PhaseBoard below.
  // A failed update never calls refreshPhotos, so the photo simply stays
  // in the tray exactly as it was (never optimistically removed before
  // the request settles) -- satisfies the spec's "don't silently lose
  // the photo on failure" intent via this file's own existing alert()
  // convention (every other write in this file -- saveDraft, doDelete,
  // quickMove -- already surfaces failures the same way) rather than a
  // new per-item inline-error UI this file has no other precedent for.
  const handleAssignPhoto = async (photoId, taskId) => {
    setAssigningPhotoId(photoId)
    try {
      const { error } = await supabase.from('line_site_photos').update({ task_id: taskId }).eq('id', photoId)
      if (error) throw error
      await refreshPhotos()
    } catch (e) {
      alert('มอบหมายรูปไม่สำเร็จ: ' + e.message)
    } finally {
      setAssigningPhotoId(null)
    }
  }
```

- [ ] **Step 4: Render the tray panel**

Add a module-level constant near the top of the file (alongside `ALL_PHASES`/`COLUMNS`):
```js
const PHOTO_DRAG_MIME = 'application/x-line-site-photo-id'
```

Insert the tray panel in the main render, right after the `todayLeaders` banner block and before the phase-chips block (i.e. right after the `)}` that closes the `{(todayLeaders.morning || todayLeaders.evening) && (...)}` block, before the `{Array.from({ length: selectedChain.length + 1 }, ...)}` chips code):
```jsx
      <div className="card" style={{ padding: 14, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: unassignedPhotos.length ? 10 : 0, flexWrap: 'wrap', gap: 8 }}>
          <div className="card-title">📷 รูปที่รอมอบหมาย{unassignedPhotos.length > 0 ? ` (${unassignedPhotos.length})` : ''}</div>
          {canEdit && (
            <label className="btn btn-ghost btn-sm" style={{ cursor: uploadingBulk ? 'default' : 'pointer' }}>
              {uploadingBulk ? '⏳ กำลังอัปโหลด...' : '+ อัปโหลดรูป'}
              <input type="file" accept="image/*" multiple hidden disabled={uploadingBulk || !tenant?.id} onChange={handleBulkUpload} />
            </label>
          )}
        </div>
        {loadingPhotos ? (
          <div style={{ color: 'var(--text3)', fontSize: 12 }}>กำลังโหลด...</div>
        ) : unassignedPhotos.length > 0 ? (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {unassignedPhotos.map((p) => (
              <div key={p.id}
                draggable={canEdit}
                onDragStart={canEdit ? (e) => e.dataTransfer.setData(PHOTO_DRAG_MIME, p.id) : undefined}
                title={`${p.workers?.nickname || p.workers?.name || ''} · ลากไปวางบนการ์ดเพื่อมอบหมาย`}
                style={{ width: 90, opacity: assigningPhotoId === p.id ? 0.5 : 1, cursor: canEdit ? 'grab' : 'default' }}>
                {p.url ? (
                  <img src={p.url} alt="" style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)' }} />
                ) : (
                  <div style={{ width: '100%', aspectRatio: '1', borderRadius: 8, border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, color: 'var(--text3)' }}>โหลดไม่สำเร็จ</div>
                )}
                <div style={{ fontSize: 9.5, marginTop: 3, color: 'var(--text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.workers?.nickname || p.workers?.name || '-'}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
```

- [ ] **Step 5: Wire drop-to-assign onto individual task cards**

In `PhaseBoard`, the task-card `<div>` (currently `draggable={canEdit}` with `onDragStart` only, no `onDrop`) needs a drop handler for photos. Add these props to `PhaseBoard`'s destructured params: `onAssignPhoto`. Then change the card's opening tag from:
```jsx
                <div key={task.id}
                  draggable={canEdit}
                  onDragStart={canEdit ? (e) => e.dataTransfer.setData('text/plain', task.id) : undefined}
                  onClick={canEdit ? () => onStartEdit(task) : undefined}
```
to:
```jsx
                <div key={task.id}
                  draggable={canEdit}
                  onDragStart={canEdit ? (e) => e.dataTransfer.setData('text/plain', task.id) : undefined}
                  onDragOver={canEdit ? (e) => { if (e.dataTransfer.types.includes(PHOTO_DRAG_MIME)) e.preventDefault() } : undefined}
                  onDrop={canEdit ? (e) => {
                    const photoId = e.dataTransfer.getData(PHOTO_DRAG_MIME)
                    if (!photoId) return // not a photo drag -- let it bubble to the column's own onDrop (card-to-column move)
                    e.preventDefault()
                    e.stopPropagation()
                    onAssignPhoto(photoId, task.id)
                  } : undefined}
                  onClick={canEdit ? () => onStartEdit(task) : undefined}
```
Note: `onDragOver` must call `e.preventDefault()` for a drop to be allowed at all — but only when the drag is actually a photo, otherwise a card-drag being dragged over another card (not a valid drop target for that) must NOT have its default prevented, or it would interfere with the existing column-level card-to-column reordering behavior.

Then in `PhaseKanbanBoard`'s `boardProps` object, add `onAssignPhoto: handleAssignPhoto,` alongside the existing `taskPhotoCounts, onViewPhotos: handleViewPhotos,` line.

- [ ] **Step 6: Manual verification**

Run the dev server, open a site's Kanban tab as an ADMIN/OWNER account:
1. Confirm the tray renders (empty state if no unassigned photos yet).
2. Click "+ อัปโหลดรูป", multi-select 2-3 image files, confirm they appear in the tray after upload.
3. Drag one tray photo onto a task card; confirm it disappears from the tray and the card's 📷 badge count increases by 1.
4. Confirm dragging a CARD onto a different status column still works exactly as before (unaffected by the photo-drop change).
5. Confirm the 6 real photos already sitting unassigned in production (`site_id` + `task_id IS NULL` in `line_site_photos`, tenant `1b9affc4-2136-4ed1-b168-a36e6624e743`) become visible in their site's tray and can be dragged onto a card.

- [ ] **Step 7: Commit**

```bash
git add src/pages/sites/PhaseKanbanBoard.jsx
git commit -m "feat: admin photo upload + drag-to-assign tray in Kanban board"
```

---

### Task 4: Worker per-task photo upload (MySchedule.jsx)

**Files:**
- Modify: `src/pages/assign/MySchedule.jsx`

**Interfaces:**
- Consumes: `uploadSitePhotos` from `../../lib/photoUpload.js` (import path from `src/pages/assign/`). No RPC call needed for the worker id — `me.id` (already resolved via the file's existing `workers.find(w => w.email === user?.email)` pattern) is already the worker's own id. `useTenant()` from `../../hooks/useTenant.js` for `tenant.id` — **verified via schema query that `workers_with_rate` (the view `useAllActiveWorkers()` selects `*` from, which `me` comes from) has no `tenant_id` column**; same fix as Task 3, same established `useTenant()` pattern (`Sites.jsx`/`PurchaseOrders.jsx`).
- Produces: nothing new consumed elsewhere.

- [ ] **Step 1: Add imports and state**

Add to the imports:
```js
import { uploadSitePhotos } from '../../lib/photoUpload.js'
import { useTenant } from '../../hooks/useTenant.js'
```

Inside the component function, add (near the top, alongside the other hook calls):
```js
  const { tenant } = useTenant()
```

Add alongside the existing `openStatusMenuId`/`savingTaskId` state:
```js
  const [uploadingTaskId, setUploadingTaskId] = useState(null)
  const [uploadedTaskId, setUploadedTaskId] = useState(null) // brief "✅ แนบรูปแล้ว" confirmation, cleared after ~2s
```

- [ ] **Step 2: Add the upload handler**

Add after `updateTaskStatus`:
```js
  const uploadTaskPhotos = async (task, files) => {
    if (!files || !files.length) return
    if (!tenant?.id) { alert('กำลังโหลดข้อมูลบริษัท กรุณาลองใหม่อีกครั้ง'); return }
    setUploadingTaskId(task.id)
    try {
      const { succeeded, failed } = await uploadSitePhotos(files, {
        tenantId: tenant.id, workerId: me.id, siteId: task.site_id, taskId: task.id,
        date: new Date().toISOString().slice(0, 10),
      })
      if (failed.length) alert(`แนบรูปไม่สำเร็จ ${failed.length} ไฟล์: ${failed.map((f) => f.file.name).join(', ')}`)
      if (succeeded.length) {
        setUploadedTaskId(task.id)
        setTimeout(() => setUploadedTaskId((id) => (id === task.id ? null : id)), 2000)
      }
    } finally {
      setUploadingTaskId(null)
    }
  }
```

- [ ] **Step 3: Add the "📷 แนบรูป" button to the expanded task row**

In the `myTasks.map` block, the status-picker row currently reads:
```jsx
                {isOpen && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    {TASK_STATUS_OPTS.map((s) => (
                      <button key={s.value} type="button" className={`btn btn-sm ${t.status === s.value ? 'btn-primary' : 'btn-ghost'}`}
                        disabled={savingTaskId === t.id} style={{ flex: 1, fontSize: 11 }}
                        onClick={() => updateTaskStatus(t.id, s.value)}>
                        {s.label}
                      </button>
                    ))}
                  </div>
                )}
```
Change to:
```jsx
                {isOpen && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    {TASK_STATUS_OPTS.map((s) => (
                      <button key={s.value} type="button" className={`btn btn-sm ${t.status === s.value ? 'btn-primary' : 'btn-ghost'}`}
                        disabled={savingTaskId === t.id} style={{ flex: 1, fontSize: 11 }}
                        onClick={() => updateTaskStatus(t.id, s.value)}>
                        {s.label}
                      </button>
                    ))}
                    <label className="btn btn-sm btn-ghost" style={{ flex: 1, fontSize: 11, textAlign: 'center', cursor: uploadingTaskId === t.id ? 'default' : 'pointer' }}>
                      {uploadingTaskId === t.id ? '⏳...' : uploadedTaskId === t.id ? '✅ แนบรูปแล้ว' : '📷 แนบรูป'}
                      <input type="file" accept="image/*" capture="environment" multiple hidden
                        disabled={uploadingTaskId === t.id || !tenant?.id}
                        onChange={(e) => { uploadTaskPhotos(t, e.target.files); e.target.value = '' }} />
                    </label>
                  </div>
                )}
```

- [ ] **Step 4: Manual verification**

Log in as a real WORKER-role account with a linked `workers` row and at least one assigned, not-done `phase_tasks` row for today. Open the Assign page (renders `MySchedule.jsx` automatically for non-`canEdit` users):
1. Tap a task under "งานของคุณวันนี้" to expand it — confirm the "📷 แนบรูป" button appears alongside the status buttons.
2. Tap it, multi-select 2-3 photos (on a real phone: confirm the camera app is offered as a picker option via `capture="environment"`).
3. Confirm the button briefly shows "✅ แนบรูปแล้ว" and no `alert()` fires on success.
4. Confirm the new photo(s) show up in `line_site_photos` with `task_id` set to that task, `worker_id` set to this worker.
5. Open the same site's Kanban board as an ADMIN — confirm the task card's 📷 badge count reflects the new upload (no separate action needed; it's the same `taskPhotoCounts` query Task 3 already drives).
6. Confirm a WORKER account cannot upload to a task they are NOT assigned to (RLS-level: this isn't reachable through the UI at all since the button only ever appears on the worker's own `myTasks`, but worth a direct RLS check reusing Task 1 Step 4's simulated-session technique against a task the test worker is NOT assigned to, confirming the insert is rejected).

- [ ] **Step 5: Commit**

```bash
git add src/pages/assign/MySchedule.jsx
git commit -m "feat: per-task photo upload for WORKER-role field crews"
```

---

### Task 5: Final verification and ship

**Files:** none (verification only, plus version/changelog files per this project's standing convention)

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass, including the new `photoUpload.test.js`.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean build, no errors.

- [ ] **Step 3: Re-run the manual verification from Task 3 Step 6 and Task 4 Step 4 end-to-end in one pass**, confirming both surfaces still work together correctly (e.g. a photo uploaded via Surface 2 shows up correctly in Surface 1's per-card badge, a photo uploaded via Surface 1's bulk upload and left unassigned does NOT appear anywhere on Surface 2 since that surface never shows unassigned photos). Clean up any test data created during verification (test photos, temporary accounts) the same way earlier features in this session's history were cleaned up — through the app's own UI/delete paths where possible, direct SQL only for what the UI can't remove.

- [ ] **Step 4: Confirm the 6 originally-stuck production photos are resolved**

```sql
select count(*) from line_site_photos where task_id is null and tenant_id = '1b9affc4-2136-4ed1-b168-a36e6624e743';
```
Expected: 0, or explicitly confirm with the user which (if any) remain intentionally unassigned.

- [ ] **Step 5: Version bump + changelog**

Bump `package.json`'s `"version"` (patch bump, matching this project's standing convention) and add a matching entry to the top of `src/changelog.json`, in Thai, describing both surfaces (admin drag-and-drop photo tray in the Kanban board; per-task photo upload for field crews in the Assign day view).

- [ ] **Step 6: Commit the version bump**

```bash
git add package.json src/changelog.json
git commit -m "chore: bump version for Kanban photo upload feature"
```

- [ ] **Step 7: Report back to the controller/user for the push/deploy-zip decision** — this plan does not push or build a deploy zip itself; that follows this project's established shipping cycle (confirm with the user before pushing to `origin/main`, then build+place the deploy zip), same as every other feature shipped this session.
