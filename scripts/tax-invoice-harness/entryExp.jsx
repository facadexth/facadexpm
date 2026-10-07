import React from 'react'
import { createRoot } from 'react-dom/client'
import Page from 'SRC/pages/Expenses.jsx'
window.__errors = []
class EB extends React.Component {
  constructor(p) { super(p); this.state = { e: null } }
  static getDerivedStateFromError(e) { return { e } }
  componentDidCatch(e) { window.__errors.push(String((e && e.stack) || e)) }
  render() { return this.state.e ? <div id="crash">CRASH {String(this.state.e)}</div> : this.props.children }
}
let root
window.__render = () => { const el = document.getElementById('root'); if (root) root.unmount(); root = createRoot(el); root.render(<EB><Page navigateTo={() => {}} navState={{}} openSiteOverview={() => {}} /></EB>) }
