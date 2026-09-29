# Kanban Photo Upload & Assignment — Design

## Motivation

Today `line_site_photos` (photo storage for site work) is written to
exclusively by the LINE bot (`supabase/functions/line-webhook/index.ts`),
via a service-role client that bypasses RLS entirely. The web app can only
*view* photos already attached to a Kanban card
(`PhaseKanbanBoard.jsx`'s photo-count badge + viewer). There is no way,
from the web app, to:

1. Upload a photo that didn't come through LINE (e.g. a batch someone
   collected on their own phone and wants to add from a desktop).
2. Assign an *already-uploaded* photo to a card after the fact. Right now
   the only path that ever sets `task_id` is the LINE bot's live
   `job_done_pick` flow (pick a task, *then* send the photo, same
   message exchange) — a photo sent via the general "รูปภาพ" LINE
   handler, outside that flow, lands with `task_id = null` and stays
   there forever. **Six real photos in production are stuck this way
   right now**, confirmed via direct query.

This feature adds both: a way to upload new photos from the web, and a
way to assign any unassigned photo (web-uploaded or LINE-uploaded) to a
Kanban card — as two distinct surfaces for two distinct audiences, per
the approved design conversation.

## Data model — no schema changes

`line_site_photos` and the `line-site-photos` Storage bucket already have
every column this feature needs (`tenant_id`, `worker_id`, `site_id`,
`date`, `photo_path`, `description`, `task_id` nullable). Only RLS
policies are added — see below. New photo rows and files follow the
LINE bot's own existing path convention exactly, so LINE- and
web-originated photos stay indistinguishable to the rest of the app:

```
<tenant_id>/<site_id>/<timestamp>-<worker_id>.jpg
```

## Access model

`line_site_photos` currently has exactly one RLS policy
(`admin_reads`, SELECT, ADMIN/OWNER only) — no INSERT/UPDATE policy
exists for any role; the storage bucket has the parallel SELECT-only
policy. Two new policy pairs are added, deliberately mirroring the
existing `phase_tasks`/`phase_task_workers` admin-vs-worker split
(`my_assigned_phase_task_ids()`, introduced in
`2026-09-17-05-fix-phase-tasks-rls-recursion.sql`) rather than
inventing a new access model:

- **ADMIN/OWNER** (`is_admin_or_owner()`): INSERT and UPDATE any row
  within their own tenant — matches `phase_tasks.admin_updates`.
- **WORKER**: INSERT only rows where `worker_id` resolves to their own
  linked `workers` row (`workers.email = auth.email()`, same lookup
  `my_assigned_phase_task_ids()` already does); UPDATE (to set
  `task_id`) only their own rows, and only to a `task_id` that is in
  `my_assigned_phase_task_ids()` — a worker can attach their own photo
  to their own assigned task, nothing else.

The storage bucket's INSERT policy mirrors this: path's tenant segment
must equal `current_tenant_id()`, combined with the same
admin-or-owns-a-linked-worker check.

A `workers`-linked account is required either way (same precondition
the check-in-locations feature already established for ADMIN/OWNER
accounts): no linked `workers` row means no `worker_id` to write, and
the UI surfaces this the same way `MySchedule.jsx` already does
elsewhere ("ไม่พบข้อมูลพนักงานที่ผูกกับบัญชีนี้").

## Surface 1 — Admin/office triage tray (`PhaseKanbanBoard.jsx`)

A new "📷 รูปที่รอมอบหมาย" panel, visible whenever `canEdit` (same gate
the rest of this board already uses), showing every
`line_site_photos` row for this site with `task_id IS NULL` — the six
stuck photos included — as thumbnails (signed URLs, same
`createSignedUrls` call `handleViewPhotos` already makes).

- **Bulk upload**: a `<input type="file" multiple accept="image/*">`
  button in the panel header. Each selected file is downscaled
  client-side (see below), uploaded, and inserted as an unassigned
  (`task_id: null`) row, then appended to the tray — reusing
  `AttachmentsSection.jsx`'s established upload-then-insert-then-
  remove-orphan-on-failure shape, extended to loop over a `FileList`
  instead of a single file.
- **Assignment — real drag-and-drop**: this board already has a
  working DnD mechanism (`draggable={canEdit}` cards,
  `onDragStart`/`onDrop` handling — today only used to drop a *card*
  onto a status column via `e.dataTransfer.setData('text/plain', ...)`
  and `onQuickMove`). Photo thumbnails become draggable too, using a
  distinct MIME type (`application/x-line-site-photo-id`) so a
  photo-drag never gets misread as a card-drag or vice versa. Each
  individual task card (not just the status columns, which are the
  only current drop targets) gains its own `onDrop`, reading that
  MIME type and — when present — `UPDATE`ing the photo's `task_id`
  instead of calling `onQuickMove`. Dropping a photo also refreshes
  `taskPhotoCounts` so the card's existing photo-badge updates
  immediately.
- Assigning removes the thumbnail from the tray (it's no longer
  unassigned); the tray empties out as photos get sorted, same feel as
  clearing an inbox.

## Surface 2 — Worker/field per-task upload (`MySchedule.jsx`)

No new top-level component. `MySchedule.jsx`'s existing "งานของคุณวันนี้"
list already expands each task (tap to open) into a status-picker row
(`TASK_STATUS_OPTS`) scoped to that one task via `t.id`/`t.site_id` and
the signed-in worker via `me.id` — exactly the container a photo
upload needs, so this is a small addition to that existing expanded
row, not a new screen:

- A "📷 แนบรูป" button alongside the status buttons, opening a
  `<input type="file" multiple accept="image/*" capture="environment">`
  (`capture` hints a phone's camera app as a picker option, still
  falls back to the normal gallery/file picker everywhere else).
- No drag-and-drop, no separate tray, no picking which task afterward
  — the task is already fixed by which card's row the button lives in,
  matching how a field worker actually thinks about this ("here are
  the photos for the thing I'm doing right now"), not a desktop
  sorting task.
- Selected files upload the same way as Surface 1 (downscale → upload
  → insert), except every inserted row already carries this task's
  `task_id` — never lands unassigned.
- On success, a brief inline "✅ แนบรูปแล้ว (N)" replaces the button
  text for ~2 seconds, then reverts — no `alert()`, since a multi-file
  batch succeeding would otherwise mean stacking several blocking
  alerts in a row. Failures still use `alert()` (listing which files
  failed), matching this file's existing error convention.

## Client-side image downscaling

Both surfaces route uploads through one shared helper (new file,
`src/lib/photoUpload.js`) that decodes each selected `File` onto an
off-screen `<canvas>`, resizes so its longer edge is ≤1600px (no
upscaling of smaller images), and re-encodes as JPEG at quality 0.8
before upload — a raw phone photo can be 5-10MB, and a real "bulk"
selection could be a dozen at once. This is a technical default with
no user-facing decision to make, not a spec placeholder.

## Error handling

- Upload failure (storage or DB insert) on any one file in a
  multi-select batch does not abort the rest — each file's
  upload+insert is its own try/catch, matching
  `AttachmentsSection.jsx`'s per-file error handling; a failed file's
  storage object is removed (no orphan) and its name is listed in a
  single end-of-batch alert.
- Assigning a photo via drag-and-drop that fails (network, RLS
  mismatch) leaves the photo in the tray with an inline error state
  rather than silently disappearing.

## Testing

No pure-function surface large enough to warrant dedicated unit tests
(the downscale helper is a thin canvas wrapper; meaningfully testing
it means faking `<canvas>`/`Image` in a DOM test environment for
marginal value). Verified via manual testing against the live app,
matching this session's established pattern for RLS/UI-heavy features:
upload as an ADMIN account, upload as a linked-WORKER account,
drag-assign on desktop, tap-assign on a narrow/mobile viewport, and
confirm the six currently-stuck production photos become assignable
through the new tray — then clean up any test data created during
verification.
