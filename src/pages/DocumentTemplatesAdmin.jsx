// ============================================================
// DocumentTemplatesAdmin — platform-admin-only page: tune the quotation
// templates (classic / modern / premium), manage the default image packs,
// then publish. Tenants only see a template once it is published.
// Spec: docs/superpowers/specs/2026-10-10-document-templates-design.md (phase 3).
// The database (RLS + admin RPCs) is the real boundary; the tab is also hidden
// for non-admins in App.jsx.
// ============================================================
import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { useTenant } from '../hooks/useTenant.js'
import { ConfirmDialog } from '../components/Modal.jsx'
import DocStyleEditor from '../components/DocStyleEditor.jsx'
import { useUserRole } from '../hooks/useUserRole.js'
import DocStyleControls from '../components/DocStyleControls.jsx'
import { QuotationPaper } from './Quotations.jsx'
import { resolveDocumentStyle } from '../lib/documentStyle.js'
import { resolveDocumentTemplate, DEFAULT_IMAGE_BUCKET } from '../lib/documentTemplates.js'
import { docImageUrl } from '../components/documentLayouts/quotationTheme.js'
import { DOC_STYLE_PREVIEW_SAMPLE } from '../lib/documentPreviewSample.js'
import { resizeToJpeg } from '../lib/resizeImage.js'

const STATUS_LABEL = { draft: '📝 ร่าง (tenant ยังไม่เห็น)', published: '✅ เผยแพร่แล้ว' }

export default function DocumentTemplatesAdmin() {
  const { tenant, refetch: refetchTenant } = useTenant()
  // The current tenant's own document_style sliders (moved here from Settings, 2026-10-18).
  // Same gate as in Settings: OWNER (the tenants UPDATE is owner-only under RLS) + platform admin (this tab).
  const { isAtLeast } = useUserRole()
  const isOwner = isAtLeast('OWNER')
  const [templates, setTemplates] = useState(null)
  const [packs, setPacks] = useState([])
  const [usage, setUsage] = useState({})
  const [loadError, setLoadError] = useState('')
  const [selKey, setSelKey] = useState('modern')
  const [docStyle, setDocStyle] = useState(resolveDocumentStyle({}))
  const [previewPackId, setPreviewPackId] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [confirm, setConfirm] = useState(null) // { title, message, run, danger }
  const [editPack, setEditPack] = useState(null)

  const load = useCallback(async () => {
    const [t, p, u] = await Promise.all([
      supabase.from('document_templates').select('*').order('key'),
      supabase.from('document_image_packs').select('*').order('name_th'),
      supabase.rpc('platform_document_template_usage'),
    ])
    const err = t.error || p.error
    if (err) { setLoadError(err.message || 'โหลดข้อมูลไม่สำเร็จ (ยังไม่ได้ติดตั้งตารางแบบเอกสารหรือไม่)'); return }
    setLoadError('')
    setTemplates(t.data || [])
    setPacks(p.data || [])
    setUsage(Object.fromEntries((u.data || []).map(r => [r.template_key, Number(r.tenant_count)])))
  }, [])
  useEffect(() => { load() }, [load])

  const selected = useMemo(() => (templates || []).find(t => t.key === selKey) || null, [templates, selKey])
  const selectedStyleKey = selected ? JSON.stringify(selected.style) : ''
  useEffect(() => { if (selected) setDocStyle(resolveDocumentStyle(selected.style)) }, [selKey, selectedStyleKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!previewPackId && packs.length) setPreviewPackId(packs[0].id) }, [packs, previewPackId])

  const setField = (k, v) => setDocStyle(s => ({ ...s, [k]: v }))
  const dirty = selected && JSON.stringify(resolveDocumentStyle(selected.style)) !== JSON.stringify(docStyle)

  const run = async (fn, okMsg) => {
    setBusy(true); setMsg('')
    try { await fn(); await load(); setMsg(okMsg) } catch (e) { setMsg('❌ ' + (e.message || e)) } finally { setBusy(false); setConfirm(null) }
  }
  const saveTemplate = (status) => run(async () => {
    const { error } = await supabase.rpc('platform_save_document_template', { p_key: selected.key, p_style: docStyle, p_status: status })
    if (error) throw error
  }, status === 'published' ? '✅ บันทึกแล้ว (เผยแพร่)' : '✅ บันทึกแล้ว')
  const rollback = () => run(async () => {
    const { error } = await supabase.rpc('platform_rollback_document_template', { p_key: selected.key })
    if (error) throw error
  }, '✅ ย้อนกลับ 1 ขั้นแล้ว')

  const count = usage[selKey] || 0
  const askSave = () => {
    if (selected.status === 'published' && selected.key !== 'classic') {
      setConfirm({ title: 'บันทึกแบบที่เผยแพร่อยู่', message: `แบบนี้เผยแพร่อยู่ และมี ${count} บริษัทใช้อยู่ การบันทึกจะมีผลกับเอกสารของพวกเขาทันที`, run: () => saveTemplate('published') })
    } else saveTemplate(selected.status)
  }
  const askPublish = () => setConfirm({ title: `เผยแพร่ "${selected.name_th}"`, message: `บริษัทที่ใช้งานอยู่ทุกรายจะเลือกแบบนี้ได้ (ตอนนี้ ${count} บริษัทใช้แบบนี้อยู่) ตรวจตัวอย่างทางขวาแล้วใช่ไหม`, run: () => saveTemplate('published') })
  const askUnpublish = () => setConfirm({ title: `ถอน "${selected.name_th}" เป็นร่าง`, message: `${count} บริษัทที่ใช้แบบนี้อยู่จะกลับไปใช้แบบคลาสสิกโดยอัตโนมัติ`, danger: true, run: () => saveTemplate('draft') })

  const previewTpl = useMemo(() => {
    if (!selected || !tenant) return null
    return resolveDocumentTemplate({
      tenant: { ...tenant, document_template_key: selected.key, document_accent: null, document_style: null, document_content: previewPackId ? { pack_id: previewPackId } : {} },
      templates: [{ ...selected, status: 'published', style: docStyle }],
      packs: packs.map(p => ({ ...p, status: 'published' })),
    })
  }, [selected, tenant, docStyle, packs, previewPackId])

  if (loadError) return <div className="card" style={{ padding: 20 }}>⚠️ {loadError}</div>
  if (!templates) return <div style={{ padding: 20, color: 'var(--text3)' }}>กำลังโหลด…</div>

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="card" style={{ padding: '14px 18px' }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>🎨 แบบเอกสาร (ใบเสนอราคา)</h2>
        <p style={{ margin: '6px 0 0', fontSize: 12.5, color: 'var(--text3)' }}>ปรับแต่งแล้วกด "เผยแพร่" บริษัทลูกค้าจึงจะเลือกแบบนั้นได้ ใบแจ้งหนี้/ใบเสร็จ/ใบกำกับภาษีใช้แบบคลาสสิกเสมอ</p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
          {templates.map(t => (
            <button key={t.key} type="button" className={`btn ${t.key === selKey ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setSelKey(t.key)} style={{ textAlign: 'left' }}>
              <div style={{ fontWeight: 700 }}>{t.name_th}</div>
              <div style={{ fontSize: 11, opacity: 0.85 }}>{STATUS_LABEL[t.status]} · ใช้อยู่ {usage[t.key] || 0}</div>
            </button>
          ))}
        </div>
      </div>

      {selected && (
        <div className="card">
          <div className="card-header"><div className="card-title">แก้ไข: {selected.name_th}</div></div>
          <div className="card-body" style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 20, alignItems: 'start' }}>
            <div style={{ display: 'grid', gap: 10, maxHeight: '80vh', overflowY: 'auto', paddingRight: 8 }}>
              {selected.layout !== 'classic' && (
                <div>
                  <label className="label">ชุดรูปที่ใช้ดูตัวอย่าง</label>
                  <select className="input" value={previewPackId} onChange={e => setPreviewPackId(e.target.value)}>
                    <option value="">— ยังไม่เลือก —</option>
                    {packs.map(p => <option key={p.id} value={p.id}>{p.name_th}{p.status === 'draft' ? ' (ร่าง)' : ''}</option>)}
                  </select>
                  {!packs.length && <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 4 }}>ยังไม่มีชุดรูป เพิ่มด้านล่างก่อน แบบโมเดิร์น/พรีเมียมต้องมีรูปปก</div>}
                </div>
              )}
              {selected.layout !== 'classic' && (
                <div style={{ fontSize: 11.5, color: 'var(--text3)' }}>แบบนี้ใช้ "สีหลัก" กับหัวตาราง/แถบหัว/กล่องยอดรวม ช่องสีพื้นและสีตัวอักษรหัวตารางด้านล่างไม่มีผล</div>
              )}
              <DocStyleControls docStyle={docStyle} setDocStyleField={setField} />
              <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
                <button className="btn btn-primary" disabled={busy || !dirty} onClick={askSave}>💾 บันทึก{selected.status === 'draft' ? ' (ยังเป็นร่าง)' : ''}</button>
                {selected.status === 'draft'
                  ? <button className="btn btn-ghost" disabled={busy || dirty} onClick={askPublish} title={dirty ? 'บันทึกก่อน' : ''}>🚀 เผยแพร่</button>
                  : selected.key !== 'classic' && <button className="btn btn-ghost" disabled={busy} onClick={askUnpublish}>⏸️ ถอนเป็นร่าง</button>}
                <button className="btn btn-ghost" disabled={busy || !selected.style_prev} onClick={rollback}>↩️ ย้อนกลับ 1 ขั้น</button>
                {msg && <div style={{ fontSize: 12.5 }}>{msg}</div>}
              </div>
            </div>
            <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'auto', maxHeight: '80vh' }}>
              {previewTpl && (
                <QuotationPaper
                  elementId="tpl-admin-preview" tenant={tenant} template={previewTpl} tag="ตัวอย่าง"
                  extraRemeasureKey={JSON.stringify(docStyle) + previewPackId}
                  {...DOC_STYLE_PREVIEW_SAMPLE}
                />
              )}
              {selected.layout !== 'classic' && previewTpl?.layout === 'classic' && (
                <div style={{ padding: 10, fontSize: 12.5, color: 'var(--yellow, #b58900)' }}>⚠️ ยังไม่มีรูปปก จึงแสดงเป็นแบบคลาสสิก — เลือกชุดรูปที่มีรูปปกก่อน</div>
              )}
            </div>
          </div>
        </div>
      )}

      <PackManager packs={packs} onEdit={setEditPack} onNew={() => setEditPack({ id: crypto.randomUUID(), name_th: '', hero_path: '', gallery: [], features_th: [], tagline_th: '', status: 'draft', isNew: true })} />
      {isOwner && tenant && <DocStyleEditor tenant={tenant} refetchTenant={refetchTenant} title="🎨 ระยะ/รูปแบบเอกสารของบริษัทนี้" />}
      {editPack && <PackEditor pack={editPack} onClose={() => setEditPack(null)} onSaved={() => { setEditPack(null); load() }} />}
      {confirm && <ConfirmDialog title={confirm.title} message={confirm.message} danger={confirm.danger} confirmDisabled={busy} onConfirm={confirm.run} onCancel={() => setConfirm(null)} />}
    </div>
  )
}

function PackManager({ packs, onEdit, onNew }) {
  return (
    <div className="card" style={{ padding: '14px 18px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>🖼️ ชุดรูปตัวอย่าง (ใช้เป็นค่าเริ่มต้นเมื่อบริษัทยังไม่มีรูปของตัวเอง)</h3>
        <button className="btn btn-sm btn-primary" onClick={onNew}>+ เพิ่มชุดรูป</button>
      </div>
      {!packs.length && <div style={{ marginTop: 10, fontSize: 13, color: 'var(--text3)' }}>ยังไม่มีชุดรูป</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12, marginTop: 12 }}>
        {packs.map(p => (
          <button key={p.id} type="button" onClick={() => onEdit(p)} className="card" style={{ textAlign: 'left', padding: 0, overflow: 'hidden', cursor: 'pointer' }}>
            {p.hero_path ? <img src={docImageUrl(DEFAULT_IMAGE_BUCKET, p.hero_path)} alt="" style={{ width: '100%', height: 90, objectFit: 'cover', display: 'block' }} /> : <div style={{ height: 90, background: 'var(--bg3)' }} />}
            <div style={{ padding: '8px 10px' }}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>{p.name_th || '(ไม่มีชื่อ)'}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text3)' }}>{p.status === 'published' ? '✅ เผยแพร่' : '📝 ร่าง'} · แกลเลอรี {(p.gallery || []).length}/4</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

function PackEditor({ pack, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    ...pack,
    features_th: [0, 1, 2].map(i => (pack.features_th || [])[i] || ''),
    gallery: [0, 1, 2, 3].map(i => (pack.gallery || [])[i] || { path: '', caption_th: '' }),
  }))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const upload = async (file, name) => {
    const blob = await resizeToJpeg(file)
    const path = `packs/${form.id}/${name}-${Date.now()}.jpg`
    const { error } = await supabase.storage.from(DEFAULT_IMAGE_BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: true })
    if (error) throw error
    return path
  }
  const pickHero = async (file) => { if (!file) return; setBusy(true); setErr(''); try { set('hero_path', await upload(file, 'hero')) } catch (e) { setErr(e.message) } finally { setBusy(false) } }
  const pickGallery = async (i, file) => {
    if (!file) return
    setBusy(true); setErr('')
    try { const path = await upload(file, `g${i + 1}`); setForm(f => ({ ...f, gallery: f.gallery.map((g, j) => (j === i ? { ...g, path } : g)) })) } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  const save = async () => {
    if (!form.name_th.trim()) { setErr('ใส่ชื่อชุดรูปก่อน'); return }
    if (form.status === 'published' && !form.hero_path) { setErr('เผยแพร่ต้องมีรูปปก'); return }
    setBusy(true); setErr('')
    const row = {
      id: form.id, name_th: form.name_th.trim(), hero_path: form.hero_path || '', status: form.status, tagline_th: form.tagline_th.trim(),
      features_th: form.features_th.map(s => s.trim()).filter(Boolean),
      gallery: form.gallery.filter(g => g.path).map(g => ({ path: g.path, caption_th: (g.caption_th || '').trim() })),
      updated_at: new Date().toISOString(),
    }
    const { error } = await supabase.from('document_image_packs').upsert(row, { onConflict: 'id' })
    setBusy(false)
    if (error) { setErr(error.message); return }
    onSaved()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 640 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header"><div className="modal-title">{pack.isNew ? 'เพิ่มชุดรูป' : 'แก้ชุดรูป'}</div><button className="modal-close" onClick={onClose}>✕</button></div>
        <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
          <div><label className="label">ชื่อชุด (เช่น งานประตูหน้าต่างอลูมิเนียม)</label><input className="input" value={form.name_th} onChange={e => set('name_th', e.target.value)} /></div>
          <div><label className="label">คำโปรยบนรูปปก</label><input className="input" value={form.tagline_th} onChange={e => set('tagline_th', e.target.value)} /></div>
          <div>
            <label className="label">จุดเด่น (สูงสุด 3 ข้อ)</label>
            {form.features_th.map((f, i) => <input key={i} className="input" style={{ marginBottom: 6 }} value={f} onChange={e => set('features_th', form.features_th.map((x, j) => (j === i ? e.target.value : x)))} />)}
          </div>
          <div>
            <label className="label">รูปปก</label>
            {form.hero_path && <img src={docImageUrl(DEFAULT_IMAGE_BUCKET, form.hero_path)} alt="" style={{ width: '100%', height: 110, objectFit: 'cover', borderRadius: 6, marginBottom: 6 }} />}
            <input type="file" accept="image/*" disabled={busy} onChange={e => pickHero(e.target.files?.[0])} />
          </div>
          <div>
            <label className="label">แกลเลอรี (สูงสุด 4 รูป)</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {form.gallery.map((g, i) => (
                <div key={i}>
                  {g.path && <img src={docImageUrl(DEFAULT_IMAGE_BUCKET, g.path)} alt="" style={{ width: '100%', height: 70, objectFit: 'cover', borderRadius: 6, marginBottom: 4 }} />}
                  <input type="file" accept="image/*" disabled={busy} onChange={e => pickGallery(i, e.target.files?.[0])} style={{ width: '100%' }} />
                  <input className="input" placeholder="คำบรรยายสั้นๆ" style={{ marginTop: 4 }} value={g.caption_th || ''} onChange={e => setForm(f => ({ ...f, gallery: f.gallery.map((x, j) => (j === i ? { ...x, caption_th: e.target.value } : x)) }))} />
                </div>
              ))}
            </div>
          </div>
          <div>
            <label className="label">สถานะ</label>
            <select className="input" value={form.status} onChange={e => set('status', e.target.value)}>
              <option value="draft">📝 ร่าง</option>
              <option value="published">✅ เผยแพร่ (tenant เลือกใช้ได้)</option>
            </select>
          </div>
          {err && <div style={{ color: 'var(--red, #d33)', fontSize: 13 }}>{err}</div>}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>ยกเลิก</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? '⏳…' : '💾 บันทึก'}</button>
        </div>
      </div>
    </div>
  )
}
