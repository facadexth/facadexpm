// _shared/lineTaskRules.ts -- which Kanban cards a worker may close, and what to say when not.
// Pure (no Deno imports) so vitest can import it. Missing columns (migration not applied yet)
// mean: progress_mode defaults to 'status', no children info means no children.

export type WorkerTaskLike = {
  progress_mode?: string | null
  parent_task_id?: string | null
  has_children?: boolean | null
}

export const QUANTITY_BLOCKED_MESSAGE = 'งานนี้นับเป็นจำนวน ให้ PM บันทึกยอดในแอป'
export const PARENT_BLOCKED_MESSAGE = 'งานนี้มีงานย่อย ให้กดเสร็จที่งานย่อย'
export const PLAN_GATE_MESSAGE = 'ไซท์นี้ยังไม่มี PLAN แจ้ง PM ให้บันทึก PLAN v1 ก่อน'

const isParent = (t: WorkerTaskLike) => t.has_children === true
const isQuantity = (t: WorkerTaskLike) => (t.progress_mode ?? 'status') === 'quantity'

export function isWorkerDoneable(t: WorkerTaskLike): boolean {
  return (t.progress_mode ?? 'status') === 'status' && !isParent(t)
}

export function doneBlockedMessage(t: WorkerTaskLike): string | null {
  if (isQuantity(t)) return QUANTITY_BLOCKED_MESSAGE
  if (isParent(t)) return PARENT_BLOCKED_MESSAGE
  return null
}

// Maps a DB error from the status update to the reply text, or null if it is some other error.
export function doneErrorReply(message: string | null | undefined): string | null {
  const m = message ?? ''
  if (m.includes('บันทึก PLAN v1')) return PLAN_GATE_MESSAGE
  if (m.includes(QUANTITY_BLOCKED_MESSAGE)) return QUANTITY_BLOCKED_MESSAGE
  if (m.includes('สถานะงานหลักคิดจากงานย่อย')) return PARENT_BLOCKED_MESSAGE
  return null
}
