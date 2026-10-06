// Comparison helpers for the offline PO-scan evaluation
// (scripts/eval-po-extract.mjs). Lines are aligned by position and scored
// over the EXPECTED lines, so a missing line costs accuracy.

const near = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.005

const normRef = s => String(s || '').toLowerCase().replace(/[\s\-_./#:()]/g, '')

/** Expected deposit deductions found in actual (ref normalized, amount within a satang). Absent expectation = ignored. */
export function depositDeductionsMatch(expected, actual) {
  const exp = expected?.deposit_deductions
  if (!Array.isArray(exp)) return true
  const act = Array.isArray(actual?.deposit_deductions) ? actual.deposit_deductions : []
  return exp.length === act.length && exp.every(e => act.some(a => normRef(a.ref) === normRef(e.ref) && near(a.amount, e.amount)))
}

export function compareExtraction(expected, actual) {
  const exp = expected?.line_items || []
  const act = actual?.line_items || []
  const depositOk = depositDeductionsMatch(expected, actual)
  if (exp.length === 0) return { lineCountMatches: act.length === 0, quantityAcc: 1, unitPriceAcc: 1, unitAcc: 1, depositOk, accuracy: depositOk ? 1 : 0.5 }
  let q = 0, p = 0, u = 0
  exp.forEach((e, i) => {
    const a = act[i]
    if (!a) return
    if (near(e.quantity, a.quantity)) q++
    if (near(e.unit_price, a.unit_price)) p++
    // A document that prints no unit has an empty expected unit: anything the model answers is fine.
    if (!(e.unit || '').trim() || (e.unit || '').trim() === (a.unit || '').trim()) u++
  })
  const n = exp.length
  return {
    lineCountMatches: act.length === exp.length,
    quantityAcc: q / n, unitPriceAcc: p / n, unitAcc: u / n,
    depositOk,
    // a missed/invented deposit deduction costs a quarter (only when the fixture lists deposit_deductions)
    accuracy: Array.isArray(expected?.deposit_deductions) ? ((q + p + u) / (3 * n)) * 0.75 + (depositOk ? 0.25 : 0) : (q + p + u) / (3 * n),
  }
}

export function summariseProvider(rows) {
  const n = rows.length || 1
  return {
    docs: rows.length,
    meanAccuracy: rows.reduce((s, r) => s + r.accuracy, 0) / n,
    checkPassRate: rows.filter(r => r.kind === 'ok').length / n,
    inputTokens: rows.reduce((s, r) => s + (r.inputTokens || 0), 0),
    outputTokens: rows.reduce((s, r) => s + (r.outputTokens || 0), 0),
  }
}

// The shape production saves as a supplier example (and replays as the
// assistant turn): header guesses plus reduced line items. status and
// printed_subtotal are NOT saved, so they are dropped here.
export function pickExampleFields(extracted) {
  const e = extracted || {}
  return {
    supplier_name_guess: e.supplier_name_guess ?? null,
    document_date_guess: e.document_date_guess ?? null,
    reference_no_guess: e.reference_no_guess ?? null,
    line_items: (e.line_items || []).map(li => ({
      description: li.description,
      quantity: li.quantity,
      unit: li.unit,
      unit_price: li.unit_price,
      discount_pct: li.discount_pct ?? 0,
    })),
  }
}
