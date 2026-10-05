import { scanErrorNotice } from '../lib/scanNotice.js'

/** Yellow notice for a scan that could not be read automatically. Replaces
 *  the old red error box: the user can still enter the lines by hand. */
export default function ScanNotice({ code, message }) {
  const { text } = scanErrorNotice(code, message)
  return (
    <div role="status" style={{ marginTop: 6, padding: 10, borderRadius: 8, fontSize: 13, background: 'rgba(245,158,11,.12)', border: '1px solid rgba(245,158,11,.5)' }}>
      {text}
    </div>
  )
}
