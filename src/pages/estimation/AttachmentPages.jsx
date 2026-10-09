// Attachment pages ("แบบแนบ") for the quotation print. Pure presentation: the
// plan comes from lib/attachmentPages.js; the header is supplied by the caller
// (renderHeader) so the real quotation header can be reused.
import { PAGE_WIDTH_PX, PAGE_HEIGHT_PX, PAGE_PADDING_CSS, PAGE_PADDING_V_PX } from '../../hooks/usePaginatedDocument.jsx'
import { itemSpecRows, hardwareSchedule, colourLegend, APPROVAL_NOTE } from '../../lib/attachmentPages.js'

const MUTED = '#5b6876'
const LINE = '#d7dde4'
const INK = '#1b2430'

function PlaceholderIcon({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true" style={{ flex: 'none' }}>
      <rect x="1" y="1" width="26" height="26" rx="4" fill="#f1f4f7" stroke="#b8c2cc" />
      <circle cx="14" cy="14" r="5" fill="none" stroke="#8793a1" strokeWidth="1.6" />
      <circle cx="14" cy="14" r="1.6" fill="#8793a1" />
    </svg>
  )
}

function Swatch({ hex, size = 13 }) {
  return (
    <span style={{ display: 'inline-block', width: size, height: size, border: '1px solid #8793a1', borderRadius: 2, verticalAlign: -2, background: hex || '#cfd4d9' }} />
  )
}

const specTd1 = { whiteSpace: 'nowrap', color: MUTED, width: '1%', padding: '2px 5px', verticalAlign: 'top' }
const specTd2 = { padding: '2px 5px', verticalAlign: 'top', color: INK }

function ItemFrame({ item, ctx }) {
  const spec = itemSpecRows(item, ctx)
  const finish = ctx?.finishesById?.[item.alu_finish_id]
  const qty = item.quantity != null && item.quantity !== '' ? item.quantity : null
  return (
    <figure style={{ margin: 0, padding: 6, border: `1px solid ${LINE}`, borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 3, breakInside: 'avoid', pageBreakInside: 'avoid', minWidth: 0 }}>
      {item.noPreview ? (
        <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px dashed ${LINE}`, borderRadius: 4, color: MUTED, fontSize: 11 }}>ยังไม่มีภาพ</div>
      ) : (
        <div style={{ display: 'flex', gap: 2, justifyContent: 'center', width: '100%' }}>
          {item.views.map(v => (
            <div key={v.side} className={`att-view att-view-${v.side}`} style={{ width: item.views.length === 1 ? '100%' : '50%', flex: '1 1 50%', minWidth: 0 }}
              // sanitised in planAttachmentPages -> itemViews -> sanitizeSvg
              dangerouslySetInnerHTML={{ __html: v.svg }} />
          ))}
        </div>
      )}
      <figcaption style={{ fontSize: 10.5, lineHeight: 1.3 }}>
        <b>{item.opening_no}</b>{item.type_name ? ` ${item.type_name}` : ''} · ขนาดชุด {spec.size}{qty != null ? ` · ${qty} ชุด` : ''}
      </figcaption>
      <table style={{ width: '100%', fontSize: 10, border: `1px solid ${LINE}`, borderCollapse: 'collapse' }}>
        <tbody>
          <tr>
            <td style={specTd1}>อลูมิเนียม</td>
            <td style={specTd2}>{spec.aluminium.series} หนา {spec.aluminium.thickness} · <Swatch hex={finish?.color_hex} /> {spec.aluminium.colour}</td>
          </tr>
          <tr>
            <td style={specTd1}>กระจก</td>
            <td style={specTd2}>{[spec.glass.code, spec.glass.name].filter(Boolean).join(' ')}</td>
          </tr>
          <tr>
            <td style={specTd1}>ชุดอุปกรณ์</td>
            <td style={specTd2}>{spec.hardwareSet}</td>
          </tr>
        </tbody>
      </table>
    </figure>
  )
}

function HardwareBlock({ sched, imageUrls }) {
  return (
    <div style={{ fontSize: 11.5 }}>
      <b>รายละเอียดชุดอุปกรณ์ (Hardware schedule)</b>
      {sched.sets.map(s => (
        <div key={s.setId} style={{ border: `1px solid ${LINE}`, borderRadius: 4, marginTop: 8, breakInside: 'avoid', pageBreakInside: 'avoid' }}>
          <div style={{ padding: '4px 8px', background: '#f4f6f8', borderBottom: `1px solid ${LINE}` }}>
            <b>{s.name}</b>{s.brand ? <> · ยี่ห้อ {s.brand}</> : null} <span style={{ color: MUTED }}>· ใช้กับ {s.itemNos.join(', ')}</span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: MUTED, fontSize: 10.5, textAlign: 'left' }}>
                <th style={{ padding: '2px 8px', width: 40 }}></th><th style={{ padding: '2px 8px' }}>ชิ้นส่วน</th>
                <th style={{ padding: '2px 8px' }}>ยี่ห้อ</th><th style={{ padding: '2px 8px', textAlign: 'right' }}>จำนวน</th>
              </tr>
            </thead>
            <tbody>
              {s.parts.map(p => {
                const url = p.imagePath ? imageUrls?.[p.imagePath] : null
                return (
                  <tr key={p.partId} style={{ borderTop: `1px solid ${LINE}` }}>
                    <td style={{ padding: '3px 8px' }}>
                      {url ? <img src={url} alt="" width={28} height={28} style={{ objectFit: 'contain', display: 'block' }} /> : <PlaceholderIcon />}
                    </td>
                    <td style={{ padding: '3px 8px' }}>{p.name}</td>
                    <td style={{ padding: '3px 8px' }}>{s.brand || '—'}</td>
                    <td style={{ padding: '3px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>{p.quantity} {p.unit}</td>
                  </tr>
                )
              })}
              {s.parts.length === 0 && (
                <tr style={{ borderTop: `1px solid ${LINE}` }}><td colSpan={4} style={{ padding: '3px 8px', color: MUTED }}>—</td></tr>
              )}
            </tbody>
          </table>
        </div>
      ))}
      {sched.needsApprovalNote && <p style={{ margin: '8px 0 0', color: MUTED, fontSize: 11 }}>* {sched.approvalNote || APPROVAL_NOTE}</p>}
    </div>
  )
}

function ColourBlock({ legend }) {
  return (
    <div style={{ fontSize: 11.5, breakInside: 'avoid', pageBreakInside: 'avoid' }}>
      <b>สีอลูมิเนียม (Colour legend)</b>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 8 }}>
        {legend.map(c => (
          <div key={c.finishId} style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${LINE}`, borderRadius: 4, padding: 6 }}>
            <span style={{ width: 24, height: 24, flex: 'none', border: '1px solid #8793a1', borderRadius: 2, background: c.hex || '#cfd4d9' }} />
            <div style={{ minWidth: 0 }}>
              <div><b>{c.name}</b></div>
              <div style={{ color: MUTED, fontSize: 10.5 }}>{c.itemNos.join(', ')}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function AttachmentPages({ pages = [], items = [], ctx = {}, imageUrls = {}, renderHeader, totalPages, options }) { // eslint-disable-line no-unused-vars
  const total = totalPages ?? (pages.length ? pages[pages.length - 1].pageNo : 0)
  const sched = hardwareSchedule({ items, setsById: ctx.setsById, partsBySet: ctx.partsBySet, providersById: ctx.providersById })
  const legend = colourLegend(items, ctx)
  return (
    <>
      {pages.map(p => (
        <div key={p.pageNo} className="attachment-page"
          style={{ width: PAGE_WIDTH_PX, height: PAGE_HEIGHT_PX + 2 * PAGE_PADDING_V_PX, padding: PAGE_PADDING_CSS, boxSizing: 'border-box', background: '#fff', color: '#000', display: 'flex', flexDirection: 'column', overflow: 'hidden', breakAfter: 'page', pageBreakAfter: 'always' }}>
          {renderHeader ? renderHeader({ pageNumber: p.pageNo, totalPages: total }) : null}
          <div style={{ marginTop: 14, flex: 1, minHeight: 0 }}>
            {p.kind === 'items' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, alignItems: 'start' }}>
                {p.items.map(it => <ItemFrame key={it.id ?? it.opening_no} item={it} ctx={ctx} />)}
              </div>
            )}
            {p.kind === 'hardware' && (
              <>
                <HardwareBlock sched={sched} imageUrls={imageUrls} />
                {p.withColours && legend.length > 0 && <div style={{ marginTop: 14 }}><ColourBlock legend={legend} /></div>}
              </>
            )}
            {p.kind === 'colours' && <ColourBlock legend={legend} />}
          </div>
          <div style={{ textAlign: 'right', fontSize: 11, color: '#7a8794' }}>หน้า {p.pageNo}/{total}</div>
        </div>
      ))}
    </>
  )
}
