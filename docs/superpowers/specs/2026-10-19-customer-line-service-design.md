# Customer LINE service: progress, handover, warranty and repair tickets (design, 2026-10-19)

## Intent (the owner's words, in order)
- "ปกติจะมีการไปเก็บงาน ไซท์ที่ปิดไปแล้ว ทำยังไงให้ไม่ต้องเปลี่ยน status จาก complete เป็น ongoing แล้วก็ต้องกลับมาปิดอีก"
- "อยากให้ลูกค้า แจ้งซ่อมงานมาได้ โดยอ้างอิงจาก client, site ที่ complete แล้ว … ให้ลูกค้าเชื่อม line oa ของตัวเองได้ ให้ใช้วิธีเปิด ticket"
- The flow today: "line มาแจ้ง → เช็คประกันผลงาน → เรา plan คนเข้าเก็บ → ปิดงาน"
- Warranty means a **period after handover** (answer ก). It is **set per site**.
- **Use the tenant's own LINE OA.** Test it now with FacadeX's OA.
- **One customer contact per site.**
- The customer can follow progress during construction ("ระหว่างก่อสร้าง ลูกค้าเช็ค status ได้ไหม" → yes).
- Warranty starts on the **handover date that the tenant confirms in the app** (answer ข), not when the customer adds the OA.
- Messages the bot sends to the customer by itself (push) use the tenant's LINE quota. They sit behind a **per-tenant on/off switch**; the owner said "ok". With the switch off, the bot only replies when the customer writes first.

## Scope grew into a small CRM (owner, 2026-10-19)
"จริงๆต้องออกแบบตั้งแต่ เป็นลูกค้าใหม่ ให้ทำราคาเพื่อเสนองาน / ลูกค้าปัจจุบัน บอกสเตตัสของงาน / ลูกค้าเก่า เช็คประกัน แจ้งซ่อม ซื้อของเพิ่ม … คล้ายๆ เป็น CRM ย่อมๆ"

| Customer stage | What they do in LINE | What it maps to in the app |
|---|---|---|
| New | Ask for a quote | A lead, then an estimation draft, then a quotation sent back in LINE |
| Current | Ask for job status | An Ongoing site |
| Past | Check warranty, report a repair, buy more (another house, a new door, …) | A repair ticket, or a new lead linked to the same client |

**Quote requests (owner):**
- Only **new aluminium work**. Repairs and other work come later, after feedback.
- The price comes from the **price structure (the estimation / alu cost catalog) plus margin**, which gives the selling price.
- Two intake routes, both producing the same item list:
  - (a) the customer sends a drawing to scan. AI extraction, like the PO scan, gives window/door types, sizes and quantities.
  - (b) the chatbot asks question by question: type, W×H, quantity, colour, glass, site address, photos.
- Both routes become an **estimation draft** in the app. The tenant reviews it, then issues the quotation, which goes back to the customer in LINE.
- My call: the bot never sends a price by itself; a person always approves it first.
- Dependency: the estimate module (branch feat/alu-cost-catalog) is not merged, and its catalogue still has no widths or prices. The quote phase waits for it.

**Project order** (my call, each part ships on its own):
1. Foundation: tenant OA connection, customer linking, rich menu, `สถานะงาน`.
2. Leads and quote requests, connected to estimation.
3. Handover and warranty.
4. Repair tickets.
5. Optional push.

## Who and what
- **Tenant:** a CHANG company, e.g. FacadeX. It connects its own LINE Official Account.
- **Customer contact:** one LINE user per site. This is the client's person who follows the job and reports problems. They see only their own site(s).
- **Service ticket (ใบงานซ่อม / เก็บงาน):** one reported problem, or one planned touch-up visit, on a site. It works whether the site is Ongoing or Completed. **A ticket never changes the site status.**

## Goals
1. **Connect the tenant's own OA.**
   - In Settings › 💬 การสื่อสารและแจ้งเตือน, the owner enters the OA's Channel ID, Channel secret and Channel access token.
   - These are stored server-side only and are never readable from the browser after saving.
   - A "ทดสอบการเชื่อมต่อ" button checks them.
   - The screen shows the webhook URL to paste into LINE Developers.
   - The tenant's own OA is for **customers only**. Workers keep using the shared @changpm crew bot exactly as today. Crew and customer chats never mix, and no worker has to re-link.
2. **Link the customer to a site.**
   - Each site has a "เชิญลูกค้า" action that gives a QR code and a link. It carries a one-time code the customer sends to the tenant OA (the same mechanism as worker link codes today).
   - Linking binds that LINE user to the site and its client. It can happen at any time, during construction or after.
   - One contact per site. Re-inviting replaces the old contact, after the owner confirms.
3. **Progress during construction.** The customer types `สถานะงาน`. The bot replies with:
   - the site name;
   - overall % (the Gantt weighted progress the app already computes);
   - the current phase(s);
   - the planned finish date;
   - up to 3 latest photos the PM marked "ให้ลูกค้าเห็น".

   It never shows prices, costs, other sites, workers' names or pay, or internal notes.
4. **Handover and warranty.**
   - Each site gets `warranty_months` (default 12, editable).
   - An owner/admin button "ยืนยันส่งมอบงาน" sets `handover_date` (defaults to today, editable).
   - Warranty end = handover_date + warranty_months.
   - Closing a site as Completed does not by itself start the warranty.
5. **Repair report.** The customer types `แจ้งซ่อม`, or taps a rich-menu button on the tenant OA.
   - The bot asks for the details and photos. If the contact has several sites, it asks which one first.
   - It creates a ticket with status `รับเรื่อง`.
   - In the app the ticket shows a warranty badge: `ในประกัน (ถึง dd/mm/yyyy)`, `หมดประกัน`, or `ยังไม่ส่งมอบ`.
6. **Plan and do the work without reopening the site.**
   - A ticket can be scheduled. The Assign page can assign crew to the ticket, which means to its site even when the site is Completed.
   - For that visit, check-in, photos, material requests and expenses all work.
   - A ticket visit does not count against the package's Ongoing-site limit.
   - Statuses: `รับเรื่อง` → `นัดเข้า` (with a date) → `กำลังทำ` → `เสร็จ`, or `ยกเลิก`.
   - The tenant can also create a ticket by hand (an internal touch-up with no customer report).
7. **The customer sees ticket status.** The customer types `สถานะแจ้งซ่อม`. The bot replies with their open tickets, each with its status and appointment date.
7b. **Rich menu for the tenant OA** (owner, 2026-10-19: "ต้องทำ rich menu ของ line oa ของ facadex ด้วย"). Build it first for FacadeX's OA. Each button sends a text the customer bot understands, the same way the crew rich menu works today. Proposed buttons (the owner confirms them on a mockup): 🏗️ สถานะงาน · 🔧 แจ้งซ่อม · 📋 สถานะแจ้งซ่อม · 🛡️ ประกันของฉัน (the warranty end date per site) · 📞 ติดต่อเรา (the tenant's phone / office hours). A customer who isn't linked yet gets a reply to send the invitation code first. The design follows the owner's existing look, like the crew menu image they supplied.
8. **Optional push** (per-tenant switch, default OFF). When it's on, the bot pushes:
   - "ส่งมอบงานแล้ว ประกันถึง …";
   - "รับเรื่องแล้ว";
   - "นัดช่างเข้าวันที่ …";
   - "ปิดใบงานแล้ว".

   It uses the tenant's own token and quota, with a daily cap and dedupe like the existing push budget.

## Non-goals (this project)
- Billing for repairs outside the warranty. The ticket only shows "หมดประกัน"; any quotation is made the normal way.
- Customer ratings or signatures.
- Moving the crew bot onto tenant OAs.
- More than one contact per site.

## Anti-goals (a failure even if it "works")
- The customer sees money, costs, another customer's site, worker data or internal notes.
- The tenant's OA secret or token is readable in the browser, logs, or any API response.
- The crew bot (@changpm) behaves differently for workers.
- A ticket visit changes the site status or uses up an Ongoing-site slot.
- A push goes out while the tenant's switch is off.

## Constraints
- Multi-tenant. Every service-role query is tenant-filtered.
- The customer OA webhook resolves the tenant from the URL, e.g. `/functions/v1/customer-line-webhook?t=<tenant-key>`. The signature is verified with THAT tenant's secret, which is read server-side only.
- The global `LINE_PUSH_ENABLED` crew switch is untouched. Customer push is governed by the tenant's switch and the budget.
- The UI is in Thai. **The owner approves a mockup before any UI is built.**
- Every migration gets a BEGIN … ROLLBACK dry run on CHANG first. Subagents never call DB tools. Every deploy is warned about and confirmed first.

## Phases (each one ships on its own)
1. Tenant OA connection, customer webhook, link-code binding, `สถานะงาน` (progress), and the FacadeX OA rich menu (its image plus area texts; the owner uploads it in LINE OA Manager).
2. Site warranty fields, "ยืนยันส่งมอบงาน", and the warranty badge.
3. Tickets: the customer's `แจ้งซ่อม`, the ticket list and detail in the app, statuses, and `สถานะแจ้งซ่อม`.
4. Ticket scheduling: assign crew to a ticket on a Completed site, with check-in, photos and expenses for that visit, without reopening the site.
5. Optional customer push behind the switch.

## Already known about the system (recon, 2026-10-19)
- There is one shared crew OA, @changpm. Its credentials are global env values (`_shared/line.ts:30-43`), and its webhook verifies one global secret. The tenant comes from the group id or `workers.line_user_id`.
- The legacy `line_settings.channel_access_token` and `channel_secret` columns are unused and nullable. Only `group_link_code` is read.
- Linking uses 6-character codes stored on `workers.line_link_code` and `user_roles.line_link_code`. There is no follow-event handler.
- `clients` has `contact_person`, `phone` and `email`, but no LINE column. `sites` has `status` (Ongoing / Completed / On Hold / Cancelled) and `start_date` / `end_date`, but no completed or handover date.
- Push is a hardcoded constant, `LINE_PUSH_ENABLED = false`, in `_shared/line.ts:74`.

## Settled after the builder check (2026-10-19)
- **FacadeX's customer OA is @facadex,** a separate channel from the crew bot @changpm (owner). It gets its own webhook, `customer-line-webhook`. @changpm and line-webhook are untouched.
- **Non-command messages: the bot stays silent** (my call). Staff keep chatting in LINE OA Manager as they do now. The only reply to an unknown text is from an unlinked customer typing a menu command, who gets "ส่งรหัสเชิญจากบริษัทก่อน".
- **Rich menu:** ours replaces @facadex's current rich menu. The owner asked for it and uploads it in LINE OA Manager.
- **Customer-visible photos:** only site photos a PM/admin ticked "ให้ลูกค้าเห็น" (LINE site photos and site attachments). Ticket-visit photos are not shown automatically (my call).
- **Packages:** available to every tenant with the line_bot module. Customer push gets its own counter on the tenant's own quota, separate from the @changpm crew caps (my call).
- **Decide before Phase 3** (the owner, later):
  - Do already-Completed sites get `handover_date` from `end_date`, or does the owner confirm each one?
- **Decide before Phase 4** (the owner, later):
  - Are repair/warranty costs counted in the site's own figures, or tracked per ticket?

## Left to the builder
- Table names.
- How to store secrets: Supabase Vault, or a table with no SELECT grant plus a SECURITY DEFINER reader.
- The customer OA's rich-menu layout. Mockup first.
- How "assign crew to a ticket" fits the existing worker_assignments (e.g. a nullable `ticket_id`) so check-in and payroll keep working.
- How the progress % is fetched (reuse the Gantt weighted progress).
