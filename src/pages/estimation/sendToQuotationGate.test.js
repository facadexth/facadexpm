import { describe, it, expect } from 'vitest'
import { canSendToQuotation } from './sendToQuotationGate.js'

const ok = { canEditEstimation: true, hasEstimation: true, hasQuotations: true, isAdmin: true, canEditQuotations: true }
describe('canSendToQuotation', () => {
  it('allows only when every condition holds', () => {
    expect(canSendToQuotation(ok)).toBe(true)
    for (const k of Object.keys(ok)) expect(canSendToQuotation({ ...ok, [k]: false })).toBe(false)
  })
})
