# Supplier catalogue extraction brief (owner request 2026-10-16)

Owner: "the ALUMNIUM CATALOG folder holds the catalogues of every supplier we use, including how each series is
assembled. Use them to build the formulas, the live preview and the aluminium series DB."

Source PDFs: /Users/plfx/code/FacadeXPM/facadex-app/DOC/ALUMNIUM CATALOG/ (read-only).
Pre-rendered pages (JPEG, long edge 2000 px, rotation already applied) + PDF text layer, one folder per PDF:
/private/tmp/claude-501/-Users-plfx-code-FacadeXPM-facadex-app/b2f8c48c-54bd-40ef-b3cd-c4b9b6b00bea/scratchpad/cat/NN/
  SOURCE.txt (the PDF file name), pNNN.jpg, text.txt ("=== PAGE n ===" separated; empty for scanned PDFs).
For small print, crop/enlarge with `sips` (e.g. `sips -c H W --cropOffset Y X in.jpg --out out.jpg`, then `sips -Z 2000`)
into your own scratch folder .../scratchpad/catwork/<your-group>/. Or re-render one page bigger with the PDFKit tool
.../scratchpad/render3 "<pdf>" <outdir> 4000 (renders ALL pages of that pdf — copy the page you need, delete the rest).

## What the app needs (target DB, see supabase/migrations/2026-10-10-0{1,2,3}-alu-catalog-*.sql, 2026-10-12-01-*.sql)
alu_providers(name, short_name, price_basis per_kg|per_piece|both) → alu_series(provider, name) → alu_series_types
(series ↔ door_window_types by Thai type name) ; alu_profiles(provider, name, drawing_no = die no., family = role
name used by the BOM templates, thickness_mm, linear_weight_kg_per_m, default_length_m, width_mm = wide face,
depth_mm = narrow face, primary_contact width|depth, butt_distance_mm = how much a butting bar is shortened against
it, often half/whole of a dimension or a notch) ; alu_series_profiles(series, profile, family) ; alu_finishes ;
alu_kg_prices / alu_piece_prices ; alu_parts (hardware / accessories) per series and type.
The BOM templates use Thai "family" (role) names such as กล่องร่อง, กล่องเรียบ, กล่องเปิด, ฝาปิด, ฝาตบร่อง,
เฟรมบน 2 ราง, เฟรมล่าง 2 ราง, เฟรมข้าง 2 ราง, เสากุญแจ, เสาเกี่ยว, ขวางบน, ขวางล่าง, กรอบในบานกระทุ้ง,
กรอบนอกบานกระทุ้ง, คิ้ว, ธรณี, ตบธรณี … Map each catalogue profile to the closest role; invent a clear Thai role name
when none fits and list it under new_families.

## Output (write ONLY under docs/catalogs/<group>/ in the worktree; do NOT commit; do not edit code; no SQL; no DB)
Per PDF, one JSON + one short markdown:
docs/catalogs/<group>/<slug>.json
{
  "source_pdf": "...", "supplier": "...", "brand": "...", "catalogue_year": "...", "pages": N,
  "page_index": [{"page": 1, "content": "cover|toc|series overview|profile table|section drawing|assembly|cut formula|price|hardware|other", "series": "..."}],
  "series": [{
    "name": "as printed", "system": "sliding window|sliding door|awning|casement|fixed|swing door|folding|hanging|curtain wall|louvre|other",
    "app_types": ["Thai door_window_types names it fits, e.g. บานเลื่อนสวน 2 บาน"], "frame_size_mm": "e.g. 101.6x44.5",
    "profiles": [{"die_no": "...", "name": "as printed", "role_family": "Thai role", "kg_per_m": 0.0, "width_mm": null,
                  "depth_mm": null, "wall_mm": null, "std_length_m": null, "page": n, "confidence": "read|estimated"}],
    "assembly": [{"type": "...", "page": n, "joints": "which member runs through, which butts, mitre?",
                  "cut_formulas": [{"member": "...", "formula_as_printed": "...", "formula_normalised": "W - 2*44.5 + 6 etc"}],
                  "glass_formula": "...", "clearances_mm": "...", "sash_overlap_mm": "...", "notes": "..."}],
    "hardware": [{"name": "...", "code": "...", "per": "per sash/door/set", "qty": n, "page": n}],
    "accessories": [...], "prices": [{"die_no|item": "...", "finish": "...", "price": 0, "unit": "บาท/กก.|บาท/เส้น|บาท/ชิ้น", "page": n}]
  }],
  "new_families": ["..."], "open_questions": ["Thai, short, for the owner"], "unreadable_pages": [n]
}
docs/catalogs/<group>/<slug>.md — one screen: what the catalogue is, its series, which app types each serves, the
assembly/cut rules in plain words, the pages a human should look at, and what could not be read.
Never invent numbers: a value not printed is null; a value read from a blurry drawing is confidence "estimated".
Copy formulas exactly as printed first, then normalise.
