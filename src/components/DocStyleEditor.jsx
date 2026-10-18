// Document style customizer (logo / table spacing sliders + live preview) for
// the CURRENT tenant's tenants.document_style. Moved verbatim out of
// Settings.jsx (2026-10-18 settings reorg) -- it is a platform-admin tool now
// and renders inside DocumentTemplatesAdmin.jsx; tenants never see it.
import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { DEFAULT_DOCUMENT_STYLE, resolveDocumentStyle } from '../lib/documentStyle.js'
import DocStyleControls from './DocStyleControls.jsx'
import { DOC_STYLE_PREVIEW_SAMPLE } from '../lib/documentPreviewSample.js'
import { QuotationPaper } from '../pages/Quotations.jsx'

// Placeholder document content for the document-style live preview -- NOT
// real tenant data. The tenant's real company_name/logo_url/etc. ARE used
// (via the real `tenant` object passed to QuotationPaper below), but the
// client/items/document-number are fake so the preview doesn't depend on
// the tenant having any real quotations.
export default function DocStyleEditor({ tenant, refetchTenant, title = '🎨 รูปแบบเอกสาร (ใบเสนอราคา/ใบแจ้งหนี้/ใบเสร็จ)' }) {
  // Document style customizer -- resolveDocumentStyle always returns a
  // fully-populated object, so local state always starts fully populated.
  // The useEffect below re-syncs local state when the PERSISTED value
  // actually changes (e.g. after this card's own Save/Reset calls
  // refetchTenant()) -- keyed on a stringified comparison, not
  // `tenant?.document_style` object identity, because useTenant()
  // re-parses JSON on every fetch (a new object even when the underlying
  // value is unchanged), and OTHER saves on this same page (company
  // profile, logo upload) also call refetchTenant(). Keying on identity
  // would silently wipe any in-progress (unsaved) slider edits every time
  // an OWNER saved something unrelated elsewhere on this page.
  const [docStyle, setDocStyle] = useState(() => resolveDocumentStyle(tenant?.document_style))
  const [savingDocStyle, setSavingDocStyle] = useState(false)
  const tenantStyleKey = JSON.stringify(tenant?.document_style)
  useEffect(() => {
    setDocStyle(resolveDocumentStyle(tenant?.document_style))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantStyleKey])
  const setDocStyleField = (k, v) => setDocStyle(s => ({ ...s, [k]: v }))

  const handleSaveDocStyle = async () => {
    setSavingDocStyle(true)
    try {
      const { error } = await supabase.from('tenants').update({ document_style: docStyle }).eq('id', tenant.id)
      if (error) throw error
      refetchTenant()
      alert('✅ บันทึกรูปแบบเอกสารแล้ว')
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSavingDocStyle(false)
    }
  }

  const handleResetDocStyle = async () => {
    setSavingDocStyle(true)
    try {
      const { error } = await supabase.from('tenants').update({ document_style: null }).eq('id', tenant.id)
      if (error) throw error
      refetchTenant()
      setDocStyle(DEFAULT_DOCUMENT_STYLE)
      alert('✅ คืนค่าเริ่มต้นแล้ว')
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSavingDocStyle(false)
    }
  }

  return (
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header"><div className="card-title">{title}</div></div>
        <div className="card-body" style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 20, alignItems: 'start' }}>
          {/* Capped to the same maxHeight as the preview column below, with
              its own overflow -- previously this column had no height cap
              at all, so scrolling down through the (long) slider list
              scrolled the WHOLE page, taking the preview (which starts at
              the top of this grid row) out of view along with it. Now
              each column scrolls independently and the preview stays put
              the whole time you're tuning any slider, footer ones
              included. */}
          <div style={{ display: 'grid', gap: 10, maxHeight: '80vh', overflowY: 'auto', paddingRight: 8 }}>
            <DocStyleControls docStyle={docStyle} setDocStyleField={setDocStyleField} />

            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="btn btn-primary" onClick={handleSaveDocStyle} disabled={savingDocStyle} style={{ flex: 1 }}>
                {savingDocStyle ? '⏳...' : '💾 บันทึก'}
              </button>
              <button className="btn btn-ghost" onClick={handleResetDocStyle} disabled={savingDocStyle}>
                ↺ คืนค่าเริ่มต้น
              </button>
            </div>
          </div>

          <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'auto', maxHeight: '80vh' }}>
            <QuotationPaper
              elementId="doc-style-preview"
              tenant={{ ...tenant, document_style: docStyle }}
              extraRemeasureKey={JSON.stringify(docStyle)}
              quotationNumber={DOC_STYLE_PREVIEW_SAMPLE.quotationNumber}
              tag="ตัวอย่าง"
              date={DOC_STYLE_PREVIEW_SAMPLE.date}
              validUntil={DOC_STYLE_PREVIEW_SAMPLE.validUntil}
              revision={DOC_STYLE_PREVIEW_SAMPLE.revision}
              siteName={DOC_STYLE_PREVIEW_SAMPLE.siteName}
              clientName={DOC_STYLE_PREVIEW_SAMPLE.clientName}
              clientAddress={DOC_STYLE_PREVIEW_SAMPLE.clientAddress}
              clientTaxId={DOC_STYLE_PREVIEW_SAMPLE.clientTaxId}
              items={DOC_STYLE_PREVIEW_SAMPLE.items}
              hasVat={DOC_STYLE_PREVIEW_SAMPLE.hasVat}
              priceIncludesVat={DOC_STYLE_PREVIEW_SAMPLE.priceIncludesVat}
              paymentTerms={DOC_STYLE_PREVIEW_SAMPLE.paymentTerms}
              notes={DOC_STYLE_PREVIEW_SAMPLE.notes}
              bankAccount={DOC_STYLE_PREVIEW_SAMPLE.bankAccount}
              clientSignature={DOC_STYLE_PREVIEW_SAMPLE.clientSignature}
            />
          </div>
        </div>
      </div>
  )
}
