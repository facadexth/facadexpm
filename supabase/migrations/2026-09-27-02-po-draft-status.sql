-- Lets a LINE crew-bot material request create a REAL purchase_orders
-- row straight away (status 'draft'), instead of a separate approval
-- table nobody but ADMIN/OWNER ever saw. supplier_id becomes nullable
-- (a worker in the field has no way to know which supplier to order
-- from -- that's exactly the ADMIN follow-up step) and the status check
-- gains 'draft' alongside the existing three. PurchaseOrders.jsx's edit
-- gate widens to cover 'draft' rows in the same commit that adds this
-- migration -- a draft PO with no edit button reachable would be a dead
-- end for the very admin follow-up this exists for.
ALTER TABLE purchase_orders ALTER COLUMN supplier_id DROP NOT NULL;

ALTER TABLE purchase_orders DROP CONSTRAINT purchase_orders_status_check;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_status_check
  CHECK (status = ANY (ARRAY['draft'::text, 'ordered'::text, 'received'::text, 'cancelled'::text]));
