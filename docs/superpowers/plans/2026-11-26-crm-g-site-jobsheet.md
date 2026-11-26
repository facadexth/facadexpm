# CRM G — Crew Daily Job Sheet (ใบงานประจำวัน) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On an installation day, crew get a no-login daily job sheet from LINE "งานวันนี้" showing the site, which day of the booked run it is, the team, a safety note, the site's open Kanban cards and drawings; the shift's team leader can close a card or log "ทำต่อพรุ่งนี้" with ≥1 photo; staff download the same sheet as an A4 PDF.

**Architecture:** Same shape as phase 2a (repair work order): pure view model `_shared/site-jobsheet.ts` → React sheet; one shared DB loader `_shared/site-jobsheet-load.ts` used by the web (authenticated) and a new no-JWT edge function `site-jobsheet` (crew token in `line_deep_link_tokens`, action `site_jobsheet` + `site_id`). Card writes reuse the crew rules in `_shared/lineTaskRules.ts` and the photo table/bucket of LINE "งานเสร็จ" (`line_site_photos`, bucket `line-site-photos`).

**Tech Stack:** React/Vite, Supabase (Postgres, Deno edge functions, storage), html2pdf via `src/lib/pdf.js`, `qrcode`, vitest.

**Spec:** `docs/superpowers/specs/2026-11-24-crm-design.md` — "Principle — one record, two views", "G — crew daily job sheet" (owner answers 2026-11-26). Mockup: https://claude.ai/artifact/SYenKGv2znFJE4Br11deXc v3 (screens 1–3 phone, 4 A4).

## Global Constraints

- **Do not deploy.** Owner 2026-11-26: "สิ่งที่ทำตอนนี้ไม่ให้ขึ้นระบบ จนกว่าจะบอก". No migration apply, no function deploy, no `npm run deploy` until the owner says so. Dry runs (rolled back) are allowed and run by the controller.
- Version **1.42.0** (live 1.41.0). Thai changelog entry; manual section in `public/manual/index.html`.
- Subagents make no DB calls; migrations ship with a `.dryrun.sql` ending `RAISE EXCEPTION 'RESULT ok'`.
- Shared pure logic lives in `supabase/functions/_shared/*.ts`, imported by vitest from `src/lib/*.test.js`. Reuse `formatThaiDate` (`_shared/thai-date.ts`), `siteMapLink` (`_shared/site-map-link.ts`), `bangkokDay` (`_shared/customer-form-logic.ts`), `endOfBangkokDayIso` (`_shared/repair-workorder-link.ts`), `isWorkerDoneable` / `doneBlockedMessage` / `doneErrorReply` (`_shared/lineTaskRules.ts`).
- Dates shown `dd/mm/yyyy+543`; "today" is the Bangkok date.
- **Cards are the site's Kanban cards** (`phase_tasks`, statuses `not_started` / `in_progress` / `done`). Crew never enter quantities; qty/% are display-only (PM-only in the web, owner 2026-10-17).
- **Only the team leader** (`worker_assignments.is_team_leader` for that site, today) may act on the crew page; other booked crew view only.
- **≥1 photo** for every crew card action (done or continue).
- Safety note = `sites.safety_note` when set, else tenant setting `site_safety_note_default`, else the built-in default `ก่อนเริ่มงาน: ตรวจอุปกรณ์เซฟตี้ · ใส่เข็มขัดนิรภัยเมื่อทำงานที่สูง · ปูผ้ากันเปื้อนพื้น · เก็บเศษวัสดุและทำความสะอาดก่อนกลับ`.
- Problem cards (cards in an issue phase / with `issue_report_id`) appear only on crew/staff views, never to customers.
- Repair assignments (`worker_assignments.repair_ticket_id` not null) are not installation days: they never produce a job sheet.
- Every new SECURITY DEFINER function / table: `REVOKE ALL … FROM PUBLIC, anon`. New edge function deploys later with `--no-verify-jwt`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A worker booked at the site today but not the leader opens the link → sees the sheet, no action buttons; a forged `card_update` from them is refused server-side.
2. A quantity card (`progress_mode` ≠ 'status') or a parent card → "เสร็จทั้งการ์ด" is not offered; the reason text from `doneBlockedMessage` shows; "ทำต่อพรุ่งนี้ + รูป" still works.
3. Weekend gap: booked Mon–Fri, Sat off, Mon again → Mon is day 1 of a new run only if the gap rule says so (see Task 2); a worker who went to another site in between starts a new run.
4. A site with 60 open cards across 8 zones → sheet groups by phase then zone, wraps, paginates in the PDF; crew page stays scrollable.
5. Token for site A used after the worker was moved to site B today → `not_assigned`; token reused tomorrow → `expired`.

---

### Task 1: Migration — job-sheet tokens + safety note

**Files:** Create `supabase/migrations/2026-11-26-01-site-jobsheet.sql` + `.dryrun.sql`.

**Produces:**
- `line_deep_link_tokens.action_type` CHECK = the 8 live values (`material_request, leave, check_in, check_out, advance, payslip, time_clock, repair_workorder`) + `'site_jobsheet'`; new CHECK `line_deep_link_tokens_site_jobsheet_check`: `action_type <> 'site_jobsheet' OR site_id IS NOT NULL`.
- `sites.safety_note text NULL` with CHECK `char_length(safety_note) <= 500`.
- Dry run: pre-checks the live constraint name/values (fail loudly on drift, as 2026-11-25-03 did), applies the DDL, asserts a `site_jobsheet` token with a site inserts, one without fails, all 8 old types still insert, `sites.safety_note` 501 chars fails, then `RAISE EXCEPTION 'RESULT ok'`. Demo tenant `8b61c890-0a90-4223-91d3-b5f8f4e89908`, any of its sites.
- Check for views selecting `sites.*` (memory: view column freeze) and list them in the report; recreate only if one must expose `safety_note` (none expected).

- [ ] Write both files, commit. Do not run them.

### Task 2: Job-sheet view model (pure)

**Files:** Create `supabase/functions/_shared/site-jobsheet.ts`; test `src/lib/siteJobsheet.test.js`.

**Produces:**
```ts
export const DEFAULT_SAFETY_NOTE: string // exact text from Global Constraints
export function resolveSafetyNote(siteNote?: string | null, tenantDefault?: string | null): string // trimmed site → tenant → DEFAULT
export function runOfDays(dates: string[], today: string): { index: number; total: number; from: string; to: string } | null
//   dates = this worker's install-assignment dates at THIS site (any order, duplicates allowed), plus `otherSiteDates` handled by caller filtering;
//   consecutive run = sorted unique dates where each next date is ≤ 3 calendar days after the previous; today must be in the list, else null.
export type JobSheetInput = {
  tenant: { company_name?: string; address?: string; phone?: string; logo_url?: string | null }
  date: string // Bangkok YYYY-MM-DD
  site: { id: string; name: string; site_number?: string | null; location?: string | null; map_url?: string | null; lat?: number | null; lng?: number | null; safety_note?: string | null }
  tenantSafetyDefault?: string | null
  run: { index: number; total: number; from: string; to: string } | null
  crew: Array<{ worker_id: string; name: string; nickname?: string | null; shifts: string[]; is_team_leader: boolean }>
  phases: Array<{ id: string; name: string; sort_order: number; is_issue_phase?: boolean }>
  cards: Array<{ id: string; phase_id: string; name: string; zone?: string | null; status: 'not_started' | 'in_progress' | 'done'; sort_order?: number | null;
                 progress_mode?: string | null; planned_qty?: number | null; done_qty?: number | null; unit?: string | null;
                 issue_report_id?: string | null; has_children?: boolean; worker_ids: string[]; updated_at?: string | null }>
  drawings: Array<{ id: string; title: string; url: string | null }>
  viewerWorkerId?: string | null // crew page: the token's worker
}
export type JobSheet = {
  dateText: string                 // 'พ 26/11/2569'
  runText: string | null           // 'วันที่ 3 จาก 5 · 24–28/11/2569'
  company: { name: string; address: string; phone: string; logoUrl: string | null }
  siteName: string; address: string; mapUrl: string | null
  leaderText: string               // 'สมชาย (ชาย) · เช้า + บ่าย' or '-'
  crewText: string                 // others, comma-joined, or '-'
  safetyNote: string
  progressText: string | null      // e.g. 'ติดตั้งบานกระจก · คืบหน้า 62%' — share of cards done in the phase with the most open cards; null when no cards
  problems: Array<{ id: string; name: string; zone: string }>   // issue cards, not done
  groups: Array<{ phase: string; zone: string; cards: Array<{ id: string; name: string; statusText: string; qtyText: string; ownersText: string;
                   mine: boolean; canClose: boolean; blockedText: string | null }> }>
  cardCount: number
  drawings: JobSheetInput['drawings']
  viewerIsLeader: boolean
}
export function buildJobSheet(input: JobSheetInput): JobSheet
```
Rules: cards shown = not done, plus done cards whose `updated_at` Bangkok date is today; issue cards go to `problems` (not `groups`); groups ordered by phase sort_order then zone (empty zone → 'ทั่วไป') then card sort_order; statusText ยังไม่เริ่ม / กำลังทำ / เสร็จแล้ว; qtyText `done/planned unit` for quantity cards else '-' (phase_tasks has no unit column: the loader fills `unit` from the card's BOQ item via `boq_item_id` when that table has a unit column — check the migration that created `phase_tasks.boq_item_id` — else `unit` is null and the text is `done/planned`); `mine` when viewerWorkerId ∈ worker_ids (sort mine first within a group); `canClose` = `isWorkerDoneable(card)` and status ≠ done; `blockedText` = `doneBlockedMessage(card)`; ownersText from crew names by worker_ids (fallback '-'). Weekday names as in `_shared/repair-workorder.ts` (`thaiWeekday`).

- [ ] Tests: safety resolution 3 levels + trim; runOfDays (5 consecutive, today 3rd → 3/5; weekend gap ≤3 days continues; gap of 4 starts new run; today absent → null; duplicates); grouping/order; issue split; done-today kept, done-earlier dropped; qty text; mine-first; canClose false for quantity and parent cards with the exact blocked text; leader text with shifts; viewerIsLeader.
- [ ] Fail → implement → pass → commit.

### Task 3: Shared loader + web wrapper

**Files:** Create `supabase/functions/_shared/site-jobsheet-load.ts`, `src/lib/siteJobsheetLoad.js`; test `src/lib/siteJobsheetLoad.test.js`.

**Produces:** `loadJobSheetInput(db, siteId, { date, tenant, viewerWorkerId, signUrls }) : Promise<JobSheetInput>` (client-agnostic supabase-js calls only; reads the site first, then filters every other query by the site's `tenant_id`):
- site (`id, tenant_id, name, site_number, location, map_url, lat, lng, safety_note`); tenant default from `app_settings` key `site_safety_note_default` for that tenant;
- today's install assignments at the site (`worker_assignments` date = date, site_id, `repair_ticket_id is null`, type 'site') with `workers(name, nickname)` → crew (merge shifts per worker; leader if any row `is_team_leader`);
- run: for `viewerWorkerId` (crew page) or else the leader (staff PDF), that worker's install-assignment dates at this site within date ±21 days, excluding dates where the same worker also had an install assignment at another site → `runOfDays`;
- `site_phases` of the site; `phase_tasks` of the site (with `phase_task_workers(worker_id)`; `has_children` = any task whose `parent_task_id` is this id);
- `site_drawings` (signed URLs via `signUrls('site-drawings', paths)`, 30 min).
`src/lib/siteJobsheetLoad.js`: `loadJobSheet(supabase, siteId, tenant, date)` → `buildJobSheet(await loadJobSheetInput(...))`. Errors throw `Error('โหลดใบงานไม่สำเร็จ: …')`.

- [ ] Tests with a fake db: tenant filter on every child query; crew merge; repair rows excluded; run with other-site day splitting; drawings signed; viewerWorkerId passthrough. Commit.

### Task 4: A4 sheet component

**Files:** Create `src/components/SiteJobSheet.jsx`; test `src/components/SiteJobSheet.test.jsx`.

`SiteJobSheet({ sheet, id, compact })` renders mockup screen 4 at `A4_CONTENT_WIDTH_PX` (white paper both themes): header (logo or initial — reuse the initial helper from `RepairWorkOrderSheet.jsx`; move it to a small shared module if needed), "ใบงานประจำวัน", dateText; cards: หน้างาน (address, QR "แผนที่" when mapUrl) and รอบนี้ (runText + day dots when run, หัวหน้าทีม, ทีม, เฟส progressText); safety box; `การ์ดงานวันนี้ (N ใบ)` table `# | การ์ด | ผู้รับผิดชอบ | จำนวน (PM) | วันนี้ | หมายเหตุ` with zone rows, tick boxes เสร็จทั้งการ์ด / ทำต่อพรุ่งนี้ (CSS borders), 2 dotted note lines; `ปัญหาที่ต้องแก้ (ภายใน)` list (omit block when empty); `แบบที่เกี่ยวข้อง` titles; บันทึกหัวหน้าทีม + เริ่มงาน/เลิกงาน; 2 signatures หัวหน้าทีม / ผู้ตรวจ (PM); footer `ใบงานประจำวัน <date> · <site> · เอกสารภายใน`. Rows avoid page breaks; long text wraps. `compact` is unused here (reserved for Task 7 — do not add it).

- [ ] Tests: heading count, zone rows, problems block hidden when empty, no QR without mapUrl, footer text. Commit.

### Task 5: Staff side — 🖨 button, safety settings

**Files:** Create `src/components/SiteJobSheetModal.jsx`; modify `src/pages/assign/DayView.jsx` (per-site 🖨 ใบงานวันนี้ button, admin+/PM who can see Assign), `src/pages/Settings.jsx` (textarea `ข้อควรระวังหน้างาน (ค่าเริ่มต้น)` saving `site_safety_note_default` via `saveAppSetting`), `src/pages/Sites.jsx` (site form field `ข้อควรระวังหน้างาน (ไซท์นี้)` → `safety_note`, max 500, placeholder shows the current default; include in PM_SITE_KEYS); tests for each touched component.

`SiteJobSheetModal({ siteId, date, onClose })`: loads via `loadJobSheet`, shows the sheet, `📄 ดาวน์โหลด PDF` → `downloadPDF('site-js-<siteId>', 'ใบงาน-<site short or name>-<dd-mm-yyyy BE>.pdf')`, disabled `กำลังเตรียม…` until images + QR are ready (reuse `waitForSheetImages` from `RepairWorkOrderModal.jsx`; export it if needed).

- [ ] Tests first, implement, commit.

### Task 6: Edge function `site-jobsheet`

**Files:** Create `supabase/functions/_shared/site-jobsheet-logic.ts` (`handleSiteJobsheet(body, deps, now)`), `supabase/functions/site-jobsheet/index.ts`; test `src/lib/siteJobsheetLogic.test.js`. Pattern: `repair-workorder` (deps injection, refusals 200 `{ reason }`, generic errors).

Token checks (every action): row `action_type='site_jobsheet'`, not expired (multi-use), worker active in token tenant, `line_bot` module, worker has an install assignment (`repair_ticket_id is null`) at `token.site_id` on the Bangkok date of now → else `expired | not_found | not_assigned | line_bot_disabled`.
- `view` → `{ ok, sheet: JobSheet }` (loader with viewerWorkerId = token worker; signed URLs 30 min).
- `upload_url` `{ mime: image/jpeg|image/png, bytes ≤ 15 MB }` → leader only (`not_leader`), signed upload URL in bucket `line-site-photos` at `<tenant>/<site>/<date>/js-<now>-<rand>.<ext>`; max 30 per token per day.
- `card_update` `{ taskId, mode: 'done' | 'continue', note ≤ 500, photos: string[] 1–10 (paths from upload_url, must start with `<tenant>/<site>/<date>/js-`) }` → leader only; card must belong to token.site_id and tenant; `done`: refuse with `doneBlockedMessage` text when `!isWorkerDoneable`, else `update status='done'` and map DB errors with `doneErrorReply`; `continue`: `not_started` → `in_progress` (no change otherwise); both insert one `line_site_photos` row per photo (`tenant_id, worker_id, site_id, date, photo_path, description: note || null, task_id, customer_visible: false`). Return `{ ok, sheet }` (fresh).
- Bad input → 400 `{ error }`.

- [ ] Tests per branch incl. non-leader refused on upload_url/card_update but allowed on view, photo prefix check, 0 photos refused, quantity card done refused with QUANTITY_BLOCKED_MESSAGE, repair-only assignment → not_assigned, moved to other site → not_assigned. Deno check. Commit.

### Task 7: Crew page `/j/:token`

**Files:** Create `src/SiteJobSheetPage.jsx`; modify `src/main.jsx` (route + `takeWaitingWorker` list + lazy import); test `src/SiteJobSheetPage.test.jsx`.

Phone-first native layout (mockup screen 2 — NOT the scaled A4): header site + dateText + day badge `วันที่ 3/5` + dots; card (ที่อยู่ + 🗺️ แผนที่ link, ทีม, กะ); safety box; problems group `ปัญหาที่ต้องแก้` on top (crew can't act on them here); card groups by phase/zone with status, qty, `ของคุณ` badge; drawings strip (tap opens the signed URL in a new tab). Leader only: tapping a card opens a bottom sheet (screen 3): card name, `จำนวน (PM กรอกในเว็บ)` read-only, buttons `⏳ ยังทำต่อพรุ่งนี้` and `✅ เสร็จทั้งการ์ด` (hidden with blockedText shown when `!canClose`), photos (camera/gallery, ≥1, ≤10, downscale like RepairFormPage), note, `ส่ง` disabled until a mode + ≥1 photo. Non-leader: no sheet, a line `เฉพาะหัวหน้าทีมกดอัปเดตการ์ดได้`. Errors: expired/not_found → `ลิงก์หมดอายุ กด "งานวันนี้" ใน LINE อีกครั้ง`; not_assigned → `วันนี้คุณไม่ได้อยู่ในทีมของไซท์นี้แล้ว`; line_bot_disabled → `ใบงานออนไลน์ยังไม่เปิดใช้ ติดต่อแอดมิน`; network → `โหลดไม่สำเร็จ ลองใหม่`. After `card_update` success show `บันทึกแล้ว` and render the returned sheet.

- [ ] Tests: each error text; non-leader has no actions; leader done flow posts taskId/mode/photos/note; blocked card hides done; send disabled without photo. Commit.

### Task 8: LINE "งานวันนี้" link

**Files:** Modify `supabase/functions/line-webhook/index.ts` (both branches of `handleTodaysJobMenu`); create `supabase/functions/_shared/site-jobsheet-link.ts` (`jobSheetLines(rows: Array<{ siteName: string; runText: string | null; url: string | null }>): string[]`, `installSitesToday(assignments)` → unique site ids with `repair_ticket_id` null); test `src/lib/siteJobsheetLink.test.js`.

One token per install site today (expires `endOfBangkokDayIso(now)`, `action_type 'site_jobsheet'`, `site_id`), lines `['', '📋 ใบงานวันนี้ <siteName>: <APP_URL>/j/<token>']` (add ` (วันที่ x/y)` when run known — compute with `runOfDays` from the worker's assignments, or omit if the extra query fails); failure → `📋 ใบงานวันนี้ <siteName>: เปิดไม่ได้ตอนนี้ ลองใหม่`. Wrapped in try/catch so the existing reply is never blocked; placed before the repair work-order lines.

- [ ] Tests for helpers; deno check (3 pre-existing errors allowed, none new). Commit.

### Task 9: Release 1.42.0 (no deploy)

**Files:** `package.json`, `package-lock.json` (`npm version 1.42.0 --no-git-tag-version`), `src/changelog.json`, `public/manual/index.html` (new subsection in the Assign/งานวันนี้ area: crew job sheet, leader-only, ≥1 photo, qty is PM's, safety note settings, 🖨 PDF).

- [ ] Full `npx vitest run` green; commit `chore(release): 1.42.0 …`.

## Release (only when the owner says go)
migration -01 (dry run first) → `site-jobsheet` (`--no-verify-jwt`) → web 1.42.0 (check build-info) → `line-webhook` last.
