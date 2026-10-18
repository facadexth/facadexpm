# ขอเบิกเงินล่วงหน้าผ่าน LINE — design

Date: 2026-10-17. Owner: FacadeX (CHANG). Builds on the payroll rework (spec
`2026-10-17-payroll-payslip-design.md`, live 1.21.1), which already has
`salary_advances`, owner-only approve/reject RPCs, installment deduction in
payroll, and the HR → 💸 เบิกล่วงหน้า tab.

## Why

Today a worker DMs the owner on LINE asking for an advance; if it is not more
than their salary the owner transfers it. The painful part is **remembering who
took how much and deducting it correctly at payroll time**. The payroll system
can already deduct approved advances automatically, but only if someone types
the request into the app — nobody does; requests live in LINE chats.

Success: every advance request lands in CHANG by itself, the owner decides in
the app with the numbers in front of them, and payroll deducts it without
anyone remembering anything.

## Goals

1. A linked worker requests an advance from the LINE 1:1 chat with the bot.
2. The request becomes a `salary_advances` row with status `pending` — no
   retyping by anyone.
3. The owner approves/rejects **in the app**, seeing the numbers needed to
   decide, and may change the amount and number of installments while
   approving.
4. Approved advances are deducted by payroll as today (no change to payroll).
5. The worker can ask the bot for their status at any time and get an
   immediate answer.

## Non-goals

- Approving from inside LINE (owner chose the app).
- LINE push notifications of any kind (all pushes are off since 2026-10-13,
  `LINE_PUSH_ENABLED=false`; owner chose "worker asks, bot replies" for now).
- Requests from LINE **group** chats (money is private → DM only).
- Paying out the money (the owner transfers manually, as today).
- Changing how payroll deducts advances.

## Anti-goals (would be a failure even if it works)

- A money request silently routed to the existing **material request**
  ("ขอเบิก" already means เบิกของ) or vice versa.
- One worker seeing another worker's advances (in LINE or the app).
- A PM seeing any of it (PM never sees money).
- The owner approving without seeing outstanding balance / salary.

## Decided with the owner

| Topic | Decision |
|---|---|
| Where to approve | In the app (HR → เบิกล่วงหน้า) |
| What the approval screen shows | requested amount, **outstanding balance of earlier advances** (ยอดคืนคงเหลือ); I add salary + "ยังเบิกได้อีก" |
| Limit | ยังเบิกได้อีก = salary of the month − outstanding balance of earlier advances |
| Over the limit | Worker can still submit; approval screen shows a **red warning**; owner decides |
| Installments | **Worker chooses** in the form |
| Edit at approval | Owner can change **amount and number of installments** when approving |
| Result notification | No push. Worker types a status phrase; bot **replies** (free) |

## How it works

### Worker side (LINE 1:1 DM with the shared CHANG bot)

1. Worker types **"เบิกเงิน"** (also matches "ขอเบิกเงิน", "อยากเบิกเงิน").
   - This check must run **before** the material-request match, because
     "ขอเบิก" (a material-request keyword) is a substring of "ขอเบิกเงิน".
     Add a regression test for both directions ("ขอเบิกปูน" → material,
     "ขอเบิกเงิน" → advance).
   - DM only. In a group, the bot ignores it (or, my call: replies "ขอเบิกเงินทางแชตส่วนตัวกับบอทนะครับ" — free reply).
   - Throttled like leave (`linkRequestsThrottled`).
2. Bot replies with a one-time field-form link (`line_deep_link_tokens`, 30
   min), new `action_type = 'advance'` (extend the CHECK constraint).
3. Form (`FieldFormPage.jsx` / `field-form` function):
   - amount (baht, > 0), reason/title (short text), installments (select
     **1–6**, default 1 — my call), shows the worker's own current
     outstanding balance (read-only) so they know before asking.
   - Start month: current payroll month if that month is still draft,
     otherwise next month (my call; computed server-side).
   - Submit inserts `salary_advances` (`status='pending'`,
     `requested_by` = a marker such as `line:<worker_id>` or the worker's
     email if set — builder decides, must satisfy NOT NULL), using the
     service role inside the edge function with the worker/tenant taken
     from the token, never from the form body.
   - Daily submit limit like leave (`dailySubmitLimitReached`).
   - After submit: in-app notification (bell) for owner/admins of that
     tenant. **No LINE push.**
4. Worker types **"ยอดเบิก"** → bot replies with: each advance (title,
   amount, status รออนุมัติ / อนุมัติแล้ว / ไม่อนุมัติ + reason / ผ่อนครบแล้ว),
   installments paid/total, and total outstanding. Reply only (free).
5. Both phrases are owner-configurable/renamable like the other DM commands
   (`line_command_settings`), default enabled for DM, disabled for group.

### Owner side (app, HR → 💸 เบิกล่วงหน้า)

- Pending requests at the top; each card shows:
  - requested amount, installments requested, reason, requested via LINE/app
  - **ยอดคืนคงเหลือ (ของเก่า)**: outstanding of this worker's approved,
    not-settled advances = Σ amount − Σ deducted lines
  - เงินเดือน: monthly salary, or daily_wage × 30 for daily workers (my call,
    matches the ÷30 rule)
  - **ยังเบิกได้อีก** = เงินเดือน − ยอดคืนคงเหลือ
  - **red warning** when requested amount > ยังเบิกได้อีก
- Approve opens a small editor prefilled with the request: amount and
  installments editable (installments 1–60 as the DB allows), then confirm.
  Reject asks for a reason (already exists).
- Approval uses a new owner-only RPC (or extends `approve_salary_advance`)
  that sets amount/installments and approves atomically; same owner +
  module checks as today. Audit the change (original vs approved amount).
- The bell notification links to this tab.

## Settled after the builder check (Claude's calls, owner may override)

1. **Start month at approval.** The approval editor also shows the start
   month, prefilled with the first payroll month that is still draft (or not
   yet created) at approval time, editable. The approve RPC rejects a start
   month whose period is confirmed or closed, so no installment can silently
   skip a locked month.
2. **Several pending requests.** Allowed (no hard block). The card shows a
   third number, **รออนุมัติอื่นอยู่** (sum of this worker's other pending
   requests), and ยังเบิกได้อีก = เงินเดือน − ยอดคืนคงเหลือ − รออนุมัติอื่น.
   The red warning uses that figure. Duplicate taps are already limited by
   the token (one use) and the daily submit limit.
3. **Who can request.** A worker whose LINE is linked, whose status is
   `active`, in a tenant with the `payroll` module. A worker with no salary
   or daily wage set can still request (the card shows เงินเดือน — and the red
   warning). Anyone else gets a short reply: "ยังขอเบิกเงินผ่าน LINE ไม่ได้
   ติดต่อแอดมินครับ".
4. **Bell.** In-app notification to the tenant's OWNER and ADMIN users (both
   can see the tab; only the owner can approve). Never to PM or workers. Use
   the existing in-app notifications system (team/LINE-groups work, live
   2026-10-14) if it supports role targeting. Otherwise, owner + admin by
   role query.
5. **Gating.** Behind the existing `payroll` module only; no new tier quota.
   The new LINE commands follow the same per-tenant enable/rename settings
   as the other DM commands.
6. **"Requested via LINE"** is shown when `requested_by` starts with
   `line:`.

## Rich menu (owner decision 2026-10-18)

- The owner designed the new 2×3 menu: `docs/line-rich-menu/rich-menu-v2-1200x810.jpg`. They upload it in LINE OA Manager by hand.
- Row 2, col 2 becomes **ยื่นคำขอ** (text `ยื่นคำขอ`). The bot replies with quick-reply chips: 🏖️ ขอลา · 📦 เบิกของ · 💸 เบิกเงิน · ยกเลิก. Each chip sends the matching phrase, so it runs the same flow as typing it.
- Row 2, col 3 becomes **สถานะคำขอ** (text `สถานะคำขอ`). The bot replies once (a reply, so it is free), with two sections:
  - Leave: the latest leave requests (last 60 days) with their status, then the days left for personal and sick leave.
  - Advances: as in "ยอดเบิก".
- "ขอเบิกของ" and "ขอลา" are no longer menu buttons. Typing them still works exactly as before, and "เบิกเงิน" and "ยอดเบิก" stay typeable.
- New DM command keys: `request_menu` (ยื่นคำขอ) and `request_status` (สถานะคำขอ). Like the other commands, the owner can rename or disable them.

## Constraints

- Multi-tenant shared LINE OA: tenant/worker resolved from the linked
  `workers.line_user_id`; never trust tenant/worker ids from the client.
- Pushes stay off; only replies and in-app notifications.
- PM must not see this tab, the card numbers, or the bell item
  (`canSeeMoney` / gantt PM gating).
- Database writes go through migrations; dry-run in BEGIN…ROLLBACK first;
  the owner applies or approves the apply. Ask the owner before any web or
  edge-function deploy (several worktrees deploy to the same site).
- Thai copy, short and plain.

## Left to the builder

- Exact `requested_by` value for LINE requests.
- Whether "ยอดเบิก" lists rejected requests older than N months.
- Form layout details (follow the existing leave form).
- Whether to extend `approve_salary_advance` or add
  `approve_salary_advance_with_changes`.
