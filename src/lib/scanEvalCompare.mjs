// Comparison helpers for the offline PO-scan evaluation
// (scripts/eval-po-extract.mjs). Lines are aligned by position and scored
// over the EXPECTED lines, so a missing line costs accuracy.

const near = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.005

export function compareExtraction(expected, actual) {
  const exp = expected?.line_items || []
  const act = actual?.line_items || []
  if (exp.length === 0) return { lineCountMatches: act.length === 0, quantityAcc: 1, unitPriceAcc: 1, unitAcc: 1, accuracy: 1 }
  let q = 0, p = 0, u = 0
  exp.forEach((e, i) => {
    const a = act[i]
    if (!a) return
    if (near(e.quantity, a.quantity)) q++
    if (near(e.unit_price, a.unit_price)) p++
    if ((e.unit || '').trim() === (a.unit || '').trim()) u++
  })
  const n = exp.length
  return {
    lineCountMatches: act.length === exp.length,
    quantityAcc: q / n, unitPriceAcc: p / n, unitAcc: u / n,
    accuracy: (q + p + u) / (3 * n),
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
