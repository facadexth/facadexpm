-- Owner 2026-11-01 (artifact comment): saw kerf straight 3 mm, 45-degree 5 mm. Tenant 1b9affc4 had no settings row (defaults 3 / 10).
BEGIN;
INSERT INTO estimation_settings (tenant_id, kerf_square_mm, kerf_miter_mm)
VALUES ('1b9affc4-2136-4ed1-b168-a36e6624e743', 3, 5)
ON CONFLICT (tenant_id) DO UPDATE SET kerf_square_mm = 3, kerf_miter_mm = 5;
SELECT tenant_id, stock_length_m, kerf_square_mm, kerf_miter_mm, min_keep_offcut_m FROM estimation_settings WHERE tenant_id = '1b9affc4-2136-4ed1-b168-a36e6624e743';
COMMIT;
