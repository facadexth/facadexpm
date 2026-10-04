// The 🔔 mark on a row that is waiting for action: it is one of the rows counted in the
// numbers on the tabs and in the header bell (rules in src/lib/pendingRules.js).
export default function PendingMark({ label = 'รอดำเนินการ' }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={`${label} (นับอยู่ในตัวเลขแจ้งเตือน)`}
      style={{
        display: 'inline-block', marginRight: 6, padding: '0 5px', borderRadius: 8, fontSize: 11, lineHeight: '17px',
        background: 'rgba(229,72,77,0.15)', color: 'var(--red, #e5484d)', verticalAlign: 'middle',
      }}
    >
      🔔
    </span>
  )
}
