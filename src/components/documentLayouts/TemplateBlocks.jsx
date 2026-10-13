// Header / cover / benefit blocks for the "modern" and "premium" quotation
// layouts. Pure presentational: QuotationPaper hands in the resolved
// template (src/lib/documentTemplates.js). Every image has a FIXED height so
// the pagination measuring pass never depends on an image finishing loading.
import { docImageUrl } from './quotationTheme.js'

const HERO_H = 110
const GALLERY_H = 56

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('th-TH') : '—')

function Logo({ tenant, style, size }) {
  if (tenant?.logo_url) {
    return (
      <div style={{ position: 'relative', width: style.logoWidth, height: Math.min(style.logoMaxHeight, size), flexShrink: 0, background: '#fff', borderRadius: 6, padding: 4, boxSizing: 'border-box' }}>
        <img src={tenant.logo_url} alt="" style={{ position: 'absolute', inset: 4, width: 'calc(100% - 8px)', height: 'calc(100% - 8px)', objectFit: 'contain', objectPosition: 'left center' }} crossOrigin="anonymous" />
      </div>
    )
  }
  return null
}

function CompanyLines({ tenant, style, color, muted }) {
  return (
    <div>
      <div style={{ fontSize: style.nameSize, fontWeight: 700, color }}>{tenant?.company_name}</div>
      {tenant?.address && <div style={{ fontSize: style.addressSize, color: muted, lineHeight: 1.6, marginTop: 2 }}>{tenant.address}</div>}
      {tenant?.tax_id && <div style={{ fontSize: style.addressSize, color: muted }}>เลขผู้เสียภาษี {tenant.tax_id}</div>}
      {style.showContactIcons && (tenant?.phone || tenant?.email || tenant?.website) && (
        <div style={{ fontSize: style.contactSize, color: muted, marginTop: style.contactLineGap }}>
          {[tenant?.phone && `📞 ${tenant.phone}`, tenant?.email && `✉️ ${tenant.email}`, tenant?.website && `🌐 ${tenant.website}`].filter(Boolean).join('   ')}
        </div>
      )}
    </div>
  )
}

function Meta({ p, theme, labelMuted, rule }) {
  const { style } = p
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `${style.splitRatioClient}fr ${100 - style.splitRatioClient}fr`, gap: 20, marginTop: style.clientInfoOffset }}>
      <div style={{ fontSize: 12.5, lineHeight: 2 }}>
        <div><span style={{ color: labelMuted }}>ลูกค้า&nbsp;:</span> <strong>{p.clientName || '—'}</strong></div>
        <div><span style={{ color: labelMuted }}>ที่อยู่&nbsp;:</span> {p.clientAddress || '—'}</div>
        {p.clientTaxId && <div><span style={{ color: labelMuted }}>เลขที่ภาษี&nbsp;:</span> {p.clientTaxId}</div>}
      </div>
      <div style={{ borderLeft: `1px solid ${rule}`, paddingLeft: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px', fontSize: style.infoSize, alignContent: 'start' }}>
        <div><span style={{ color: labelMuted }}>เลขที่เอกสาร</span><br /><strong>{p.quotationNumber}{style.showRevisionSuffix ? p.revisionSuffix : ''}</strong></div>
        <div><span style={{ color: labelMuted }}>วันที่ออก</span><br />{fmtDate(p.date)}</div>
        <div><span style={{ color: labelMuted }}>ใช้ได้ถึง</span><br />{fmtDate(p.validUntil)}</div>
        <div><span style={{ color: labelMuted }}>โครงการ</span><br />{p.siteName || '—'}</div>
      </div>
    </div>
  )
}

// ---- modern: coloured band bleeding to the page edges ----
export function ModernHeader(p) {
  const { tenant, style, tag, pageNumber, totalPages, theme } = p
  return (
    <>
      <div style={{ margin: `-${style.pagePaddingV}px -${style.pagePaddingH}px 0`, padding: `26px ${style.pagePaddingH}px 18px`, background: style.accent, color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ display: 'flex', gap: style.logoGap, alignItems: 'flex-start' }}>
          <Logo tenant={tenant} style={style} size={style.logoMaxHeight} />
          <CompanyLines tenant={tenant} style={style} color="#fff" muted="rgba(255,255,255,.82)" />
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: style.addressSize, opacity: 0.85, marginBottom: 4 }}>หน้า {pageNumber}/{totalPages}</div>
          <div style={{ fontSize: style.addressSize, fontWeight: 700, border: '1px solid rgba(255,255,255,.7)', borderRadius: 4, padding: '2px 8px', display: 'inline-block', marginBottom: 6 }}>{tag || 'ต้นฉบับ'}</div>
          <div style={{ fontSize: style.titleSize, fontWeight: 800 }}>ใบเสนอราคา</div>
        </div>
      </div>
      <Meta p={p} theme={theme} labelMuted={theme.muted} rule={theme.rowBorder} />
    </>
  )
}

// cover image (+ product gallery) right under the header, page 1 only
export function ModernFirstPageExtra({ content, style }) {
  const gallery = content?.gallery || []
  return (
    <div>
      <div style={{ margin: `16px -${style.pagePaddingH}px 0`, height: HERO_H, overflow: 'hidden' }}>
        <img src={docImageUrl(content.heroBucket, content.heroPath)} alt="" crossOrigin="anonymous" style={{ display: 'block', width: '100%', height: HERO_H, objectFit: 'cover' }} />
      </div>
      {gallery.length > 0 && (
        <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: `repeat(${gallery.length}, 1fr)`, gap: 10 }}>
          {gallery.map((g, i) => (
            <div key={i}>
              <img src={docImageUrl(g.bucket, g.path)} alt="" crossOrigin="anonymous" style={{ display: 'block', width: '100%', height: GALLERY_H, objectFit: 'cover', borderRadius: 4 }} />
              <div style={{ fontSize: 10, fontWeight: 600, marginTop: 3, lineHeight: 1.3, height: 15, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{g.caption}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---- premium: serif, cream paper, letter-spaced title, cover with tagline ----
export function PremiumHeader(p) {
  const { tenant, style, tag, pageNumber, totalPages, theme } = p
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ display: 'flex', gap: style.logoGap, alignItems: 'flex-start' }}>
          <Logo tenant={tenant} style={style} size={style.logoMaxHeight} />
          <CompanyLines tenant={tenant} style={style} color={theme.text} muted={theme.muted} />
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: style.addressSize, color: theme.muted, marginBottom: 4 }}>หน้า {pageNumber}/{totalPages} · {tag || 'ต้นฉบับ'}</div>
          <div style={{ fontSize: style.titleSize, letterSpacing: '0.12em', fontWeight: 400, color: theme.text }}>ใบเสนอราคา</div>
        </div>
      </div>
      <Meta p={p} theme={theme} labelMuted={theme.muted} rule={theme.rowBorder} />
    </>
  )
}

export function PremiumFirstPageExtra({ content, style, theme }) {
  return (
    <div style={{ margin: `16px -${style.pagePaddingH}px 0`, height: HERO_H, overflow: 'hidden', position: 'relative' }}>
      <img src={docImageUrl(content.heroBucket, content.heroPath)} alt="" crossOrigin="anonymous" style={{ display: 'block', width: '100%', height: HERO_H, objectFit: 'cover' }} />
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg, rgba(0,0,0,0) 30%, rgba(0,0,0,.45) 100%)' }} />
      {content.tagline && (
        <div style={{ position: 'absolute', right: style.pagePaddingH, top: 0, bottom: 0, display: 'flex', alignItems: 'center', textAlign: 'right', color: '#fff', fontStyle: 'italic', fontSize: 15, lineHeight: 1.5, maxWidth: 300, textShadow: '0 1px 6px rgba(0,0,0,.55)', whiteSpace: 'pre-line' }}>
          {content.tagline}
        </div>
      )}
    </div>
  )
}

// benefit strip + thank-you line, drawn near the bottom of the last page
export function BenefitStrip({ content, theme, style }) {
  const feats = content?.features || []
  if (!feats.length) return null
  const modern = theme.layout === 'modern'
  return (
    <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: `repeat(${feats.length}, 1fr)`, textAlign: 'center', fontSize: 11, fontWeight: 600,
      background: modern ? theme.notesBoxBg : 'transparent', borderRadius: modern ? 8 : 0, padding: modern ? '10px 6px' : '10px 0', borderTop: modern ? 'none' : `1px solid ${theme.rowBorder}`, borderBottom: modern ? 'none' : `1px solid ${theme.rowBorder}`, color: modern ? style.accent : theme.text }}>
      {feats.map((f, i) => (
        <div key={i} style={{ padding: '0 8px', borderLeft: !modern && i > 0 ? `1px solid ${theme.rowBorder}` : 'none' }}>{f}</div>
      ))}
    </div>
  )
}

export function ThanksLine({ content, theme }) {
  if (!content?.thanks) return null
  return <div style={{ marginTop: 10, fontStyle: 'italic', fontSize: 11, color: theme.muted, textAlign: 'center' }}>{content.thanks}</div>
}

// ---- pages 2+: one slim line (logo/company, document number, page) ----
export function CompactHeader(p) {
  const { tenant, style, theme, tag, pageNumber, totalPages, quotationNumber, revisionSuffix } = p
  const modern = theme.layout === 'modern'
  return (
    <div style={modern
      ? { margin: `-${style.pagePaddingV}px -${style.pagePaddingH}px 0`, padding: `14px ${style.pagePaddingH}px`, background: style.accent, color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }
      : { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingBottom: 10, borderBottom: `1px solid ${theme.rowBorder}`, color: theme.text }}>
      <div style={{ fontSize: style.nameSize - 3, fontWeight: 700 }}>{tenant?.company_name}</div>
      <div style={{ textAlign: 'right', fontSize: style.addressSize + 1, opacity: modern ? 0.95 : 1 }}>
        <strong>ใบเสนอราคา {quotationNumber}{style.showRevisionSuffix ? revisionSuffix : ''}</strong>
        <span style={{ marginLeft: 12, color: modern ? undefined : theme.muted }}>{tag || 'ต้นฉบับ'} · หน้า {pageNumber}/{totalPages}</span>
      </div>
    </div>
  )
}
