// src/components/ProviderLogo.jsx
// An extruder's logo in a fixed white box (logos are drawn for white paper). No URL shows a dash in the
// same box, so rows stay aligned.
export default function ProviderLogo({ url, name = '', width = 72, height = 32 }) {
  const box = {
    width, height, background: '#ffffff', border: '1px solid var(--border)', borderRadius: 6, flex: 'none',
    display: 'inline-grid', placeItems: 'center', overflow: 'hidden', padding: 2, verticalAlign: 'middle', boxSizing: 'border-box',
  }
  if (!url) return <span style={{ ...box, background: 'transparent', color: 'var(--text3)' }} aria-label="ไม่มีโลโก้">—</span>
  return (
    <span style={box}>
      <img src={url} alt={name ? `โลโก้ ${name}` : 'โลโก้'} loading="lazy" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
    </span>
  )
}
