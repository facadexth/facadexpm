# Delivery Report (DR) Implementation Plan — Plan B

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From any invoice, build a signed รายงานส่งงาน (DR+YYMM-NNN): a detailed delivered-before / this-งวด / remaining table, marked-up site plans, card photo blocks and a customer signature (paper, this device, or remote link).

**Architecture:** New tables `delivery_reports`, `delivery_report_cards`, `site_plans`, `site_plan_marks`. Pure maths in `src/lib/deliveryReport.js`; one data hook; UI split into a picker (editor), a plan-markup editor and an A4 document under `src/pages/invoices/delivery/`. Signing reuses `document_receipts`, `DocumentReceiptModal`, `SignLinkModal` and the `sign-link` edge function with a new document type `delivery_report`.

**Tech Stack:** React 18 + Vite, Supabase (Postgres, RLS, Storage, Deno edge functions), vitest + @testing-library/react (jsdom), existing `src/lib/pdf.js` (`downloadPDF`), `src/lib/photoUpload.js` (`uploadSitePhoto`).

**Spec:** `docs/superpowers/specs/2026-10-22-delivery-report-design.md` (decisions 3, 4, 8–12). Mockup v10: https://claude.ai/artifact/UQq1GCTo9XbBVtMVJMMboD — layout and Thai copy come from the mockup.

## Global Constraints

- Report number `DR` + YYMM of the report's `date` + `-` + 3-digit sequence, per tenant (pattern of `generate_invoice_number`, scoped `WHERE tenant_id = NEW.tenant_id`). Unique `(tenant_id, report_number)`.
- One DR belongs to one invoice; an invoice may have several DRs, only the newest non-void one is "current".
- Signed report = locked (no UPDATE of content; RLS + trigger). Editing a signed report creates a new DR with `replaces_id` = old id; old gets `status = 'replaced'`.
- Weight is % of price. Row value = qty × unit price × weight% / 100, round to 2 decimals (satang).
- Cards with no BOQ appear with weight 0 and value 0 (spec 4).
- Plan colours: delivered before `#16a34a` (green), this งวด `#f97316` (orange), remaining `#9ca3af` (grey).
- Plan file: image (jpg/png/webp) or ONE-page PDF; multi-page PDF is rejected with "รองรับ PDF หน้าเดียว".
- Remote link expiry 7 days (`expires_at = now() + interval '7 days'`).
- Migrations: dry-run in BEGIN…ROLLBACK by the controller only; subagents never call the DB. Any SQL text containing the word DELETE must be built as `'DEL'||'ETE'` inside EXECUTE (MCP rejects it).
- Every new table: `tenant_id uuid NOT NULL DEFAULT current_tenant_id()`, RLS `admin_full_access` written like `invoice_item_phases` (wrapped `( SELECT … )` calls, `has_module_access('invoices')`), `REVOKE ALL … FROM anon`.
- Version 1.32.0 + changelog entry + manual section before deploy.
- Worktree needs `.env` copied from `../feat-dashboard-v2/.env` for tests.

## Review Focus

1. Invoice made in easy/advanced mode (no `invoice_item_phases` rows) — report must still build: phases inferred from BOQ splits whose cards show done, value split by weight; a line with no BOQ shows as a single row with its invoice amount. (Task 2 test `legacy invoice without phase rows`.)
2. Second and third งวด — "delivered before" must count only earlier non-void invoices of the same quotation, by invoice date then number, never the current one or later ones. (Task 2 test `prev excludes current and later invoices`.)
3. Card deleted or photo removed after the report was saved — document renders with "(การ์ดถูกลบ)" and skips missing photos, no crash. (Task 6 test.)
4. Remote link opened after the report was replaced — sign-link returns `replaced` and the page says "รายงานนี้ถูกแทนด้วยฉบับใหม่". (Task 7 test.)
5. Plan image of any aspect ratio / phone photo with EXIF rotation — marks stored as 0–1 fractions of the displayed image, so they line up on screen and in print. (Task 5 test `marks survive resize`.)

---

### Task 1: Schema migration

**Files:**
- Create: `supabase/migrations/2026-10-23-01-delivery-reports.sql`
- Create: `supabase/migrations/2026-10-23-01-delivery-reports.dryrun.sql` (BEGIN … tests … ROLLBACK, for the controller)

**Interfaces:**
- Produces tables:
  - `delivery_reports(id uuid pk, tenant_id, invoice_id uuid not null → invoices on delete cascade, site_id uuid not null → sites, report_number text, date date not null default (now() at time zone 'Asia/Bangkok')::date, status text not null default 'draft' check in ('draft','issued','signed','replaced','void'), replaces_id uuid null → delivery_reports, phase_ids uuid[] not null default '{}', note text, signed_receipt_id uuid null → document_receipts, signed_at timestamptz, signed_seen_at timestamptz, created_by uuid default auth.uid(), created_at timestamptz default now())`
  - `delivery_report_cards(id, tenant_id, report_id → delivery_reports cascade, task_id uuid null → phase_tasks on delete set null, card_title text not null, photo_ids uuid[] not null default '{}', caption text, sort_order int not null default 0)` — `card_title` snapshot so a deleted card still prints.
  - `site_plans(id, tenant_id, site_id → sites cascade, title text not null, file_path text not null, mime text not null, width int, height int, sort_order int default 0, created_at)`
  - `site_plan_marks(id, tenant_id, plan_id → site_plans cascade, task_id uuid null → phase_tasks on delete set null, kind text check in ('rect','pin'), x numeric, y numeric, w numeric, h numeric, label text)` — x/y/w/h are 0–1 fractions (CHECK between 0 and 1).
  - trigger `trg_delivery_report_number` BEFORE INSERT → `generate_delivery_report_number()`.
  - trigger `trg_delivery_report_locked` BEFORE UPDATE OR DELETE on `delivery_reports` and `delivery_report_cards`: when the (parent) report has `status = 'signed'`, allow only the update that sets `status = 'replaced'`; otherwise RAISE 'รายงานที่เซ็นแล้วแก้ไม่ได้ กรุณาออกฉบับใหม่'.
  - widen both `document_type` CHECKs on `document_receipts` and `document_receipt_links` to include `'delivery_report'`.
  - storage bucket `site-plans` (private), policies mirroring `invoice-photos` (path first segment = tenant id).
  - `pending_counts()` gains key `delivery_report_signed` = count of reports with `status='signed' AND signed_seen_at IS NULL` for the tenant. Copy the latest body from `2026-10-04-03-pending-counts-no-invoices.sql` and add one key; keep every other key identical.

- [ ] **Step 1: Write the dry-run script** — wraps the migration body, then asserts: (a) two inserts in October 2026 for one tenant get `DR2610-001`, `DR2610-002`; another tenant gets `DR2610-001`; (b) setting a report `signed` then updating `note` raises the lock message; updating `status='replaced'` succeeds; (c) `site_plan_marks` insert with `x = 1.2` fails; (d) `pending_counts()` contains key `delivery_report_signed`. End with `ROLLBACK`.
- [ ] **Step 2: Write the migration** (idempotent: `IF NOT EXISTS`, `to_regclass` guards like `2026-10-22-02-invoice-progress-mode.sql`; `ON DELETE` clauses through `format(... 'DEL'||'ETE')`).
- [ ] **Step 3: Hand both files to the controller.** The controller runs the dry-run on CHANG and reports. Do NOT apply. Expected: every assertion passes, final ROLLBACK.
- [ ] **Step 4: Commit** `feat(dr): delivery report schema`.

### Task 2: Report maths `src/lib/deliveryReport.js`

**Files:**
- Create: `src/lib/deliveryReport.js`, `src/lib/deliveryReport.test.js`

**Interfaces:**
- Consumes: `phaseWeight`, `doneQty`, `checkLine` from `src/lib/progressBilling.js`.
- Produces:
  - `buildReportRows({ invoice, invoiceItems, itemPhases, earlierItems, earlierItemPhases, boqByQuotationItem, splitsByBoq, phases, cards }) → { rows: Row[], totals: { contract, prev, this, remaining, pctDone } }`
    - `Row = { key, boqCode, description, phaseId, phaseName, unit, qty, unitPrice, weightPct, value, prev, this, remaining, check: 'ok'|'warn'|'block', reasons: string[] }`
    - `value` = BOQ planned qty × unit price × weight / 100 (contract value of that line-phase); `this` = this invoice's amount for that line-phase; `prev` = sum over `earlierItems`; `remaining = value − prev − this` (never below 0; if negative, set 0 and add reason `over_billed`).
    - Invoice with `itemPhases` → one row per phase row. Invoice without them (easy/advanced/legacy) → split the item's `line_total` across the BOQ phases whose cards show done > 0, in proportion to their weight; no BOQ → one row, `phaseId = null`, `weightPct = null`, `value = line_total`.
    - `earlierItems` = items of invoices on the same quotation, status ≠ 'void', ordered before this one by `(date, invoice_number)`. Filtering is the hook's job; this function trusts its input.
  - `markColour(taskId, { prevTaskIds: Set, thisTaskIds: Set }) → '#16a34a'|'#f97316'|'#9ca3af'` (this wins over prev).
  - `nextReportStatusOnEdit(report) → 'edit-in-place' | 'reissue'` ('reissue' when status is 'signed').

- [ ] **Step 1: Tests** in `deliveryReport.test.js`:
  - `progress invoice`: BOQ A 26 ตร.ม. @ 500, splits ผลิต 20 / ติดตั้ง 80, this invoice phase row ผลิต qty 26 amount 2600 → row ผลิต `{ value: 2600, prev: 0, this: 2600, remaining: 0 }`, row ติดตั้ง absent from this-invoice rows but present with `value 10400, this 0, remaining 10400`; `totals.contract = 13000`, `pctDone = 20`.
  - `legacy invoice without phase rows`: same BOQ, easy invoice item line_total 13000, cards done in both phases → ผลิต this 2600, ติดตั้ง this 10400.
  - `no-BOQ line`: item line_total 5000, no BOQ → one row `phaseId null, value 5000, this 5000, remaining 0`.
  - `prev excludes current and later invoices`: earlierItems with 2600 for ผลิต → second invoice row ผลิต `prev 2600, this 0`.
  - `over-billed`: prev 2600 + this 100 on value 2600 → `remaining 0`, reasons include `over_billed`.
  - `satang`: 3 phases 33.33/33.33/33.34 on 1000 → values sum exactly to 1000.00 (put the remainder on the last phase).
  - `markColour` three cases; `nextReportStatusOnEdit` signed vs issued.
- [ ] **Step 2:** `npx vitest run src/lib/deliveryReport.test.js` → FAIL (module missing).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5: Commit** `feat(dr): report maths`.

### Task 3: Data hook `src/hooks/useDeliveryReport.js`

**Files:**
- Create: `src/hooks/useDeliveryReport.js`, `src/hooks/useDeliveryReport.test.js`

**Interfaces:**
- Consumes: `useProgressBillingData(siteId, quotationId)` (Plan A) for BOQ, splits, phases, cards; `buildReportRows` (Task 2).
- Produces:
  - `useDeliveryReport(invoiceId) → { data: { invoice, reports, current, rows, totals, cards, photosByTask, plans, marksByPlan }, loading, error, refetch }` — `current` = newest report with status not in ('replaced','void').
  - `saveDeliveryReport({ reportId|null, invoiceId, siteId, phaseIds, note, cards: [{ taskId, cardTitle, photoIds, caption }] }) → report` — insert or update; replaces all `delivery_report_cards` of the report (delete-then-insert in that order; on insert error throw).
  - `reissueDeliveryReport(oldReport, draft) → newReport` — inserts new with `replaces_id`, then sets old `status='replaced'`.
  - `markDeliveryReportIssued(id)`, `markSignedSeen(id)`.
  - `uploadSitePlan({ siteId, tenantId, file }) → plan` (bucket `site-plans`, path `${tenantId}/${siteId}/${Date.now()}-${safeName}`; PDF: render page 1 to PNG with pdf.js already used by the app if present, else reject PDF with "รองรับเฉพาะรูปภาพ" — check `package.json` for `pdfjs-dist` first and say which in the report); `saveSitePlanMarks(planId, marks[])`.
- [ ] **Step 1: Tests** with a mocked `supabase` (pattern from `src/pages/Invoices.easyMode.test.jsx` mocks): `earlier invoices are filtered to same quotation, non-void, before this one` (feed 4 invoices, assert which ids reach `buildReportRows` via a spy); `saveDeliveryReport replaces cards`; `reissue marks old replaced after inserting new`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS.
- [ ] **Step 5: Commit** `feat(dr): data hook`.

### Task 4: Card picker `DeliveryReportEditor.jsx`

**Files:**
- Create: `src/pages/invoices/delivery/DeliveryReportEditor.jsx`, `…/DeliveryReportEditor.test.jsx`

**Interfaces:**
- Consumes: Task 3 hook + save functions; `uploadSitePhoto` from `src/lib/photoUpload.js` (pass `taskId` so the photo also lands on the card).
- Produces: `<DeliveryReportEditor invoiceId onClose onSaved />` (modal, `Modal` component as in Invoices.jsx).
- Behaviour (mockup v10 order): (1) phase-weight table — one row per phase with Σ weight and ☐ "ส่งงวดนี้", pre-ticked from the invoice's `invoice_item_phases` (or phases with cards done for legacy invoices); (2) cards filtered to ticked phases, grouped by phase, each with photo thumbnails to tick and a caption box; cards with no BOQ show badge "ไม่มี BOQ · 0%"; (3) "＋ รูป" per card → file input (multiple, image/*) → `uploadSitePhoto` → new photo ticked; (4) check summary: any row with `check !== 'ok'` listed with ⚠️ text before "บันทึก"; warnings never block. Save button text "บันทึกรายงาน".
- [ ] **Step 1: Tests:** `pre-ticks phases billed on the invoice`; `unticking a phase hides its cards`; `no-BOQ card shows ไม่มี BOQ · 0%`; `＋ รูป calls uploadSitePhoto with taskId and ticks the new photo`; `save sends phaseIds and ticked photoIds`.
- [ ] **Step 2–4:** fail → implement → pass (`npx vitest run src/pages/invoices/delivery`).
- [ ] **Step 5: Commit** `feat(dr): card picker`.

### Task 5: Site plans + markup `PlanMarkupEditor.jsx`

**Files:**
- Create: `src/pages/invoices/delivery/PlanMarkupEditor.jsx`, `…/PlanMarkup.jsx` (read-only SVG overlay used by editor and document), tests for both.

**Interfaces:**
- Consumes: `uploadSitePlan`, `saveSitePlanMarks` (Task 3), `markColour` (Task 2).
- Produces: `<PlanMarkup plan marks colourFor={(taskId) => string} />` — `<img>` with absolutely positioned `<svg viewBox="0 0 1 1" preserveAspectRatio="none">`; rect = translucent fill (opacity .35) + stroke; pin = circle with number label (index of its card in the report's card order, else "•").
- Editor: plan list for the site (reused every งวด — spec 9) + "＋ แบบแปลน"; tools "สี่เหลี่ยม" (drag) and "หมุด" (click); each new mark asks which card (select from report cards); delete mark; "บันทึก". Coordinates = pointer position ÷ the image's rendered `getBoundingClientRect()` size, clamped 0–1.
- [ ] **Step 1: Tests:** `marks survive resize` (render PlanMarkup at 400×300 and 800×600; the rect's SVG attributes are identical); `click with pin tool at (200,150) on 400×300 image stores x 0.5 y 0.5`; `colour follows colourFor`; `multi-page PDF rejected with รองรับ PDF หน้าเดียว` (only if PDF path is implemented in Task 3).
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** `feat(dr): site plans and markup`.

### Task 6: A4 document `DeliveryReportDocument.jsx`

**Files:**
- Create: `src/pages/invoices/delivery/DeliveryReportDocument.jsx` + test.

**Interfaces:**
- Consumes: Task 3 data, `PlanMarkup`, `usePaginatedDocument` / `PAGE_WIDTH_PX` / `PAGE_HEIGHT_PX` / `resolveDocumentStyle` (same imports Invoices.jsx uses), `downloadPDF`.
- Produces: `<DeliveryReportDocumentModal reportId onClose />` with menu "📄 บันทึกเป็น PDF", "🖨 พิมพ์", "✍️ ให้ลูกค้าเซ็น" (opens Task 7 chooser).
- Pages: header (company, "รายงานส่งงาน", DR number, `อ้างอิงใบแจ้งหนี้ <invoice_number>`, site, date; if `replaces_id`: "แทนฉบับ <old number>"); page 1 table columns รายการ · เฟส · หน่วย · ปริมาณ · ราคา/หน่วย · weight · มูลค่า · ส่งก่อนหน้า · งวดนี้ · คงเหลือ, totals row, "% ของสัญญา", 3-colour bar (green prev / orange this / grey remaining, widths from totals); page 2 plans; page 3+ one block per card (title, phase, up to 4 photos 2×2, caption; deleted card → title + "(การ์ดถูกลบ)"); last block signature: signer name, date, image from `document_receipts` or empty lines for paper.
- [ ] **Step 1: Tests:** `header shows DR and invoice number`; `bar widths match totals` (prev 20 / this 30 / remaining 50 → style widths "20%","30%","50%"); `deleted card prints (การ์ดถูกลบ) and no img`; `missing photo url is skipped`.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** `feat(dr): A4 document`.

### Task 7: Signing (paper / this device / remote link) + bell

**Files:**
- Create: `src/pages/invoices/delivery/SignChooser.jsx` + test
- Modify: `supabase/functions/sign-link/index.ts` (add `delivery_report` to `DOCUMENT_LOADERS`; after signing set `delivery_reports.status='signed', signed_at, signed_receipt_id`; refuse with `{ valid:false, reason:'replaced' }` when status is 'replaced' or 'void')
- Modify: the public sign page that renders loader output (find with `grep -rn "unsupported_document_type\|reason ===" src`) — add text for `replaced`: "รายงานนี้ถูกแทนด้วยฉบับใหม่"
- Modify: `src/lib/pendingItems.js` — entry `{ key: 'delivery_report_signed', label: 'ลูกค้าเซ็นรับงานแล้ว', tab: 'invoices' }` (copy shape of neighbours)

**Interfaces:**
- Consumes: `DocumentReceiptModal({ documentType:'delivery_report', documentId, tenantId, title, onClose, onSaved })`, `SignLinkModal({ documentType:'delivery_report', documentId, onClose })`.
- Three choices: "พิมพ์แล้วเซ็นบนกระดาษ" (print; optional "แนบรูปใบที่เซ็นแล้ว" upload → creates a `document_receipts` row with the photo as `signature_path`, signer name typed), "เซ็นบนเครื่องนี้" (DocumentReceiptModal), "ส่งลิงก์ให้ลูกค้า" (SignLinkModal; if the site's client has a linked customer LINE account, also offer "ส่งทาง LINE" — reuse the existing customer push helper if one exists, else copy-link only and note it in the report). Every path ends with the report `status='signed'` (local paths update it from the client after `onSaved`).
- [ ] **Step 1: Tests:** chooser renders 3 options; local `onSaved` calls update with `status:'signed'`; Deno test or pure-function test for the loader mapping (`replaced → reason replaced`) in the style of existing `supabase/functions/sign-link` tests if any, else extract `linkState(report)` to `_shared` and unit-test it.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** `feat(dr): signing paths and bell`. Edge function deploy is the controller's job after owner OK.

### Task 8: Wire into invoices + docs + version

**Files:**
- Modify: `src/pages/Invoices.jsx` — invoice row/action menu "📋 รายงานส่งงาน" (opens editor if no current report, else document); badge "ลูกค้าเซ็นรับงานแล้ว <date>" when current report signed; opening the invoices tab calls `markSignedSeen` for shown signed reports.
- Modify: `package.json` version `1.32.0`, `src/changelog.json` new top entry (Thai, plain), `public/manual/index.html` new section "รายงานส่งงาน" (steps: เลือกเฟส → เลือกการ์ดและรูป → วาดบนแบบแปลน → พิมพ์/เซ็น).
- [ ] **Step 1: Test** in `Invoices.easyMode.test.jsx` style: `invoice row shows รายงานส่งงาน action`; `signed badge shows date`.
- [ ] **Step 2–4:** fail → implement → pass. Full suite `npx vitest run` and `npm run build` pass.
- [ ] **Step 5: Commit** `feat(dr): invoice entry point, 1.32.0`.

## Controller steps after all tasks (not for subagents)

1. Dry-run Task 1 on CHANG, then ask owner → apply migration.
2. Deploy `sign-link` after owner OK.
3. Live test on SOAP OPERA: make DR for the test invoice, mark a plan, sign locally, then void.
4. Ask before merge/deploy of 1.32.0.
