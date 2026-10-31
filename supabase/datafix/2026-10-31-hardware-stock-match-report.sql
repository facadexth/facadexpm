-- supabase/datafix/2026-10-31-hardware-stock-match-report.sql
-- READ ONLY (spec section 12). The catalogue's existing parts (no stock link yet) next to stock items with a similar
-- name, for the owner to confirm before any link is made. Nothing is linked automatically.
-- match = 'same name' (case and outer spaces ignored) or 'contains' (one name inside the other). Up to 3 per part.
SELECT p.code, p.name AS part, p.kind, p.unit,
       m.code AS stock_code, m.name AS stock_name, m.base_unit AS stock_unit, c.name AS stock_category,
       CASE WHEN m.id IS NULL THEN 'no match'
            WHEN lower(btrim(m.name)) = lower(btrim(p.name)) THEN 'same name'
            ELSE 'contains' END AS match
  FROM alu_parts p
  LEFT JOIN LATERAL (
    SELECT i.id, i.code, i.name, i.base_unit, i.category_id
      FROM inventory_items i
     WHERE i.tenant_id = p.tenant_id AND i.active
       AND (lower(btrim(i.name)) = lower(btrim(p.name))
            OR position(lower(btrim(p.name)) IN lower(i.name)) > 0
            OR position(lower(btrim(i.name)) IN lower(p.name)) > 0)
     ORDER BY (lower(btrim(i.name)) = lower(btrim(p.name))) DESC, length(i.name), i.name
     LIMIT 3
  ) m ON true
  LEFT JOIN expense_categories c ON c.id = m.category_id
 WHERE p.kind <> 'hardware_set' AND p.inventory_item_id IS NULL
 ORDER BY p.code, match DESC, m.name;
