# LINE Communication & Notifications — Design Spec

## Problem

FacadeX's only LINE touchpoint today is a "📋 คัดลอกสำหรับ LINE" button
that copies formatted text for someone to paste by hand — one-way, no
preview, no structure. The three-expert field review hit this gap from
two independent angles: the PM's bottom-line verdict was "my foremen
will stay on LINE" (the site-execution layer isn't usable enough to pull
them off it), and the ERP specialist separately called the copy button
"a manual shim, not real integration."

This reopens the "Internal comms" thread from the 2026-08-20 ConTech
roadmap memory (`contech-saas-expansion-roadmap`), which was explicitly
deferred until the PM system stabilized — it now has, after this
session's Gantt/Kanban/subtask work — **and extends it** with a second
track the memory didn't cover: office/back-office reminders. The
after-sales/customer-defect-management LINE OA thread from the same
memory stays deferred; nothing in the field review validated it as
urgent, unlike this one.

## Two Tracks

```
Track A: Worker/crew comms        Track B: Office reminders
  (two-way, daily rhythm)           (one-way, event/schedule-driven)
  → crew LINE group                 → individual OWNER/ADMIN LINE accounts
```

They share one push mechanism and one LINE OA connection per tenant,
but differ in audience, direction, and trigger shape — worth building
as two clearly separated feature sets on shared plumbing, not one
generic "notifications" system (this split is the user's own framing
from the original roadmap conversation, and it holds up here too).

### Track A: Worker/Crew Comms (from the roadmap memory, unchanged)

**Outbound** — the evening before, around 6 PM, auto-push each worker's
next-day site assignment to the crew LINE group. (Not "every morning" —
this was explicitly corrected once already; the point is workers know
their assignment the night before.)

**Inbound** — three free-text triggers from the crew group become
structured records instead of evaporating into chat history:

| Crew says | Becomes |
|---|---|
| "งานมีปัญหา" (site problem) | A row in a new lightweight `line_issue_reports` table (site, reporting worker, message, timestamp) — **not** a full Knowledge Management system; that's future work, this just stops the report from being chat-only |
| "อยากเบิกของเพิ่ม" (want more material) | A **draft** row in the existing `purchase_orders` module (`src/pages/PurchaseOrders.jsx`) — draft status, needs ADMIN review/approval before it's real, same as any other PO |
| "อยากขอลากิจ" (want personal leave) | A leave request using the existing HR/Assign leave types (`src/pages/HR.jsx`, `leave_sick`/`leave_personal` etc. already in `constants.js`'s `TYPE_COLOR`/`TYPE_LEGEND`) |

### Track B: Office Reminders (new)

Three reminder types, all delivered to **individual** OWNER accounts
plus the specific ADMIN responsible for that record — not a shared
group. Decided during brainstorming: "owner and admin who make
quotation," which means each of those people needs their own LINE
account linked (see "Individual LINE linking" below) rather than one
shared group receiving everything.

1. **Quotation follow-up.** Set **per quotation, at the moment of
   sending** — clicking "ส่ง" pops up "ตั้งเตือนติดตามหลังจากกี่วัน?"
   with a number input, pre-filled from a tenant-level default (**1
   week**), fully editable per quotation, with a skip option for quotes
   that don't need one. Fires once, X days after send, only if the
   quotation is still in "ส่งแล้ว" status with no client
   response/signature — never fires again once it's been sent or the
   quotation's own status has moved past "sent."
2. **Cheque due-date reminder.** Reuses the existing configurable
   threshold (Settings → "แจ้งเตือนเช็คใกล้ครบกำหนด") that already
   drives the Dashboard's in-app alert — this just **also** pushes the
   same alert to LINE, on the same schedule, instead of being
   in-app-only.
3. **Monthly invoice-due reminder.** For sites on recurring
   progress-milestone billing, a monthly scan flags which sites are
   "due" their next progress invoice, based on each site's billing
   schedule / date of its last issued invoice — not a blind fixed-date
   reminder, a real per-site due check.

## Shared Infrastructure

### New table: `line_settings` (one row per tenant)

| column | notes |
|---|---|
| `tenant_id` | PK-ish, one row per tenant |
| `channel_access_token` | LINE Messaging API channel access token — pasted once by an OWNER, same "paste one token" philosophy the deferred defect-management thread already committed to |
| `channel_secret` | for verifying inbound webhook signatures |
| `crew_group_id` | the LINE group ID Track A pushes to / listens on |
| `quotation_followup_default_days` | tenant default for the per-quotation popup (**7**, adjustable in Settings) |

### New Edge Functions

- **`line-webhook`** — receives every inbound LINE event, verifies the
  signature against that tenant's `channel_secret`, routes by which
  tenant's channel it came in on. Handles Track A's three inbound
  triggers, and handles the one-time "link my LINE account" code
  exchange (see below).
- **Four scheduled functions** (Supabase Cron / `pg_cron`, an
  already-available platform feature — nothing new to build there):
  `line-push-daily-assignments` (6 PM daily), `line-push-quotation-
  followups` (daily scan), `line-push-cheque-reminders` (daily scan,
  reusing the existing threshold setting), `line-push-invoice-due`
  (monthly scan).
- All five functions share **one** `sendLinePush(tenant, recipient,
  message)` helper — a single point of contact with the LINE Messaging
  API, not five separate implementations that could drift.

### Individual LINE linking (for Track B's per-person targeting)

Track B needs each OWNER/ADMIN's own LINE account linked to their
FacadeX identity, not just one shared group token. Building a full LINE
Login/OAuth flow for this is a meaningfully bigger project than
anything else in this spec — instead:

1. A user's own Settings page shows a one-time linking code.
2. They DM that code to the tenant's LINE OA (the same channel
   `line_settings` already connects).
3. `line-webhook` recognizes a bare code in a DM, matches it to the
   `user_roles` row that generated it, and stores the sender's LINE
   user ID against that row.

Simple, consistent with this whole feature's "paste/type one thing"
bias, and avoids standing up OAuth for what's otherwise a one-time
action per person.

## Schema Changes

| Table | Change | Why |
|---|---|---|
| `line_settings` | new table | tenant's LINE connection, see above |
| `line_issue_reports` | new table | structured capture for "งานมีปัญหา," see Track A |
| `workers` | + `line_user_id` (nullable) | routes inbound crew messages to the right worker |
| `user_roles` | + `line_user_id` (nullable) | individual push target for Track B; also the destination of the one-time linking code |
| `quotations` | + `created_by_email` | **does not exist today** — confirmed live via schema check, only `created_at` exists. Needed to know who gets the follow-up reminder |
| `quotations` | + `follow_up_after_days` (nullable int) | set by the send-time popup; null = skipped, no reminder scheduled |
| `quotations` | + `follow_up_sent_at` (nullable timestamptz) | set once the reminder actually fires, so the daily scan never sends the same one twice |

**Open verification for the planning stage:** whatever table holds
cheque records needs the same "who created / who's responsible"
check `quotations` just failed — don't assume it has one; verify before
assuming Track B's cheque reminder can target an individual the same
way the quotation reminder does. If it can't, the cheque reminder may
need to fall back to "every OWNER" until that gap is separately closed,
rather than silently defaulting to nobody.

## UI Additions

- **Settings (OWNER)**: new "🔌 LINE" card — paste Channel Access
  Token/Secret, set crew group ID, set the quotation follow-up default
  (days), and a new "ส่งแจ้งเตือนไป LINE ด้วย" toggle next to the
  existing cheque-reminder threshold setting.
- **Settings (any user)**: "เชื่อมต่อ LINE ของฉัน" — shows the one-time
  linking code described above; needed by any OWNER/ADMIN who should
  receive Track B reminders individually.
- **Quotations page**: clicking "ส่ง" now opens a small popup —
  "ตั้งเตือนติดตามหลังจากกี่วัน?", number input pre-filled with the
  tenant default (7), Confirm / "ไม่ต้องเตือน" (skip) — before the
  existing send action completes.

## Out of Scope for This Spec

- A real Knowledge Management system for "งานมีปัญหา" reports —
  `line_issue_reports` is structured capture only; search, categorization,
  and a proper viewer UI are future work, matching the roadmap memory's
  own "not spec'd yet" framing.
- The after-sales/customer-defect-management LINE OA thread — still
  deferred; nothing in the field review validated it as urgent, unlike
  this one.
- LINE Login/OAuth-based account linking — using the one-time DM-a-code
  approach instead, see above.
- Multi-tenant Rich Menu / LIFF auto-provisioning — that was specific
  to the deferred customer-facing thread's "make it easy for the SME to
  set up for their own customers" problem; Track A/B here are both
  internal-facing, no Rich Menu needed.
