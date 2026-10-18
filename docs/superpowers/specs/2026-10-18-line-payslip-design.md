# LINE payslip request — design (2026-10-18)

## Intent
A worker gets their own payslip from LINE, without asking the owner. The owner's words:
"ขอใน line กด ยื่นคำขอ sub menu เป็น ขอสลิปเงินเดือน แล้วเข้าไปที่ chang", "เก็บไว้ 1 ปีย้อนหลัง".
The owner approved the playback ("ตามนี้เลย ทำเลย").

## Flow
1. In a 1:1 chat, the worker taps Rich Menu **ยื่นคำขอ**. The chips now include **🧾 ขอสลิปเงินเดือน**, after 💸 เบิกเงิน and before ยกเลิก. Tapping it sends `ขอสลิปเงินเดือน`. Typing `ขอสลิป…` does the same.
2. The bot replies (reply only, never push) with a `changpm.app/f/<token>` link: `🧾 กดลิงก์นี้เพื่อดูสลิปเงินเดือนครับ (ใช้ได้ 30 นาที)`.
3. The page shows the worker's name and the months that have a slip. These are the last 12 months, newest first, with net pay on each row. Tapping a month shows the same A5 slip the owner prints in the app, with a "⬇️ บันทึก PDF" button.

## Rules (owner-approved)
- Only months whose payroll period is **closed** (ปิดงวดแล้ว). Draft and confirmed months are never shown.
- Only months where this worker has a salary_records row. Months without a slip are skipped.
- 12 months back, counted from the current Bangkok month (the current month plus the 11 before it).
- Available immediately. No owner approval.
- No slip is ever pushed into LINE; LINE push is OFF globally.

## Decided by me (owner can override)
- **Not single-use.** The worker browses months, so viewing never consumes the link. It only expires after 30 minutes. It never sets `used_at`.
- Requires the tenant's payroll module, an active worker, and a linked LINE account, the same gate as advances. Otherwise the bot replies `ยังขอสลิปผ่าน LINE ไม่ได้ ติดต่อแอดมินครับ`.
- **Group chat:** silent ('ignore'), because a slip is personal. The short-message hint is used only for money commands.
- New command key `payslip_request`, built-in phrase `ขอสลิป`. It is DM-only and the owner can rename or switch it off in การสื่อสาร, like the other request keys.
- The slip page uses the existing `PayslipSheet` layout unchanged. The data comes from the edge function, because the page has no login and no RLS session. The year-to-date line uses the same rule as the app: closed months of that year, up to that month.
- **On a phone:** the A5 sheet is scaled to fit the screen width. The PDF is made from the unscaled sheet.

## Anti-goals
- A worker must never see another worker's slip. The worker comes from the token only; the request body carries just year and month.
- Never show a draft or confirmed month.
- Existing chips and flows (ขอลา / เบิกของ / เบิกเงิน / สถานะคำขอ) keep working as they do now.
