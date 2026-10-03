import { describe, it, expect } from 'vitest'
import { jobDonePrompt, jobDoneConfirmation, JOB_DONE_CONFIRM_CHIP } from '../../supabase/functions/_shared/job-done-messages.ts'

describe('job done wording', () => {
  it('says photos are optional and offers the one-tap confirm chip', () => {
    const p = jobDonePrompt('ติดตั้งกระจก')
    expect(p).toContain('ติดตั้งกระจก')
    expect(p).toContain('ไม่ต้องส่งซ้ำ')
    expect(p).not.toContain('ส่งรูปงานเสร็จมาได้เลย')
    expect(JOB_DONE_CONFIRM_CHIP).toEqual({ label: 'เสร็จแล้ว', text: 'เสร็จแล้ว' })
  })
  it('confirms without a photo count when there were no photos', () => {
    expect(jobDoneConfirmation('งาน ก', 0)).toBe('✅ บันทึกงานเสร็จแล้ว "งาน ก" อัปเดตบอร์ดเรียบร้อยครับ')
  })
  it('shows the photo count when photos were sent', () => {
    expect(jobDoneConfirmation('งาน ก', 3)).toContain('(3 รูป)')
  })
})
