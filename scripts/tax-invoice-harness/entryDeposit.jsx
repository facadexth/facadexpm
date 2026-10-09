import React from 'react'
import { createRoot } from 'react-dom/client'
import InvoiceTotalsCard, { useDepositChoiceState } from 'SRC/components/InvoiceTotalsCard.jsx'
import { computeInvoiceNet } from 'SRC/lib/invoiceNet.js'

const BAL = 78210
// Host = what CreateInvoiceModal does: choice state at the top, one calc from the shared pipeline, one merged card.
// window.__reserved (default 0) = deposit already promised by other unpaid invoices.
function Host() {
  const [sub, setSub] = React.useState(150000)
  const choice = useDepositChoiceState(30)
  const reservedTotal = window.__reserved || 0
  const free = Math.max(0, BAL - reservedTotal)
  const calc = computeInvoiceNet({
    raw: sub, hasVat: true, priceIncludesVat: false, whtPct: 3, retentionPct: 0, availableOffset: BAL,
    deposit: { enabled: true, mode: choice.mode, text: choice.text, balance: free },
  })
  return (
    <div>
      <input id="sub" type="text" value={sub} onChange={e => setSub(Number(e.target.value) || 0)} />
      <span id="resolved">{calc.depositAmount}</span>
      <InvoiceTotalsCard
        calc={calc} hasVat isSplit={false} materialLabor={null}
        showDeposit choice={choice} siteDepositPct={30} remaining={BAL}
        reservedTotal={reservedTotal} reservedInvoices={reservedTotal ? [{ invoice_number: 'IN2610-002', amount: reservedTotal }] : []}
        free={free} availableOffset={BAL}
        whtPct={3} legacyDepositPct={0}
      />
    </div>
  )
}
window.__render = () => { createRoot(document.getElementById('root')).render(<Host />) }
