// Browser access to the shared repair-ticket status rules (labels, steps, allowed moves).
// One source of truth with the LINE webhook: supabase/functions/_shared/repair.ts.
export { REPAIR_STATUS, REPAIR_STEPS, canMove, startTime } from '../../supabase/functions/_shared/repair.ts'
