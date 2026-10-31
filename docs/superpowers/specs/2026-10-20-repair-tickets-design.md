# Repair tickets (งานซ่อม) — design, 2026-10-20

This is Phase 4 of `2026-10-19-customer-line-service-design.md`. Mockup: https://claude.ai/artifact/KUmuM4Env22zgk7ypm6c5u, boards 12–15.

## Owner decisions
- **Where repairs live.** Repairs get a new **main tab "🔧 งานซ่อม"**. It is one Kanban board covering all sites, with columns: รอพิจารณา / รับเรื่อง / นัดเข้า / กำลังซ่อม / เสร็จ.
- **The site stays Completed** the whole time. A ticket never changes the site status and never uses an Ongoing package slot.
- **Customer reports a problem from LINE.** The customer taps แจ้งซ่อม and sends text, photos, video and PDF.
  - If the customer has several sites, the bot first asks which site.
  - Everything sent within **30 minutes**, or until the customer taps **"ส่งครบแล้ว"**, becomes **one** ticket.
  - The files are **stored in CHANG**.
- **The bell** shows a new item "งานซ่อมรอพิจารณา". It opens the board, where staff decide **เปิดงานซ่อม** or **ไม่รับ**.
  - **ไม่รับ:** staff tell the customer themselves. The bot sends nothing.
- **Scheduling.** Staff set date, start time, duration and crew.
  - **Saving pushes a LINE message** to the customer with the appointment.
  - **A reminder push goes out at 13:00 the day before.**
- **Closing.** When the work is done, staff upload photos and the fix note, then mark it done. This **pushes a report card with before and after photos**.
  - Before = the customer's photos plus any "before" photos taken by the crew.
  - After = the "after" photos.
- **Costs count toward the ORIGINAL site:**
  - crew days, through worker_assignments on that site;
  - materials and expenses, using the site's id.
- **"สถานะแจ้งซ่อม" in LINE** returns a Flex card per ticket with a stepper (รับเรื่อง → นัดเข้า → กำลังซ่อม → เสร็จ), the appointment and the warranty state.
- **Staff can open a ticket themselves** ("+ เปิดงานซ่อมเอง") for internal touch-ups.

## Data
- **`repair_tickets`**
  - `id`, `tenant_id`
  - `ticket_number` (RPYYMM-nnn, per tenant)
  - `site_id NOT NULL`, `client_id`
  - `source` ('line'|'staff'), `line_user_id`
  - `status` ('pending_review','received','scheduled','in_progress','done','declined')
  - `description`
  - `scheduled_date`, `scheduled_start time`, `duration_hours numeric`
  - `fix_note`
  - timestamps: `received_at`, `scheduled_at`, `started_at`, `done_at`, `declined_at`
  - push markers: `notified_schedule_at`, `reminded_at`, `reported_at`
  - `created_by`, `created_at`, `updated_at`
- **`repair_ticket_media`**
  - `id`, `tenant_id`, `ticket_id`
  - `role` ('customer'|'before'|'after')
  - `media_type` ('image'|'video'|'file')
  - `storage_path`, `file_name`, `mime`, `size_bytes`, `created_at`
  - Files go in the new private bucket `repair-media`, under `{tenant}/{ticket}/…`. Storage RLS uses tenant-folder access, like the other buckets.
- **`customer_line_repair_sessions`** (`tenant_id`, `line_user_id`, `ticket_id`, `expires_at`). One open session per LINE user. It holds the 30-minute window.
- **`worker_assignments.repair_ticket_id`** (nullable FK). Crew assignments created from a ticket are ordinary `type='site'` rows on the ticket's site. Check-in, payroll and labour cost therefore work unchanged, and the cost lands on the original site.
- **`pending_counts()`** gains `repair_pending`, the count of tickets with status `pending_review`, for admin/owner.
- **Customer push.**
  - It uses the tenant's own OA token. It does NOT go through the crew `LINE_PUSH_ENABLED` switch.
  - It is gated by a per-tenant setting, "ส่งไลน์แจ้งลูกค้าอัตโนมัติ" (default ON, since the owner wants these pushes).
  - It is limited by its own daily budget: a separate counter from the crew push budget, default 100 per day per tenant.
- **Reminder cron.** pg_cron at 06:00 UTC (13:00 Bangkok) calls an edge function, authenticated with the existing vault cron secret. The function selects tickets with `status='scheduled'`, `scheduled_date` = tomorrow (Bangkok), and `reminded_at` null.

## Unblockers in existing code (from recon)
- The Assign page and field-form show **Ongoing sites only**. A ticket's assignments are created from the ticket detail, not from the Assign grid. The field-form material-request site list must also include sites that have a ticket scheduled or in progress for today.
- The customer bot currently ignores non-text messages. Image, video and file messages must be handled while a repair session is open.
- Doc-number triggers rely on RLS for tenant scoping. The RP generator must filter `tenant_id = NEW.tenant_id` explicitly, because LINE-created tickets are inserted with the service role.

## Out of scope
- Billing for out-of-warranty repairs; staff quote the usual way.
- Transferring a site to the homeowner. This is designed separately and comes later.
- Customer ratings.

## Anti-goals (unchanged from the parent spec)
- A ticket changes the site status, or uses a slot.
- The customer sees money, workers' names, costs or internal notes. The report shows only description, fix note, dates and photos.
- One tenant sees another tenant's tickets or media.
- A push is sent while the tenant switch is off, or beyond the budget.
