-- Phase template is now applied on-demand from the Gantt tab's own "+ เริ่มใช้ Gantt"
-- button (GanttView.jsx), not automatically on every new site. Existing sites that
-- already got auto-seeded keep their phase rows untouched -- this only stops new
-- sites created going forward from getting them automatically.
DROP TRIGGER IF EXISTS trg_seed_site_phases ON sites;
-- seed_site_phases() function itself is left in place (unused now, harmless) in case
-- a future admin "reset to template" action wants to reuse its exact phase list.
