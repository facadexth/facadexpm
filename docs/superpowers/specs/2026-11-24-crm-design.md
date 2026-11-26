# CRM: repair form, repair work order, customer reviews — design, 2026-11-24

Branch `feat/crm` (worktree `.claude/worktrees/crm`, from origin/main 9ce5aa33 / v1.38.2).
This builds on the live repair module (`2026-10-20-repair-tickets-design.md`, v1.26.0) and on customer LINE service (`2026-10-19-customer-line-service-design.md`).

Mockups (owner approved, with decisions written in them):
- E repair form: https://claude.ai/artifact/3VWucQKx39dGLWgV7TpAdA
- F repair work order: https://claude.ai/artifact/4UHzP5QXUmi8LEZ9bifFbq
- A/B reviews + warranty: https://claude.ai/artifact/3Dtnz7C6C9spotvwhdmPTv

## Build order

| Phase | What | Why this order |
|---|---|---|
| 1 | **E** repair form in LINE (items table) | Owner's newest request; A/B reuse its item table |
| 2 | **F** repair work order (A4 + crew link) + out-of-warranty quotation | Needs E's items |
| 3 | **A** review after handover + bonus + +3 months warranty | Independent of repair, larger |
| 4 | **B** review ↔ repair link | Needs A + E |
| 5 | **C** repair leftovers | Small, can ride along with any phase |
| later | **D** transfer a site to the homeowner | Spec section already on branch (commit 2676755d) |

Each phase ships on its own version bump. Each phase needs its own implementation plan. This document is the shared design.

---

## Owner decisions (all phases)

### E — repair form
- In customer OA @facadex, tapping **แจ้งซ่อม** replies with a link to a **form page** (no login).
- If the customer has several sites, they pick the site on the first screen of the form.
- **Per item:**
  - location: chips (ห้องนอน / ห้องนั่งเล่น / ครัว / ห้องน้ำ / ระเบียง / ภายนอก / อื่นๆ) + a free-text room
  - symptom: chips (รั่วซึม / เปิดปิดยาก / กระจกร้าว-แตก / ซีลยางหลุด / มือจับ-กลอนเสีย / อื่นๆ) + a note
  - **≥1 photo is required**; video ≤30 s is allowed (camera or gallery)
  - press **ยืนยันรายการนี้**
- **Loop:** "+ เพิ่มรายการ" until done, then a **summary table** (edit/delete per row).
- **Confirm screen:** the customer picks **up to 3 preferred days** and a slot (เช้า / บ่าย / ทั้งวัน). These are **wishes only**. The team must confirm in the web app before they become the appointment.
- Send → **one** ticket with an item table. Then a LINE reply: "รับเรื่องแล้ว RPxxxx-nnn".
- The old chat flow (30-minute window + "ส่งครบแล้ว") **stays** as a fallback.

### F — repair work order
- An A4 PDF "ใบงานซ่อม" containing:
  - header, ticket number
  - site address + map QR, appointment, crew, PM
  - warranty badge (in warranty / ⚠️ นอกประกัน)
  - safety note
  - item table with the customer's photos, an empty after-photo box and result ticks
  - materials (prefilled from withdrawals for that ticket)
  - crew notes
  - 3 signatures
- **Signatures:** both paper signature lines AND on-screen signing (reuse `SignaturePad` + `document_receipts`).
  - Owner decided 2026-11-25: main path = customer signs on the CREW's phone in `/w/:token` (crew taps "ให้ลูกค้าเซ็นรับงาน", hands phone over); signer name + time stored; signature attached to the before/after report sent to the customer. Fallback button "ส่งลิงก์ให้ลูกค้าเซ็นทีหลัง" sends a customer_link_tokens link via the customer OA for when the customer is not on site.
- **Crew get it in LINE:** in the crew OA, "งานวันนี้" shows a **📄 ดูใบงานซ่อม** link on repair jobs. The link opens without login.
- **Out of warranty → quotation first, every time.**
  - The ticket shows a **📝 ทำใบเสนอราคา** button.
  - The button opens the **normal** quotation form prefilled with: client, site, one line per repair item, and the note "อ้างอิง RPxxxx-nnn".
  - The quotation is linked to the ticket. After that the normal flow runs (send → approve → invoice → receipt).
  - **Scheduling is blocked until that quotation is `accepted`.** This is my default; the owner did not object.

### A — review after handover
- 1–2 days after `sites.handover_date`, the **PM presses a button** to send the review request (not automatic).
- The customer gives ⭐1–5 in LINE. Then:
  - **⭐4–5:** sub-scores + testimonial in the form page.
    - The PDPA consent box is unticked by default.
    - The customer chooses how their name is displayed.
  - **⭐1–3:** alert the owner. The score is **held** until the **owner** reviews the cause.
- **+3 months warranty:**
  - The customer earns it when they **type a comment AND attach ≥1 photo**, at **any** star score.
  - It covers **install work only**, not parts under the manufacturer's warranty.
- **Effect on staff (option 2):**
  - **Bonus:** ฿1,500 per 5★ job, split between crew by check-in days. The PM gets ฿300 separately.
  - The bonus lands in the next payroll as an item the **owner approves**.
  - **Annual evaluation:** weights 30/50/20.
  - **No deductions, ever.**
  - All numbers are tenant settings.
- **Visibility (B1):** **only admin/owner** see scores and customer comments.
  - Crew and PM see nothing: no praise push and no "my score" view.
  - The payslip shows one line **"โบนัสคุณภาพงาน"**, with no stars and no text.

### B — review ↔ repair
- **⭐1–2 always opens a repair ticket.** ⭐3 opens one only if the customer ticks **"งานไม่เรียบร้อย"**. This is my default; the owner did not object.
  - The ticket is `pending_review` with the badge "จากรีวิว".
  - The review text and photos are copied in as the customer's media.
- **The done-report Flex** gets 3 rating buttons (😞 / 🙂 / 😍), one press each.
  - 😞 puts the ticket back to `received` with a 🔁 mark and an owner cause review.
- **The repair score counts for the repair crew,** via `worker_assignments.repair_ticket_id`.
  - It is **only visible to admin/owner**.
  - **No repair bonus** (B2).
- **Warranty:** base months and review bonus months are stored separately.
  - warranty end = handover_date + warranty_months + warranty_bonus_months.

### C — repair leftovers
- **R31:** keep blocking a close without an after photo, but explain what to do.
- **R4:** keep one button.
- **Staff-opened tickets ALWAYS notify the customer.** This only works when that site's client has a linked LINE (`customer_line_accounts`). With no link, the app shows "ลูกค้ายังไม่ผูก LINE — แจ้งเองทางโทรศัพท์".
- Still owed: the owner's live LINE test of the whole repair flow. LINE pushes are off globally (`LINE_PUSH_ENABLED=false`) and must be switched on for the test.

---

### Principle — one record, two views (owner, 2026-11-26)
- The company's process and what the customer sees come from the **same records** (Kanban cards = `phase_tasks`, PM-entered qty/%, repair items). Nothing is typed separately for customers.
- The customer view is a **filtered projection**: phase/floor/% level, only data the **PM has confirmed** (PM-entered qty and %, cards PM-checked), photos the PM picked.
- **Customers never see site problems** (issue cards / แจ้งปัญหา), crew names, shifts, check-ins, crew notes, costs or material shortages. (Owner: "ไม่เห็น".)
- **Customers open their progress themselves in LINE** (customer OA menu), any time — not a PM push, not a weekly push. (Owner: "เปิดดูผ่าน line".)

### G — crew daily job sheet for installation (mockup https://claude.ai/artifact/SYenKGv2znFJE4Br11deXc v2)
- No new batch booking: Assign already books several days at once. Consecutive days a worker is booked at the same site = one "รอบ"; the sheet shows "วันที่ 3/5".
- Daily link from crew "งานวันนี้" (`/j/<token>`), valid to end of the Bangkok day, only for crew booked at that site today.
- Items are the site's Kanban cards (open cards; the worker's own cards first, badge "ของคุณ"; issue cards grouped on top for crew only). Crew can mark a card done or "ยังทำต่อพรุ่งนี้" with photos + note — same effect as LINE "งานเสร็จ". **Crew never enter quantities**; qty/% stay PM-only in the web (owner decision 2026-10-17).
- Owner answers 2026-11-26:
  1. On the crew sheet only the **team leader** of that day's shift may close or update a card (other crew view only). Admin/owner keep doing it in the web Kanban as today.
  2. **At least 1 photo** to close or update a card.
  3. Safety note = a company-wide default text (tenant setting) that each site can override.
  4. An **A4 PDF** of the day's sheet is needed (staff download; same layout family as ใบงานซ่อม). Mockup before build.

### H — customer progress in LINE (later)
- Customer OA menu → a no-login progress page for their site(s) built from the PM-confirmed data only (per the principle above). No issue cards. Design + mockup before build.

## Data changes

New migrations, prefix `2026-11-2x-NN-…`. Each one gets a `.dryrun.sql` (BEGIN…ROLLBACK) first.

### Phase 1 (E)
- **`repair_ticket_items`**
  - `id`, `tenant_id`, `ticket_id → repair_tickets ON DELETE CASCADE`, `seq int`
  - `location text`, `room text`, `symptom text`, `note text`
  - `result text NULL CHECK (result IN ('fixed','partial','not_fixed'))`, `result_note`
  - `created_at`
  - RLS: same admin policies as `repair_tickets`.
- **`repair_ticket_media.item_id uuid NULL → repair_ticket_items ON DELETE SET NULL`**
  - Customer photos belong to an item.
  - Staff before/after photos may belong to an item or to the whole ticket.
- **`repair_tickets` add:**
  - `preferred_days date[]` (≤3)
  - `preferred_slot text CHECK IN ('morning','afternoon','all_day')`
- **`customer_link_tokens`** (new, because `line_deep_link_tokens.worker_id` is NOT NULL and only for crew):
  - `id`, `tenant_id`, `client_id`, `line_user_id`, `purpose CHECK IN ('repair_form','review')`
  - `token unique`, `ref_id uuid NULL`, `expires_at`, `used_at`, `created_at`
  - Validity: 24 h. The token is claimed atomically on submit (lesson 2026-10-18), so a second send fails cleanly.
  - RLS: admin read only. All other access goes through the edge function with the service role.
- **Storage:** reuse the existing repair media bucket and its paths.
- **Check:** any view built on `repair_tickets.*` must be recreated (lesson: a view's `x.*` column list freezes when the view is created).

### Phase 2 (F)
- **`repair_tickets.quotation_id uuid NULL → quotations ON DELETE SET NULL`**
- **`schedule_repair_ticket` RPC:** refuse with a clear message when the ticket is out of warranty and its quotation is missing or not `accepted`.
  - Out of warranty means: today > handover_date + (warranty_months + warranty_bonus_months) months.
  - Before phase 3 adds `warranty_bonus_months`, treat it as 0.
- **`line_deep_link_tokens.action_type`:**
  - add `'repair_workorder'`
  - add a `ref_id uuid NULL` column (the ticket)
  - the token is read-only and stays valid until the end of the appointment day
- **`document_receipts`:** extend the allowed document type with `'repair_ticket'` (pattern of `2026-09-02-06`).

### Phase 3 (A)
- **`sites.warranty_bonus_months int NOT NULL DEFAULT 0`**
  - Update everything that computes warranty end: the LINE status card, the repair warranty badge, `pending_counts` warranty_followup, and the retention due date.
  - Copy each of these from the LIVE definition before changing it.
- **`site_reviews`**
  - `id`, `tenant_id`, `site_id`, `client_id`, `line_user_id`
  - `stars 1–5`, `sub_scores jsonb` (courtesy / quality / punctuality)
  - `comment`, `bad_work bool`
  - `consent_publish bool`, `display_name_mode`
  - `status CHECK IN ('held','counted','excluded')`
  - `owner_note`, `reviewed_by`, `reviewed_at`
  - `warranty_granted bool`, `repair_ticket_id NULL`
  - `requested_at`, `submitted_at`
- **`site_review_media`:** photos, same shape as `repair_ticket_media`.
- **`review_bonus_lines`**
  - `review_id`, `worker_id`, `role ('crew','pm')`, `checkin_days`, `amount`
  - `payroll_period_id NULL`, `approved_at`
- **pay item:** a system `pay_items` row with `system_key 'review_bonus'` and display name "โบนัสคุณภาพงาน". Add it to `seed_default_pay_items` and backfill existing tenants.
- **Tenant settings** (app settings):
  - `review_bonus_amount` 1500
  - `review_bonus_pm` 300
  - `review_warranty_bonus_months` 3
  - `annual_review_weights` 30/50/20
- **RLS:** `site_reviews`, `site_review_media` and `review_bonus_lines` are **admin/owner only**. No worker-facing policy and no worker RPC.

### Phase 4 (B)
- **`repair_tickets.origin text NULL CHECK IN ('review')`**, plus `review_id`.
- **`repair_ticket_ratings`**
  - `ticket_id`, `score CHECK IN (1,2,3)`, `rated_at`, `line_user_id`
  - unique per ticket per "round": a re-done ticket can be rated again. Field: `round int`.
- **`repair_tickets.redo_count int DEFAULT 0`** for the 🔁 mark.

---

## Components

### Edge functions
- **`customer-line-webhook` / `_shared/customer-line-handler.ts`**
  - แจ้งซ่อม → create a `customer_link_tokens` row → reply with a Flex card holding the link button.
  - The old chat flow stays reachable via "แจ้งทางแชท".
  - Reply only, never push (replies don't use quota).
- **New `customer-form` function** (same pattern as `field-form`):
  - `GET` → sites list + a token check
  - `POST upload` → signed upload URL per file
  - `POST submit` → ticket + items + media in one RPC `submit_repair_form(token, payload)`, SECURITY DEFINER, service role only
  - Phase 3 adds review submit.
- **`line-webhook` `handleTodaysJobMenu`:** for an assignment with `repair_ticket_id`, add a 📄 ดูใบงานซ่อม button with a `repair_workorder` token link.
- **`field-form`** (or a new `workorder` function): `GET` work order data by token, read-only. Signing posts to `document_receipts`.
- **`repair-push`:**
  - the done-report Flex gets 3 postback buttons (phase 4)
  - a staff-opened ticket push (phase 5)
  - a review request push (phase 3, PM button; this counts against the daily push cap)

### Web app
- **`/r/:token`** customer form page: mobile-first, no app shell. It follows the E mockup screens site → item → list → confirm → done.
  - Client-side image downscale before upload.
  - Video ≤30 s is checked by duration before upload.
- **`RepairTicketModal`:**
  - item table: per-item result tick + after photo
  - the customer's preferred days shown above the schedule form, which is prefilled from the first preferred day
  - warranty badge; when out of warranty, the 📝 ทำใบเสนอราคา button and the linked quotation's status
  - 🖨 ใบงานซ่อม export (html2pdf, A4, same helper as the other exports, Buddhist-year dates)
- **`Quotations.jsx`:** a new prefill entry.
  - `navigate('/quotations', { state: { prefill: { client_id, site_id, items, notes, repair_ticket_id } } })`
  - becomes `initial = editFormInitial || dupInitial || prefillInitial || newQuotationInitial`
  - after save, write `repair_tickets.quotation_id`
- **`/w/:token`** crew work-order page: the same layout as the PDF, plus a sign button (`SignaturePad`).
- **Phase 3:** PM button "ส่งขอรีวิว" on the site; an admin/owner review inbox (held reviews, owner cause review); the team score page (admin/owner only); bonus lines feeding payroll.

---

## Error handling and edge cases
- **Expired or used token** → a friendly page: "ลิงก์หมดอายุ กดแจ้งซ่อมใน LINE อีกครั้ง".
- **Upload fails midway** → the item stays as a draft in browser storage (per viewer only) so the customer can retry. Nothing is written to the DB until submit.
- **Customer with no linked site** → the form says to contact the company; no ticket is created.
- **Out-of-warranty check** uses the Bangkok date.
- **Push switch off** → every push path logs and skips, as today. Replies still work.

## Testing
- **vitest:**
  - warranty end / out-of-warranty calculation (incl. bonus months, month-end)
  - bonus split by check-in days (rounding: the remainder goes to the team leader)
  - ⭐ → ticket rule
  - preferred-days validation
  - quotation prefill mapping
- **SQL dry runs** (BEGIN…ROLLBACK) for every migration and RPC, including a real UPDATE under RLS. These are written by subagents and run by me.
- **Live:**
  - dev server + Chrome walkthrough of the form on a phone-width window
  - one real LINE run with pushes switched on (owner)

## Not in scope
- Showing scores to crew in any form (B1).
- A repair bonus (B2).
- Automatic review sending (the PM button only).
- Wage deductions.
- D (site transfer): later, its own spec section.
