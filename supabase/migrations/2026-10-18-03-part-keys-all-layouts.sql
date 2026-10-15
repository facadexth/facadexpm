-- Part-editor rows for every layout kind. 2026-10-15-01 created bom_template_parts.part_key and
-- bom_template_positions.position_key with CLOSED lists of the sliding_2 keys only; 2026-10-17-01 widened the
-- layout_kind CHECKs but not these, so no template of another kind (and no sliding_2 template with ธรณีกันบานเลื่อน,
-- position sill_guard) could be saved. Found 2026-10-15 while generating templates for every type.
-- The keys are defined by the layouts in code (src/lib/layouts/*.js, validated by partSave before every write), so the
-- database now checks the key FORMAT instead of a list that every new layout would have to repeat.
-- Additive in effect (only loosens), re-runnable. No view selects these tables with .* (grepped). Needs 2026-10-15-01.
ALTER TABLE bom_template_parts DROP CONSTRAINT IF EXISTS bom_template_parts_part_key_check;
ALTER TABLE bom_template_parts ADD CONSTRAINT bom_template_parts_part_key_check CHECK (part_key ~ '^[a-z][a-z0-9_]{0,39}$');
ALTER TABLE bom_template_positions DROP CONSTRAINT IF EXISTS bom_template_positions_position_key_check;
ALTER TABLE bom_template_positions ADD CONSTRAINT bom_template_positions_position_key_check CHECK (position_key ~ '^[a-z][a-z0-9_]{0,39}$');
