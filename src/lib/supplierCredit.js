// ============================================================
// supplierCredit — pure logic for supplier credit-term gating,
// extracted from ExpenseForm (src/pages/Expenses.jsx) so it's
// unit-testable without rendering the form.
// ============================================================

/** เครดิตเทอมของ Supplier (วัน) — null = ไม่มีเครดิต (จ่ายสด/โอนทันที) */
export function creditTermDays(supplier) {
  return supplier?.credit_days ?? null
}

/** วิธีชำระที่เลือกได้ ตาม credit_days ของ supplier ที่เลือก (หรือยังไม่เลือก) */
export function paymentMethodOptions(supplier) {
  const hasCredit = !supplier || supplier.credit_days != null
  return hasCredit ? ['transfer', 'check', 'cash', 'credit'] : ['transfer', 'cash']
}

/** ช่องที่ setBillingDate ควรเขียนวันครบกำหนดลงไป ตามวิธีชำระ */
export function billingDueTargetField(paymentMethod) {
  return paymentMethod === 'check' ? 'check_date' : 'due_date'
}

/** วันครบกำหนด = วันวางบิล + เครดิตเทอม (ISO date string) */
export function calcDueDate(billingDateStr, days) {
  const d = new Date(billingDateStr)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

/** เมื่อเปลี่ยน Supplier — รีเซ็ต payment_method เป็น 'transfer' ถ้าวิธีเดิม (check/credit)
 *  ใช้ไม่ได้กับ supplier ใหม่ที่ไม่มีเครดิตเทอม */
export function resolvePaymentMethodOnSupplierChange(currentMethod, newSupplierHasCredit) {
  if (!newSupplierHasCredit && (currentMethod === 'check' || currentMethod === 'credit')) return 'transfer'
  return currentMethod
}
