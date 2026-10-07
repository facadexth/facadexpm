// Stand-in for QuickAddSelect: a <select> of options plus a "create" button that simulates creating an item.
export default function MockQuickAdd({ value, onChange, options, onCreated, disabled, extraPayload }) {
  return (
    <span>
      <select data-qa="stock" disabled={disabled} value={value || ''} onChange={e => onChange(e.target.value)}>
        <option value="">— ไม่ใช่สต็อก —</option>
        {(options || []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <button type="button" data-qa="create" onClick={async () => {
        const id = 'NEW' + Math.floor(Math.random() * 1e6)
        window.__data.items.push({ id, name: 'New item', base_unit: (extraPayload && extraPayload.base_unit) || 'หน่วย', active: true })
        await onCreated(id)
      }}>create</button>
    </span>
  )
}
