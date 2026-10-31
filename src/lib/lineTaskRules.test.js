import { describe, it, expect } from 'vitest'
import { isWorkerDoneable, doneBlockedMessage, doneErrorReply } from '../../supabase/functions/_shared/lineTaskRules.ts'

const status = { progress_mode: 'status', parent_task_id: null, has_children: false }
const quantity = { progress_mode: 'quantity', parent_task_id: null, has_children: false }
const parent = { progress_mode: 'status', parent_task_id: null, has_children: true }
const child = { progress_mode: 'status', parent_task_id: 'P1', has_children: false }

describe('isWorkerDoneable', () => {
  it('status card, child card, and pre-migration card are doneable', () => {
    expect(isWorkerDoneable(status)).toBe(true)
    expect(isWorkerDoneable(child)).toBe(true)
    expect(isWorkerDoneable({})).toBe(true)
  })
  it('quantity and parent cards are not', () => {
    expect(isWorkerDoneable(quantity)).toBe(false)
    expect(isWorkerDoneable(parent)).toBe(false)
  })
})

describe('doneBlockedMessage', () => {
  it('explains quantity and parent cards, null otherwise', () => {
    expect(doneBlockedMessage(quantity)).toBe('งานนี้นับเป็นจำนวน ให้ PM บันทึกยอดในแอป')
    expect(doneBlockedMessage(parent)).toBe('งานนี้มีงานย่อย ให้กดเสร็จที่งานย่อย')
    expect(doneBlockedMessage(status)).toBeNull()
    expect(doneBlockedMessage(child)).toBeNull()
  })
})

describe('doneErrorReply', () => {
  it('maps DB errors by substring', () => {
    expect(doneErrorReply('บันทึก PLAN v1 ของไซท์นี้ก่อนเริ่มบันทึกความคืบหน้า')).toBe('ไซท์นี้ยังไม่มี PLAN แจ้ง PM ให้บันทึก PLAN v1 ก่อน')
    expect(doneErrorReply('งานนี้นับเป็นจำนวน ให้ PM บันทึกยอดในแอป')).toBe('งานนี้นับเป็นจำนวน ให้ PM บันทึกยอดในแอป')
    expect(doneErrorReply('สถานะงานหลักคิดจากงานย่อย')).toBe('งานนี้มีงานย่อย ให้กดเสร็จที่งานย่อย')
    expect(doneErrorReply('boom')).toBeNull()
    expect(doneErrorReply(undefined)).toBeNull()
  })
})
