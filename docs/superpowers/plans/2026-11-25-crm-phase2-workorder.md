# CRM Phase 2a — Repair Work Order (ใบงานซ่อม) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff download an A4 ใบงานซ่อม PDF from a repair ticket; crew open the same work order from LINE "งานวันนี้" without login; the customer signs on the crew's phone (or later through a /sign link).

**Architecture:** One pure view-model builder (`_shared/repair-workorder.ts`) feeds one React sheet (`RepairWorkOrderSheet.jsx`). The staff modal builds the model from the authenticated client; a new no-JWT edge function `repair-workorder` builds it from a crew token (`line_deep_link_tokens`, new action `repair_workorder` + `repair_ticket_id`). Signatures reuse `document_receipts` / `document_receipt_links` with a new `document_type 'repair_ticket'`; the "sign later" link reuses `sign-link` + `/sign/<id>`.

**Tech Stack:** React/Vite, Supabase (Postgres, Deno edge functions, storage), html2pdf via `src/lib/pdf.js`, `qrcode` 1.5.4, vitest.

**Spec:** `docs/superpowers/specs/2026-11-24-crm-design.md` (section F + Components). Sample layout: `ใบงานซ่อม-ตัวอย่าง-RP2611-012.pdf` (main repo root) / artifact https://claude.ai/artifact/4UHzP5QXUmi8LEZ9bifFbq v4.

**Scope note:** Phase 2 is split. 2a (this plan) = work order + signing. 2b (later plan) = out-of-warranty quotation prefill + schedule block.

## Global Constraints

- Version **1.41.0** (live is 1.40.1). Changelog entry Thai, newest first; `public/manual/index.html` repair section updated.
- Dates on paper/screens: `formatThaiDate` → `dd/mm/yyyy+543`. Bangkok date for "today".
- No subagent runs SQL against any database. Migrations ship with a `.dryrun.sql` (`BEGIN … RAISE EXCEPTION 'RESULT …'`) that the controller runs.
- Every new table/column/function: `REVOKE ALL … FROM PUBLIC, anon`; new edge function uses the service role and validates the token itself. Deploy with `--no-verify-jwt`.
- LINE pushes are globally off (`LINE_PUSH_ENABLED=false`). Any push goes through `pushToCustomer(customerPushDeps(admin), …)` and must degrade to a visible "ส่งไม่ได้" result, never throw.
- Shared pure logic lives in `supabase/functions/_shared/*.ts` and is imported by vitest from `src/lib/*.test.js`.
- Thai UI copy exactly as written in this plan.
- Materials table on the sheet prints **4 empty rows** (withdrawals have no repair link today — ruling, see Task 2).
- No PM row in the header card (sites have no PM field) — the 3rd signature line stays "ผู้ตรวจ (PM)".
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Crew token for a worker later removed from the ticket → page must refuse (`not_assigned`), not show the customer's address/photos.
2. Ticket with no items (old chat-flow ticket) → sheet shows one row from `description` + all customer media, not an empty table.
3. Site without `handover_date` / warranty 0 → badge "ยังไม่ส่งมอบ" / "ไม่มีประกัน", never "อยู่ในประกัน".
4. Signing twice (double tap, crew and staff both) → one visible latest receipt; no crash; second submit returns `already` unless `p_force`.
5. Very long text (room 100 chars, note 1000 chars, 20 items) → sheet wraps and paginates; no text clipped off the A4 width.

---

### Task 1: Migration — tokens + receipt types

**Files:**
- Create: `supabase/migrations/2026-11-25-03-repair-workorder.sql`, `supabase/migrations/2026-11-25-03-repair-workorder.dryrun.sql`

**Interfaces — Produces:**
- `line_deep_link_tokens.action_type` CHECK gains `'repair_workorder'` (keep all 7 live values: material_request, leave, check_in, check_out, advance, payslip, time_clock).
- `line_deep_link_tokens.repair_ticket_id uuid NULL REFERENCES repair_tickets(id) ON DELETE CASCADE`, plus CHECK `(action_type = 'repair_workorder') = (repair_ticket_id IS NOT NULL)`.
- `document_receipts.document_type` and `document_receipt_links.document_type` CHECKs gain `'repair_ticket'` (keep cheque, quotation, invoice, delivery_report). Constraint names: read them in the dry run with `pg_constraint` and DROP/ADD by name inside the file (both live as `<table>_document_type_check`; the dry run asserts it).

- [ ] Step 1: write the migration (one `BEGIN; … COMMIT;`).
- [ ] Step 2: write the dry run: same DDL, then asserts — insert a `repair_workorder` token row with a ticket id (ok), one without (fails, caught), a `document_receipts` row type `repair_ticket` (ok) — end with `RAISE EXCEPTION 'RESULT ok'`. Use demo tenant `8b61c890-0a90-4223-91d3-b5f8f4e89908` and demo ticket number `RP2611-001` looked up by number.
- [ ] Step 3: commit. Do NOT run either file.

### Task 2: Work-order view model (pure)

**Files:**
- Create: `supabase/functions/_shared/repair-workorder.ts`
- Test: `src/lib/repairWorkorder.test.js`

**Interfaces — Consumes:** `warrantyStatus` (`_shared/warranty.ts`), `siteMapLink` (`_shared/site-map-link.ts`), `SLOTS` (`_shared/repair-form.ts`).
**Produces:**
```ts
export type WorkOrderInput = {
  tenant: { company_name?: string; address?: string; phone?: string; logo_url?: string | null }
  ticket: { ticket_number: string; created_at: string; source: string; description?: string | null;
            scheduled_date?: string | null; scheduled_start?: string | null; duration_hours?: number | null;
            preferred_days?: string[] | null; preferred_slot?: string | null }
  site: { name: string; location?: string | null; map_url?: string | null; lat?: number | null; lng?: number | null;
          handover_date?: string | null; warranty_months?: number | null } | null
  client: { name?: string | null; phone?: string | null } | null
  items: Array<{ id: string; seq: number; location: string; room?: string | null; symptom: string; note?: string | null }>
  media: Array<{ id: string; item_id?: string | null; role: string; media_type: 'image' | 'video'; url: string | null }>
  crew: Array<{ name: string; nickname?: string | null; is_team_leader?: boolean }>
  receipt: { signer_name: string; signed_at: string; signature_url: string | null } | null
  today: string // Bangkok YYYY-MM-DD
}
export type WorkOrder = {
  number: string; reportedText: string                    // 'แจ้งทาง LINE 25/11/2569' | 'แจ้งโดยทีมงาน 25/11/2569'
  company: { name: string; address: string; phone: string; logoUrl: string | null }
  siteName: string; address: string; customerText: string // 'คุณสมใจ ใจดี · 081-…' (phone omitted when null)
  mapUrl: string | null
  appointmentText: string | null                          // 'พฤหัส 27/11/2569 · 22:00 · ประมาณ 3 ชม.'
  crewText: string                                        // leader first with ' (หัวหน้าทีม)', '-' when empty
  warranty: { kind: 'active' | 'expired' | 'none' | 'not_handed_over'; text: string } // texts below
  preferredText: string | null                            // 'ลูกค้าสะดวก: 27/11/2569, 29/11/2569 · กลางคืน'
  customerNote: string | null                             // the "หมายเหตุ:" tail of ticket.description from the form, else null
  rows: Array<{ no: number; where: string; room: string; symptom: string; note: string;
                photos: Array<{ url: string | null; video: boolean }> }>
  receipt: WorkOrderInput['receipt']
}
export function buildWorkOrder(input: WorkOrderInput): WorkOrder
```
Warranty texts: active → `✓ อยู่ในประกัน ถึง dd/mm/yyyy · ไม่เก็บเงิน`; expired → `⚠️ นอกประกัน (หมด dd/mm/yyyy) · ต้องมีใบเสนอราคาก่อน`; none → `ไม่มีประกัน`; not_handed_over → `ยังไม่ส่งมอบงาน`. Weekday short names: อา จ อ พ พฤหัส ศ ส (use `พฤหัส` for Thursday as in the sample). Rows: items sorted by `seq`, photos = `media` with that `item_id` and role `customer` (roles are customer/before/after; the sheet shows only `customer`). No items → one row `{ no: 1, where: 'ตามที่ลูกค้าแจ้ง', symptom: '', note: description, photos: all customer media }`. `customerNote`: form tickets end description with `\nหมายเหตุ: <text>` (see `itemsDescription` in `_shared/repair-form.ts`) — extract that text.

- [ ] Step 1: tests — active/expired/none/not_handed_over badges; appointment text for `2026-11-27`,`22:00:00`,3 → `พฤหัส 27/11/2569 · 22:00 · ประมาณ 3 ชม.`; null schedule → null; crew order leader first; legacy ticket single row; item photos grouped by item_id; video flag; customerNote extraction; preferredText with `night`.
- [ ] Step 2: run, see fail. Step 3: implement. Step 4: pass. Step 5: commit.

### Task 3: The A4 sheet component

**Files:**
- Create: `src/components/RepairWorkOrderSheet.jsx`
- Test: `src/components/RepairWorkOrderSheet.test.jsx`

**Interfaces — Consumes:** `WorkOrder` (Task 2). **Produces:** `export default function RepairWorkOrderSheet({ wo, id })` — a fixed-width (`A4_CONTENT_WIDTH_PX` from `src/lib/pdf.js`) white document with `id` on its root so `downloadPDF(id, …)` can capture it.

Layout = the sample PDF: header (logo or initials box, company name/address/phone; right: "ใบงานซ่อม", number, reportedText); two cards (หน้างาน: siteName, ที่อยู่, ลูกค้า, QR "แผนที่" when mapUrl; นัดหมาย: appointmentText or "ยังไม่ได้นัด", ช่าง crewText, ประกัน badge (green active / orange expired / grey others), preferredText); customerNote box "หมายเหตุจากลูกค้า:" when present; safety box `⚠️ ก่อนเริ่มงาน: ถ่ายรูปจุดซ่อมก่อนแตะงานทุกจุด · ปูผ้ากันเปื้อนพื้น · เก็บเศษวัสดุและทำความสะอาดก่อนกลับ`; heading `รายการที่ต้องซ่อม (N รายการ)`; table columns `# | ตรงไหน / เป็นอะไร | ลูกค้าแจ้ง | รูปจากลูกค้า | รูปหลังซ่อม | ผล` (max 3 photos per cell, then `+N`; video tile labelled `▶ วิดีโอ`; dashed "ถ่ายในแอป หลังซ่อม" box; ticks เสร็จ / ต้องมาอีกครั้ง / ไม่ซ่อม (เหตุผล) drawn with CSS borders — html2canvas drops SVG strokes); rows `page-break-inside: avoid`; วัสดุที่ใช้ table with 4 empty rows; บันทึกช่าง 4 dotted lines + เวลาเข้า/เวลาออก; 3 signature blocks หัวหน้าช่าง / ลูกค้ารับงาน / ผู้ตรวจ (PM) — when `wo.receipt` exists the ลูกค้า block shows the signature image, signer name and `formatThaiDate` + HH:MM; footer `number · siteName`. QR: `QRCode.toDataURL(mapUrl, { margin: 0, width: 160 })` in an effect; images `crossOrigin="anonymous"`. Colours fixed (paper stays white in dark mode).

- [ ] Step 1: tests (jsdom, mock `qrcode`): renders number, 2 rows, `รายการที่ต้องซ่อม (2 รายการ)`, warranty text, no QR img when mapUrl null, signature img + signer name when receipt present, `+2` when 5 photos.
- [ ] Steps 2–5: fail, implement, pass, commit.

### Task 4: Staff modal — 🖨 ใบงานซ่อม, sign, sign link

**Files:**
- Create: `src/lib/repairWorkorderLoad.js` (`export async function loadWorkOrder(supabase, ticketId, tenant): Promise<WorkOrder>`), `src/components/RepairWorkOrderModal.jsx`
- Modify: `src/components/RepairTicketModal.jsx` (buttons + receipt line)
- Test: `src/lib/repairWorkorderLoad.test.js`, `src/components/RepairTicketModal.test.jsx`

`loadWorkOrder` reads ticket (+ sites `name, location, map_url, lat, lng, handover_date, warranty_months`, clients `name, phone`), items, media (signed URLs via `REPAIR_BUCKET` as the modal does), crew = `worker_assignments` with `repair_ticket_id` on `scheduled_date` joined `workers(name, nickname)` + `is_team_leader` (repair scheduling does not set a leader today, so usually nobody is marked — crewText then lists names only), latest `document_receipts` where `document_type='repair_ticket'` and `document_id=ticket.id` (signed URL from bucket `document-receipts`), then `buildWorkOrder` with Bangkok today. Every query error throws `Error('โหลดใบงานซ่อมไม่สำเร็จ: …')`.

`RepairWorkOrderModal({ ticketId, onClose })`: Modal titled `ใบงานซ่อม RPxxxx`, scroll container with the sheet, buttons `📄 ดาวน์โหลด PDF` → `downloadPDF('repair-wo-<id>', 'ใบงานซ่อม-<number>.pdf')` after images load.

RepairTicketModal header buttons (admin+, any status except `declined`): `🖨 ใบงานซ่อม` (opens RepairWorkOrderModal), `✍️ ให้ลูกค้าเซ็นรับงาน` (DocumentReceiptModal `documentType="repair_ticket"`, title `ลูกค้าเซ็นรับงาน <number>`), `🔗 ลิงก์ให้ลูกค้าเซ็น` (SignLinkModal `documentType="repair_ticket"`). Show the latest receipt under the header: `✅ ลูกค้าเซ็นรับงานแล้ว: <name> · dd/mm/yyyy HH:MM`.

- [ ] Steps: tests first (loader maps rows → model with mocked client; modal shows the 3 buttons and the receipt line), fail, implement, pass, commit.

### Task 5: sign-link supports `repair_ticket`

**Files:**
- Modify: `supabase/functions/sign-link/index.ts` (new `DOCUMENT_LOADERS.repair_ticket`), `src/PublicSignPage.jsx` (render branch), `src/components/SignLinkModal.jsx` (header comment only)
- Test: `src/PublicSignPage.test.jsx` (create if absent)

Loader returns `{ type: 'repair_ticket', label: 'ใบงานซ่อม RPxxxx', number, date: created_at date, tenant_id, clientName, siteName, items: [{ description: '<location> (<room>) — <symptom>: <note>' }], notes: null }`; refuse (`refuseReason: 'replaced'`) when the ticket is `declined`. After a successful sign nothing else changes (no status move). PublicSignPage: for `repair_ticket` hide every money column/total and show the item list as a numbered list with heading `รายการซ่อม`.

- [ ] Steps: test the PublicSignPage branch (no ฿ text, numbered items), implement, deno check `sign-link`, commit.

### Task 6: Edge function `repair-workorder`

**Files:**
- Create: `supabase/functions/_shared/repair-workorder-logic.ts` (`handleRepairWorkorder(body, deps, now)`), `supabase/functions/repair-workorder/index.ts` (shell: CORS, service-role client, deps)
- Test: `src/lib/repairWorkorderLogic.test.js`

Actions (POST JSON `{ action, token, … }`):
- `view` → token row must be `action_type='repair_workorder'`, not expired (`used_at` ignored — multi-use), worker `status='active'`, and a `worker_assignments` row exists with `worker_id=token.worker_id AND repair_ticket_id=token.repair_ticket_id`; else `{ reason: 'expired' | 'not_found' | 'not_assigned' }`. Ticket `declined` → `{ reason: 'declined' }`. OK → `{ ok: true, workOrder: WorkOrder }` (signed URLs, 2 h).
- `sign` `{ signerName (1–100 chars), signaturePng: 'data:image/png;base64,…' (≤ 300 KB decoded) }` → same checks; if a receipt already exists and `!body.force` → `{ ok: true, already: true, receipt }`; else upload to `document-receipts` at `<tenant>/repair_ticket/<ticketId>/<now>-crew.png`, insert `document_receipts` (`signed_by: 'crew:' + worker name`) → `{ ok: true, receipt }`.
- `sign_link` → create `document_receipt_links` row (`created_by: 'crew:' + name`), push a text to the ticket's `line_user_id` via `pushToCustomer`: `กรุณาเซ็นรับงานซ่อม <number>\n<APP_URL>/sign/<linkId>`; return `{ ok: true, sent: boolean, url }`.
Invalid action/body → 400 `{ error }`. Deps injected (DB reads/writes, storage, push, clock) exactly like `customer-form-logic.ts`.

- [ ] Steps: tests per branch (expired, not_assigned, declined, view ok shape, sign ok, sign already, sign force, bad png, sign_link sent false when push off), fail, implement, pass, `DENO_NO_PACKAGE_JSON=1 npx -y deno@2.1.4 check --node-modules-dir=none supabase/functions/repair-workorder/index.ts`, commit.

### Task 7: Crew page `/w/:token`

**Files:**
- Create: `src/RepairWorkOrderPage.jsx`
- Modify: `src/main.jsx` (route + include in the `takeWaitingWorker` condition)
- Test: `src/RepairWorkOrderPage.test.jsx`

Phone-first, no app shell. Calls `repair-workorder` `view`. Errors: expired → `ลิงก์หมดอายุ กด "งานวันนี้" ใน LINE อีกครั้ง`; not_assigned → `คุณไม่ได้อยู่ในทีมของงานซ่อมนี้แล้ว`; declined → `งานซ่อมนี้ถูกยกเลิกแล้ว`; network → `โหลดไม่สำเร็จ ลองใหม่`. OK → the sheet scaled to the screen width (CSS `transform: scale(w/718)` in a wrapper with matching height), then a sticky bottom bar: `✍️ ให้ลูกค้าเซ็นรับงาน` and `🔗 ส่งลิงก์ให้ลูกค้าเซ็นทีหลัง`. Sign sheet: name field prefilled with the client name, `SignaturePad`, `บันทึกลายเซ็น` (disabled until name + signature) → `sign`; on `already` show `ลูกค้าเซ็นไปแล้ว: <name>` with `เซ็นใหม่แทน` (sends `force: true`). After success re-load `view` so the sheet shows the signature. Sign-later: result `sent` → `ส่งลิงก์ให้ลูกค้าทาง LINE แล้ว`; not sent → `ส่งทาง LINE ไม่ได้ตอนนี้ แจ้งแอดมินให้ส่งลิงก์ให้ลูกค้า`.

- [ ] Steps: tests (each error text; sign flow posts `signerName` + png and refreshes; already → force), fail, implement, pass, commit.

### Task 8: LINE "งานวันนี้" link for crew

**Files:**
- Modify: `supabase/functions/line-webhook/index.ts` (`issueRepairWorkorderLink`, both branches of `handleTodaysJobMenu`)
- Create: `supabase/functions/_shared/repair-workorder-link.ts` (`workOrderLines(rows: Array<{ ticketNumber: string; url: string | null }>): string[]`)
- Test: `src/lib/repairWorkorderLink.test.js`

For the worker's `worker_assignments` today with `repair_ticket_id` not null (join `repair_tickets(ticket_number, status)`, skip `declined`/`done`), issue one token each (24 h, `action_type 'repair_workorder'`, `repair_ticket_id`) and append `['', '📄 ใบงานซ่อม RPxxxx: <APP_URL>/w/<token>']` lines (a failed insert → `📄 ใบงานซ่อม RPxxxx: เปิดไม่ได้ตอนนี้ ลองใหม่`). Reply only (no push).

- [ ] Steps: helper tests, implement, deno check `line-webhook`, commit.

### Task 9: Release 1.41.0

**Files:** `package.json`, `package-lock.json` (`npm version 1.41.0 --no-git-tag-version`), `src/changelog.json`, `public/manual/index.html` (repair section: new subsection "1.2 ใบงานซ่อมและลายเซ็นลูกค้า (ตั้งแต่ 1.41.0)" — 3 buttons, crew link in งานวันนี้, sign-later link, pushes-off note).

- [ ] Full `npx vitest run` green (needs worktree `.env`), commit `chore(release): 1.41.0 …`.

## Deploy order (controller, after owner OK)
migration -03 (dry run first) → `repair-workorder` (`--no-verify-jwt`) → `sign-link` → web 1.41.0 (check build-info) → `line-webhook` last.
