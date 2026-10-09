import React from 'react'
import { createRoot } from 'react-dom/client'
import InvoiceDepositBox, { useDepositChoiceState } from 'SRC/components/InvoiceDepositBox.jsx'
import { resolveDepositChoice } from 'SRC/lib/invoiceDeposit.js'

const BAL = 78210
// Host = what CreateInvoiceModal does: the choice state at the top, the box given the invoice figures.
function Host() {
  const [sub, setSub] = React.useState(150000)
  const choice = useDepositChoiceState(30)
  const vat = Math.round(Math.max(0, sub - BAL) * 0.07 * 100) / 100
  const dep = resolveDepositChoice({ subtotal: sub, mode: choice.mode, text: choice.text, balance: BAL })
  return (
    <div>
      <input id="sub" type="text" value={sub} onChange={e => setSub(Number(e.target.value) || 0)} />
      <span id="resolved">{dep.amount}</span>
      <InvoiceDepositBox choice={choice} subtotal={sub} vat={vat} total={sub + vat} taxOffset={BAL} whtPct={3} retentionPct={0} balance={BAL} siteDepositPct={30} />
    </div>
  )
}
window.__render = () => { createRoot(document.getElementById('root')).render(<Host />) }
