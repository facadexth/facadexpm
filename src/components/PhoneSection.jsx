// PhoneSection — desktop: returns the children untouched. Phone: a collapsible block whose heading carries a
// one-line summary (round-2 spec: site overview sections).
import { useIsPhone } from '../hooks/useIsPhone.js'

export default function PhoneSection({ title, summary, defaultOpen = false, children }) {
  const isPhone = useIsPhone()
  if (!isPhone) return children
  return (
    <details className="phone-section" open={defaultOpen}>
      <summary>
        <span className="ps-title">{title}</span>
        {summary && <span className="ps-sum">{summary}</span>}
      </summary>
      <div className="ps-body">{children}</div>
    </details>
  )
}
