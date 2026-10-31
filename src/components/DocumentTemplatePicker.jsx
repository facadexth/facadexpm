// Tenant (OWNER) picker for the quotation look: published templates as live
// thumbnails, accent colour, cover/gallery images (own or our sample pack with a
// T&C), short texts. Nothing here is visible until a platform admin publishes a
// template (see useDocumentTemplates). Spec: docs/superpowers/specs/2026-10-10-document-templates-design.md §6.
import { useMemo, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { QuotationPaper } from '../pages/Quotations.jsx'
import { resolveDocumentTemplate, TENANT_IMAGE_BUCKET, MAX_GALLERY, MAX_FEATURES } from '../lib/documentTemplates.js'
import { DOC_STYLE_PREVIEW_SAMPLE } from '../lib/documentPreviewSample.js'
import { resizeToJpeg } from '../lib/resizeImage.js'
import { docImageUrl } from './documentLayouts/quotationTheme.js'
import { clearDocumentTemplatesCache } from '../hooks/useDocumentTemplates.js'

export const PACK_TERMS_TH = [
  'รูปภาพในชุดตัวอย่างสร้างด้วยปัญญาประดิษฐ์ (AI) เพื่อใช้เป็นภาพประกอบเอกสารเท่านั้น ไม่ใช่ภาพถ่ายงานจริงของบริษัทคุณหรือของผู้ให้บริการ',
  'ผู้ให้บริการไม่รับรองว่ารูปภาพนี้เป็นเอกลักษณ์ และไม่รับรองว่าผู้ใช้รายอื่นหรือบุคคลภายนอกจะไม่ใช้รูปที่เหมือนหรือคล้ายกัน',
  'คุณรับผิดชอบเนื้อหาของเอกสารที่ออกถึงลูกค้า รวมถึงการนำรูปตัวอย่างไปใช้ และไม่ควรใช้รูปตัวอย่างเพื่อสื่อว่าเป็นผลงานจริงของคุณ',
  'คุณเปลี่ยนเป็นรูปของตัวเองหรือเลิกใช้รูปตัวอย่างได้ตลอดเวลาในหน้านี้',
  'ผู้ให้บริการอาจเปลี่ยนแปลงหรือถอนชุดรูปตัวอย่างได้ หากมีการถอน เอกสารจะแสดงแบบคลาสสิกจนกว่าคุณเลือกรูปใหม่',
]

const THUMB_W = 190
const SCALE = THUMB_W / 718

function Thumb({ tpl, tenant, scale = SCALE, id }) {
  return (
    <div style={{ width: 718 * scale, height: 1020 * scale, overflow: 'hidden', position: 'relative', background: '#fff', borderRadius: 4, border: '1px solid var(--border)', pointerEvents: 'none' }}>
      <div style={{ width: 718, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
        <QuotationPaper elementId={id} tenant={tenant} template={tpl} tag="ตัวอย่าง" {...DOC_STYLE_PREVIEW_SAMPLE} />
      </div>
    </div>
  )
}

export default function DocumentTemplatePicker({ tenant, templates, packs, refetchTenant }) {
  const content0 = tenant?.document_content && typeof tenant.document_content === 'object' ? tenant.document_content : {}
  const currentKey = tenant?.document_template_key || 'classic'
  const [draft, setDraft] = useState(null) // null = just browsing
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [accepted, setAccepted] = useState(false)

  const list = useMemo(() => [...(templates || [])].sort((a, b) => (a.key === 'classic' ? -1 : b.key === 'classic' ? 1 : a.key.localeCompare(b.key))), [templates])

  const startDraft = (key) => {
    setErr(''); setAccepted(false)
    const own = content0
    setDraft({
      key,
      accent: tenant?.document_accent || '',
      source: own.hero_path ? 'own' : 'pack',
      packId: own.pack_id || (packs && packs[0]?.id) || '',
      hero: own.hero_path || '',
      gallery: [...(own.gallery || [])].slice(0, MAX_GALLERY),
      features: [0, 1, 2].map(i => (own.features || [])[i] || ''),
      tagline: own.tagline || '',
      thanks: own.thanks || '',
    })
  }

  // what the document would look like with the draft applied
  const contentOf = (d) => ({
    pack_id: d.source === 'pack' ? d.packId || null : null,
    hero_path: d.source === 'own' ? d.hero || null : null,
    gallery: d.source === 'own' ? d.gallery.filter(g => g.path) : [],
    features: d.features.map(s => s.trim()).filter(Boolean).slice(0, MAX_FEATURES),
    tagline: d.tagline.trim(), thanks: d.thanks.trim(),
  })
  const tplFor = (key, d) => resolveDocumentTemplate({
    tenant: { ...tenant, document_template_key: key === 'classic' ? null : key, document_accent: (d ? d.accent : tenant?.document_accent) || null, document_content: d ? contentOf(d) : (hasOwnOrPack(content0) ? content0 : { pack_id: packs?.[0]?.id }) },
    templates, packs,
  })
  const hasOwnOrPack = (c) => !!(c.hero_path || c.pack_id)

  const upload = async (file, name) => {
    const blob = await resizeToJpeg(file)
    const path = `${tenant.id}/${name}-${Date.now()}.jpg`
    const { error } = await supabase.storage.from(TENANT_IMAGE_BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: true })
    if (error) throw error
    return path
  }
  const guard = async (fn) => { setBusy(true); setErr(''); try { await fn() } catch (e) { setErr(e.message || String(e)) } finally { setBusy(false) } }
  const pickHero = (file) => file && guard(async () => { const path = await upload(file, 'hero'); setDraft(d => ({ ...d, hero: path })) })
  const addGallery = (file) => file && guard(async () => {
    const path = await upload(file, 'g'); setDraft(d => (d.gallery.length >= MAX_GALLERY ? d : { ...d, gallery: [...d.gallery, { path, caption: '' }] }))
  })

  const termsAlready = !!content0.pack_terms_accepted_at
  const save = () => guard(async () => {
    const d = draft
    if (d.key !== 'classic') {
      if (d.source === 'pack' && !d.packId) throw new Error('เลือกชุดรูปตัวอย่างก่อน')
      if (d.source === 'own' && !d.hero) throw new Error('อัปโหลดรูปปกก่อน')
      if (d.source === 'pack' && !termsAlready && !accepted) throw new Error('ต้องติ๊กยอมรับข้อกำหนดรูปตัวอย่างก่อน')
    }
    const content = d.key === 'classic' ? (tenant.document_content ?? null) : {
      ...contentOf(d),
      pack_terms_accepted_at: d.source === 'pack' ? (content0.pack_terms_accepted_at || new Date().toISOString()) : (content0.pack_terms_accepted_at || null),
    }
    const { error } = await supabase.from('tenants').update({
      document_template_key: d.key === 'classic' ? null : d.key,
      document_accent: /^#[0-9a-fA-F]{6}$/.test(d.accent) ? d.accent : null,
      document_content: content,
    }).eq('id', tenant.id)
    if (error) throw error
    clearDocumentTemplatesCache()
    await refetchTenant?.()
    setDraft(null)
  })

  const d = draft
  const draftTpl = d ? tplFor(d.key, d) : null
  const draftFellBack = d && d.key !== 'classic' && draftTpl?.layout === 'classic'

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header"><div className="card-title">🎨 แบบใบเสนอราคา</div></div>
      <div className="card-body" style={{ display: 'grid', gap: 16 }}>
        <div style={{ fontSize: 13, color: 'var(--text3)' }}>เลือกหน้าตาของใบเสนอราคาที่ส่งให้ลูกค้า (ใบแจ้งหนี้ ใบเสร็จ และใบกำกับภาษีใช้แบบคลาสสิกเสมอ) การเปลี่ยนแบบมีผลกับใบเสนอราคาทุกใบเมื่อเปิดดูอีกครั้ง</div>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {list.map(t => (
            <div key={t.key} style={{ width: THUMB_W, display: 'grid', gap: 6 }}>
              <Thumb id={`tpl-thumb-${t.key}`} tenant={tenant} tpl={tplFor(t.key, null)} />
              <div style={{ fontWeight: 700, fontSize: 13.5 }}>{t.name_th}{currentKey === t.key && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--green, #2a9d8f)' }}>✓ ใช้อยู่</span>}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text3)', minHeight: 30 }}>{t.description_th}</div>
              <button className="btn btn-sm btn-ghost" onClick={() => startDraft(t.key)} disabled={busy}>{currentKey === t.key ? 'แก้ไขแบบนี้' : 'เลือกแบบนี้'}</button>
            </div>
          ))}
        </div>

        {d && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 16, display: 'grid', gridTemplateColumns: 'minmax(260px, 340px) 1fr', gap: 20, alignItems: 'start' }}>
            <div style={{ display: 'grid', gap: 12 }}>
              <div style={{ fontWeight: 700 }}>ตั้งค่า: {list.find(t => t.key === d.key)?.name_th}</div>
              <div>
                <label className="label">สีหลัก</label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input type="color" value={d.accent || draftTpl?.accent || '#6c63ff'} onChange={e => setDraft(x => ({ ...x, accent: e.target.value }))} style={{ width: 60, height: 32 }} />
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDraft(x => ({ ...x, accent: '' }))}>ใช้สีเริ่มต้นของแบบ</button>
                </div>
              </div>

              {d.key !== 'classic' && (
                <>
                  <div>
                    <label className="label">รูปภาพ</label>
                    <label style={{ display: 'flex', gap: 6, fontSize: 13 }}><input type="radio" checked={d.source === 'pack'} onChange={() => setDraft(x => ({ ...x, source: 'pack' }))} /> ใช้ชุดรูปตัวอย่างของระบบ</label>
                    <label style={{ display: 'flex', gap: 6, fontSize: 13 }}><input type="radio" checked={d.source === 'own'} onChange={() => setDraft(x => ({ ...x, source: 'own' }))} /> ใช้รูปของบริษัทเอง</label>
                  </div>

                  {d.source === 'pack' && (
                    <div style={{ display: 'grid', gap: 8 }}>
                      <select className="input" value={d.packId} onChange={e => setDraft(x => ({ ...x, packId: e.target.value }))}>
                        {(packs || []).map(p => <option key={p.id} value={p.id}>{p.name_th}</option>)}
                      </select>
                      <div style={{ background: 'var(--bg3)', borderRadius: 8, padding: '10px 12px', fontSize: 12, lineHeight: 1.6 }}>
                        <strong>ข้อกำหนดการใช้รูปภาพตัวอย่าง</strong>
                        <ol style={{ margin: '6px 0 0', paddingLeft: 18 }}>{PACK_TERMS_TH.map((t, i) => <li key={i}>{t}</li>)}</ol>
                        {termsAlready
                          ? <div style={{ marginTop: 8, color: 'var(--text3)' }}>✓ ยอมรับแล้วเมื่อ {new Date(content0.pack_terms_accepted_at).toLocaleDateString('th-TH')}</div>
                          : <label style={{ display: 'flex', gap: 6, marginTop: 8, fontWeight: 600 }}><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} /> ฉันอ่านและยอมรับข้อกำหนดนี้</label>}
                      </div>
                    </div>
                  )}

                  {d.source === 'own' && (
                    <div style={{ display: 'grid', gap: 8 }}>
                      <div>
                        <div style={{ fontSize: 12, color: 'var(--text3)' }}>รูปปก (1 รูป)</div>
                        {d.hero && <img src={docImageUrl(TENANT_IMAGE_BUCKET, d.hero)} alt="" style={{ width: '100%', height: 80, objectFit: 'cover', borderRadius: 6, margin: '4px 0' }} />}
                        <input type="file" accept="image/*" disabled={busy} onChange={e => pickHero(e.target.files?.[0])} />
                      </div>
                      <div>
                        <div style={{ fontSize: 12, color: 'var(--text3)' }}>แกลเลอรี (สูงสุด {MAX_GALLERY} รูป — แบบโมเดิร์นเท่านั้นที่แสดง)</div>
                        {d.gallery.map((g, i) => (
                          <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '4px 0' }}>
                            <img src={docImageUrl(TENANT_IMAGE_BUCKET, g.path)} alt="" style={{ width: 54, height: 40, objectFit: 'cover', borderRadius: 4 }} />
                            <input className="input" placeholder="คำบรรยาย" value={g.caption} onChange={e => setDraft(x => ({ ...x, gallery: x.gallery.map((y, j) => (j === i ? { ...y, caption: e.target.value } : y)) }))} />
                            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDraft(x => ({ ...x, gallery: x.gallery.filter((_, j) => j !== i) }))}>🗑️</button>
                          </div>
                        ))}
                        {d.gallery.length < MAX_GALLERY && <input type="file" accept="image/*" disabled={busy} onChange={e => { addGallery(e.target.files?.[0]); e.target.value = '' }} />}
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="label">คำโปรยบนรูปปก (ไม่บังคับ)</label>
                    <input className="input" value={d.tagline} onChange={e => setDraft(x => ({ ...x, tagline: e.target.value }))} />
                  </div>
                  <div>
                    <label className="label">จุดเด่น (สูงสุด 3 ข้อ ไม่บังคับ)</label>
                    {d.features.map((f, i) => <input key={i} className="input" style={{ marginBottom: 6 }} value={f} onChange={e => setDraft(x => ({ ...x, features: x.features.map((y, j) => (j === i ? e.target.value : y)) }))} />)}
                  </div>
                  <div>
                    <label className="label">คำขอบคุณท้ายเอกสาร (ไม่บังคับ)</label>
                    <input className="input" value={d.thanks} onChange={e => setDraft(x => ({ ...x, thanks: e.target.value }))} />
                  </div>
                </>
              )}

              {err && <div style={{ color: 'var(--red, #d33)', fontSize: 13 }}>{err}</div>}
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? '⏳…' : '✅ ใช้แบบนี้'}</button>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setDraft(null)}>ยกเลิก</button>
              </div>
            </div>

            <div>
              <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 6 }}>ตัวอย่าง (ข้อมูลสมมติ พร้อมชื่อและโลโก้บริษัทของคุณ)</div>
              {draftFellBack && <div style={{ fontSize: 12.5, color: 'var(--yellow, #b58900)', marginBottom: 6 }}>⚠️ ยังไม่มีรูปปก จึงแสดงเป็นแบบคลาสสิก — เลือกชุดรูปหรืออัปโหลดรูปปก</div>}
              {draftTpl && <Thumb id="tpl-draft-preview" tenant={tenant} tpl={draftTpl} scale={0.62} />}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
