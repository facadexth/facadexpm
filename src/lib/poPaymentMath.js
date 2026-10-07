// src/lib/poPaymentMath.js
// Pure mirrors of create_po_deposit (deposit split) and split_payment (partial payment by splitting a bill),
// supabase/migrations/2026-10-09-02-po-receipt-rpcs.sql. The RPCs are the authority.
import { round2 } from './depositMath.js'
import { VAT_RATE } from './invoiceCalc.js'

const EPS = 0.005

export const DEPOSIT_INPUT_TEXT = {
  bad_deposit_value: 'กรอกเปอร์เซ็นต์ (มากกว่า 0 ไม่เกิน 100) หรือจำนวนเงินที่มากกว่า 0',
  deposit_exceeds_po: 'ยอดมัดจำเกินยอดใบสั่งซื้อ',
}

export const SPLIT_INPUT_TEXT = {
  bad_split_amount: 'ยอดที่จ่ายต้องมากกว่า 0 และน้อยกว่ายอดบิล',
  bill_bad_split: 'ยอดก่อน VAT + VAT ของบิลนี้ไม่เท่ากับยอดรวม — แก้ที่หน้ารายจ่ายก่อน',
}

/** Deposit created from a PO: percent (0, 100] of the PO total incl. VAT, or an amount incl. VAT. */
export function depositFromPo({ mode, value, poTotal, hasVat }) {
  const v = Number(value)
  if (mode !== 'percent' && mode !== 'amount') return { code: 'bad_deposit_value' }
  if (value === '' || value == null || !Number.isFinite(v) || v <= 0) return { code: 'bad_deposit_value' }
  if (mode === 'percent' && v > 100) return { code: 'bad_deposit_value' }
  const total = round2(poTotal)
  const gross = mode === 'percent' ? round2((v / 100) * total) : round2(v)
  if (gross <= 0 || total <= 0) return { code: 'bad_deposit_value' }
  if (gross > total + EPS) return { code: 'deposit_exceeds_po', gross }
  const net = hasVat ? round2(gross / (1 + VAT_RATE)) : gross
  const vat = round2(gross - net)
  const pctOfPo = Math.max(0.0001, Math.round((gross / total) * 100 * 10000) / 10000)
  return { code: null, gross, net, vat, pctOfPo }
}

/** Pay part of a pending bill: the paid part keeps VAT in proportion; the rest is exact (no satang lost). */
export function splitPaymentAmounts(bill, pay) {
  const amount = round2(bill.amount)
  const p = Number(pay)
  if (pay === '' || pay == null || !Number.isFinite(p)) return { code: 'bad_split_amount' }
  const paid = round2(p)
  if (amount <= 0 || paid <= 0 || paid >= amount - EPS) return { code: 'bad_split_amount' }
  const hasSplit = bill.amount_no_vat != null && bill.vat != null
  if (!hasSplit) return { code: null, paid: { amount: paid, net: null, vat: null }, rest: { amount: round2(amount - paid), net: null, vat: null } }
  const net = Number(bill.amount_no_vat)
  const vat = Number(bill.vat)
  if (Math.abs(round2(net + vat) - amount) > EPS) return { code: 'bill_bad_split' }
  const paidVat = round2((paid * vat) / amount)
  const paidNet = round2(paid - paidVat)
  return {
    code: null,
    paid: { amount: paid, net: paidNet, vat: paidVat },
    rest: { amount: round2(amount - paid), net: round2(net - paidNet), vat: round2(vat - paidVat) },
  }
}
