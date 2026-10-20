# BOQ % per phase + company phase template — design, 2026-10-20

Mockup: https://claude.ai/artifact/KUmuM4Env22zgk7ypm6c5u, boards 17 (company template) and 18 (BOQ tab matrix + one-click cards).

## Owner decisions
- **Company phase template.** Each tenant has a phase template: names, order and a weight % per phase that sums to 100. Settings › "🧩 แม่แบบเฟสงาน", editable by OWNER only. Not set = the built-in 7 phases (5/15/5/30/30/10/5). The owner's own template is 0/0/0/40/40/20/0.
- **BOQ split matrix.** The site's BOQ tab gets a "% ต่อเฟส" table.
  - Every BOQ item has its own row. Never group items.
  - There is one column for EVERY phase of the site, and every cell is editable.
  - The default for each cell is the template weight of the phase with the same name, or 0 if no name matches.
  - Each row must total 100.
  - OWNER and PM can edit it (`can_manage_plan()`). Others may view it, money roles only. PM sees the value share as "แต้ม", never baht.
- **Phase weights follow the BOQ.** Once a site has a saved split, it is "BOQ mode", and phase weights (`billing_weight_pct`) are computed from it: weight(p) = Σ_i share_i × pct(i,p), where share_i = item value / total BOQ value.
  - In the Gantt the weight field is read-only, with the note "คิดจาก BOQ".
  - Sites without a saved split keep their manually typed weights.
- **BOQ cards are counted per phase.** One BOQ item can have cards in several phases. The sum of card quantities per item **per phase** must not exceed the BOQ quantity. Today the limit is per site.
- **Card points follow the split**, so the site % is exact. Within a node, card value = planned_qty × unit price × pct(item, node's phase)/100.
- **One-click card creation.** PM still creates cards. A Kanban phase column shows "+ การ์ดจาก BOQ (n)" when items with pct > 0 in that phase still have quantity left there.
  - The button opens a list with every row pre-ticked at the full remaining quantity. One button creates them all.
  - The card name is the BOQ description, and the card is a BOQ card (progress_mode 'quantity').

## Data
- **Template:** stored as `app_settings` key `phase_template`, JSON `[{name, sort_order, weight}]`. Write through `saveAppSetting`. Read with a default.
- **New table `boq_phase_splits`** (one row per item × phase):

  | column | definition |
  |---|---|
  | `tenant_id` | |
  | `boq_item_id` | FK boq_items, ON DELETE CASCADE |
  | `phase_id` | FK site_phases, ON DELETE CASCADE |
  | `pct` | numeric(5,2), 0–100 |

  - PK (boq_item_id, phase_id).
  - RLS: read for site staff with money access or PM, following the existing boq_items policy. Write only for can_manage_plan() with tenant_can_write().
- **Save path.** A SECURITY INVOKER RPC `save_boq_phase_splits(p_site uuid, p_rows jsonb)` replaces the site's rows in one transaction.
  - It validates that each item's row sums to 100.
  - It validates that every item and phase belongs to the site.
  - It then recomputes the site's phase weights and node card points.
- **Default for new BOQ items.** A BOQ item added later to a BOQ-mode site gets default rows from the tenant template (name match) via a trigger. The phase weights are then recomputed.
- `recompute_node_weights`: when the site is in BOQ mode, card value is multiplied by pct/100. Otherwise it is unchanged.
- `check_boq_qty`: the per-item sum is grouped by the card's phase_id. Cards on a subtask count under the subtask's phase.

## Out of scope
- LINE status card changes.
- Splitting general (non-BOQ) cards.
- VO phases: they keep their current behaviour and are excluded from BOQ-mode weights (weight 0).
