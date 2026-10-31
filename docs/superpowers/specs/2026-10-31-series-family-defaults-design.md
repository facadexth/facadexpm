# ซีรีส์หลัก (Series family) สำหรับค่าเริ่มต้นโปรเจกต์ — Design

วันที่ 2026-10-31 · branch `feat/series-family` (จาก main d0814f23) · ร่างตาราง family: https://claude.ai/artifact/RLfdw5D34xJ61qqMEMMMYq · mockup การ์ดย่อ: https://claude.ai/artifact/MziM6ThU546RsfpGs9CyXg

## 1. ที่เจ้าของบอก (ยืนยันแล้ว)
- "ค่าเริ่มต้นโปรเจค เลือกแค่ ซีรีย์หลักเช่น iconiq ไม่ต้องลงไปถึงประเภทช่องเปิด"
- "ต้อง เลือก project default แต่ในแต่ละ item แก้ไข รายละเอียดได้"
- "ค่าเริ่มต้นของ project เซฟแล้ว กดย่อได้ แล้วโชว์แค่ wording หลักๆ ที่เราเลือก"

## 2. สมมติฐาน (เจ้าของยังไม่ตอบ — แก้ได้ก่อนวางแผน)
- A1 HOMELIFE รวมเป็น family เดียว (บานเลื่อน 3 รุ่น) — รายการบานเลื่อนได้รุ่นแรกตามชื่อ เปลี่ยนในรายการได้
- A2 PROLINE รวมเป็น family เดียว (ช่องแสง 2 รุ่น) — กติกาเดียวกับ A1
- A3 MN, เค ซี, Aluminium calculation ไม่จัดกลุ่ม: แต่ละชุดเป็น family ของตัวเอง
- ตาราง family ที่เติมตอนแรกคือตารางใน artifact ข้างบน

## 3. ข้อมูลจริงตอนนี้ (อ่านจาก CHANG 2026-10-31)
- `alu_series` 115 แถว คอลัมน์: id, tenant_id, provider_id, name, is_base, active, created_at — ยังไม่มี family
- `estimation_projects` 3 โปรเจกต์ มีค่าเริ่มต้นซีรีส์ 1 โปรเจกต์: HOSPITAL = "ICONIQ EURO บานเลื่อน" มี 1 รายการ และรายการนั้นตั้งซีรีส์เองแล้ว → **ย้ายแล้วราคาไม่เปลี่ยน**
- `alu_hardware_packages` 0 แถว

## 4. Data model
1. `alu_series.family text NULL` — ชื่อซีรีส์หลัก เช่น 'ICONIQ EURO'. NULL = family ของตัวเอง (ชื่อ = `name`). family เป็นของโรงรีดเดียว (กุญแจ = provider_id + family).
2. `estimation_projects.default_family text NULL` — family ที่โปรเจกต์เลือก (คู่กับ `primary_provider_id` ที่มีอยู่แล้ว).
3. `estimation_projects.default_series_id` เก็บไว้ ไม่ลบ (กันข้อมูลหาย/โค้ดเก่า) แต่หน้าเว็บใหม่ไม่เขียนลงอีก (ตั้งเป็น NULL ตอนบันทึก family).
4. Migration `2026-10-31-01-alu-series-family.sql` (+ `.dryrun.sql` BEGIN..ROLLBACK ที่พิมพ์ตารางก่อน/หลัง):
   - ADD COLUMN ทั้งสอง (ตรวจ view `x.*` ที่อ่านตารางพวกนี้ — กฎ view column freeze)
   - เติม family ตามชื่อ ด้วยรายการ (provider name, series name prefix → family) แบบ explicit ไม่ใช่ regex เดา; series ที่ไม่ตรงรายการคง NULL
   - ย้ายโปรเจกต์: `default_family = coalesce(s.family, s.name)`, `primary_provider_id = coalesce(primary_provider_id, s.provider_id)`, `default_series_id = NULL` จาก series ที่ตั้งไว้
   - เจ้าของรันของจริงด้วย `!`; ผมรัน dry-run ก่อน

## 5. การเลือกชุดอัตโนมัติ (หัวใจ)
ฟังก์ชันใหม่ pure ใน `src/lib/seriesFamily.js`:
- `familyKey(series)` → `series.family || series.name`
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
- ความหนาวงกบ: union ของ `thicknessesForSeries` ทุกชุดใน family; มีค่าเดียว → เลือกให้
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
- แต่ละ series มีช่อง "ซีรีส์หลัก" (text + datalist ของ family ที่มีในโรงรีดนั้น) แก้ได้; ว่าง = ใช้ชื่อตัวเอง

## 9. ไม่ทำ (YAGNI)
- ตาราง family แยก, รูป/คำอธิบาย family, family ข้ามโรงรีด, เปลี่ยน schema ของ series_types

## 10. ทดสอบ
- unit: seriesFamily.js (key, choices, first-by-name, ไม่มีชุด, inactive), resolveItemInputs ลำดับ 1–4, thickness union, packages, itemsAffected
- render smoke: ProjectDefaultsPanel ย่อ/กาง/บันทึกแล้วย่อ/ค่ายังไม่บันทึกไม่หาย
- เทียบราคา: สคริปต์รายงานก่อน/หลังทุกรายการทุกโปรเจกต์ (คาด: ไม่เปลี่ยน เพราะ HOSPITAL ตั้งซีรีส์ในรายการแล้ว)
- live: dev server — เลือก family ICONIQ EURO, เพิ่มรายการบานเปิดกับบานเลื่อน ต้องได้ชุดตรงประเภท
- snapshot เดิมต้องไม่เปลี่ยน

## 11. ส่งงาน
version 1.36.0 + changelog ไทย + คู่มือ public/manual (ส่วนค่าเริ่มต้นโปรเจกต์) + lessons note
