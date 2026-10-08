// ============================================================
// Orchestration for one PO document scan, with every side effect
// injected so the ORDER of steps is unit-testable (see
// docs/superpowers/specs/2026-10-05-po-extract-tiered-fallback-design.md,
// "Relationship to the scan-credit purchase design"):
//   cache -> quota -> model pass(es) -> usage + cache write.
// A cache hit skips quota/usage entirely; usage is written only for a
// result that is returned to the user.
// ============================================================
import { classifyModelOutput, withExtractionDefaults, type Extraction } from './scan-logic.ts'

export const TIME_BUDGET_MS = 100_000
export const ESCALATE_ONLY_BEFORE_MS = 40_000

export type ModelCall =
  | { ok: true; text: string; stopReason: string | null; inputTokens: number | null; outputTokens: number | null }
  | { ok: false; detail: string }

export type ScanDeps = {
  cheapFirst: boolean
  cheapModel: string
  strongModel: string
  now(): number
  lookupCache(key: string): Promise<Extraction | null>
  storeCache(key: string, result: Extraction): Promise<void>
  checkQuota(): Promise<{ ok: true; allowed: boolean } | { ok: false }>
  callModel(model: string, deadlineMs: number): Promise<ModelCall>
  recordUsage(info: { model: string; inputTokens: number | null; outputTokens: number | null }): Promise<void>
}

export type ScanOutcome = { status: number; body: Record<string, unknown> }

const QUOTA_MSG = 'ใช้โควต้าการสแกนเอกสารในเดือนนี้ครบแล้ว กรุณาอัพเกรดแพ็กเกจหรือรอรอบเดือนถัดไป'
const TOO_LONG_MSG = 'เอกสารนี้มีรายการเยอะเกินไป AI ตอบไม่ทันจบภายในขีดจำกัด กรุณาสแกนทีละหน้า/ทีละส่วนที่มีตารางรายการ หรือกรอกใบสั่งซื้อด้วยตนเอง'
const UNREADABLE_MSG = 'อ่านเอกสารนี้ไม่ออก (ภาพไม่ชัดหรือไม่พบตารางรายการ) กรุณาถ่ายใหม่ให้ชัดขึ้น หรือกรอกใบสั่งซื้อด้วยตนเอง'
const MALFORMED_MSG = 'อ่านผลลัพธ์จาก AI ไม่สำเร็จ (ไม่ใช่ JSON ที่ถูกต้อง)'
const CHECK_FAILED_MSG = 'ผลลัพธ์จาก AI ไม่ผ่านการตรวจความถูกต้อง'

const fail = (status: number, code: string, error: string): ScanOutcome => ({ status, body: { error, code } })

export async function runScan(deps: ScanDeps, cacheKey: string): Promise<ScanOutcome> {
  const cached = await deps.lookupCache(cacheKey).catch(() => null)
  if (cached) return { status: 200, body: { ...withExtractionDefaults(cached), cache_hit: true } }

  const quota = await deps.checkQuota()
  if (!quota.ok) return fail(500, 'quota_check_failed', 'ตรวจสอบโควต้าไม่สำเร็จ')
  if (!quota.allowed) return fail(429, 'quota_exhausted', QUOTA_MSG)

  const start = deps.now()
  const deadline = start + TIME_BUDGET_MS
  const models = deps.cheapFirst ? [deps.cheapModel, deps.strongModel] : [deps.strongModel]
  let inputTokens = 0
  let outputTokens = 0
  let sawTokens = false
  let lastFailure: ScanOutcome = fail(502, 'ai_unavailable', 'เรียก AI ไม่สำเร็จ')

  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    const isLast = i === models.length - 1
    if (i > 0 && deps.now() - start > ESCALATE_ONLY_BEFORE_MS) break

    const call = await deps.callModel(model, deadline)
    if (!call.ok) {
      lastFailure = fail(502, 'ai_unavailable', `เรียก AI ไม่สำเร็จ: ${call.detail}`)
      continue
    }
    if (call.inputTokens != null || call.outputTokens != null) {
      sawTokens = true
      inputTokens += call.inputTokens ?? 0
      outputTokens += call.outputTokens ?? 0
    }
    if (call.stopReason === 'max_tokens') return fail(502, 'too_long', TOO_LONG_MSG)

    const c = classifyModelOutput(call.text)
    // Accept a clean answer from any pass; accept a check-failed answer only
    // from the LAST pass (the user reviews it), and never an empty one.
    if (c.kind === 'ok' || (isLast && c.kind === 'check_failed' && c.reason !== 'no_items')) {
      await deps.recordUsage({
        model,
        inputTokens: sawTokens ? inputTokens : null,
        outputTokens: sawTokens ? outputTokens : null,
      }).catch(() => {})
      if (c.kind === 'ok') await deps.storeCache(cacheKey, c.result).catch(() => {})
      return { status: 200, body: { ...c.result, model_used: model } }
    }

    if (c.kind === 'reject') lastFailure = fail(422, 'unreadable', UNREADABLE_MSG)
    else if (c.kind === 'check_failed') {
      lastFailure = c.reason === 'no_items' ? fail(422, 'unreadable', UNREADABLE_MSG) : fail(502, 'ai_unavailable', CHECK_FAILED_MSG)
    } else lastFailure = fail(502, 'ai_unavailable', MALFORMED_MSG)
  }
  return lastFailure
}
