# Cut Sheet, Stickers and Offcut Stock — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the project's "BOM ทั้งโครงการ" tab, produce a per-bar cut sheet for the whole project, let project jobs order custom bar lengths (searched over the mill's range, with a 1-ton minimum), use offcuts already in stock before new bars, and print a QR sticker for every cut piece and every offcut (which then enters offcut stock).

**Architecture:** Pure planning code in `src/lib/cutPlan.js` (piece expansion with provenance, packing with stock offcuts first, length search, MOQ, sticker model) on top of the existing `cutOptimizer.js` kerf rules. BOM profile lines gain end data (each end 90°/45°/notch, notch size, joint name) passed through `assembly.js` → `bomEngine.js`. Two new tables (`alu_offcuts`, `alu_cut_plans`) and two RPCs (`issue_cut_plan`, `void_cut_plan`) make issuing a plan atomic: it freezes the plan as a snapshot, consumes the stock offcuts it used, and creates the kept offcuts with codes. Stickers render from the issued snapshot to PDF with html2pdf at the chosen label size.

**Tech Stack:** React 18 + Vite, Supabase (Postgres, RLS, plpgsql RPC), vitest (+ `react-dom/server` smoke tests), html2pdf.js, new dependency `qrcode@1.5.4`.

**Spec:** No separate spec document. The binding spec is the approved mockup **https://claude.ai/artifact/4RnfxBtcTuyUjbNPftfaB6 (v5)** plus the owner rulings below (chat 2026-10-27). Rulings made in this plan are provisional where marked "Ruling".

## Owner rulings (binding, 2026-10-27)

1. Normal jobs use the 6.40 m market bar only — no length choice.
2. Project jobs may order custom lengths, optimised per project. Mill range 4.00–7.00 m in 0.05 m steps (editable settings).
3. Custom-length minimum order = 1 ton. **Ruling (flagged to owner):** counted as the total kg of custom-length bars in the whole project; below it, every profile falls back to 6.40 m.
4. Custom-length price per kg = standard price per kg (no surcharge). Best length = least kg bought; ties → less scrap → fewer bars.
5. Stickers carry a QR code; the paper size is selectable (roll 50×30, 60×40, 40×30 mm; A4 sheet 24-up 70×37 mm).
6. Every offcut gets a sticker; the user ticks the offcuts NOT to keep; kept ones enter offcut stock.
7. Use offcuts in stock before cutting new bars (same profile AND same finish).
8. Each piece sticker shows each end's cut (90° / 45°) and the notch (type + size).

## Global Constraints

- Work only in worktree `/Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/alu-cost-catalog`, branch `feat/alu-cost-catalog`. Do not merge or push.
- Database: CHANG only, project ref `kntspldhvcjeaubtqtkn`. NEVER `yyzbgdmgyvvypfcjuhtr` (retired Tokyo). Migrations are applied by the owner after a rolled-back dry run; implementers never apply them.
- No upsert (house rule): look up, then insert / update / delete.
- New RLS policies use the initplan-wrapped form: `(SELECT is_admin_or_owner())`, `(SELECT current_tenant_id())`, `(SELECT has_module_access('estimation'))`.
- All user-facing text in Thai. Lengths on screen and stickers in mm (integers); bar lengths in m with 2 decimals.
- Kerf: 90° = `settings.kerf_square_mm`, 45° = `settings.kerf_miter_mm` (a piece with any 45° end uses the miter kerf); a notch end cuts square (90°) then notches.
- html2canvas does not render inline SVG reliably (session lesson 2026-10-14): QR codes and end glyphs go into the sticker as PNG data URLs.
- Run the full suite before each commit: `npx vitest run` from the worktree (2503+ tests must stay green).
- Commit trailer on every commit:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01SKarDAHEncS9RZ6zCSPXc1`

## Review Focus

1. A piece longer than the longest candidate bar → listed as "ตัดไม่ได้", never dropped; the length is not offered as feasible (Task 3/4 tests).
2. Two projects issuing plans that use the same stock offcut at the same time → the second issue fails with a clear Thai message, nothing half-written (Task 1 RPC `FOR UPDATE` + status check; Task 6 surfaces the error).
3. Items edited after a plan was issued → the cut sheet shows "ใบตัดไม่ตรงกับรายการปัจจุบัน" (signature mismatch) and stickers still print from the issued snapshot (Task 5 `planSignature`, Task 8).
4. An offcut of the same profile but another finish is never used (Task 3 test).
5. Custom mode below 1,000 kg → all profiles use 6.40 m and the summary says why (Task 4 test, Task 7 UI).

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/2026-10-27-01-cut-plans-offcuts.sql` | settings columns, `estimation_projects.cut_mode`, `alu_offcuts`, `alu_cut_plans`, RPCs, RLS |
| `src/lib/assembly.js` (modify) | carry `cut_ends`, `joint_name` onto jointed components |
| `src/lib/bomEngine.js` (modify) | pass end data through `priceProfileLine` |
| `src/lib/estimationSettings.js` (modify) | 4 new settings with defaults |
| `src/lib/cutPlan.js` (new) | pieces with provenance, packing with stock offcuts, grouping, length search, MOQ, plan assembly, signature |
| `src/lib/stickers.js` (new) | sticker view model (pure): piece + offcut stickers, QR payloads, paper sizes |
| `src/lib/stickerRender.js` (new) | browser-only: QR / end-glyph PNG data URLs, PDF export |
| `src/hooks/useEstimation2b.js` (modify) | `useOffcuts`, `useCutPlans`, `issueCutPlan`, `voidCutPlan`, `saveProjectCutMode`, `discardOffcut` |
| `src/pages/estimation/CutModeField.jsx` (new) | stock / custom switch on the BOM tab |
| `src/pages/estimation/CustomLengthSummary.jsx` (new) | custom-length search result, MOQ, "ใช้ทั้งหมด" |
| `src/pages/estimation/CutSheetView.jsx` (new) | bar diagrams, stock offcuts first, issue / void |
| `src/pages/estimation/StickerSheet.jsx` (new) | sticker preview, keep/discard ticks, paper size, PDF |
| `src/pages/estimation/OffcutStockPanel.jsx` (new) | in-stock offcuts of the project's profiles, manual discard |
| `src/pages/estimation/ProjectBomView.jsx` (modify) | wire the above; stock mode ignores length overrides |
| `src/pages/estimation/projectBomHelpers.js` (modify) | candidate lengths from the custom range in custom mode |
| `src/App.jsx`, `src/pages/Estimation.jsx` (modify) | QR deep link `#tab=estimation&project=…&item=…` / `&offcut=…` |

---

### Task 1: Migration — settings, cut mode, offcuts, cut plans, RPCs

**Files:**
- Create: `supabase/migrations/2026-10-27-01-cut-plans-offcuts.sql`
- Create: `.superpowers/sdd/2026-10-27-cut-sheet/dryrun-migration.sh` (git-ignored)

**Interfaces:**
- Produces tables `alu_offcuts`, `alu_cut_plans`; columns `estimation_settings.custom_len_min_m / custom_len_max_m / custom_len_step_m / custom_moq_kg`, `estimation_projects.cut_mode`.
- Produces `issue_cut_plan(p_project_id uuid, p_signature text, p_plan jsonb, p_used_offcut_ids uuid[], p_new_offcuts jsonb) RETURNS jsonb` → `{ plan_id, offcuts: [{ key, id, code }] }`.
  `p_new_offcuts` = `[{ key text, profile_id uuid, finish_id uuid|null, length_m numeric, end_a text }]` (only the kept ones).
- Produces `void_cut_plan(p_plan_id uuid) RETURNS void`.

- [ ] **Step 1: Write the migration**

```sql
-- 2026-10-27-01: cut sheet, offcut stock and stickers (plan docs/superpowers/plans/2026-10-27-cut-sheet-stickers-offcuts.md)
BEGIN;

ALTER TABLE estimation_settings
  ADD COLUMN custom_len_min_m  NUMERIC NOT NULL DEFAULT 4.0  CHECK (custom_len_min_m > 0),
  ADD COLUMN custom_len_max_m  NUMERIC NOT NULL DEFAULT 7.0  CHECK (custom_len_max_m > 0),
  ADD COLUMN custom_len_step_m NUMERIC NOT NULL DEFAULT 0.05 CHECK (custom_len_step_m > 0),
  ADD COLUMN custom_moq_kg     NUMERIC NOT NULL DEFAULT 1000 CHECK (custom_moq_kg >= 0),
  ADD CONSTRAINT estimation_settings_custom_range CHECK (custom_len_max_m >= custom_len_min_m);

-- 'stock' = normal job, market bar only; 'custom' = project job, custom lengths allowed
ALTER TABLE estimation_projects
  ADD COLUMN cut_mode TEXT NOT NULL DEFAULT 'stock' CHECK (cut_mode IN ('stock','custom'));

CREATE TABLE alu_cut_plans (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  project_id  UUID NOT NULL REFERENCES estimation_projects(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','void')),
  signature   TEXT NOT NULL,           -- planSignature() of the items the plan was made from
  plan        JSONB NOT NULL,          -- frozen plan: groups, bars, pieces, offcuts (see src/lib/cutPlan.js)
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  issued_by   UUID DEFAULT auth.uid(),
  voided_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX alu_cut_plans_one_issued ON alu_cut_plans(project_id) WHERE status = 'issued';
CREATE INDEX idx_alu_cut_plans_project_id ON alu_cut_plans(project_id);

CREATE TABLE alu_offcuts (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  code              TEXT NOT NULL,                       -- OC-0001, per tenant
  profile_id        UUID NOT NULL REFERENCES alu_profiles(id) ON DELETE RESTRICT,
  finish_id         UUID REFERENCES alu_finishes(id) ON DELETE RESTRICT,
  length_m          NUMERIC NOT NULL CHECK (length_m > 0),
  end_a             TEXT NOT NULL DEFAULT 'square' CHECK (end_a IN ('square','miter45','notch')), -- the end the last piece left
  status            TEXT NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock','used','discarded')),
  source_project_id UUID REFERENCES estimation_projects(id) ON DELETE SET NULL,
  source_plan_id    UUID REFERENCES alu_cut_plans(id) ON DELETE SET NULL,
  used_plan_id      UUID REFERENCES alu_cut_plans(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  status_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
CREATE INDEX idx_alu_offcuts_profile_finish ON alu_offcuts(profile_id, finish_id) WHERE status = 'in_stock';
CREATE INDEX idx_alu_offcuts_source_plan ON alu_offcuts(source_plan_id);
CREATE INDEX idx_alu_offcuts_used_plan ON alu_offcuts(used_plan_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['alu_cut_plans','alu_offcuts'] LOOP
    EXECUTE format('CREATE INDEX idx_%s_tenant_id ON %I(tenant_id)', t, t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY admin_full_access ON %I FOR ALL TO authenticated
      USING ((SELECT is_admin_or_owner()) AND tenant_id = (SELECT current_tenant_id()) AND (SELECT has_module_access('estimation')))
      WITH CHECK ((SELECT is_admin_or_owner()) AND tenant_id = (SELECT current_tenant_id()) AND (SELECT has_module_access('estimation')))$p$, t);
  END LOOP;
END $$;

-- Issue: freeze the plan, consume the stock offcuts it uses, stock the kept new offcuts. All or nothing.
-- SECURITY INVOKER: RLS above is the access check; the function only adds the concurrency rules.
CREATE FUNCTION issue_cut_plan(p_project_id UUID, p_signature TEXT, p_plan JSONB, p_used_offcut_ids UUID[], p_new_offcuts JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  v_plan UUID; v_n INT; v_next INT; v_out JSONB := '[]'::jsonb; r JSONB; v_id UUID; v_code TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM estimation_projects WHERE id = p_project_id AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'ไม่พบโปรเจกต์' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM alu_cut_plans WHERE project_id = p_project_id AND status = 'issued') THEN
    RAISE EXCEPTION 'โปรเจกต์นี้มีใบตัดที่ยืนยันแล้ว ยกเลิกใบเดิมก่อน' USING ERRCODE = 'P0001';
  END IF;
  -- lock the offcuts this plan uses; every one must still be in stock
  SELECT count(*) INTO v_n FROM (
    SELECT id FROM alu_offcuts WHERE id = ANY(COALESCE(p_used_offcut_ids, '{}')) AND tenant_id = v_tenant AND status = 'in_stock' FOR UPDATE
  ) x;
  IF v_n <> COALESCE(array_length(p_used_offcut_ids, 1), 0) THEN
    RAISE EXCEPTION 'เศษบางชิ้นถูกใช้หรือทิ้งไปแล้ว คำนวณใบตัดใหม่แล้วลองอีกครั้ง' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO alu_cut_plans (tenant_id, project_id, signature, plan) VALUES (v_tenant, p_project_id, p_signature, p_plan) RETURNING id INTO v_plan;
  UPDATE alu_offcuts SET status = 'used', used_plan_id = v_plan, status_at = now() WHERE id = ANY(COALESCE(p_used_offcut_ids, '{}'));
  -- per-tenant running code; the table lock serialises concurrent issues of the same tenant
  LOCK TABLE alu_offcuts IN SHARE ROW EXCLUSIVE MODE;
  SELECT COALESCE(max(substring(code FROM 4)::int), 0) INTO v_next FROM alu_offcuts WHERE tenant_id = v_tenant AND code ~ '^OC-[0-9]+$';
  FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(p_new_offcuts, '[]'::jsonb)) LOOP
    v_next := v_next + 1;
    v_code := 'OC-' || lpad(v_next::text, 4, '0');
    INSERT INTO alu_offcuts (tenant_id, code, profile_id, finish_id, length_m, end_a, source_project_id, source_plan_id)
      VALUES (v_tenant, v_code, (r->>'profile_id')::uuid, NULLIF(r->>'finish_id','')::uuid, (r->>'length_m')::numeric,
              COALESCE(r->>'end_a','square'), p_project_id, v_plan)
      RETURNING id INTO v_id;
    v_out := v_out || jsonb_build_object('key', r->>'key', 'id', v_id, 'code', v_code);
  END LOOP;
  RETURN jsonb_build_object('plan_id', v_plan, 'offcuts', v_out);
END $$;

-- Void: only while none of the offcuts this plan created has been used by another plan.
CREATE FUNCTION void_cut_plan(p_plan_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_tenant UUID := current_tenant_id();
BEGIN
  PERFORM 1 FROM alu_cut_plans WHERE id = p_plan_id AND tenant_id = v_tenant AND status = 'issued' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบใบตัดที่ยืนยันแล้ว' USING ERRCODE = 'P0002'; END IF;
  IF EXISTS (SELECT 1 FROM alu_offcuts WHERE source_plan_id = p_plan_id AND status = 'used') THEN
    RAISE EXCEPTION 'เศษจากใบตัดนี้ถูกงานอื่นใช้ไปแล้ว ยกเลิกไม่ได้' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM alu_offcuts WHERE source_plan_id = p_plan_id;
  UPDATE alu_offcuts SET status = 'in_stock', used_plan_id = NULL, status_at = now() WHERE used_plan_id = p_plan_id;
  UPDATE alu_cut_plans SET status = 'void', voided_at = now() WHERE id = p_plan_id;
END $$;

REVOKE ALL ON FUNCTION issue_cut_plan(UUID, TEXT, JSONB, UUID[], JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION void_cut_plan(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION issue_cut_plan(UUID, TEXT, JSONB, UUID[], JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION void_cut_plan(UUID) TO authenticated;

COMMIT;
```

- [ ] **Step 2: Write the dry-run script** (`.superpowers/sdd/2026-10-27-cut-sheet/dryrun-migration.sh`): copies the migration, replaces the final `COMMIT;` with checks + `ROLLBACK;`:

```bash
#!/usr/bin/env bash
set -euo pipefail
SRC=/Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/alu-cost-catalog/supabase/migrations/2026-10-27-01-cut-plans-offcuts.sql
OUT="$(mktemp -d)/dry.sql"
{ sed '/^COMMIT;$/d' "$SRC"; cat <<'SQL'
SELECT 'DRY RUN PASSED' AS result,
  (SELECT count(*) FROM information_schema.columns WHERE table_name='estimation_settings' AND column_name LIKE 'custom_%') AS settings_cols,
  (SELECT count(*) FROM information_schema.columns WHERE table_name='estimation_projects' AND column_name='cut_mode') AS cut_mode_col,
  (SELECT count(*) FROM pg_proc WHERE proname IN ('issue_cut_plan','void_cut_plan')) AS rpcs,
  (SELECT count(*) FROM pg_policies WHERE tablename IN ('alu_offcuts','alu_cut_plans')) AS policies;
ROLLBACK;
SQL
} > "$OUT"
grep -q '^COMMIT;$' "$OUT" && { echo "COMMIT still present"; exit 1; }
npx supabase db query --project-ref kntspldhvcjeaubtqtkn --linked=false -f "$OUT"
```

- [ ] **Step 3: Run the dry run** — `bash /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/alu-cost-catalog/.superpowers/sdd/2026-10-27-cut-sheet/dryrun-migration.sh`. Expected: `DRY RUN PASSED`, settings_cols 4, cut_mode_col 1, rpcs 2, policies 2. If the auto-mode classifier blocks it, report the exact command for the owner to run with `!`. **Do not apply the migration.**

- [ ] **Step 4: Commit** — `git add supabase/migrations/2026-10-27-01-cut-plans-offcuts.sql && git commit -m "feat(cut-sheet): migration for offcut stock, issued cut plans and custom-length settings"` (+ trailer).

---

### Task 2: BOM lines carry end data

**Files:**
- Modify: `src/lib/assembly.js:41-61`
- Modify: `src/lib/bomEngine.js:45-48, 80`
- Modify: `src/lib/estimationSettings.js`
- Test: `src/lib/assemblyEnds.test.js` (new; copy the `index` fixture shape from the existing `src/lib/assembly.test.js` if `applyJoints` needs more fields than the minimal one below), `src/lib/bomEngine.test.js`, `src/lib/estimationSettings.test.js` (or the existing settings test file)

**Interfaces:**
- Produces on every component returned by `applyJoints` and every BOM profile line: `cut_style` (unchanged meaning), `cut_ends` (`0|1|2` = how many ends carry `cut_style`; the other ends are square), `notch_width_mm`, `notch_depth_mm`, `joint_name` (string|null).
- Produces settings `custom_len_min_m` 4, `custom_len_max_m` 7, `custom_len_step_m` 0.05, `custom_moq_kg` 1000.

- [ ] **Step 1: Failing tests**

```js
// src/lib/assemblyEnds.test.js
import { describe, it, expect } from 'vitest'
import { applyJoints } from './assembly.js'

const index = { profiles: {}, series: {}, seriesProfiles: [] }
describe('applyJoints end data', () => {
  it('a jointed component carries the joint name and how many ends it cuts', () => {
    const joints = [{ id: 'j1', name: 'บากรับกรอบนอน', main_family: 'X', secondary_family: 'Y', deduction_mode: 'manual', deduction_mm: 5, cut_style: 'notch', notch_width_mm: 20, notch_depth_mm: 8 }]
    const components = [{ role_name: 'กรอบบานตั้ง', profile_family: 'Y', length_rule_type: 'height', length_deduction_mm: 0, joint_id: 'j1', joint_ends: 1 }]
    const { components: out } = applyJoints({ components, joints, index, seriesId: null, thicknessMm: 1.2 })
    expect(out[0]).toMatchObject({ cut_style: 'notch', cut_ends: 1, joint_name: 'บากรับกรอบนอน', notch_width_mm: 20, notch_depth_mm: 8 })
  })
  it('a mitred main bar cuts both ends; a plain bar cuts none', () => {
    const joints = [{ id: 'j1', name: 'มุม 45', main_family: 'F', secondary_family: 'F', deduction_mode: 'manual', deduction_mm: 0, cut_style: 'miter45' }]
    const components = [{ role_name: 'เฟรมบน', profile_family: 'F', length_rule_type: 'width' }, { role_name: 'อื่น', profile_family: 'Z', length_rule_type: 'width' }]
    const { components: out } = applyJoints({ components, joints, index, seriesId: null, thicknessMm: 1.2 })
    expect(out[0]).toMatchObject({ cut_style: 'miter45', cut_ends: 2, joint_name: 'มุม 45' })
    expect(out[1]).toMatchObject({ cut_style: 'square', cut_ends: 0, joint_name: null })
  })
})
```

Add to `bomEngine.test.js` one case: a component `{ ..., cut_style: 'notch', cut_ends: 1, notch_width_mm: 20, notch_depth_mm: 8, joint_name: 'บาก' }` yields a profile line with those five fields; a grid line yields `cut_style: 'square', cut_ends: 0, joint_name: null`.
Add to the settings test: `mergeSettings({})` has the four custom defaults; `mergeSettings({ custom_len_step_m: 0 })` falls back to 0.05.

- [ ] **Step 2: Run** `npx vitest run src/lib/assemblyEnds.test.js src/lib/bomEngine.test.js` — expect FAIL (`cut_ends` undefined).

- [ ] **Step 3: Implement**

In `applyJoints`:
- the no-joint branch returns `{ ...c, cut_style: c.cut_style || 'square', cut_ends: (c.cut_style && c.cut_style !== 'square') ? 2 : 0, joint_name: null }`;
- both early-return issue branches return `{ ...c, cut_style: 'square', cut_ends: 0, joint_name: null }`;
- the resolved branch adds `cut_ends: (joint.cut_style || 'square') === 'square' ? 0 : ends, joint_name: joint.name || null`;
- `withMitreMains` sets `{ ...c, cut_style: 'miter45', cut_ends: 2, joint_name: <name of the first miter joint whose main_family is c.profile_family> }` (build a `miterName` map next to `miterMains`).

In `bomEngine.js`:
```js
function priceProfileLine({ role_name, family, length_m, quantity, pricing, opening, thickness_mm, cut_style, cut_ends, notch_width_mm, notch_depth_mm, joint_name }) {
  // (existing body up to `line`)
  const style = cut_style || 'square'
  return { ...line, cut_style: style, cut_ends: style === 'square' ? 0 : (Number(cut_ends) === 1 ? 1 : 2),
    notch_width_mm: notch_width_mm ?? null, notch_depth_mm: notch_depth_mm ?? null, joint_name: joint_name ?? null }
}
```
and pass `cut_ends: c.cut_ends, notch_width_mm: c.notch_width_mm, notch_depth_mm: c.notch_depth_mm, joint_name: c.joint_name` at line 80.

In `estimationSettings.js` add to `DEFAULT_SETTINGS`: `custom_len_min_m: 4, custom_len_max_m: 7, custom_len_step_m: 0.05, custom_moq_kg: 1000`, and in `mergeSettings`: min/max/step `n > 0`, moq `n >= 0`; if merged max < min, use the defaults for both.

- [ ] **Step 4: Run** the three test files, then `npx vitest run` — all PASS.
- [ ] **Step 5: Commit** — `feat(cut-sheet): BOM lines carry each end's cut and the notch`.

---

### Task 3: `cutPlan.js` — pieces with provenance, packing with stock offcuts first

**Files:**
- Create: `src/lib/cutPlan.js`
- Test: `src/lib/cutPlan.test.js`

**Interfaces:**
- Consumes: BOM profile lines from Task 2; `kerfM(style, settings)` from `cutOptimizer.js`; `entries` from `buildEntries` (`projectBomHelpers.js`).
- Produces:
  - `piecesOf(entries) → Map<groupKey, Piece[]>` where `groupKey = profileId|finishId` and `Piece = { length_m, opening_no, item_name, role_name, end_a, end_b, notch: {joint_name, width_mm, depth_mm}|null, kerf_style: 'square'|'miter45' }`. `end_a` = the line's `cut_style` if `cut_ends >= 1` else `'square'`; `end_b` = the `cut_style` if `cut_ends === 2` else `'square'`.
  - `packWithOffcuts(pieces, barLengthM, settings, offcuts) → { offcutBars, bars, unplaced }`; each bar `{ length_m, left_m, pieces: Piece[], offcut?: {id, code, length_m} }`.
  - `groupIdenticalBars(bars) → [{ bar, count, nos: number[] }]` (1-based bar numbers in packing order).

- [ ] **Step 1: Failing tests**

```js
// src/lib/cutPlan.test.js
import { describe, it, expect } from 'vitest'
import { piecesOf, packWithOffcuts, groupIdenticalBars } from './cutPlan.js'

const S = { kerf_square_mm: 3, kerf_miter_mm: 10, min_keep_offcut_m: 0.5 }
const line = (o) => ({ resolved: true, profile_id: 'P', length_m: 1, quantity: 1, role_name: 'r', cut_style: 'square', cut_ends: 0, ...o })
const entry = (lines, o = {}) => ({ opening_no: 'W-01', item_name: 'บาน', quantity: 1, finish_id: 'F', bom: { profileLines: lines, gridLines: [] }, ...o })
const pc = (len, o = {}) => ({ length_m: len, opening_no: 'W-01', item_name: '', role_name: 'r', end_a: 'square', end_b: 'square', notch: null, kerf_style: 'square', ...o })

describe('piecesOf', () => {
  it('expands quantity x item quantity, keeps the item and both ends', () => {
    const m = piecesOf([entry([line({ length_m: 1.8, quantity: 2, cut_style: 'miter45', cut_ends: 2 })], { quantity: 3 })])
    const ps = m.get('P|F')
    expect(ps).toHaveLength(6)
    expect(ps[0]).toMatchObject({ length_m: 1.8, opening_no: 'W-01', end_a: 'miter45', end_b: 'miter45', kerf_style: 'miter45' })
  })
  it('one notched end: the other end is square, the notch is described', () => {
    const ps = piecesOf([entry([line({ cut_style: 'notch', cut_ends: 1, joint_name: 'บากรับกรอบนอน', notch_width_mm: 20, notch_depth_mm: 8 })])]).get('P|F')
    expect(ps[0]).toMatchObject({ end_a: 'notch', end_b: 'square', kerf_style: 'square', notch: { joint_name: 'บากรับกรอบนอน', width_mm: 20, depth_mm: 8 } })
  })
  it('skips unresolved lines', () => {
    expect(piecesOf([entry([line({ resolved: false })])]).size).toBe(0)
  })
})

describe('packWithOffcuts', () => {
  it('uses a stock offcut of the profile before opening a new bar', () => {
    const r = packWithOffcuts([pc(2.0), pc(2.0), pc(2.0), pc(2.0)], 6.4, S, [{ id: 'o1', code: 'OC-0001', length_m: 2.1 }])
    expect(r.offcutBars).toHaveLength(1)
    expect(r.offcutBars[0].pieces).toHaveLength(1)
    expect(r.bars).toHaveLength(1)
    expect(r.bars[0].pieces).toHaveLength(3)
  })
  it('an offcut too short for every piece is left unused', () => {
    const r = packWithOffcuts([pc(1.5)], 6.4, S, [{ id: 'o1', code: 'OC-0001', length_m: 0.8 }])
    expect(r.offcutBars).toHaveLength(0)
  })
  it('the last piece on an offcut needs no trailing kerf', () => {
    const r = packWithOffcuts([pc(1.0)], 6.4, S, [{ id: 'o1', code: 'OC-0001', length_m: 1.0 }])
    expect(r.offcutBars).toHaveLength(1)
    expect(r.offcutBars[0].left_m).toBe(0)
  })
  it('a piece longer than the bar is unplaced, never dropped', () => {
    const r = packWithOffcuts([pc(7.0), pc(1.0)], 6.4, S, [])
    expect(r.unplaced.map(p => p.length_m)).toEqual([7.0])
    expect(r.bars).toHaveLength(1)
  })
  it('mitred pieces use the miter kerf', () => {
    const r = packWithOffcuts([pc(3.2, { kerf_style: 'miter45' }), pc(3.2, { kerf_style: 'miter45' })], 6.4, S, [])
    expect(r.bars).toHaveLength(2) // 3.2 + 0.010 + 3.2 > 6.4
  })
})

describe('groupIdenticalBars', () => {
  it('bars with the same pieces in the same order share one row', () => {
    const b = (lens) => ({ length_m: 6.4, left_m: 0, pieces: lens.map(l => pc(l)) })
    const g = groupIdenticalBars([b([2, 2]), b([2, 2]), b([1])])
    expect(g.map(x => [x.count, x.nos])).toEqual([[2, [1, 2]], [1, [3]]])
  })
})
```

- [ ] **Step 2: Run** `npx vitest run src/lib/cutPlan.test.js` — FAIL (module missing).

- [ ] **Step 3: Implement**

```js
// src/lib/cutPlan.js
// Whole-project cut planning with piece provenance (which item, which part, how each end is cut), stock offcuts used
// before new bars, custom-length search and the 1-ton custom-order minimum. Pure. Kerf rules from cutOptimizer.js.
import { kerfM } from './cutOptimizer.js'

const EPS = 1e-9
const bomsOf = e => [e.bom, e.addonBom, ...(e.addonBoms || []).map(a => a && a.bom)].filter(Boolean)
const mm = n => Math.round(Number(n) * 1000) / 1000

export function piecesOf(entries) {
  const out = new Map()
  for (const e of entries || []) {
    const q = Number(e.quantity) > 0 ? Number(e.quantity) : 1
    for (const bom of bomsOf(e)) for (const l of [...bom.profileLines, ...bom.gridLines]) {
      if (!l.resolved || !l.profile_id) continue
      const style = l.cut_style || 'square'
      const ends = style === 'square' ? 0 : (Number(l.cut_ends) === 1 ? 1 : 2)
      const end_a = ends >= 1 ? style : 'square'
      const end_b = ends === 2 ? style : 'square'
      const piece = {
        length_m: mm(l.length_m), opening_no: e.opening_no, item_name: e.item_name || '', role_name: l.role_name || '',
        end_a, end_b, kerf_style: end_a === 'miter45' || end_b === 'miter45' ? 'miter45' : 'square',
        notch: style === 'notch' ? { joint_name: l.joint_name || null, width_mm: l.notch_width_mm ?? null, depth_mm: l.notch_depth_mm ?? null } : null,
      }
      const key = `${l.profile_id}|${e.finish_id || ''}`
      if (!out.has(key)) out.set(key, [])
      const list = out.get(key)
      const n = (Number(l.quantity) || 0) * q
      for (let i = 0; i < n; i++) list.push({ ...piece })
    }
  }
  return out
}

const fits = (bar, p, settings) => bar.left_m + EPS >= p.length_m + kerfM(p.kerf_style, settings) || (bar.left_m + EPS >= p.length_m && bar.pieces.length === 0)
const place = (bar, p, settings) => { bar.left_m = Math.max(0, bar.left_m - p.length_m - kerfM(p.kerf_style, settings)); bar.pieces.push(p) }

// Longest piece first. Offcuts (shortest first, so small leftovers get used up) are tried before new bars.
export function packWithOffcuts(pieces, barLengthM, settings, offcuts) {
  const sorted = [...(pieces || [])].sort((a, b) => b.length_m - a.length_m)
  const offBars = [...(offcuts || [])].sort((a, b) => a.length_m - b.length_m)
    .map(o => ({ length_m: Number(o.length_m), left_m: Number(o.length_m), pieces: [], offcut: { id: o.id, code: o.code, length_m: Number(o.length_m) } }))
  const bars = []
  const unplaced = []
  for (const p of sorted) {
    if (p.length_m > barLengthM + EPS && !offBars.some(b => fits(b, p, settings))) { unplaced.push(p); continue }
    const ob = offBars.find(b => fits(b, p, settings))
    if (ob) { place(ob, p, settings); continue }
    const b = bars.find(x => fits(x, p, settings))
    if (b) place(b, p, settings)
    else { const nb = { length_m: barLengthM, left_m: barLengthM, pieces: [] }; place(nb, p, settings); bars.push(nb) }
  }
  return { offcutBars: offBars.filter(b => b.pieces.length), bars, unplaced }
}

const barSig = b => b.pieces.map(p => `${p.opening_no}|${p.role_name}|${p.length_m}|${p.end_a}|${p.end_b}`).join(';') + `#${b.length_m}`
export function groupIdenticalBars(bars) {
  const out = []
  const idx = new Map()
  ;(bars || []).forEach((bar, i) => {
    const s = barSig(bar)
    if (idx.has(s)) { const g = out[idx.get(s)]; g.count++; g.nos.push(i + 1) }
    else { idx.set(s, out.length); out.push({ bar, count: 1, nos: [i + 1] }) }
  })
  return out
}
```

The sheet labels a group "เส้นที่ a–b × n" when `nos` is consecutive, otherwise "เส้นที่ 1, 4, 7 × 3".

- [ ] **Step 4: Run** the test file, then the suite — PASS.
- [ ] **Step 5: Commit** — `feat(cut-sheet): cut pieces keep their item and ends; stock offcuts are packed before new bars`.

---

### Task 4: `cutPlan.js` — custom-length search and the minimum order

**Files:**
- Modify: `src/lib/cutPlan.js`
- Test: `src/lib/cutPlan.test.js`

**Interfaces:**
- Produces:
  - `rangeLengths(settings) → number[]` (min..max by step, rounded to mm; `[]` when invalid; capped at 400 values).
  - `evaluateLength(pieces, L, settings, offcuts, kgPerM) → { length_m, newBars, kg, scrap_m, keep_m, feasible, packed }` (kg counts NEW bars only).
  - `bestLength(pieces, candidates, settings, offcuts, kgPerM) → evaluation|null` (least kg → less scrap → fewer bars → shorter).
  - `chooseLengths({ groups, mode, settings, kgPerM, offcutsByGroup, overrides }) → { byGroup: {key: {length_m, custom, eval}}, customKg, moqMet, reason }`
    `groups` = `[{ key, pieces }]`; `mode` = `'stock'|'custom'`; `overrides` = `{ key: length_m }` chosen by the user (custom mode only).
    In stock mode every group uses `settings.stock_length_m`. In custom mode each group uses its override if feasible, else `bestLength` over `[stock, ...rangeLengths]`. Then if `0 < customKg < settings.custom_moq_kg`, every group falls back to stock and `reason = 'moq'`.

- [ ] **Step 1: Failing tests** (append)

```js
import { rangeLengths, evaluateLength, bestLength, chooseLengths } from './cutPlan.js'
const S2 = { ...S, stock_length_m: 6.4, custom_len_min_m: 4, custom_len_max_m: 7, custom_len_step_m: 0.05, custom_moq_kg: 1000 }

describe('rangeLengths', () => {
  it('4.00..7.00 by 0.05 is 61 values', () => {
    const r = rangeLengths(S2)
    expect(r).toHaveLength(61); expect(r[0]).toBe(4); expect(r[60]).toBe(7)
  })
  it('an invalid range gives no candidates', () => { expect(rangeLengths({ ...S2, custom_len_step_m: 0 })).toEqual([]) })
})

describe('bestLength', () => {
  it('picks the length that buys the least kg', () => {
    const pieces = Array.from({ length: 8 }, () => pc(2.4))   // 2 per 4.85 m bar
    const b = bestLength(pieces, [6.4, 4.85], S2, [], 0.62)
    expect(b.length_m).toBe(4.85)
  })
  it('never picks an infeasible length', () => {
    expect(bestLength([pc(5.0)], [4.0, 4.5], S2, [], 1)).toBe(null)
  })
})

describe('chooseLengths', () => {
  const groups = [{ key: 'A|F', pieces: Array.from({ length: 8 }, () => pc(2.4)) }]
  it('stock mode always uses the stock length', () => {
    const r = chooseLengths({ groups, mode: 'stock', settings: S2, kgPerM: { 'A|F': 0.62 }, offcutsByGroup: {}, overrides: {} })
    expect(r.byGroup['A|F'].length_m).toBe(6.4)
  })
  it('custom mode below the minimum order falls back to stock and says why', () => {
    const r = chooseLengths({ groups, mode: 'custom', settings: S2, kgPerM: { 'A|F': 0.62 }, offcutsByGroup: {}, overrides: {} })
    expect(r.moqMet).toBe(false); expect(r.reason).toBe('moq'); expect(r.byGroup['A|F'].length_m).toBe(6.4)
  })
  it('custom mode at or above the minimum keeps the custom lengths', () => {
    const big = [{ key: 'A|F', pieces: Array.from({ length: 800 }, () => pc(2.4)) }]
    const r = chooseLengths({ groups: big, mode: 'custom', settings: S2, kgPerM: { 'A|F': 0.62 }, offcutsByGroup: {}, overrides: {} })
    expect(r.moqMet).toBe(true); expect(r.byGroup['A|F'].custom).toBe(true)
  })
})
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement** (append to `cutPlan.js`)

```js
export function rangeLengths(settings) {
  const a = Number(settings.custom_len_min_m), b = Number(settings.custom_len_max_m), s = Number(settings.custom_len_step_m)
  if (!(a > 0 && b >= a && s > 0)) return []
  const out = []
  for (let i = 0; out.length < 400; i++) { const x = mm(a + i * s); if (x > b + EPS) break; out.push(x) }
  return out
}

export function evaluateLength(pieces, L, settings, offcuts, kgPerM) {
  const packed = packWithOffcuts(pieces, L, settings, offcuts)
  let keep = 0, scrap = 0
  for (const b of [...packed.offcutBars, ...packed.bars]) (b.left_m + EPS >= settings.min_keep_offcut_m ? (keep += b.left_m) : (scrap += b.left_m))
  return { length_m: L, newBars: packed.bars.length, kg: packed.bars.length * L * (Number(kgPerM) || 0), scrap_m: scrap, keep_m: keep,
    feasible: packed.unplaced.length === 0, packed }
}

const better = (a, b) => !b || a.kg < b.kg - 1e-6 || (Math.abs(a.kg - b.kg) < 1e-6 && (a.scrap_m < b.scrap_m - EPS ||
  (Math.abs(a.scrap_m - b.scrap_m) < EPS && (a.newBars < b.newBars || (a.newBars === b.newBars && a.length_m < b.length_m)))))

export function bestLength(pieces, candidates, settings, offcuts, kgPerM) {
  let best = null
  for (const L of [...new Set(candidates)]) { const ev = evaluateLength(pieces, L, settings, offcuts, kgPerM); if (ev.feasible && better(ev, best)) best = ev }
  return best
}

export function chooseLengths({ groups, mode, settings, kgPerM, offcutsByGroup, overrides }) {
  const stockL = settings.stock_length_m
  const stockPick = g => ({ length_m: stockL, custom: false, eval: evaluateLength(g.pieces, stockL, settings, (offcutsByGroup || {})[g.key] || [], (kgPerM || {})[g.key]) })
  const byGroup = {}
  if (mode !== 'custom') { for (const g of groups || []) byGroup[g.key] = stockPick(g); return { byGroup, customKg: 0, moqMet: true, reason: null } }
  const cands = [stockL, ...rangeLengths(settings)]
  let customKg = 0
  for (const g of groups || []) {
    const off = (offcutsByGroup || {})[g.key] || []
    const kg = (kgPerM || {})[g.key]
    const ov = overrides && overrides[g.key]
    const forced = ov ? evaluateLength(g.pieces, Number(ov), settings, off, kg) : null
    const ev = forced && forced.feasible ? forced : bestLength(g.pieces, cands, settings, off, kg)
    if (!ev) { byGroup[g.key] = stockPick(g); continue }
    const custom = Math.abs(ev.length_m - stockL) > EPS
    if (custom) customKg += ev.kg
    byGroup[g.key] = { length_m: ev.length_m, custom, eval: ev }
  }
  if (customKg > 0 && customKg < Number(settings.custom_moq_kg)) {
    for (const g of groups || []) byGroup[g.key] = stockPick(g)
    return { byGroup, customKg, moqMet: false, reason: 'moq' }
  }
  return { byGroup, customKg, moqMet: true, reason: null }
}
```

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** — `feat(cut-sheet): custom-length search by least kg with the 1-ton minimum order`.

---

### Task 5: `cutPlan.js` — the whole plan, offcut defaults, signature, issue payload

**Files:** Modify `src/lib/cutPlan.js`; Test `src/lib/cutPlan.test.js`

**Interfaces:**
- Produces:
  - `planSignature(entries) → string` — stable text of every piece (`groupKey|opening_no|role|length|ends`), sorted; same items → same signature.
  - `buildCutPlan({ entries, mode, settings, kgPerM, offcutsByGroup, overrides, groupInfo }) → Plan` where
    `Plan = { signature, mode, customKg, moqMet, reason, groups: [{ key, profile_id, finish_id, die_no, name, finish_name, length_m, custom, offcutBars, bars, unplaced, kg, newOffcuts }] }`
    and `newOffcuts = [{ key, bar_ref, length_m, end_a, keep }]` for every bar remainder ≥ 0.05 m (`bar_ref` = `'N'` new bar number or the stock offcut code), `keep` default = `length_m >= settings.min_keep_offcut_m`. `end_a` = `end_b` of the bar's last piece. `groupInfo` = `{ key: { profile_id, finish_id, die_no, name, finish_name } }`.
  - `issuePayload(plan, flippedKeys:Set) → { p_signature, p_plan, p_used_offcut_ids, p_new_offcuts }` — an offcut is created when `keep !== flippedKeys.has(key)` (the user flips the default either way).

**Ruling:** remainders under 50 mm are saw loss, not offcuts (no sticker). Every other remainder gets a sticker; the default for remainders under `min_keep_offcut_m` is "ไม่เก็บ" (owner ruling 6 lets the user flip either way).

- [ ] **Step 1: Failing tests**

```js
import { planSignature, buildCutPlan, issuePayload } from './cutPlan.js'
describe('buildCutPlan', () => {
  const entries = [entry([line({ length_m: 2.0, quantity: 3 })])]
  const groupInfo = { 'P|F': { profile_id: 'P', finish_id: 'F', die_no: 'F7976', name: 'เฟรม', finish_name: 'ขาว' } }
  it('lists remainders as new offcuts with a keep default from min_keep_offcut_m', () => {
    const plan = buildCutPlan({ entries, mode: 'stock', settings: S2, kgPerM: { 'P|F': 0.5 }, offcutsByGroup: {}, overrides: {}, groupInfo })
    const g = plan.groups[0]
    expect(g.bars).toHaveLength(1)
    expect(g.newOffcuts).toEqual([{ key: 'P|F#1', bar_ref: '1', length_m: 0.391, end_a: 'square', keep: false }])
  })
  it('the signature changes when an item changes and not otherwise', () => {
    expect(planSignature(entries)).toBe(planSignature([entry([line({ length_m: 2.0, quantity: 3 })])]))
    expect(planSignature(entries)).not.toBe(planSignature([entry([line({ length_m: 2.1, quantity: 3 })])]))
  })
  it('issuePayload sends the used stock offcut ids and only the kept new offcuts', () => {
    // offcut 2.05: first 2.0 piece goes on it (0.047 left = saw loss, no offcut); two pieces on a new bar leave 2.394 (kept by default)
    const plan = buildCutPlan({ entries, mode: 'stock', settings: S2, kgPerM: { 'P|F': 0.5 }, offcutsByGroup: { 'P|F': [{ id: 'o1', code: 'OC-0001', length_m: 2.05 }] }, overrides: {}, groupInfo })
    const kept = issuePayload(plan, new Set())
    expect(kept.p_used_offcut_ids).toEqual(['o1'])
    expect(kept.p_new_offcuts).toEqual([{ key: 'P|F#1', profile_id: 'P', finish_id: 'F', length_m: 2.394, end_a: 'square' }])
    expect(issuePayload(plan, new Set(['P|F#1'])).p_new_offcuts).toEqual([])
  })
})
```
(0.391 = 6.4 − 3 × (2.0 + 0.003), rounded to mm.)

- [ ] **Step 2–4: Implement and run.**

```js
export function planSignature(entries) {
  const rows = []
  for (const [key, ps] of piecesOf(entries)) for (const p of ps) rows.push(`${key}|${p.opening_no}|${p.role_name}|${p.length_m}|${p.end_a}|${p.end_b}`)
  return rows.sort().join('\n')
}

const MIN_OFFCUT_M = 0.05

export function buildCutPlan({ entries, mode, settings, kgPerM, offcutsByGroup, overrides, groupInfo }) {
  const pieces = piecesOf(entries)
  const groups = [...pieces.entries()].map(([key, ps]) => ({ key, pieces: ps }))
  const chosen = chooseLengths({ groups, mode, settings, kgPerM, offcutsByGroup, overrides })
  const out = groups.map(g => {
    const c = chosen.byGroup[g.key]
    const { offcutBars, bars, unplaced } = c.eval.packed
    const newOffcuts = []
    const add = (bar, ref) => {
      if (bar.left_m + EPS < MIN_OFFCUT_M) return
      const last = bar.pieces[bar.pieces.length - 1]
      newOffcuts.push({ key: `${g.key}#${ref}`, bar_ref: ref, length_m: mm(bar.left_m), end_a: last ? last.end_b : 'square', keep: bar.left_m + EPS >= settings.min_keep_offcut_m })
    }
    offcutBars.forEach(b => add(b, b.offcut.code))
    bars.forEach((b, i) => add(b, String(i + 1)))
    return { key: g.key, ...(groupInfo || {})[g.key], length_m: c.length_m, custom: c.custom, offcutBars, bars, unplaced, kg: c.eval.kg, newOffcuts }
  })
  return { signature: planSignature(entries), mode, customKg: chosen.customKg, moqMet: chosen.moqMet, reason: chosen.reason, groups: out }
}

// flippedKeys = offcut keys whose keep default the user flipped (ticked "ไม่เก็บ" on a kept one, or unticked it on a dropped one)
export function issuePayload(plan, flippedKeys) {
  const flipped = flippedKeys || new Set()
  const used = []
  const created = []
  for (const g of plan.groups) {
    for (const b of g.offcutBars) used.push(b.offcut.id)
    for (const o of g.newOffcuts) if (o.keep !== flipped.has(o.key)) created.push({ key: o.key, profile_id: g.profile_id, finish_id: g.finish_id || null, length_m: o.length_m, end_a: o.end_a })
  }
  return { p_signature: plan.signature, p_plan: plan, p_used_offcut_ids: used, p_new_offcuts: created }
}
```

- [ ] **Step 5: Commit** — `feat(cut-sheet): whole-project cut plan with offcut keep defaults and the issue payload`.

---

### Task 6: Data hooks and saves

**Files:** Modify `src/hooks/useEstimation2b.js`; Test `src/hooks/useEstimation2bCut.test.js`

**Interfaces:**
- `useOffcuts()` → `useCatalogTable('alu_offcuts', 'code')` (all rows; screens filter `status === 'in_stock'`).
- `useCutPlans()` → `useCatalogTable('alu_cut_plans', 'issued_at')`.
- `issueCutPlan(payload) → { plan_id, offcuts: [{key,id,code}] }` — `supabase.rpc('issue_cut_plan', payload)`; on error throws `new Error(error.message)` (the Thai text from the RPC).
- `voidCutPlan(planId)`; `saveProjectCutMode(projectId, mode)` (`update estimation_projects set cut_mode`); `discardOffcut(id)` (`update alu_offcuts set status='discarded', status_at=now()` filtered by `id` and `status='in_stock'`; throws when 0 rows updated — select back with `.select('id')`).
- `offcutsByGroup(offcuts) → { 'profileId|finishId': [{id, code, length_m}] }` (pure, exported, in-stock only).

- [ ] Step 1: test `offcutsByGroup` (in-stock only, keyed with `''` for a null finish) and `issueCutPlan` with a mocked `supabase.rpc` returning `{ error: { message: 'เศษบางชิ้นถูกใช้…' } }` → rejects with that message.
- [ ] Step 2: run — FAIL. Step 3: implement. Step 4: run — PASS. Step 5: commit `feat(cut-sheet): hooks for offcut stock, cut plans and cut mode`.

---

### Task 7: Cut mode and custom-length summary on the BOM tab

**Files:**
- Create: `src/pages/estimation/CutModeField.jsx`, `src/pages/estimation/CustomLengthSummary.jsx`
- Modify: `src/pages/estimation/ProjectBomView.jsx`, `src/pages/estimation/projectBomHelpers.js`
- Test: `src/pages/estimation/CustomLengthSummary.smoke.test.jsx`, `src/pages/estimation/projectBomHelpers.test.js`

**Behaviour (mockup v5, "ประเภทงาน" + "สรุปการซื้อเส้น"):**
- `CutModeField`: two buttons "งานทั่วไป · เส้น 6.40 ม. หาซื้อได้เลย" / "งานโครงการ · สั่งความยาวพิเศษ"; `canEdit` only; saves via `saveProjectCutMode`, then `onProjectSaved()`. The `6.40` text comes from `settings.stock_length_m`.
- In **stock** mode `ProjectBomView` passes `stock = { byProfile: {}, projectM: null }` to `buildProjectBom` (overrides ignored), hides `ProjectStockField` and `CutOptimizerPanel`.
- In **custom** mode it shows `CustomLengthSummary` and `CutOptimizerPanel`; `candidateLengths` gets a new optional 5th arg `rangeM` (array) merged into the set — pass `rangeLengths(settings)` in custom mode.
- `CustomLengthSummary` props `{ plan, settings, canEdit, onUse(profileId, lengthM), onUseAll() }`; table columns: หน้าตัด, กก./ม., 6.40 ม.: เส้น / กก., ความยาวที่ดีที่สุด (badge "−x.xx กก."), ใช้, เส้นใหม่, เศษสต็อก, กก. ที่ซื้อ, ค่าอลูมิเนียม ฿ (kg × per-kg price via `makeBarPrice(...)(1)` / kg-per-m; show "—" when unpriced). Footer note:
  - `plan.reason === 'moq'`: warning "สั่งความยาวพิเศษรวม X กก. ไม่ถึงขั้นต่ำ Y กก. — ใช้เส้น 6.40 ม. ทั้งโครงการ".
  - else if saving > 0: "ประหยัด X กก. ≈ Y ฿ เทียบกับ 6.40 ม.".
  - "ใช้ทั้งหมด" writes every group's best length through the existing `saveProfileStock`.
- The plan for this tab is built once in `ProjectBomView` with `buildCutPlan` (`useMemo`) from `entries`, `project.cut_mode`, `settings`, `kgPerM` (from `index.profiles[pid].linear_weight_kg_per_m`), `offcutsByGroup(useOffcuts().data)` (only when the "ใช้เศษในสต็อกก่อน" toggle — local state, default on — is on), `overrides = stockForProject(...).byProfile` mapped to group keys.

- [ ] Steps: smoke test renders the MOQ warning for a plan with `reason: 'moq'` and the saving line otherwise; helper test for `candidateLengths(..., rangeM)`; implement; run suite; commit `feat(cut-sheet): normal / project job switch and custom-length summary`.

---

### Task 8: Cut sheet view with issue / void

**Files:** Create `src/pages/estimation/CutSheetView.jsx`; Test `src/pages/estimation/CutSheetView.smoke.test.jsx`; Modify `ProjectBomView.jsx`

**Behaviour (mockup "ใบตัด — แยกตามหน้าตัด"):**
- Props `{ plan, issued, canEdit, onIssue(), onVoid(), busy }` where `issued` = the project's issued `alu_cut_plans` row or null.
- If `issued`: render from `issued.plan` (the snapshot) and show "ยืนยันแล้ว <date>" + button "ยกเลิกใบตัด"; if `issued.signature !== plan.signature` show a warning "ใบตัดไม่ตรงกับรายการปัจจุบัน — ยกเลิกแล้วยืนยันใหม่ถ้าต้องการใบตัดตามรายการล่าสุด".
- Else render the live `plan` and a primary button "ยืนยันใบตัด (ตัดเศษสต็อก + สร้างสติกเกอร์)".
- Per group: header `die · name · finish · เส้น L ม.` (+ tag "สั่งพิเศษ" when custom), `เศษสต็อก n + m เส้นใหม่ · kg`. Stock-offcut bars first (yellow outline, code label), then `groupIdenticalBars(bars)` rows "เส้นที่ a–b × n". Each bar is a flex track: pieces sized `length/L`, coloured per opening_no (8-colour palette cycling), label `mm` + `opening_no role`; remainder hatched (scrap) or green (≥ min keep). `unplaced` pieces listed in red "ตัดไม่ได้ — ยาวเกินเส้น".
- `ProjectBomView` wires `onIssue` → `issueCutPlan(issuePayload(plan, flipped))` (flipped from StickerSheet state lifted to ProjectBomView), then refetch plans + offcuts; errors → `alert(e.message)`.

- [ ] Steps: smoke tests — (a) live plan shows the issue button and "เส้นที่ 1–2" for two identical bars; (b) an issued plan with a different signature shows the mismatch warning; implement; suite; commit `feat(cut-sheet): per-bar cut sheet with issue and void`.

---

### Task 9: Stickers — model, render, PDF

**Files:**
- Create: `src/lib/stickers.js`, `src/lib/stickers.test.js`, `src/lib/stickerRender.js`, `src/pages/estimation/StickerSheet.jsx`, `src/pages/estimation/StickerSheet.smoke.test.jsx`
- Modify: `package.json` (add `"qrcode": "1.5.4"`), `ProjectBomView.jsx`

**Interfaces:**
- `PAPERS = { roll50x30: {w:50,h:30,label:'ม้วน 50×30 มม.'}, roll60x40: {w:60,h:40,...}, roll40x30: {w:40,h:30,...}, a4x24: {sheet:'a4', cols:3, rows:8, w:70, h:37, label:'A4 24 ดวง (70×37 มม.)'} }`
- `stickerModel({ plan, projectName, projectId, items, codes }) → Sticker[]` in cutting order (per group: stock-offcut bars then new bars; each bar's pieces, then its remainder). `items` maps `opening_no → opening id` for the QR. `codes` maps offcut key → code after issue (before issue the offcut sticker shows "OC-ใหม่").
  `Sticker = { kind:'piece'|'offcut', title, length_mm, sub, ends:[a,b], notchText, footL, footR, qr, offKey?, keepDefault? }`
  - piece: `title = "W-01 · กรอบบานตั้ง"`, `sub = "F7980 · อบขาว"`, `notchText = "บากรับกรอบนอน 20×8"` (joint name + `w×d` when sizes known), `footL = projectName`, `footR = "เส้น 3 · 7/24"` (or the offcut code for pieces cut from stock), `qr = '#tab=estimation&project=<projectId>&item=<openingId>'` prefixed by `window.location.origin` at render time.
  - offcut: `title = 'เศษ → เข้าสต็อก'`, `sub = 'F7980 กรอบบาน · อบขาว'`, `ends = [end_a, 'square']`, `footL = 'จาก ' + projectName`, `footR = '<bar> · <dd/mm/yy>'`, `qr = '#tab=estimation&offcut=<code>'`.
- End labels: `square → '90°'`, `miter45 → '45°'`, `notch → 'บาก'`.
- `stickerRender.js`: `qrDataUrl(text) → Promise<string>` (`QRCode.toDataURL(text, { margin: 0, width: 160, errorCorrectionLevel: 'M' })`), `endGlyphDataUrl(a, b) → string` (canvas 140×28 px: bar polygon with slanted ends for 45°, a notch rectangle cut-out for `notch`), `downloadStickersPdf(elementId, paper, filename)` → html2pdf with `jsPDF: { unit:'mm', format: paper.sheet ? 'a4' : [paper.w, paper.h], orientation: paper.w > paper.h ? 'landscape' : 'portrait' }`, `margin: 0`, `pagebreak: { mode: ['css'], after: '.stk-page' }`. **Await the save promise with `.then()` chaining exactly as `downloadPDF` does — html2pdf's worker is a thenable trap (session lesson 2026-10-15): never `await html2pdf().set(...)` without `.from(el).save()` in the same chain.**

**StickerSheet** (props `{ plan, issued, projectName, projectId, openingIds, flipped, onFlip(key) }`): profile select, paper select, sticker grid (preview), each offcut sticker has a checkbox "ไม่เก็บ" (checked = will not be kept; disabled once issued); button "ดาวน์โหลด PDF สติกเกอร์" renders a hidden print container (one `.stk-page` per roll label, or per 24 for A4) and calls `downloadStickersPdf`. Before issue, the PDF button is disabled with the hint "ยืนยันใบตัดก่อน จึงจะได้รหัสเศษสำหรับสติกเกอร์".

- [ ] Steps: `npm i qrcode@1.5.4`; tests for `stickerModel` (order, footR numbering `k/total`, notch text, offcut placeholder code before issue and real code after); smoke test (checkbox disabled when issued); implement; suite; commit `feat(cut-sheet): piece and offcut stickers with QR, end cuts and notch, PDF by label size`.

---

### Task 10: Offcut stock panel and QR deep link

**Files:**
- Create: `src/pages/estimation/OffcutStockPanel.jsx` (+ smoke test)
- Modify: `src/App.jsx:316-317`, `src/pages/Estimation.jsx`, `ProjectBomView.jsx`

**Behaviour:**
- `OffcutStockPanel` (on the BOM tab): in-stock offcuts whose `profile_id|finish_id` matches a group of this project — columns รหัสเศษ, หน้าตัด, ยาว (มม.), มาจาก (source project name), วันที่, ผล ("ใช้ตัด n ท่อน …" from the live plan's offcutBars, or "ยังอยู่ในสต็อก"), and a "ทิ้ง" button (`discardOffcut`, inline confirm row — no `confirm()`).
- Deep link: `App.jsx` accepts `#tab=<id>(&key=value)*`; it sets the tab and stores the extra params in `sessionStorage['deeplink']` (try/catch), then clears the hash. `Estimation.jsx` on mount reads and removes `deeplink`: `project` → `setSelectedProjectId`; `item` → `setItemModal({ id })`; `offcut` → select tab `'bom'` of the source project and scroll to the panel row with that code (or `alert('ไม่พบเศษ ' + code)`).

- [ ] Steps: smoke test for the panel (lists only matching in-stock rows); unit test for a small `parseDeepLink(hash)` helper exported from a new `src/lib/deepLink.js` (`'#tab=estimation&project=a&item=b'` → `{ tab:'estimation', params:{project:'a',item:'b'} }`; old `'#tab=x'` still works; junk → null); implement; suite; commit `feat(cut-sheet): offcut stock panel and QR deep links`.

---

### Task 11: Live check (after the owner applies the migration)

- [ ] Owner applies: `npx supabase db query --project-ref kntspldhvcjeaubtqtkn --linked=false -f /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/alu-cost-catalog/supabase/migrations/2026-10-27-01-cut-plans-offcuts.sql`
- [ ] Re-run the dry-run script: it must now fail on "column already exists" (proves applied) — then verify with `select count(*) from alu_offcuts` = 0.
- [ ] Local dev (`npm run dev` already running in the worktree), project PARLLEL TROPICAL, tab BOM: switch to งานโครงการ → summary shows the MOQ warning (W-01 alone is far below 1 t); switch back; issue the plan; download stickers as roll 50×30 and A4; open one QR text in the browser → item W-01 opens; void the plan → offcuts disappear from stock. Screenshot each step for the owner.
- [ ] Update `docs/handover-aluminium-cost-catalog.md` with the new tables, RPCs and rulings 1–8; commit `docs(cut-sheet): handover`.
