-- ปัญหาหน้างาน (LINE issue reports) become a Kanban card on the site's board.
--
-- Every site gets ONE special phase "🚧 ปัญหาหน้างาน" (site_phases.is_issue_phase) created on
-- the first report. It has no dates and 0% billing weight, and the app hides it from the Gantt,
-- S-curve, schedule pickers and the phase editor (see useSitePhases); only the Kanban shows it.
-- A card links to its report (phase_tasks.issue_report_id). Moving the card to "เสร็จแล้ว"
-- resolves the report (so the 🔔 mark and the notification count go away), and resolving the
-- report elsewhere closes the card. The reverse also holds: reopening one reopens the other.

ALTER TABLE site_phases ADD COLUMN IF NOT EXISTS is_issue_phase BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_site_issue_phase ON site_phases (site_id) WHERE is_issue_phase;

ALTER TABLE phase_tasks ADD COLUMN IF NOT EXISTS issue_report_id UUID UNIQUE REFERENCES line_issue_reports(id) ON DELETE SET NULL;

-- Called by line-webhook (service role) right after it saves a report. Idempotent.
CREATE OR REPLACE FUNCTION create_issue_card(p_report_id UUID) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r line_issue_reports%ROWTYPE;
  v_phase UUID;
  v_task  UUID;
BEGIN
  SELECT * INTO r FROM line_issue_reports WHERE id = p_report_id;
  IF NOT FOUND OR r.site_id IS NULL THEN RETURN NULL; END IF;

  SELECT id INTO v_phase FROM site_phases WHERE site_id = r.site_id AND is_issue_phase;
  IF v_phase IS NULL THEN
    INSERT INTO site_phases (site_id, tenant_id, name, sort_order, status, billing_weight_pct, is_issue_phase)
    VALUES (r.site_id, r.tenant_id, '🚧 ปัญหาหน้างาน', 9999, 'in_progress', 0, true)
    ON CONFLICT (site_id) WHERE is_issue_phase DO NOTHING
    RETURNING id INTO v_phase;
    IF v_phase IS NULL THEN SELECT id INTO v_phase FROM site_phases WHERE site_id = r.site_id AND is_issue_phase; END IF;
  END IF;

  INSERT INTO phase_tasks (phase_id, site_id, tenant_id, name, status, sort_order, issue_report_id)
  VALUES (v_phase, r.site_id, r.tenant_id, left(regexp_replace(r.message, '\s+', ' ', 'g'), 120),
          CASE WHEN r.status = 'resolved' THEN 'done' ELSE 'not_started' END,
          COALESCE((SELECT max(sort_order) + 1 FROM phase_tasks WHERE phase_id = v_phase), 0), r.id)
  ON CONFLICT (issue_report_id) DO NOTHING
  RETURNING id INTO v_task;
  RETURN v_task;
END $$;
REVOKE ALL ON FUNCTION create_issue_card(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_issue_card(UUID) TO service_role;

-- card -> report
CREATE OR REPLACE FUNCTION sync_issue_report_from_card() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE line_issue_reports
     SET status = CASE WHEN NEW.status = 'done' THEN 'resolved' ELSE 'open' END
   WHERE id = NEW.issue_report_id
     AND status IS DISTINCT FROM CASE WHEN NEW.status = 'done' THEN 'resolved' ELSE 'open' END;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION sync_issue_report_from_card() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_sync_issue_report_from_card ON phase_tasks;
CREATE TRIGGER trg_sync_issue_report_from_card AFTER UPDATE OF status ON phase_tasks
  FOR EACH ROW WHEN (NEW.issue_report_id IS NOT NULL AND NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION sync_issue_report_from_card();

-- report -> card
CREATE OR REPLACE FUNCTION sync_issue_card_from_report() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'resolved' THEN
    UPDATE phase_tasks SET status = 'done' WHERE issue_report_id = NEW.id AND status <> 'done';
  ELSE
    UPDATE phase_tasks SET status = 'not_started' WHERE issue_report_id = NEW.id AND status = 'done';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION sync_issue_card_from_report() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_sync_issue_card_from_report ON line_issue_reports;
CREATE TRIGGER trg_sync_issue_card_from_report AFTER UPDATE OF status ON line_issue_reports
  FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION sync_issue_card_from_report();
