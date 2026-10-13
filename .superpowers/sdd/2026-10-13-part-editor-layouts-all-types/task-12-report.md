# Task 12 (docs part) report

Wrote `# Layouts for every type handover (2026-10-13)` (194 lines) at the end of docs/handover-aluminium-cost-catalog.md, matching the per-arc hierarchy (`---`, top-level title, `##` subsections). Added one "See also" line under §4.1 and one under §5.1 of the parent spec (+4 lines incl. blank lines). No code changed; `npm test -- --run`: 2199 passing.

Contents: what was built, 13-kind table (inputs read from the registry via node, not memory), params columns, SQL (dry-run + apply, exact commands), click-through list, how to add a layout, 23 distinct rulings (R-P1..P7, 3a-c, 4a-b, 5a, 6a-b, 7a, 8a, 9a-c, 10a-b, 11a), open questions, deferred minors grouped by area (41 bullets; each ledger `minor (deferred)` line represented, many merged within a bullet), unbuilt spec items.

Code vs spec/ledger differences noted in the handover:
- Spec §4 says บานเปิดข้างเดี่ยว fixes n = 1 by type; in code `casement_n.n` is estimator-only, not `fixed_by_type`.
- curtain_wall has extra estimator inputs `spandrel`, `k`.
- Ledger R-10b mentions no screenshots path; they live in the main checkout `.playwright-mcp/`, not the worktree.
- Awning 6 type names were not listed in the spec; referred to as "the 6 กระทุ้ง types".
- "sealant from jointCount not priced": jointCount exists in layoutCells.js; I did not verify any caller, taken from the brief.
