-- supabase/migrations/2026-09-18-03-phase-subtasks.sql
--
-- Adds a recursively-nestable Subtask level between Phase (site_phases)
-- and Kanban microtask (phase_tasks) -- spec:
-- docs/superpowers/specs/2026-09-18-gantt-subtask-hierarchy-design.md
--
-- parent_subtask_id NULL means "direct child of phase_id"; non-null means
-- "nested under another phase_subtasks row" -- depth is not a schema
-- concept, it falls out of following this chain. phase_id is carried on
-- EVERY row regardless of depth (denormalized down the whole chain) so
-- "which top-level phase is this under" never needs a recursive walk.
--
-- phase_tasks.subtask_id is nullable: a microtask attaches to a phase
-- directly (subtask_id NULL, today's existing shape, unchanged) OR to a
-- leaf subtask (subtask_id set). App logic enforces "only a leaf may
-- carry microtasks" -- not a DB constraint, matching this schema's
-- existing style of keeping such rules in the write path.

CREATE TABLE phase_subtasks (
  id                     UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phase_id               UUID NOT NULL REFERENCES site_phases(id) ON DELETE CASCADE,
  parent_subtask_id      UUID REFERENCES phase_subtasks(id) ON DELETE CASCADE,
  site_id                UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  tenant_id              UUID NOT NULL,
  name                   TEXT NOT NULL,
  start_date             DATE,
  end_date               DATE,
  billing_weight_pct     NUMERIC NOT NULL DEFAULT 0,
  status                 TEXT NOT NULL DEFAULT 'not_started'
                         CHECK (status IN ('not_started','in_progress','done')),
  depends_on_subtask_id  UUID REFERENCES phase_subtasks(id),
  sort_order             INT NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_phase_subtasks_phase_id ON phase_subtasks(phase_id);
CREATE INDEX idx_phase_subtasks_parent_subtask_id ON phase_subtasks(parent_subtask_id);
CREATE INDEX idx_phase_subtasks_site_id ON phase_subtasks(site_id);

ALTER TABLE phase_subtasks ENABLE ROW LEVEL SECURITY;

-- Same shape as site_phases' own four policies -- ADMIN/OWNER only, flat
-- tenant_id scoping, no join needed (this table carries tenant_id
-- directly). No worker-level policy: workers interact with Kanban cards
-- (phase_tasks), never with subtasks themselves, same as they never
-- touch site_phases directly today.
CREATE POLICY admin_reads ON phase_subtasks FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id());
CREATE POLICY admin_inserts ON phase_subtasks FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_updates ON phase_subtasks FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_deletes ON phase_subtasks FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

-- phase_tasks re-parenting: nullable FK, ON DELETE CASCADE matches the
-- existing phase_tasks.phase_id -> site_phases behavior (deleting a
-- phase already deletes its microtasks today; deleting a subtask does
-- the same for consistency -- the existing delete confirmation dialog's
-- "ลบไม่สามารถย้อนกลับได้" copy already sets that expectation).
ALTER TABLE phase_tasks ADD COLUMN subtask_id UUID REFERENCES phase_subtasks(id) ON DELETE CASCADE;
CREATE INDEX idx_phase_tasks_subtask_id ON phase_tasks(subtask_id);
