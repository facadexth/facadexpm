# Contractor-Type Starter Templates — Design

## Purpose

New companies signing up today land on a completely blank workspace — no
expense categories, no suppliers. That's correct for FacadeX's own
glass/aluminum-specific categories (confirmed in the prior multi-tenancy
signup design), but leaves every new signup building their category list
and supplier list from zero, even though most of that list is predictable
once you know what kind of contractor they are.

This spec adds a one-time starter seed, keyed off a "contractor type" the
company picks at signup: a handful of expense categories that trade
typically needs, each with a suggested default supplier where one
material vendor clearly dominates that category.

## Background / decisions already made

- **Scope**: this spec covers the starter-template seed only. A related,
  larger idea — supplier "partners" paying for placement, real-time /
  location-based supplier search, revenue from transactions flowing
  through the platform — is an explicit **future direction**, not
  designed or built here. Nothing in this spec should make that harder to
  add later, but nothing here builds toward it either.
- **Type selection**: one primary contractor type, chosen from a required
  dropdown during signup (not multi-select, not skippable).
- **Changing type later**: Settings gets a way to change the stored
  type, but changing it only updates the label — it never re-seeds
  categories or suppliers. Re-seeding would risk creating duplicates or
  re-adding something the company deliberately deleted.
- **Supplier granularity**: a default supplier attaches to an individual
  expense category, not to the contractor type as a whole (a type's
  categories often need different vendors — e.g. glass and aluminum
  contractors buy glass and aluminum from different companies).
- **Labor categories get no default supplier.** A category that
  represents paying a crew (e.g. "ค่าแรงช่างทาสี") isn't a material
  purchase — `suppliers` is for material vendors, workers/subcontractors
  are tracked elsewhere in this app already. Only material categories get
  a seeded supplier.
- **Multiple suppliers per category**: not built now (each category gets
  exactly one seeded supplier at launch), but the data model supports it
  without a future migration — see Data Model.

## Contractor types and their starter content

10 types at launch, each with 3 material categories (each with one
default supplier) and 1 labor category (no supplier):

| Type | Material categories → default supplier | Labor category |
|---|---|---|
| ทาสี (Painting) | ค่าสี → TOA · ค่าอุปกรณ์ทาสี → ไทวัสดุ | ค่าแรงช่างทาสี |
| กระจก/อลูมิเนียม (Glass & Aluminum) | ค่ากระจก → กระจกไทยอาซาฮี · ค่าอลูมิเนียม/เหล็ก → TOSTEM · ค่าซิลิโคน/ยาง → Dow Corning | — |
| ไฟฟ้า (Electrical) | ค่าสายไฟ/อุปกรณ์ไฟฟ้า → บางกอกเคเบิ้ล · ค่าเบรกเกอร์/ตู้ไฟ → Schneider Electric | ค่าแรงช่างไฟฟ้า |
| ประปา/สุขาภิบาล (Plumbing) | ค่าท่อ/ข้อต่อ → SCG · ค่าสุขภัณฑ์ → American Standard | ค่าแรงช่างประปา |
| โครงสร้าง/คอนกรีต (Structural/Concrete) | ค่าปูน/คอนกรีตผสมเสร็จ → ปูนอินทรี (INSEE) · ค่าเหล็กเส้น → TATA Steel | ค่าแรงช่างโครงสร้าง |
| หลังคา (Roofing) | ค่ากระเบื้อง/แผ่นหลังคา → ตราเพชร · ค่าโครงหลังคา → เหล็กสยามยามาโตะ | ค่าแรงช่างหลังคา |
| กระเบื้อง/พื้นผิว (Tiling & Flooring) | ค่ากระเบื้อง → คอตโต้ (COTTO) · ค่าปูนกาว/ยาแนว → ตราจระเข้ | ค่าแรงช่างปู |
| ผนังเบา/ฝ้าเพดาน (Drywall/Ceiling) | ค่าแผ่นยิปซั่ม/สมาร์ทบอร์ด → ยิปซัม (Gyproc) · ค่าโครงคร่าว → ไทวัสดุ | ค่าแรงช่างฝ้า/ผนัง |
| ปรับอากาศ (HVAC) | ค่าเครื่องปรับอากาศ → ไดกิ้น (Daikin) · ค่าท่อ/ฉนวนแอร์ → Aeroflex | ค่าแรงช่างแอร์ |
| งานเหล็ก/โครงเหล็ก (Steelwork) | ค่าเหล็กรูปพรรณ → เหล็กสยามยามาโตะ · ค่าสี/สารกันสนิม → TOA | ค่าแรงช่างเหล็ก/เชื่อม |

This content was drafted from general knowledge of well-known Thai
construction-material brands, not verified business relationships —
confirmed with the user as a starting point, editable any time by
updating the template tables directly (no code change or redeploy
needed).

## Data model

Three new tables, one new column on `tenants`:

```sql
CREATE TABLE contractor_types (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT NOT NULL UNIQUE,   -- e.g. 'painting', 'glass_aluminum'
  label_th    TEXT NOT NULL,          -- e.g. 'ทาสี'
  sort_order  INT NOT NULL DEFAULT 0
);

CREATE TABLE contractor_type_categories (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_type_id UUID NOT NULL REFERENCES contractor_types(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,     -- e.g. 'ค่าสี'
  color             TEXT NOT NULL DEFAULT '#6c63ff',
  sort_order        INT NOT NULL DEFAULT 0
  -- No is_labor flag: "this category has no supplier" is already fully
  -- expressed by having zero matching rows in
  -- contractor_type_category_suppliers below — a labor category (e.g.
  -- ค่าแรงช่างทาสี) just never gets one. A redundant boolean here would
  -- have to be kept in sync with that by hand for no functional benefit.
);

-- Kept as its own table (rather than a supplier_name column on
-- contractor_type_categories) specifically so a category can carry more
-- than one candidate supplier later without a schema change — v1 only
-- ever inserts one row per category.
CREATE TABLE contractor_type_category_suppliers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_template_id UUID NOT NULL REFERENCES contractor_type_categories(id) ON DELETE CASCADE,
  supplier_name       TEXT NOT NULL,
  sort_order          INT NOT NULL DEFAULT 0
);

ALTER TABLE tenants ADD COLUMN contractor_type_id UUID REFERENCES contractor_types(id);
```

These four objects are **not** tenant-scoped (no `tenant_id`, no RLS
beyond "any authenticated user can read them") — they're shared
reference data every tenant reads from once, at signup, the same way
every tenant already reads the same `has_module_access()` function
definition. `SELECT`-only for `authenticated`; no `INSERT`/`UPDATE`/
`DELETE` policy, matching the pattern used for `tenant_modules` (writes
happen out-of-band, not through the app).

## Signup flow changes

1. **Login.jsx signup form** gains a required "ประเภทผู้รับเหมา" dropdown,
   populated from `contractor_types` ordered by `sort_order`. The
   selected type's `id` is passed in `auth.signUp()`'s metadata alongside
   `company_name`, e.g. `options: { data: { company_name, contractor_type_id } }`.

2. **`handle_new_user()` trigger**, in the "new tenant" branch only
   (unchanged for the invited-teammate branch — a teammate joins an
   existing, already-seeded tenant):
   - Sets the new `tenants` row's `contractor_type_id` from the metadata.
   - After the tenant and owner `user_roles` row are created, seeds the
     new tenant's `expense_categories` and `suppliers` from the matching
     `contractor_type_categories` / `contractor_type_category_suppliers`
     rows:
     ```sql
     INSERT INTO expense_categories (name, color, sort_order, tenant_id)
     SELECT name, color, sort_order, v_tenant_id
     FROM contractor_type_categories
     WHERE contractor_type_id = v_contractor_type_id;

     INSERT INTO suppliers (name, tenant_id)
     SELECT s.supplier_name, v_tenant_id
     FROM contractor_type_category_suppliers s
     JOIN contractor_type_categories c ON c.id = s.category_template_id
     WHERE c.contractor_type_id = v_contractor_type_id;
     ```
   - If `contractor_type_id` is absent from the metadata (shouldn't
     happen once the form makes it required, but the trigger must not
     error on a NULL) — skip seeding entirely, tenant starts blank as
     it does today. This is a safety fallback, not a supported path.

3. Seeded rows are indistinguishable from anything the tenant creates
   themselves — free to rename, recolor, delete, or add more, starting
   the moment they land in the app. No ongoing link back to the
   template.

## Settings changes

Wherever tenant-level settings live today (e.g. alongside the trial/plan
display), add a "ประเภทผู้รับเหมา" field showing the current
`contractor_type_id`, editable via a dropdown of the same
`contractor_types` list. Saving only updates `tenants.contractor_type_id`
— no categories or suppliers are touched.

## Out of scope (explicitly deferred)

- Supplier "partners" paying for placement, or any commercial
  relationship with the suppliers named in the template content above —
  the current design doesn't distinguish a "partner" supplier from any
  other; that distinction doesn't exist yet.
- Real-time or location-based supplier search/discovery.
- Any UI for admins to manage `contractor_types` /
  `contractor_type_categories` / `contractor_type_category_suppliers` —
  v1 content is edited directly via SQL, matching how `app_settings`
  defaults are maintained today.
- Multiple suppliers per category — the schema supports it, nothing else
  does yet.
