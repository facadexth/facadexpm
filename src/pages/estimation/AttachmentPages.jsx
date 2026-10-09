// Attachment pages ("แบบแนบ") for the quotation print. Pure presentation: the
// plan comes from lib/attachmentPages.js; the header is supplied by the caller
// (renderHeader) so the real quotation header can be reused.
import { PAGE_WIDTH_PX, PAGE_HEIGHT_PX, PAGE_PADDING_CSS, PAGE_PADDING_V_PX } from '../../hooks/usePaginatedDocument.jsx'
import { itemSpecRows, APPROVAL_NOTE } from '../../lib/attachmentPages.js'

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
const clamp = { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }

function SpecRow({ label, children }) {
  return (
    <tr>
      <td style={specTd1}>{label}</td>
      <td style={specTd2}><div style={clamp}>{children}</div></td>
    </tr>
  )
}

function ItemFrame({ item, ctx }) {
  const spec = itemSpecRows(item, ctx)
  const finish = ctx?.finishesById?.[item.alu_finish_id]
  const qty = item.quantity != null && item.quantity !== '' ? item.quantity : null
  const name = item.item_name || item.type_name
  return (
    <figure style={{ margin: 0, padding: 6, border: `1px solid ${LINE}`, borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 3, breakInside: 'avoid', pageBreakInside: 'avoid', minWidth: 0 }}>
      {item.noPreview ? (
        <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px dashed ${LINE}`, borderRadius: 4, color: MUTED, fontSize: 11 }}>ยังไม่มีภาพ</div>
      ) : (
        <div style={{ display: 'flex', gap: 2, justifyContent: 'center', width: '100%' }}>
          {item.views.map(v => (
            <div key={v.side} className={`att-view att-view-${v.side}`} style={{ width: item.views.length === 1 ? '100%' : '50%', flex: '1 1 50%', minWidth: 0 }}>
              <img src={v.src} alt="" style={{ width: '100%', height: 'auto', maxHeight: 150, objectFit: 'contain', display: 'block' }} />
            </div>
          ))}
        </div>
      )}
      <figcaption style={{ fontSize: 10.5, lineHeight: 1.3 }}>
        <b>{item.opening_no}</b>{name ? ` ${name}` : ''} · ขนาดชุด {spec.size} (กว้าง × สูง){qty != null ? ` · ${qty} ชุด` : ''}
      </figcaption>
      <table style={{ width: '100%', fontSize: 10, border: `1px solid ${LINE}`, borderCollapse: 'collapse' }}>
        <tbody>
          <SpecRow label="อลูมิเนียม">{spec.aluminium.series} {spec.aluminium.thickness} · <Swatch hex={finish?.color_hex} /> {spec.aluminium.colour}</SpecRow>
          {spec.weight && <SpecRow label="น.น. อลูมิเนียม">{spec.weight}</SpecRow>}
          <SpecRow label="กระจก">{[spec.glass.code, spec.glass.name].filter(Boolean).join(' ')}{spec.glassArea ? ` · ${spec.glassArea}` : ''}</SpecRow>
          <SpecRow label="ชุดอุปกรณ์">{spec.hardwareSet}</SpecRow>
          {spec.hardwareParts && <SpecRow label="อุปกรณ์">{spec.hardwareParts}</SpecRow>}
          {spec.extraNote && <SpecRow label="งานเสริม">{spec.extraNote}</SpecRow>}
        </tbody>
      </table>
    </figure>
  )
}

function HardwareBlock({ page, imageUrls }) {
  const sc = page.schedule || {}
  return (
    <div style={{ fontSize: 11.5 }}>
      <b>รายละเอียดชุดอุปกรณ์ (Hardware schedule)</b>
      {sc.intro && <p style={{ margin: '4px 0 0', color: MUTED }}>แต่ละรายการในแบบแนบอ้างชื่อชุดไว้ใต้ภาพ ด้านล่างแสดงว่าแต่ละชุดประกอบด้วยอะไรบ้าง และใช้กับรายการใด</p>}
      {page.hardwareSets.map(s => (
        <div key={s.setId + (s.continued ? '-c' : '')} style={{ border: `1px solid ${LINE}`, borderRadius: 4, marginTop: 8, breakInside: 'avoid', pageBreakInside: 'avoid' }}>
          <div style={{ padding: '4px 8px', background: '#f4f6f8', borderBottom: `1px solid ${LINE}` }}>
            <b>{[s.code, s.name].filter(Boolean).join(' · ')}</b>{s.continued ? ' (ต่อ)' : ''}{s.brand ? <> · ยี่ห้อ {s.brand}</> : null}
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              {s.parts.map((p, i) => {
                const url = p.imagePath ? imageUrls?.[p.imagePath] : null
                return (
                  <tr key={p.partId} style={{ borderTop: i ? `1px solid ${LINE}` : 'none' }}>
                    {i === 0 && !s.continued && (
                      <td rowSpan={s.parts.length} style={{ width: '30%', padding: '3px 8px', verticalAlign: 'top', borderRight: `1px solid ${LINE}` }}>
                        <div style={{ color: MUTED, fontSize: 10.5 }}>ใช้กับรายการ</div>
                        <div>{s.useText}</div>
                      </td>
                    )}
                    <td style={{ padding: '3px 8px', width: 40 }}>
                      {url ? <img src={url} alt="" width={28} height={28} style={{ objectFit: 'contain', display: 'block' }} /> : <PlaceholderIcon />}
                    </td>
                    <td style={{ padding: '3px 8px' }}>{p.name}</td>
                    <td style={{ padding: '3px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>{p.quantity} {p.unit}</td>
                  </tr>
                )
              })}
              {s.parts.length === 0 && (
                <tr><td style={{ padding: '3px 8px', color: MUTED }}>—</td></tr>
              )}
            </tbody>
          </table>
        </div>
      ))}
      {(sc.noSetItemNos || []).length > 0 && <p style={{ margin: '8px 0 0', color: MUTED, fontSize: 11 }}>{sc.noSetItemNos.join(', ')} : บานติดตาย / ไม่มีชุดอุปกรณ์</p>}
      {(sc.unselectedItemNos || []).length > 0 && <p style={{ margin: '4px 0 0', color: MUTED, fontSize: 11 }}>ยังไม่ได้เลือกชุดอุปกรณ์ : {sc.unselectedItemNos.join(', ')}</p>}
      {sc.needsApprovalNote && <p style={{ margin: '4px 0 0', color: MUTED, fontSize: 11 }}>* {sc.approvalNote || APPROVAL_NOTE}</p>}
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

// Renders exactly what planAttachmentPages() produced; nothing is recomputed here.
export default function AttachmentPages({ pages = [], ctx = {}, imageUrls = {}, renderHeader, totalPages, documentNumber }) {
  const total = totalPages ?? (pages.length ? pages[pages.length - 1].pageNo : 0)
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
                <HardwareBlock page={p} imageUrls={imageUrls} />
                {p.withColours && p.colours?.length > 0 && <div style={{ marginTop: 14 }}><ColourBlock legend={p.colours} /></div>}
              </>
            )}
            {p.kind === 'colours' && <ColourBlock legend={p.colours || []} />}
          </div>
          <div style={{ textAlign: 'right', fontSize: 11, color: '#7a8794' }}>{documentNumber ? `${documentNumber} · ` : ''}หน้า {p.pageNo} / {total}</div>
        </div>
      ))}
    </>
  )
}
