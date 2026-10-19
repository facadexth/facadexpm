# Site warranty, handover and warranty follow-up (design, 2026-10-19)

This is Phase 3 of `2026-10-19-customer-line-service-design.md` (handover and warranty), brought forward at the owner's request. Mockup: https://claude.ai/artifact/KUmuM4Env22zgk7ypm6c5u, boards 8–10.

## Owner decisions (2026-10-19)
- **Where it is set:** the warranty period is set in the **site edit form** (create and edit). It can be changed later. Default **12 months** (1 year).
- **จบไซท์งาน (finish site):** the dialog shows the site's warranty period, which can be edited there. It also asks for the **handover date**, default today. Finishing sets status Completed, `end_date = handover_date`, and the warranty.
- **Backfill:** every site that is already Completed gets `handover_date = end_date`. If `end_date` is NULL, it gets **2025-10-14** (14 ต.ค. 2568). `warranty_months` = 12.
- **Reminder:** **1 month (30 days) before the warranty ends**, staff are reminded to contact the customer and ask whether there are any problems.
  - It shows as a bell item for owner/admin and as a list with a copyable message and a "ทักแล้ว" button.
  - Nothing is pushed to the customer automatically, so no LINE quota is used.
- **Retention (เงินประกันผลงาน):** the retention due date **is** the warranty end date.
  - The separate "ระยะเวลา retention (วัน)" field leaves the form. The column stays in the DB but is no longer used.
  - The follow-up list shows the unreleased retention amount, so one contact covers both "any problems?" and returning the retention.
- **Customer LINE "ประกันของฉัน":** the bot now gives the real warranty status per site.

## Rules
- Warranty end = `handover_date + warranty_months months`, with Postgres calendar-month semantics: 31 Jan + 1 month = 28/29 Feb. The JS helper must match this.
- Status per site:
  - `ยังไม่ส่งมอบ` when there is no handover date.
  - `ในประกัน (ถึง dd/mm/yyyy)` when today ≤ end.
  - `หมดประกัน` when today > end.
- Follow-up is due when status is Completed, the warranty end is between today and today + 30 days, and `warranty_followup_at` is NULL.
  - When `handover_date` or `warranty_months` changes, `warranty_followup_at` resets to NULL, so the new end date gets its own reminder.
- Out of scope: repair tickets (Phase 4), automatic customer push, the labor-contractor retention system (`labor_contracts`).
- The usual constraints from the parent spec still hold:
  - Multi-tenant and RLS.
  - Thai UI.
  - Migrations get a BEGIN…ROLLBACK dry run first.
  - Subagents make no DB calls.
  - The owner approves every apply and deploy.
