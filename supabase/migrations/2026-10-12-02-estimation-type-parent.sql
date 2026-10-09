-- Parent/child door-window types (three levels). Additive; estimation-only table (RLS already module-gated).
ALTER TABLE door_window_types DROP CONSTRAINT IF EXISTS door_window_types_category_check;
ALTER TABLE door_window_types
  ADD CONSTRAINT door_window_types_category_check CHECK (category IN ('door','window','curtain_wall'));

ALTER TABLE door_window_types
  ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES door_window_types(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_door_window_types_parent_id ON door_window_types(parent_id);

CREATE OR REPLACE FUNCTION door_window_types_check_parent() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE p1 RECORD; p2 RECORD; depth_above INT := 0; height INT := 1;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF EXISTS (SELECT 1 FROM door_window_types WHERE parent_id = NEW.id AND category <> NEW.category) THEN
      RAISE EXCEPTION 'cannot change the category: child types have another category';
    END IF;
    IF EXISTS (SELECT 1 FROM door_window_types WHERE parent_id = NEW.id) THEN height := 2; END IF;
    IF EXISTS (SELECT 1 FROM door_window_types c JOIN door_window_types g ON g.parent_id = c.id WHERE c.parent_id = NEW.id) THEN
      height := 3;
    END IF;
  END IF;
  IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.parent_id = NEW.id THEN RAISE EXCEPTION 'a type cannot be its own parent'; END IF;
  SELECT id, tenant_id, category, parent_id INTO p1 FROM door_window_types WHERE id = NEW.parent_id;
  IF NOT FOUND OR p1.tenant_id <> NEW.tenant_id THEN RAISE EXCEPTION 'parent type not found in this tenant'; END IF;
  IF p1.category <> NEW.category THEN RAISE EXCEPTION 'a child type must have the same category as its parent'; END IF;
  depth_above := 1;
  IF p1.parent_id IS NOT NULL THEN
    IF p1.parent_id = NEW.id THEN RAISE EXCEPTION 'a type cannot be moved under its own child'; END IF;
    SELECT id, parent_id INTO p2 FROM door_window_types WHERE id = p1.parent_id;
    depth_above := 2;
    IF p2.parent_id IS NOT NULL THEN
      IF p2.parent_id = NEW.id THEN RAISE EXCEPTION 'a type cannot be moved under its own child'; END IF;
      depth_above := 3;
    END IF;
  END IF;
  IF depth_above + height > 3 THEN RAISE EXCEPTION 'types have at most three levels'; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_door_window_types_check_parent ON door_window_types;
CREATE TRIGGER trg_door_window_types_check_parent
  BEFORE INSERT OR UPDATE OF parent_id, category, tenant_id ON door_window_types
  FOR EACH ROW EXECUTE FUNCTION door_window_types_check_parent();
