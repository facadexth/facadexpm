// ============================================================
// Sites — ไซท์งาน
// ✅ Add/Edit ไซท์ (ชื่อ, สถานะ, วันเริ่ม/จบ, มูลค่าสัญญา)
// ✅ Countdown display + overdue notice
// ✅ ปุ่ม "จบไซท์งาน" พร้อม confirm dialog
// ✅ Cost breakdown (ตั้งค่าต้นทุนต่อประเภท)
// ✅ กดตัวเลขรายรับ/รายจ่าย → navigate พร้อม filter ไซท์
// ✅ Labor cost แยกช่างบริษัท vs sub-contract
// ============================================================
import { useState, useMemo, useEffect } from 'react'
import { usePendingFocus } from '../hooks/usePendingFocus.js'
import PendingFocusChip from '../components/PendingFocusChip.jsx'
import { supabase } from '../lib/supabase.js'
import { fetchAllRows } from '../lib/fetchAllRows.js'
import { autoShortName } from '../lib/siteShortName.js'
import { useSites, useLaborCost, useClients, useSeatStatus, useCategories, useSiteCostEstimates, saveSiteCostEstimates, usePhaseTasks } from '../hooks/useSupabase.js'
import GanttView from './sites/GanttView.jsx'
import { summarizeTasks } from './sites/phaseTasksCalc.js'
import { PencilIcon, LinkIcon } from '../components/icons.jsx'
import RowActionsMenu from '../components/RowActionsMenu.jsx'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import { canManageSites, canSeeMoney, isPm } from '../lib/roles.js'
import { useTenant } from '../hooks/useTenant.js'
import AttachmentsSection from '../components/AttachmentsSection.jsx'
import { fmt, fmtDate, countdown } from '../lib/supabase.js'
import { warrantyEnd } from '../lib/warranty.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import FinishSiteModal from '../components/FinishSiteModal.jsx'
import ExcelUpload from '../components/ExcelUpload.jsx'
import SearchableSelect from '../components/SearchableSelect.jsx'
import QuickAddSelect from '../components/QuickAddSelect.jsx'
import CardTable from '../components/CardTable.jsx'
import MoreActions from '../components/MoreActions.jsx'
import SitePhoneCards from '../components/phone/SitePhoneCards.jsx'
import { useIsPhone } from '../hooks/useIsPhone.js'

// Phone card layout of the sites table (CardTable): inferred roles would pick รหัส as the title, so say it explicitly.
const SITES_CARD_MAP = { title: 'ชื่อไซท์งาน', sub: ['รหัส'], amount: 'มูลค่าสัญญา', status: 'สถานะ', actions: 'last' }
import { useDraftForm } from '../hooks/useDraftForm.js'
import { loadOrigin, fetchRoute, routeErrorMessage } from '../lib/siteRoute.js'

const STATUS_OPTS = ['Ongoing', 'Completed', 'On Hold', 'Cancelled']

// cost_labor is intentionally absent here -- it's superseded by real,
// auto-computed labor cost (site_financial_summary.worker_labor_cost /
// subcontractor_labor_cost, shown in SiteOverviewModal's pie chart and no
// longer a manual estimate). The sites.cost_labor column itself is left
// untouched so no historical estimate data is lost.
const COST_TYPES = [
  { key: 'cost_aluminum',   label: 'อลูมิเนียม/เหล็ก' },
  { key: 'cost_glass',      label: 'กระจก' },
  { key: 'cost_equipment',  label: 'อุปกรณ์' },
  { key: 'cost_rubber',     label: 'ซิลิโคน/ยาง' },
  { key: 'cost_other',      label: 'เบ็ดเตล็ด' },
]

const EMPTY_FORM = {
  name: '', short_name: '', client_id: '', location: '',
  distance_km: '', travel_minutes: '', map_url: '', lat: '', lng: '',
  status: 'Ongoing', start_date: '', end_date: '',
  has_vat: true, contract_value_no_vat: '', notes: '',
  default_vat_pct: 7, default_tax_withheld_pct: 3, default_retention_pct: 0,
  default_deposit_pct: 0, warranty_months: 12, handover_date: '',
  ...Object.fromEntries(COST_TYPES.map(t => [t.key, '']))
}

const VAT_RATE = 0.07

const WARRANTY_CHIPS = [6, 12, 24, 60]
const fmtDmy = iso => (iso ? iso.split('-').reverse().join('/') : '')

/**
 * Build the `sites` insert/update payload from a SiteForm form object.
 * Shared by Sites.jsx's own add/edit flow and Quotations.jsx's
 * "accept quotation → create new site" flow, so both write the exact
 * same full set of fields (no silently-dropped fields in either place).
 */
export function siteFormToPayload(form) {
  const noVatValue = parseFloat(form.contract_value_no_vat) || 0
  const vatAmount = form.has_vat ? Math.round(noVatValue * VAT_RATE * 100) / 100 : 0
  const contractValueTotal = Math.round((noVatValue + vatAmount) * 100) / 100
  return {
    name:           form.name,
    short_name:     (form.short_name || '').trim() || null,
    client_id:      form.client_id || null,
    location:       form.location || null,
    distance_km:    parseFloat(form.distance_km) || null,
    travel_minutes: form.travel_minutes === '' || form.travel_minutes == null ? null : Math.round(parseFloat(form.travel_minutes)) || null,
    map_url:        form.map_url || null,
    lat:            form.lat === '' ? null : parseFloat(form.lat),
    lng:            form.lng === '' ? null : parseFloat(form.lng),
    status:         form.status,
    start_date:     form.start_date || null,
    end_date:       form.end_date || null,
    has_vat:              form.has_vat,
    contract_value_no_vat: noVatValue || null,
    contract_value:        contractValueTotal || null,
    default_vat_pct:           form.default_vat_pct === '' ? null : parseFloat(form.default_vat_pct),
    default_tax_withheld_pct:  form.default_tax_withheld_pct === '' ? null : parseFloat(form.default_tax_withheld_pct),
    default_retention_pct:     form.default_retention_pct === '' ? null : parseFloat(form.default_retention_pct),
    default_deposit_pct:       form.default_deposit_pct === '' ? null : parseFloat(form.default_deposit_pct),
    notes:          form.notes || null,
    warranty_months: (() => { const n = parseInt(form.warranty_months, 10); return Number.isNaN(n) ? 12 : n })(),
    handover_date:  form.handover_date || null,
    ...Object.fromEntries(COST_TYPES.map(t => [t.key, parseFloat(form[t.key]) || null]))
  }
}

// The only site fields a PM may change (mirrors pm_update_site's whitelist).
const PM_SITE_KEYS = ['name', 'short_name', 'status', 'start_date', 'end_date', 'location', 'map_url', 'lat', 'lng', 'distance_km', 'travel_minutes', 'notes']

/** PM save: the allowed fields whose value differs from the site as loaded. */
export function pmSitePatch(site, form) {
  const clean = v => (typeof v === 'number' && Number.isNaN(v) ? null : v)
  const before = siteFormToPayload({ ...EMPTY_FORM, ...site })
  const after = siteFormToPayload(form)
  const patch = {}
  for (const k of PM_SITE_KEYS) {
    if (clean(after[k]) !== clean(before[k])) patch[k] = clean(after[k])
  }
  return patch
}

export function SiteForm({ initial = EMPTY_FORM, clients = [], onSave, onCancel, loading, hasModuleAccess = () => false, draftKey = 'sites-form', seat, onClientCreated, inventoryCategories = [], siteCostEstimates = [], pmMode = false }) {
  const isAdd = !initial?.id
  const [form, setForm, clearDraft] = useDraftForm(draftKey, { ...EMPTY_FORM, ...initial }, isAdd)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  // "ดึงพิกัดจากลิงก์" -- resolves a pasted Google Maps link (full or
  // shortened, e.g. maps.app.goo.gl/xxxx) into lat/lng via
  // extract-map-coordinates, so an admin can paste a link shared by
  // someone at the site instead of standing there themselves or typing
  // coordinates by hand.
  const [extractingCoords, setExtractingCoords] = useState(false)
  const handleExtractCoords = async () => {
    if (!form.map_url) { alert('กรุณาวางลิงก์ Google Maps ก่อน'); return }
    setExtractingCoords(true)
    try {
      const { data, error } = await supabase.functions.invoke('extract-map-coordinates', { body: { url: form.map_url } })
      if (error) throw error
      if (!data?.ok) { alert(data?.error || 'หาพิกัดจากลิงก์นี้ไม่พบ'); return }
      set('lat', String(data.lat))
      set('lng', String(data.lng))
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setExtractingCoords(false)
    }
  }

  // "คำนวณจากส่วนกลาง" -- driving distance + time from the base set in Settings -> ค่าเดินทาง
  // to this site's coordinates (pasted link is resolved first if no coordinates yet).
  const [routing, setRouting] = useState(false)
  const [routeNote, setRouteNote] = useState(null)
  const handleRoute = async () => {
    setRouting(true); setRouteNote(null)
    try {
      const origin = await loadOrigin()
      if (!origin) { setRouteNote('ตั้งที่ตั้งส่วนกลางก่อนที่ ตั้งค่า → ค่าเดินทางต่อไซท์'); return }
      let lat = form.lat === '' ? null : parseFloat(form.lat)
      let lng = form.lng === '' ? null : parseFloat(form.lng)
      if ((lat == null || lng == null) && form.map_url) {
        const { data } = await supabase.functions.invoke('extract-map-coordinates', { body: { url: form.map_url } })
        if (data?.ok) { lat = data.lat; lng = data.lng; set('lat', String(lat)); set('lng', String(lng)) }
      }
      if (lat == null || lng == null) { setRouteNote('ยังไม่มีพิกัดไซต์ วางลิงก์ Google Maps แล้วกด "ดึงพิกัดจากลิงก์" ก่อน'); return }
      const r = await fetchRoute(origin, { lat, lng })
      if (!r?.ok) { setRouteNote(routeErrorMessage(r?.error)); return }
      set('distance_km', String(r.km)); set('travel_minutes', String(r.minutes))
      setRouteNote(`ได้ ${r.km} กม. ขับประมาณ ${r.minutes} นาที (ไม่รวมรถติด) กดบันทึกไซต์เพื่อเก็บค่านี้`)
    } catch (e) { setRouteNote('คำนวณไม่สำเร็จ: ' + e.message) } finally { setRouting(false) }
  }

  // ต้นทุนประมาณการต่อไซท์ -- คีย์ด้วย inventory_categories จริง (หมวดหมู่
  // เดียวกับที่ใช้ตั้งค่าตัดสต๊อกในหน้าคลังสินค้า) แทนคอลัมน์ cost_aluminum/
  // cost_glass/ฯลฯ แบบตายตัวเดิม แยกออกจาก useDraftForm's `form` เพราะเก็บคน
  // ละตารางกับ sites เอง (site_cost_estimates ผูก site_id ซึ่งไซท์ใหม่ยังไม่มี
  // จนกว่าจะบันทึกครั้งแรก)
  const [costEstimates, setCostEstimates] = useState(() => {
    const initial = {}
    for (const e of siteCostEstimates) initial[e.inventory_category_id] = String(e.estimated_amount ?? '')
    return initial
  })
  const setCostEstimate = (categoryId, v) => setCostEstimates(s => ({ ...s, [categoryId]: v }))
  // เตือนทั้งตอนสร้างไซท์ใหม่ และตอนเปลี่ยนสถานะไซท์เดิมกลับเป็น "กำลังดำเนินการ"
  // (initial.status มาจากค่าก่อนแก้ไข -- ถ้าเดิมเป็น Ongoing อยู่แล้วไม่ถือว่าใช้โควตาเพิ่ม)
  const reopening = !isAdd && initial.status !== 'Ongoing' && form.status === 'Ongoing'
  const sitesFull = (isAdd || reopening) && form.status === 'Ongoing'
    && seat?.sites?.max != null && seat.sites.used >= seat.sites.max

  const totalCostBreakdown = Object.values(costEstimates).reduce((s, v) => s + (parseFloat(v) || 0), 0)

  const noVatValue = parseFloat(form.contract_value_no_vat) || 0
  const vatAmount = form.has_vat ? Math.round(noVatValue * VAT_RATE * 100) / 100 : 0
  const contractValueTotal = Math.round((noVatValue + vatAmount) * 100) / 100

  return (
    <form onSubmit={e => {
      e.preventDefault()
      const wm = form.warranty_months === '' ? 12 : Number(form.warranty_months)
      if (!Number.isInteger(wm) || wm < 0 || wm > 120) { alert('ระยะประกันต้องอยู่ระหว่าง 0 ถึง 120 เดือน'); return }
      clearDraft(); onSave({ ...form, cost_estimates: costEstimates })
    }}>
      <div className="modal-body" style={{ display: 'grid', gap: 14 }}>
        <div className="form-grid-2">
          <div>
            <label className="label">ชื่อไซท์งาน ★</label>
            <input className="input" required value={form.name} onChange={e => set('name', e.target.value)} placeholder="เช่น NCP Tower B" />
          </div>
          {!pmMode && <div>
            <label className="label">ลูกค้า / เจ้าของงาน</label>
            <QuickAddSelect
              value={form.client_id}
              onChange={id => set('client_id', id)}
              placeholder="— เลือกลูกค้า —"
              options={clients.map(c => ({
                value: c.id,
                label: `${c.client_number} · ${c.name}`,
                keywords: `${c.client_number} ${c.name}`,
              }))}
              table="clients"
              namePlaceholder="ชื่อลูกค้าใหม่"
              onCreated={onClientCreated}
            />
          </div>}
        </div>
        <div>
          <label className="label">ชื่อย่อ (ไม่บังคับ)</label>
          <input className="input" maxLength={30} value={form.short_name ?? ''} onChange={e => set('short_name', e.target.value)} placeholder={autoShortName(form.name) || 'ใช้ชื่ออัตโนมัติจากชื่อไซท์งาน'} />
        </div>
        <div>
          <label className="label">ที่ตั้งโครงการ</label>
          <input className="input" value={form.location} onChange={e => set('location', e.target.value)} placeholder="จังหวัด / ที่อยู่" />
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label">ระยะทางจากโรงงาน (กม.)</label>
            <input type="number" className="input" min="0" step="0.1" value={form.distance_km}
              onChange={e => set('distance_km', e.target.value)} placeholder="เที่ยวเดียว — ใช้คิดค่าเดินทาง (×2)" />
            <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-ghost" disabled={routing} onClick={handleRoute} style={{ whiteSpace: 'nowrap' }}>
                {routing ? '⏳...' : '🚗 คำนวณจากส่วนกลาง'}
              </button>
              {form.travel_minutes !== '' && form.travel_minutes != null && !routeNote && (
                <span style={{ fontSize: 12, color: 'var(--text3)' }}>ขับประมาณ {form.travel_minutes} นาที</span>
              )}
            </div>
            {routeNote && <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>{routeNote}</div>}
          </div>
          <div>
            <label className="label">ลิงก์ Google Maps</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="input" type="url" value={form.map_url} onChange={e => set('map_url', e.target.value)} placeholder="วางลิงก์แผนที่..." />
              <button type="button" className="btn btn-ghost" disabled={extractingCoords || !form.map_url} onClick={handleExtractCoords} style={{ whiteSpace: 'nowrap' }}>
                {extractingCoords ? '⏳...' : '📍 ดึงพิกัดจากลิงก์'}
              </button>
            </div>
          </div>
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label">พิกัด GPS ไซท์งาน (ละติจูด, ลองจิจูด)</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="number" step="any" className="input" value={form.lat}
                onChange={e => set('lat', e.target.value)} placeholder="ละติจูด เช่น 13.756331" />
              <input type="number" step="any" className="input" value={form.lng}
                onChange={e => set('lng', e.target.value)} placeholder="ลองจิจูด เช่น 100.501765" />
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button type="button" className="btn btn-ghost" onClick={() => {
              if (!navigator.geolocation) { alert('เบราว์เซอร์นี้ไม่รองรับตำแหน่งที่ตั้ง'); return }
              navigator.geolocation.getCurrentPosition(
                pos => { set('lat', String(pos.coords.latitude)); set('lng', String(pos.coords.longitude)) },
                err => alert('ไม่สามารถอ่านตำแหน่งได้: ' + err.message)
              )
            }}>📍 ใช้ตำแหน่งปัจจุบัน</button>
          </div>
        </div>
        <p style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: -6, marginBottom: 12 }}>
          ต้องตั้งพิกัดก่อน พนักงานจึงจะเช็คอินที่ไซท์นี้ได้ — ยืนที่ไซท์งานแล้วกดปุ่ม "ใช้ตำแหน่งปัจจุบัน" ง่ายที่สุด
        </p>
        <div className="form-grid-3">
          <div>
            <label className="label">สถานะ</label>
            <select className="select" value={form.status} onChange={e => set('status', e.target.value)}>
              {pmMode ? <>
                {/* PM cannot finish a site (that flow stamps end_date and moves leftover stock); an
                    already-Completed site keeps its value as a disabled option so the select shows it */}
                {initial.status === 'Completed' && <option disabled>Completed</option>}
                {STATUS_OPTS.filter(s => s !== 'Completed').map(s => <option key={s}>{s}</option>)}
              </> : STATUS_OPTS.map(s => <option key={s}>{s}</option>)}
            </select>
            {sitesFull && (
              <div className="alert alert-warning" style={{ fontSize: 12, marginTop: 6 }}>
                ⚠️ Package ปัจจุบันอนุญาตไซท์งาน "กำลังดำเนินการ" สูงสุด {seat.sites.max} ไซท์ (ใช้ไปแล้ว {seat.sites.used})
                หากบันทึกอาจไม่สำเร็จ — ติดต่อผู้ดูแลระบบเพื่ออัปเกรด package
              </div>
            )}
          </div>
          <div>
            <label className="label">วันเริ่มต้น</label>
            <input type="date" className="input" value={form.start_date} onChange={e => set('start_date', e.target.value)} />
          </div>
          <div>
            <label className="label">วันจบงาน</label>
            <input type="date" className="input" value={form.end_date} onChange={e => set('end_date', e.target.value)} />
          </div>
        </div>
        {!pmMode && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <label className="label">การรับประกันผลงาน</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
              <span style={{ fontSize: 13 }}>ระยะประกัน</span>
              <input type="number" className="input input-sm" style={{ width: 80 }} min="0" max="120" step="1"
                value={form.warranty_months}
                onChange={e => {
                  const v = e.target.value
                  set('warranty_months', v === '' ? '' : String(Math.min(120, Math.max(0, parseInt(v, 10) || 0))))
                }} />
              <span style={{ fontSize: 13 }}>เดือน</span>
              {WARRANTY_CHIPS.map(m => (
                <button type="button" key={m}
                  className={`btn btn-sm ${Number(form.warranty_months) === m ? 'btn-primary' : ''}`}
                  onClick={() => set('warranty_months', String(m))}>{m}</button>
              ))}
            </div>
            {form.status === 'Completed' ? (
              <>
                <div style={{ maxWidth: 220, marginBottom: 6 }}>
                  <label className="label">วันส่งมอบ</label>
                  <input type="date" className="input" value={form.handover_date || ''} onChange={e => set('handover_date', e.target.value)} />
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text2)' }}>
                  {Number(form.warranty_months) === 0 ? 'ไม่มีประกัน' : (() => {
                    const end = warrantyEnd(form.handover_date || null, Number(form.warranty_months))
                    return end ? `ประกันถึง ${fmtDmy(end)}` : 'ประกันถึง —'
                  })()}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12.5, color: 'var(--text3)' }}>ประกันเริ่มนับเมื่อกด จบไซท์งาน</div>
            )}
          </div>
        )}
        {/* PM (pmMode) never sees money: contract value, cost estimates and income defaults are left out */}
        {!pmMode && <>
        <div>
          <label className="label">มูลค่าสัญญา</label>
          <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
              <input type="radio" name="has_vat" checked={form.has_vat === true} onChange={() => set('has_vat', true)} />
              มี VAT
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
              <input type="radio" name="has_vat" checked={form.has_vat === false} onChange={() => set('has_vat', false)} />
              ไม่มี VAT
            </label>
          </div>
          <div className="form-grid-2">
            <div>
              <label className="label">มูลค่าก่อน VAT (บาท)</label>
              <input type="number" className="input" min="0" step="0.01" value={form.contract_value_no_vat}
                onChange={e => set('contract_value_no_vat', e.target.value)} placeholder="ตามสัญญา" />
            </div>
            <div>
              <label className="label">รวม VAT (คำนวณอัตโนมัติ)</label>
              <input className="input" disabled value={fmt(contractValueTotal)}
                style={{ opacity: 0.7, cursor: 'not-allowed' }} />
            </div>
          </div>
          {form.has_vat && noVatValue > 0 && (
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text3)' }}>
              VAT 7%: {fmt(vatAmount)} บาท
            </div>
          )}
        </div>

        {/* Cost Breakdown -- คีย์ด้วยหมวดหมู่สินค้าคงคลังจริง (หน้าคลังสินค้า)
            แทนหมวดตายตัวเดิม ต้องมีโมดูลใบสั่งซื้อ/คลังสินค้าและมีหมวดหมู่ตั้ง
            ไว้แล้วอย่างน้อย 1 หมวดจึงจะเห็นส่วนนี้ (ตัวเลขที่กรอกที่นี่จะถูกใช้
            เป็นสัดส่วนตั้งต้นตอนตัดสต๊อกของไซท์นี้โดยเฉพาะ -- ดูหน้าคลังสินค้า) */}
        {hasModuleAccess('purchase_orders') && inventoryCategories.length > 0 && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text3)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>
              ต้นทุนประมาณการ ตามหมวดหมู่สินค้าคงคลัง (ระบุหรือไม่ก็ได้)
            </div>
            <div className="form-grid-3">
              {inventoryCategories.map(c => (
                <div key={c.id}>
                  <label className="label">{c.name}</label>
                  <input type="number" className="input input-sm" min="0" step="0.01"
                    value={costEstimates[c.id] ?? ''} onChange={e => setCostEstimate(c.id, e.target.value)} placeholder="บาท" />
                </div>
              ))}
            </div>
            {totalCostBreakdown > 0 && (
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text3)' }}>
                รวมต้นทุนที่ระบุ: <strong style={{ color: 'var(--yellow)' }}>{fmt(totalCostBreakdown)} บาท</strong>
                {contractValueTotal > 0 && (
                  <span style={{ marginLeft: 8 }}>
                    ({((totalCostBreakdown / contractValueTotal) * 100).toFixed(1)}% ของมูลค่าสัญญา)
                  </span>
                )}
              </div>
            )}
            <p style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6 }}>
              สัดส่วนที่กรอกที่นี่ (คำนวณเป็น %) จะถูกใช้เป็นค่าเริ่มต้นตอนตัดสต๊อกของไซท์นี้แทนค่าเริ่มต้นรวมของบริษัท — แก้ทีหลังต่อใบแจ้งหนี้ได้เสมอ
            </p>
          </div>
        )}

        {/* Income defaults */}
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text3)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>
            ค่าเริ่มต้นสำหรับรายรับ (ใช้ auto-fill ตอนเพิ่มรายรับของไซท์นี้)
          </div>
          <div className="form-grid-4">
            <div>
              <label className="label">VAT (%)</label>
              <input type="number" className="input input-sm" min="0" step="0.01"
                value={form.default_vat_pct} onChange={e => set('default_vat_pct', e.target.value)} placeholder="7" />
            </div>
            <div>
              <label className="label">Tax ถูกหัก (%)</label>
              <input type="number" className="input input-sm" min="0" step="0.01"
                value={form.default_tax_withheld_pct} onChange={e => set('default_tax_withheld_pct', e.target.value)} placeholder="3" />
            </div>
            <div>
              <label className="label">Retention (%)</label>
              <input type="number" className="input input-sm" min="0" step="0.01"
                value={form.default_retention_pct} onChange={e => set('default_retention_pct', e.target.value)} placeholder="0" />
            </div>
            {hasModuleAccess('client_deposits') && (
              <div>
                <label className="label">มัดจำ (%)</label>
                <input type="number" className="input input-sm" min="0" step="0.01"
                  value={form.default_deposit_pct} onChange={e => set('default_deposit_pct', e.target.value)} placeholder="0" />
              </div>
            )}
          </div>
        </div>
        </>}

        <div>
          <label className="label">หมายเหตุ</label>
          <textarea className="textarea" rows={2} value={form.notes} onChange={e => set('notes', e.target.value)} />
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={() => { clearDraft(); onCancel() }}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}
        </button>
      </div>
    </form>
  )
}

export default function Sites({ navigateTo, openSiteOverview, navState }) {
  const isPhone = useIsPhone()
  const { role } = useUserRole()
  const canEdit = canManageSites(role) && canEditPage(role, 'sites')
  const pm = isPm(role) // PM edits existing sites only, without money fields
  const showMoney = canSeeMoney(role)
  const { tenant, hasModuleAccess } = useTenant()
  const { data: sites, refetch } = useSites()
  const { data: allPhaseTasks } = usePhaseTasks() // only fetched for the 🗂 Kanban summary subtab below
  const { data: laborData } = useLaborCost()
  const { data: clients, refetch: refetchClients }   = useClients()
  const { data: seat, refetch: refetchSeat } = useSeatStatus()
  const { data: inventoryCategoriesRaw } = useCategories()
  // Only categories ticked "ใช้คิดต้นทุน/ตัดสต็อก" in ตั้งค่า > หมวดหมู่ show up
  // here -- others stay usable as plain expense/item tags, just not for cost estimates.
  const inventoryCategories = useMemo(() => (inventoryCategoriesRaw || []).filter(c => c.use_for_cost_deduction), [inventoryCategoriesRaw])
  const { data: siteCostEstimates, refetch: refetchSiteCostEstimates } = useSiteCostEstimates()

  const [showForm,    setShowForm]    = useState(false)
  const [editSite,    setEditSite]    = useState(null)     // site object to edit
  // The list rows come from the site_financial_summary view, which does not carry the warranty
  // columns, so fetch them from `sites` itself when opening the editor (not for PM: no RPC column).
  const openEdit = async st => {
    let extra = {}
    if (!pm) {
      const { data, error } = await supabase.from('sites').select('warranty_months, handover_date').eq('id', st.id).single()
      if (error || !data) { alert('โหลดข้อมูลไซท์ไม่สำเร็จ: ' + (error?.message || 'ไม่พบข้อมูล')); return }
      extra = data
    }
    setEditSite({ ...st, ...extra }); setShowForm(true)
  }
  const [completeSite, setCompleteSite] = useState(null)
  const [deleteId,    setDeleteId]    = useState(null)
  const [saving,      setSaving]      = useState(false)
  const [showImport,  setShowImport]  = useState(false)
  const [toast,       setToast]       = useState(null)
  const [statusFilter, setStatusFilter] = useState('Ongoing')
  // An ADMIN cannot open the Communication Center, so an issue-report notification lands here;
  // the reports themselves are inside each site's daily report.
  const issuesFocus = usePendingFocus(navState, 'issues_open')
  const [search,      setSearch]      = useState('')
  const [sortCol,     setSortCol]     = useState('last_activity_date')
  const [sortDir,     setSortDir]     = useState('desc')
  const [viewMode,      setViewMode]      = useState('table') // 'table' | 'gantt' | 'kanban'
  // PM rows (pm_sites) carry no last_activity_date (it is derived from money
  // activity), so PM has no กิจกรรมล่าสุด column and defaults to site code instead.
  const sortKey = pm && sortCol === 'last_activity_date' ? 'site_number' : sortCol

  // Labor cost lookup
  const laborBysite = useMemo(() => {
    const m = {}
    ;(laborData || []).forEach(l => {
      if (!m[l.site_id]) m[l.site_id] = 0
      m[l.site_id] += l.labor_cost || 0
    })
    return m
  }, [laborData])

  const filtered = useMemo(() => {
    let rows = (sites || [])
      .filter(s => !statusFilter || statusFilter === 'All' || s.status === statusFilter)
      .filter(s => !search || s.name?.toLowerCase().includes(search.toLowerCase()) || s.site_number?.toLowerCase().includes(search.toLowerCase()))
    return [...rows].sort((a, b) => {
      const va = a[sortKey] ?? ''
      const vb = b[sortKey] ?? ''
      if (typeof va === 'number') return sortDir === 'asc' ? va - vb : vb - va
      return sortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va))
    })
  }, [sites, statusFilter, search, sortKey, sortDir])

  const toggleSort = (col) => {
    if (sortKey === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }
  const si = (col) => sortKey === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕'

  // ── Handlers ──
  const handleSave = async (form) => {
    if (pm) return handlePmSave(form)
    setSaving(true)
    try {
      const payload = siteFormToPayload(form)
      let siteId = editSite?.id
      if (editSite) {
        const { error } = await supabase.from('sites').update(payload).eq('id', editSite.id)
        if (error) throw error
      } else {
        const { data, error } = await supabase.from('sites').insert(payload).select('id').single()
        if (error) throw error
        siteId = data.id
      }
      if (form.cost_estimates && Object.keys(form.cost_estimates).length) {
        await saveSiteCostEstimates(siteId, form.cost_estimates)
      }
      setShowForm(false); setEditSite(null); refetch(); refetchSeat(); refetchSiteCostEstimates()
    } catch (e) {
      alert(e.message?.includes('row-level security policy')
        ? 'บันทึกไม่สำเร็จ: อาจเกินจำนวนไซท์งานที่ package ปัจจุบันอนุญาต กรุณาติดต่อผู้ดูแลระบบเพื่ออัปเกรด package'
        : 'บันทึกไม่สำเร็จ: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const handlePmSave = async (form) => {
    if (!editSite) return
    setSaving(true)
    try {
      const patch = pmSitePatch(editSite, form)
      if (Object.keys(patch).length) {
        const { error } = await supabase.rpc('pm_update_site', { p_site_id: editSite.id, p_patch: patch })
        if (error) throw error
      }
      setShowForm(false); setEditSite(null); refetch(); refetchSeat()
    } catch (e) {
      alert('บันทึกไม่สำเร็จ: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteId) return
    const { error } = await supabase.from('sites').delete().eq('id', deleteId)
    if (!error) { setDeleteId(null); refetch() }
    else alert('Error: ' + error.message)
  }

  // Row ⋯ menu, shared by the table row and the phone card. PM gets none: completing and
  // deleting write sites directly; a PM sets the status in the edit form instead.
  const siteMenuItems = s => pm ? [] : [
    ...(s.status === 'Ongoing' ? [{ label: '✅ จบไซท์งาน', onClick: () => setCompleteSite(s) }] : []),
    { label: '🗑️ ลบ', onClick: () => setDeleteId(s.id), danger: true },
  ]

  return (
    <div>
      {toast && <div className="alert alert-success" style={{ marginBottom: 12 }}>✅ {toast}</div>}
      {/* ── Toolbar ── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {canEdit && !pm && <button className="btn btn-primary" onClick={() => { setEditSite(null); setShowForm(true) }}>+ เพิ่มไซท์งาน</button>}
        <MoreActions>
          {canEdit && !pm && <button className="btn btn-ghost" onClick={() => setShowImport(v => !v)}>📥 Import Excel</button>}
          <a className="btn btn-ghost" href="/templates/TEMPLATE_ไซท์งาน.xlsx" download>📄 Template</a>
        </MoreActions>
        <input className="input input-sm" style={{ width: 200 }} placeholder="ค้นหาชื่อ / รหัส..." value={search} onChange={e => setSearch(e.target.value)} />
        <select className="select select-sm" style={{ width: 140 }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          {['All', ...STATUS_OPTS].map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <PendingFocusChip focus={issuesFocus} pendingKey="issues_open" hint="เปิดไซท์ → รายงานประจำวัน เพื่อดูรายละเอียด" />
        <div style={{ display: 'flex', gap: 4 }} data-phone="chips">
          <button className={`btn btn-sm ${viewMode === 'table' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setViewMode('table')}>📋 ตาราง</button>
          <button className={`btn btn-sm ${viewMode === 'gantt' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setViewMode('gantt')}>📊 Gantt</button>
          <button className={`btn btn-sm ${viewMode === 'kanban' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setViewMode('kanban')}>🗂 Kanban</button>
        </div>
      </div>

      {/* ── Import Zone ── */}
      {showImport && (
        <div style={{ marginBottom: 16 }}>
          <ExcelUpload type="site" onSuccess={(msg) => {
            setToast(msg); setShowImport(false); refetch()
            setTimeout(() => setToast(null), 3000)
          }} />
        </div>
      )}

      {/* ── Table ── */}
      {viewMode === 'table' && isPhone && (
        <SitePhoneCards
          sites={filtered} toggleSort={toggleSort} sortIcon={si} canEdit={canEdit} showMoney={showMoney}
          onOpen={st => navigateTo('site_detail', { siteId: st.id, siteName: st.name })}
          onEdit={openEdit}
          menuItems={siteMenuItems} countdown={countdown} fmtDate={fmtDate} PencilIcon={PencilIcon}
        />
      )}
      {viewMode === 'table' && !isPhone && (
      <div className="card">
        <CardTable map={SITES_CARD_MAP}>
          <table>
            <thead>
              <tr>
                <th className="sortable" onClick={() => toggleSort('site_number')}>รหัส{si('site_number')}</th>
                <th className="sortable" onClick={() => toggleSort('name')}>ชื่อไซท์งาน{si('name')}</th>
                <th className="sortable" onClick={() => toggleSort('status')}>สถานะ{si('status')}</th>
                {showMoney && <>
                <th className="sortable" onClick={() => toggleSort('contract_value')}>มูลค่าสัญญา{si('contract_value')}</th>
                <th className="sortable" onClick={() => toggleSort('total_income')}>รายรับ (เบิก){si('total_income')}</th>
                <th className="sortable" onClick={() => toggleSort('total_expense')}>รายจ่าย{si('total_expense')}</th>
                <th className="sortable" onClick={() => toggleSort('gross_profit')}>กำไร{si('gross_profit')}</th>
                <th className="sortable" onClick={() => toggleSort('billing_pct')}>% เบิก{si('billing_pct')}</th>
                <th className="hide-tablet">ค่าแรงช่าง</th>
                </>}
                {!pm && <th className="sortable hide-tablet" onClick={() => toggleSort('last_activity_date')}>กิจกรรมล่าสุด{si('last_activity_date')}</th>}
                <th className="sortable hide-tablet" onClick={() => toggleSort('end_date')}>วันจบงาน{si('end_date')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(s => {
                const days = s.end_date ? countdown(s.end_date) : null
                const pct  = s.billing_pct
                const laborCost = laborBysite[s.id] || 0
                return (
                  <tr key={s.id}>
                    <td style={{ color: 'var(--accent)', fontSize: 11, whiteSpace: 'nowrap' }}>{s.site_number}</td>
                    <td>
                      <div style={{ width: 130, overflowWrap: 'break-word' }}>
                        <div
                          style={{ fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer' }}
                          onClick={() => navigateTo('site_detail', { siteId: s.id, siteName: s.name })}
                        >
                          <LinkIcon /> <span>{s.name}</span>
                          {s.map_url && (
                            <a href={s.map_url} target="_blank" rel="noreferrer" title="เปิดแผนที่ Google Maps"
                              style={{ textDecoration: 'none', fontSize: 13, flexShrink: 0 }} onClick={e => e.stopPropagation()}>📍</a>
                          )}
                        </div>
                        {(s.client_display_name || s.client_name) && (
                          <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                            {s.client_number && <span style={{ color: 'var(--accent)' }}>{s.client_number} · </span>}
                            {s.client_display_name || s.client_name}
                          </div>
                        )}
                      </div>
                    </td>
                    <td>
                      <span className={`badge badge-status-${s.status?.toLowerCase().replace(' ','-')}`}>{s.status}</span>
                    </td>
                    {showMoney && <>
                    <td className="font-mono" style={{ color: 'var(--text2)' }}>
                      {s.contract_value > 0
                        ? <>
                            {fmt(s.contract_value)}
                            <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'inherit' }}>
                              {s.has_vat ? 'รวม VAT' : 'ไม่มี VAT'}
                            </div>
                          </>
                        : <span style={{ color: 'var(--text3)' }}>—</span>}
                    </td>
                    {/* รายรับ — คลิกไปหน้า Income */}
                    <td
                      className="font-mono"
                      style={{ color: 'var(--green)', cursor: 'pointer', textDecoration: 'underline dotted' }}
                      onClick={() => navigateTo('income', { siteId: s.id, siteName: s.name })}
                      title="ดูรายรับของไซท์นี้"
                    >
                      {s.total_income > 0 ? fmt(s.total_income) : '—'}
                    </td>
                    {/* รายจ่าย — คลิกไปหน้า Expenses */}
                    <td
                      className="font-mono"
                      style={{ color: 'var(--red)', cursor: 'pointer', textDecoration: 'underline dotted' }}
                      onClick={() => navigateTo('expenses', { siteId: s.id, siteName: s.name })}
                      title="ดูรายจ่ายของไซท์นี้"
                    >
                      {s.total_expense > 0 ? fmt(s.total_expense) : '—'}
                    </td>
                    <td className="font-mono" style={{ color: (s.gross_profit||0) >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>
                      {s.total_income > 0 ? fmt(s.gross_profit) : '—'}
                    </td>
                    <td style={{ minWidth: 100 }}>
                      {pct != null ? (
                        <>
                          <div className="progress" style={{ marginBottom: 2 }}>
                            <div className={`progress-bar ${pct>100?'over':''}`} style={{ width: `${Math.min(100,pct)}%` }} />
                          </div>
                          <span style={{ fontSize: 10, color: pct>100?'var(--red)':'var(--text2)' }}>{pct.toFixed(1)}%</span>
                        </>
                      ) : <span style={{ fontSize: 11, color: 'var(--text3)' }}>ใส่มูลค่าสัญญา</span>}
                    </td>
                    <td
                      className="font-mono hide-tablet"
                      style={{ color: laborCost > 0 ? 'var(--yellow)' : 'var(--text3)', fontSize: 12, cursor: laborCost>0?'pointer':'default', textDecoration: laborCost>0?'underline dotted':'none' }}
                      onClick={() => laborCost > 0 && navigateTo('assign', { siteId: s.id, siteName: s.name })}
                      title={laborCost > 0 ? 'ดูรายชื่อช่างของไซท์นี้' : ''}
                    >
                      {laborCost > 0 ? fmt(laborCost) : '—'}
                    </td>
                    </>}
                    {!pm && <td className="hide-tablet" style={{ fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap' }}>
                      {s.last_activity_date ? fmtDate(s.last_activity_date) : <span style={{ color: 'var(--text3)' }}>—</span>}
                    </td>}
                    <td className="hide-tablet">
                      {s.end_date ? (
                        <div>
                          <div style={{ fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap' }}>{fmtDate(s.end_date)}</div>
                          {days !== null && (
                            <div className={`countdown ${days < 0 ? 'overdue' : days < 14 ? 'warning' : 'ok'}`}>
                              {days < 0 ? `เกิน ${Math.abs(days)} วัน` : `เหลือ ${days} วัน`}
                            </div>
                          )}
                        </div>
                      ) : <span style={{ color: 'var(--text3)' }}>—</span>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {canEdit && (
                        <div className="actions-cell">
                          <button className="btn btn-sm btn-edit" onClick={() => openEdit(s)}><PencilIcon /></button>
                          <RowActionsMenu items={siteMenuItems(s)} />
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
              {!filtered.length && (
                <tr><td colSpan={showMoney ? 12 : 6} style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>ไม่พบข้อมูลไซท์งาน</td></tr>
              )}
            </tbody>
          </table>
        </CardTable>
      </div>
      )}

      {viewMode === 'gantt' && (
        <GanttView
          sites={filtered}
          navigateTo={navigateTo}
          onManagePhases={(site) => navigateTo('site_detail', { siteId: site.id, siteName: site.name, tab: 'gantt' })}
          selectedSiteId={null}
          onSelectSite={(siteId) => {
            const site = filtered.find(s => s.id === siteId)
            navigateTo('site_detail', { siteId, siteName: site?.name, tab: 'gantt' })
          }}
          canEdit={false}
        />
      )}

      {viewMode === 'kanban' && (() => {
        const siteIds = new Set(filtered.map((s) => s.id))
        const todayIso = new Date().toISOString().slice(0, 10)
        const { bySite, total } = summarizeTasks((allPhaseTasks || []).filter((t) => siteIds.has(t.site_id)), todayIso)
        const empty = { not_started: 0, in_progress: 0, done: 0, overdue: 0 }
        return (
          <>
            <div className="card" style={{ marginBottom: 12, padding: 12, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <div className="kpi-card kpi-sm blue"><div className="kpi-label">ยังไม่เริ่ม</div><div className="kpi-value">{total.not_started}</div></div>
              <div className="kpi-card kpi-sm yellow"><div className="kpi-label">กำลังทำ</div><div className="kpi-value">{total.in_progress}</div></div>
              <div className="kpi-card kpi-sm green"><div className="kpi-label">เสร็จแล้ว</div><div className="kpi-value">{total.done}</div></div>
              <div className="kpi-card kpi-sm red"><div className="kpi-label">เกินกำหนด</div><div className="kpi-value">{total.overdue}</div></div>
            </div>
            <div className="card">
              <div className="table-wrap" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th>ไซท์งาน</th>
                      <th style={{ textAlign: 'right' }}>ยังไม่เริ่ม</th>
                      <th style={{ textAlign: 'right' }}>กำลังทำ</th>
                      <th style={{ textAlign: 'right' }}>เสร็จแล้ว</th>
                      <th style={{ textAlign: 'right' }}>เกินกำหนด</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((s) => {
                      const c = bySite.get(s.id) || empty
                      const goToKanban = () => navigateTo('site_detail', { siteId: s.id, siteName: s.name, tab: 'kanban' })
                      return (
                        <tr key={s.id} onClick={goToKanban} style={{ cursor: 'pointer' }}>
                          <td>
                            <div style={{ fontWeight: 600 }}>{s.name}</div>
                            <div style={{ fontSize: 11, color: 'var(--text3)' }}>{s.site_number}</div>
                          </td>
                          <td style={{ textAlign: 'right' }}>{c.not_started || '—'}</td>
                          <td style={{ textAlign: 'right', color: c.in_progress ? 'var(--yellow)' : undefined }}>{c.in_progress || '—'}</td>
                          <td style={{ textAlign: 'right', color: c.done ? 'var(--green)' : undefined }}>{c.done || '—'}</td>
                          <td style={{ textAlign: 'right', color: c.overdue ? 'var(--red)' : undefined, fontWeight: c.overdue ? 700 : 400 }}>{c.overdue || '—'}</td>
                          <td style={{ textAlign: 'right' }}>
                            <button
                              className="btn btn-sm btn-ghost"
                              onClick={(e) => { e.stopPropagation(); goToKanban() }}
                            >ดู Kanban →</button>
                          </td>
                        </tr>
                      )
                    })}
                    {!filtered.length && (
                      <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>ไม่พบข้อมูลไซท์งาน</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )
      })()}

      {/* ── Add/Edit Modal ── */}
      {showForm && (
        <Modal
          title={editSite ? `แก้ไข: ${editSite.name}` : 'เพิ่มไซท์งานใหม่'}
          onClose={() => { setShowForm(false); setEditSite(null) }}
          maxWidth={680}
        >
          <SiteForm
            initial={editSite || EMPTY_FORM}
            clients={clients || []}
            onSave={handleSave}
            onCancel={() => { setShowForm(false); setEditSite(null) }}
            loading={saving}
            onClientCreated={refetchClients}
            hasModuleAccess={hasModuleAccess}
            seat={seat}
            inventoryCategories={inventoryCategories || []}
            siteCostEstimates={editSite ? (siteCostEstimates || []).filter(e => e.site_id === editSite.id) : []}
            pmMode={pm}
          />
          {editSite && tenant?.id && (
            <div className="modal-body" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <AttachmentsSection table="site_attachments" bucket="site-attachments" foreignKey="site_id" entityId={editSite.id} tenantId={tenant.id} customerVisibleKind="site_attachment" />
            </div>
          )}
          {!editSite && (
            <div className="modal-body" style={{ fontSize: 12, color: 'var(--text3)', borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              บันทึกไซท์งานก่อน จึงจะแนบไฟล์ได้
            </div>
          )}
        </Modal>
      )}

      {completeSite && (
        <FinishSiteModal
          site={completeSite}
          onClose={() => setCompleteSite(null)}
          onDone={() => { setCompleteSite(null); refetch() }}
        />
      )}

      {/* ── Confirm Delete ── */}
      {deleteId && (
        <ConfirmDialog
          title="ลบไซท์งาน"
          message={`ยืนยันการลบไซท์งานนี้? ข้อมูลทั้งหมดที่เชื่อมโยงอาจได้รับผลกระทบ`}
          onConfirm={handleDelete}
          onCancel={() => setDeleteId(null)}
          danger
        />
      )}
    </div>
  )
}
