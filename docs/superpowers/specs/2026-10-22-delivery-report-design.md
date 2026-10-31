# Delivery report from Kanban cards (รายงานส่งงาน) — design

Date: 2026-10-22 · Owner-approved mockup: https://claude.ai/artifact/UQq1GCTo9XbBVtMVJMMboD (v10)

## Goal

Per invoice, produce a signed "รายงานส่งงาน" (own number DR+YYMM-NNN) that shows, per BOQ line and
phase, what was delivered before, in this งวด, and what remains, with unit prices, photos from the
Kanban cards, a marked-up floor plan / elevation, and a customer signature. Add a third invoice mode
"ตามความคืบหน้า" that bills from card progress × BOQ phase weights, and tighten easy mode.

## Existing pieces (verified 2026-10-22)

- `invoice_items`: `quotation_item_id`, `unit`, `unit_price`, `draw_qty`, `line_total`, `item_type`.
  Easy mode and advanced mode (per-unit %, 2–20 countable units) both store the draw as a
  **quantity** (`draw_qty`). This is how 26 m² × 80% became `draw_qty = 20.8`.
- `boq_items`: `site_id`, `quotation_item_id`, `unit`, `planned_qty`, `code`.
- `boq_phase_splits(boq_item_id, phase_id, pct)` — weight of each phase per BOQ item (1.28.0).
- `phase_tasks` (Kanban cards): `phase_id`, `boq_item_id`, `planned_qty`, `done_qty`, `status`,
  `progress_mode` ('status' | 'quantity').
- `line_site_photos.task_id` — card photos. `invoice_photos` + `WorkPhotosModal` /
  `WorkPhotosDocumentModal` in `src/pages/Invoices.jsx` — current manual "รูปประกอบการส่งงาน".
- `document_receipts` + `SignaturePad` — existing signature capture (cheques).
- Real SOAP OPERA check: 9 lines billed 80% = ผลิต 40 + ติดตั้ง 40 (match); งานรื้อถอน billed 80%
  but weight is ติดตั้ง 100% (mismatch); IN2610-003 unit prices are 8.86% under BOQ on every line
  (quotation discount).

## Owner decisions

1. **Invoice is the source of amounts.** Every line is checked against BOQ + cards for quantity,
   unit price and weight.
2. **Weight is always a % of price**, never of quantity. Line value = qty × unit price × Σ weight of
   the phases delivered. Quantity = what the cards say was actually done in that phase.
3. Checks per line (shown as an icon at the end of the row, and again before issuing the report):
   1. qty must equal the done qty of that phase on the cards → ✅
   2. % must equal Σ weight of the phases delivered (ผลิต only = 20% for composite) → ⚠️ if not
   3. qty ≠ cards but qty = BOQ qty × % (26 × 80% = 20.8) → ⚠️ "probably % of quantity".
      **Always warn, even when the amount is the same.**
   4. Unit price lower than BOQ by the same ratio on every line of the invoice (discount) → match.
4. Cards without BOQ: weight 0%. They still appear in the report (photos + status) with a 0 row.
5. Cards with no quantity recorded (status only) **block** saving a progress-mode invoice until the
   quantity is entered on the card ("กรอกในการ์ด →").
6. **Easy mode has no %.** Value = qty × unit price. ชุด / งาน / ชิ้น: whole numbers only;
   ตร.ม. / ม. (and other measured units): decimals allowed. Unit comes from the line's BOQ (fallback:
   quotation item unit). Partial billing of a set needs advanced or progress mode.
7. **One invoice = one mode**, chosen at creation and locked.
8. Report has its own number **DR+YYMM-NNN** per tenant, header references the invoice number.
   Editing after signature issues a new DR number referencing the old one; signed reports are locked.
9. Plans (floor plan / elevation, image or one-page PDF) are stored **per site** and reused every
   งวด; highlights + numbered pins tied to cards; colour = delivered before (green) / this งวด
   (orange) / remaining (grey).
10. Report pages: (1) detailed table — item, phase, unit, qty, unit price, weight, value, delivered
    before, this งวด, remaining, totals and % of contract, 3-colour bar; (2) marked plan(s);
    (3+) one block per card with photos and caption; signature block at the end.
11. Card picker: start from the phase-weight table, tick which phases this งวด delivers, then pick
    cards (filtered by those phases) and photos; "＋ รูป" uploads more photos and saves them to the
    card too.
12. Signing: choose per report — print and sign on paper (optional photo of the signed sheet),
    sign on this device (local), or send a link (remote, 7-day expiry, via customer LINE if linked,
    else copy link; bell notification when signed). Invoice shows "ลูกค้าเซ็นรับงานแล้ว <date>".

## Out of scope (v1)

- Changing existing invoices' stored data; existing invoices keep their mode ("easy"/"advanced").
- Fixing the SOAP OPERA รื้อถอน mismatch (it will simply show ⚠️).
- Multi-page PDF plans.
