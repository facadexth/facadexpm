# ซีรีส์หลัก (Series family) สำหรับค่าเริ่มต้นโปรเจกต์ — Design

วันที่ 2026-10-31 · branch `feat/series-family` (จาก main d0814f23) · ร่างตาราง family: https://claude.ai/artifact/RLfdw5D34xJ61qqMEMMMYq · mockup การ์ดย่อ: https://claude.ai/artifact/MziM6ThU546RsfpGs9CyXg

## 1. ที่เจ้าของบอก (ยืนยันแล้ว)
- "ค่าเริ่มต้นโปรเจค เลือกแค่ ซีรีย์หลักเช่น iconiq ไม่ต้องลงไปถึงประเภทช่องเปิด"
- "ต้อง เลือก project default แต่ในแต่ละ item แก้ไข รายละเอียดได้"
- "ค่าเริ่มต้นของ project เซฟแล้ว กดย่อได้ แล้วโชว์แค่ wording หลักๆ ที่เราเลือก"

## 2. ตาราง family (artifact v3) และคำตอบเจ้าของ 2026-10-31
- STANDARD = หน้าตัดทั่วไป ความหนาให้เลือก 1.0 / 1.2 / 1.5 / 1.8 / 2.0 มม.: SMS = SMS001 ทั้ง 6 ชุด, Alumet = MINI MC, MN = GROUP 01 (ยืนยันแล้ว)
- MN จัดตามหัวข้อชุดในไฟล์ราคา PriceList2024: 15 family + family 'miscellaneous (misc.)' รวม 13 ชุดที่เหลือ (artifact v4) — ใช้ misc. กับ MN เท่านั้น; SMS 230 / SMS 300 และชุดอื่นของไฟล์ Aluminium calculation แยกเดี่ยว (เจ้าของ 2026-10-31)
- **เจ้าของอนุมัติสเปก 2026-10-31 ("1. ok")**
- KC = ผู้ขายส่ง (ขาย SMS/FUJI) ไม่มี family; FUJI ยังไม่มีในแคตตาล็อก (งานแยก); แยก "ผู้ขาย" จาก "โรงรีด" = งานแยก
- สมมติฐาน (ยังไม่ตอบ): HOMELIFE และ PROLINE รวมเป็น family เดียว — หลายชุดต่อประเภท → ชุดแรกตามชื่อ เปลี่ยนในรายการได้
- พบระหว่างอ่านไฟล์ราคา (ไม่อยู่ในงานนี้): "ชุด ULTRA SLIM MN-7112" กับ "T-SLOT SOLID BARS" น่าจะสลับโปรไฟล์กัน

## 3. ข้อมูลจริงตอนนี้ (อ่านจาก CHANG 2026-10-31)
- `alu_series` 115 แถว คอลัมน์: id, tenant_id, provider_id, name, is_base, active, created_at — ยังไม่มี family
- `estimation_projects` 3 โปรเจกต์ มีค่าเริ่มต้นซีรีส์ 1 โปรเจกต์: HOSPITAL = "ICONIQ EURO บานเลื่อน" มี 1 รายการ และรายการนั้นตั้งซีรีส์เองแล้ว → **ย้ายแล้วราคาไม่เปลี่ยน**
- `alu_hardware_packages` 0 แถว

## 4. Data model
1. ตารางใหม่ `alu_series_families (id, tenant_id, provider_id, name, thickness_options numeric[] NULL, sort_order, active)` unique (tenant_id, provider_id, name). `thickness_options` NULL = ใช้ทุกความหนาของชุดในกลุ่ม; STANDARD = {1.0,1.2,1.5,1.8,2.0}.
   `alu_series.series_family_id uuid NULL` FK → family. NULL = family ของตัวเอง (ชื่อ = `name`). **ห้ามใช้ชื่อคอลัมน์ `family`** — `alu_profiles.family` มีอยู่แล้วและหมายถึงกลุ่มรูปทรง (ท่อกลม, ฉาก …).
2. `estimation_projects.default_series_family_id uuid NULL` FK → alu_series_families; โปรเจกต์ที่เลือกชุดเดี่ยว (ไม่มี family) ยังใช้ `default_series_id` ได้.
3. `estimation_projects.default_series_id` เก็บไว้ ไม่ลบ (กันข้อมูลหาย/โค้ดเก่า) แต่หน้าเว็บใหม่ไม่เขียนลงอีก (ตั้งเป็น NULL ตอนบันทึก family).
4. Migration `2026-10-31-01-alu-series-family.sql` (+ `.dryrun.sql` BEGIN..ROLLBACK ที่พิมพ์ตารางก่อน/หลัง):
   - ADD COLUMN ทั้งสอง (ตรวจ view `x.*` ที่อ่านตารางพวกนี้ — กฎ view column freeze)
   - สร้าง family + เติม `series_family_id` จากรายการ explicit (provider name, series name ตรงตัว → family) ตามตาราง v3; series ไม่อยู่ในรายการคง NULL; RLS เหมือน alu_series
   - ย้ายโปรเจกต์: ถ้า default_series_id อยู่ใน family → `default_series_family_id` = family นั้น, `primary_provider_id = coalesce(primary_provider_id, s.provider_id)`, `default_series_id = NULL`; ไม่อยู่ใน family → คงเดิม
   - เจ้าของรันของจริงด้วย `!`; ผมรัน dry-run ก่อน

## 5. การเลือกชุดอัตโนมัติ (หัวใจ)
ฟังก์ชันใหม่ pure ใน `src/lib/seriesFamily.js`:
- `familyKey(series)` → `series.series_family_id || 'series:' + series.id`
- `familyChoices(index, providerId)` → [{value: family, label, count}] เฉพาะ active, เรียงชื่อ
- `familySeries(index, providerId, family)` → series ทั้งหมดใน family (active, เรียงชื่อ)
- `familySeriesForType(index, seriesTypes, providerId, family, typeId)` → series แรกตามชื่อใน family ที่มี link `alu_series_types` ตรง typeId; ไม่มี → null

`resolveItemInputs` (src/lib/estimationInherit.js) — จุดเดียวที่ทุกหน้าใช้ — ลำดับ series ใหม่:
1. `item.series_id` (ตั้งในรายการ) ชนะเสมอ
2. family ของโปรเจกต์ → `familySeriesForType(...)` ด้วย type ของ template
3. `project.default_series_id` (โปรเจกต์เก่าที่ยังไม่ย้าย)
4. null → ขึ้น "ยังไม่ได้เลือกซีรีส์" เหมือนเดิม

เพื่อไม่ต้องแก้ signature ทุกที่: ผู้เรียกส่ง `project` ที่ผ่าน `withFamilyResolver(project, index, seriesTypes)` ซึ่งแนบฟังก์ชัน `seriesForType(typeId)`; resolveItemInputs ใช้ถ้ามี. ผู้เรียก 6 จุด: openingCost.js, itemPreviewSignature.js, useQuotationAttachments.js, useItemModel.js, SendToQuotationButton.jsx, รวมถึงที่อ่าน `default_series_id` ตรงๆ (itemForm.js:179, ItemsTable.jsx:47, projectDefaults.js:151/159, ProviderCompare.jsx) — ทุกจุดเปลี่ยนไปใช้ resolver เดียวกัน. งานแผนต้องมี test ที่ grep ว่าไม่มีการอ่าน `default_series_id` นอก resolver.

กรณี family ไม่มีชุดสำหรับประเภทนั้น → null + ข้อความ "ซีรีส์หลัก X ไม่มีชุดสำหรับประเภทนี้ — เลือกชุดในรายการ" (แทน "ซีรีส์นี้ไม่ผลิตประเภทนี้").

## 6. ค่าเริ่มต้นโปรเจกต์ (ProjectDefaultsPanel)
- ช่อง "ซีรีส์" → "ซีรีส์หลัก" แสดง `familyChoices` ของโรงรีดหลัก (label เช่น "ICONIQ EURO · 3 ชุด")
- สี: ของโรงรีด (เหมือนเดิม — สีผูกโรงรีด)
- ความหนาวงกบ: `thickness_options` ของ family ถ้ามี (STANDARD = 5 ค่า) ไม่งั้น union ของ `thicknessesForSeries` ทุกชุดใน family; มีค่าเดียว → เลือกให้. ในรายการยังเลือกความหนาอื่นของชุดได้
- ความหนาบาน: แสดงถ้ามีชุดใดใน family ที่ allow_mixed_thickness
- ชุดอุปกรณ์: package ที่ `series_id` NULL หรืออยู่ใน family
- คำเตือนเปลี่ยนค่า: `itemsAffectedByDefaultFamily` = รายการที่สืบทอดแต่ family ไม่มีชุดสำหรับประเภทของมัน
- **การ์ดย่อ** ตาม mockup: บันทึกแล้ว/เปิดโปรเจกต์ที่ตั้งค่าไว้ → แถบหัว + ป้าย (โรงรีด, ซีรีส์หลัก, สี, อุดช่อง, กำไร, วันที่ราคา; ค่าว่างไม่แสดง) + ปุ่ม "แก้ไข ▾". กดบันทึกแล้วย่อเอง. ย่อขณะมีค่าที่ยังไม่บันทึก ไม่ทิ้งค่า. โปรเจกต์ใหม่ที่ยังไม่ตั้งค่า เปิดกาง. สถานะย่อ/กางไม่เก็บใน DB.
- ProviderCompare: เทียบโรงรีดอื่นด้วย family ของโรงรีดนั้น (เลือกจาก familyChoices)

## 7. รายการ (ItemFields)
- ช่องซีรีส์ในรายการ: ค่าว่าง = "ตามโปรเจกต์ (ICONIQ EURO บานเลื่อน)" แสดงชุดที่ resolver เลือกจริง
- ตัวเลือกชุดในรายการ: ชุดใน family ที่ทำประเภทนั้นก่อน แล้วตามด้วยชุดอื่นของโรงรีด (เหมือนเดิม)
- family มีหลายชุดสำหรับประเภทเดียว (HOMELIFE บานเลื่อน) → ข้อความเล็ก "ซีรีส์หลักนี้มี 3 ชุดบานเลื่อน — เลือกได้ที่นี่"
- สี/ความหนาในรายการ: แก้ได้เหมือนเดิม

## 8. หน้าแคตตาล็อก (HierarchyTab)
- แต่ละ series มีช่อง "ซีรีส์หลัก" (select family ของโรงรีดนั้น + "ไม่มี") แก้ได้; จัดการ family (ชื่อ, ความหนาที่ให้เลือก) ในแท็บเดียวกัน

## 9. ไม่ทำ (YAGNI)
- รูป/คำอธิบาย family, family ข้ามโรงรีด, เปลี่ยน schema ของ series_types, ผู้ขาย (KC) แยกจากโรงรีด, นำเข้า FUJI, แก้ ULTRA SLIM/T-SLOT

## 10. ทดสอบ
- unit: seriesFamily.js (key, choices, first-by-name, ไม่มีชุด, inactive), resolveItemInputs ลำดับ 1–4, thickness union, packages, itemsAffected
- render smoke: ProjectDefaultsPanel ย่อ/กาง/บันทึกแล้วย่อ/ค่ายังไม่บันทึกไม่หาย
- เทียบราคา: สคริปต์รายงานก่อน/หลังทุกรายการทุกโปรเจกต์ (คาด: ไม่เปลี่ยน เพราะ HOSPITAL ตั้งซีรีส์ในรายการแล้ว)
- live: dev server — เลือก family ICONIQ EURO, เพิ่มรายการบานเปิดกับบานเลื่อน ต้องได้ชุดตรงประเภท
- snapshot เดิมต้องไม่เปลี่ยน

## 11. ส่งงาน
version 1.36.0 + changelog ไทย + คู่มือ public/manual (ส่วนค่าเริ่มต้นโปรเจกต์) + lessons note

## 12. ชุดอุปกรณ์ (เพิ่ม 2026-10-31) — mockup https://claude.ai/artifact/VkwAjoaSF5P7mrGnWbyosB (v2)
เจ้าของ: "ชุดอุปกรณ์ ผิดไปหมด 1. ไม่ต้องมีหน่วย 2. ไม่มีให้ add hardware/อุปกรณ์สิ้นเปลืองเข้าไป 3. ไม่มีให้ assign เข้ากับ series ไหน" · "รายการของที่จะใส่เข้าไปในชุด เอามาจาก stock ได้ไหม" · ราคา = "2 ราคาซื้อล่าสุด"
- หน้า (PartsTab, ชนิด ชุดอุปกรณ์): ซ้าย = รายการชุด + ค้นหา + "+ ชุดใหม่" (ฟอร์มชุด: ชื่อ, ผู้ผลิตไม่บังคับ, ใช้งาน — **ไม่มีหน่วย**; DB เก็บ unit = 'ชุด'); ขวา = ชุดที่เลือก 3 ส่วน:
  1. อุปกรณ์ · 2. วัสดุสิ้นเปลือง — ตาราง (รายการ, จำนวน แก้ได้, ราคา/หน่วย, ลบ) + "+ เพิ่ม" = ช่องค้นหา inventory_items หมวด อุปกรณ์ (ส่วนที่ 1) / วัสดุสิ้นเปลือง + ซิลิโคน/ยาง (ส่วนที่ 2) แสดงคงเหลือ + ราคาซื้อล่าสุด; ไม่เจอ → "สร้างรายการใหม่" (alu_parts ไม่มี inventory link)
  3. ใช้กับซีรีส์ — chips ของ alu_series_parts ของชุดนี้; "+ เพิ่มซีรีส์": โรงรีด → ซีรีส์หลัก → ติ๊กชุด + ประเภท (ไม่บังคับ) · ข้อมูลเดียวกับส่วน "เลือกซีรีส์เพื่อกำหนดอุปกรณ์" เดิม
  - ราคารวมของชุด = Σ จำนวน × ราคา
- Data: `alu_parts.inventory_item_id uuid NULL` FK inventory_items (unique ต่อ tenant ที่ไม่ NULL). เลือกจากสต๊อก = หา/สร้าง alu_parts ที่ผูกกับ item นั้น (kind ตามส่วน, ชื่อ/หน่วย จาก item) แล้วใส่ alu_part_set_items. ชนิด `accessory` เปลี่ยนป้ายเป็น "วัสดุสิ้นเปลือง".
- ราคา (part ที่ผูกสต๊อก): **ราคาซื้อล่าสุด** = ใบกำกับภาษีซื้อ (supplier_tax_invoice_items.base_unit_cost ของ invoice วันที่ล่าสุด) → ไม่มี → purchase_order_items.unit_price (หลังส่วนลด) ล่าสุด → ไม่มี → alu_part_prices เดิม → ไม่มี = ยังไม่มีราคา. แสดงที่มา + วันที่ของราคา. ราคาไม่รวม VAT (ตรวจในแผนว่า base_unit_cost เป็น ex-VAT). คำนวณผ่าน RPC/view อ่านอย่างเดียว ไม่เขียนลง alu_part_prices.
- อุปกรณ์ 24 ตัวเดิม: รายงานจับคู่ชื่อกับสต๊อกให้เจ้าของตรวจก่อนผูก (ไม่ผูกอัตโนมัติ)
- ตอนเลือกชุดอุปกรณ์ในรายการ: แสดงชุดที่ผูกกับซีรีส์ที่ resolve ได้ของรายการ (+ ประเภทตรง) ก่อน, ชุดที่ไม่ผูกซีรีส์เลย = ใช้ได้ทุกซีรีส์
- ไม่ทำ: ตัดสต๊อกจากชุดอุปกรณ์, หน่วยแปลง (inventory_item_unit_factors) — ใช้หน่วยฐานของ item
