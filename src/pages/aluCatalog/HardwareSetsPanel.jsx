// src/pages/aluCatalog/HardwareSetsPanel.jsx
// ชุดอุปกรณ์ (spec 2026-10-31 section 12, mockup hwset.html v2). Left: the sets (search, "+ ชุดใหม่"). Right: the chosen
// set: 1 อุปกรณ์, 2 วัสดุสิ้นเปลือง (each from stock or created new), 3 ใช้กับซีรีส์. A set has no unit (saved as 'ชุด').
// Prices: latest purchase price for stock-linked parts, else the catalogue price; the set total = Σ quantity × price.
// Errors show inline (InlineError), never in a browser dialog; the set form's errors inside its modal. "ลบชุด" asks in the
// page and removes a set only when nothing uses it (hardwareSetRemove.js, owner 2026-11-01).
import { useState, useMemo } from 'react'
import { supabase } from '../../lib/supabase.js'
import { useQuery } from '../../hooks/useSupabase.js'
import { useCatalogTable } from '../../hooks/useAluCatalog.js'
import { Modal } from '../../components/Modal.jsx'
import { CrudForm } from '../../components/CatalogCrud.jsx'
import InlineError from '../estimation/InlineError.jsx'
import { emptyForm, formFromRow, buildPayload, missingRequired, optionList } from '../../lib/catalogForm.js'
import { buildCatalogIndex } from '../../lib/aluCatalogPricing.js'
import { typePickerOptions } from '../../lib/catalogTypeForm.js'
import { localDateString } from '../../lib/localDate.js'
import { priceSourceText } from '../../lib/latestPurchasePrice.js'
import { removeHardwareSet } from '../../lib/hardwareSetRemove.js'
import { SECTIONS, setLines, setSummaryText, priceLines, setTotal, seriesChips, newSeriesLinks, rpcErrorText, addResultText } from '../../lib/hardwareSetView.js'
import StockItemPicker from './StockItemPicker.jsx'
import SeriesLinkPicker from './SeriesLinkPicker.jsx'

const money = n => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'th')

export const setFields = providers => [
  { key: 'name', label: 'ชื่อชุด', type: 'text', required: true, placeholder: 'เช่น อุปกรณ์หน้าต่างบานเลื่อนสวน' },
  { key: 'provider_id', label: 'ผู้ผลิต (ไม่บังคับ)', type: 'select', options: form => optionList(providers, p => p.name, form.provider_id) },
  { key: 'active', label: 'ใช้งานอยู่', type: 'checkbox', default: true },
]

// The chosen set (pure view). lines = { hardware, consumable } priced lines; pickerFor(sectionKey) -> node | null.
export function SetDetail({ set, lines, total, chips, canEdit, pickerFor, seriesPicker, on, removing = false, busy = false }) {
  return (
    <div className="card" style={{ padding: 16, display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>{set.name}</div>
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>
            {set.code} · {set.active === false ? 'ปิดใช้งาน' : 'ใช้งานอยู่'} · ราคาชุด = รวมราคาของในชุด {money(total.total)} บาท{total.missing ? ` (ยังไม่มีราคา ${total.missing} รายการ)` : ''}
          </div>
        </div>
        {canEdit && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button type="button" className="btn btn-sm btn-ghost" onClick={on.edit}>แก้ชื่อ</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={on.toggleActive}>{set.active === false ? 'เปิดใช้งาน' : 'ปิดใช้งาน'}</button>
            <button type="button" className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={on.askRemove}>ลบชุด</button>
          </div>
        )}
      </div>
      {canEdit && removing && (
        <div className="card" style={{ padding: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', background: 'var(--bg3)' }}>
          <div style={{ fontSize: 13, flex: 1, minWidth: 200 }}>ลบชุด {set.name}? ลบได้เฉพาะชุดที่ยังไม่มีรายการใช้อยู่ (ของในชุดและการผูกซีรีส์จะถูกลบไปด้วย)</div>
          <button type="button" className="btn btn-sm btn-ghost" onClick={on.cancelRemove}>ยกเลิก</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={on.confirmRemove}>ยืนยันลบ</button>
        </div>
      )}

      {SECTIONS.map((s, i) => (
        <section key={s.key} style={{ display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontWeight: 600 }}>{i + 1}. {s.title}</div>
            {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }} onClick={() => on.add(s.key)}>{s.addLabel}</button>}
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>รายการ</th><th>จำนวน</th><th>ราคา/หน่วย</th><th>ที่มาของราคา</th><th /></tr></thead>
              <tbody>
                {lines[s.key].map(l => (
                  <tr key={l.id}>
                    <td><span className="font-mono" style={{ color: 'var(--text3)' }}>{l.part.code}</span> {l.part.name} <span style={{ color: 'var(--text3)' }}>({l.part.unit})</span></td>
                    <td style={{ width: 96 }}>{canEdit
                      ? <input key={`${l.id}-${l.quantity}`} className="input" type="number" min="0" step="any" defaultValue={l.quantity} onBlur={e => on.quantity(l, e.target.value)} aria-label={`จำนวน ${l.part.name}`} />
                      : l.quantity}</td>
                    <td className="font-mono">{l.price ? money(l.price.net_price) : '—'}</td>
                    <td style={{ fontSize: 12, color: 'var(--text3)' }}>{priceSourceText(l.price)}</td>
                    <td>{canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} aria-label={`เอา ${l.part.name} ออก`} onClick={() => on.removeLine(l)}>✕</button>}</td>
                  </tr>
                ))}
                {!lines[s.key].length && <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text3)', padding: 12 }}>ยังไม่มี{s.title}ในชุดนี้</td></tr>}
              </tbody>
            </table>
          </div>
          {pickerFor(s.key)}
        </section>
      ))}

      <section style={{ display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontWeight: 600 }}>3. ใช้กับซีรีส์</div>
          {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }} onClick={on.addSeries}>+ เพิ่มซีรีส์</button>}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {chips.map(c => (
            <span key={c.id} className="badge" style={{ padding: '3px 8px', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <span style={{ color: 'var(--text3)' }}>{c.provider}</span><span>{c.label}{c.type ? ` · ${c.type}` : ''}</span>
              {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ padding: '0 4px' }} aria-label={`เลิกผูก ${c.label}`} onClick={() => on.removeChip(c)}>✕</button>}
            </span>
          ))}
          {!chips.length && <span style={{ fontSize: 12, color: 'var(--text3)' }}>ยังไม่ผูกซีรีส์ = ใช้ได้ทุกซีรีส์</span>}
        </div>
        {seriesPicker}
        <div style={{ fontSize: 12, color: 'var(--text3)' }}>ตอนเลือกชุดอุปกรณ์ในรายการ จะเห็นชุดที่ผูกกับซีรีส์ของรายการนั้นก่อน (ไม่ผูกเลย = ใช้ได้ทุกซีรีส์)</div>
      </section>
    </div>
  )
}

export default function HardwareSetsPanel({ canEdit }) {
  const parts = useCatalogTable('alu_parts')
  const setItems = useCatalogTable('alu_part_set_items', 'id')
  const partPrices = useCatalogTable('alu_part_prices', 'id')
  const providers = useCatalogTable('alu_providers')
  const series = useCatalogTable('alu_series')
  const families = useCatalogTable('alu_series_families')
  const types = useCatalogTable('door_window_types')
  const seriesTypes = useCatalogTable('alu_series_types', 'id')
  const seriesParts = useCatalogTable('alu_series_parts', 'id')
  const [setId, setSetId] = useState('')
  const [search, setSearch] = useState('')
  const [picking, setPicking] = useState(null)      // section key | null
  const [seriesOpen, setSeriesOpen] = useState(false)
  const [editing, setEditing] = useState(null)      // null | 'new' | set row
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [note, setNote] = useState(null)
  const [formErr, setFormErr] = useState(null)    // errors of the set form, shown inside its modal
  const [removing, setRemoving] = useState(false) // the in-page "ลบชุด" question is open

  const linkedIds = useMemo(() => [...new Set((parts.data || []).map(p => p.inventory_item_id).filter(Boolean))].sort(), [parts.data])
  const purchase = useQuery(async () => {
    if (!linkedIds.length) return []
    const { data, error } = await supabase.rpc('stock_item_purchase_prices', { p_item_ids: linkedIds })
    if (error) throw error
    return data || []
  }, [linkedIds.join(',')])
  const index = useMemo(() => buildCatalogIndex({
    providers: providers.data, series: series.data, seriesFamilies: families.data, types: types.data, seriesTypes: seriesTypes.data,
  }), [providers.data, series.data, families.data, types.data, seriesTypes.data])

  const loadError = [parts, setItems, partPrices, providers, series, families, types, seriesTypes, seriesParts].map(q => q.error).find(Boolean)
  if (loadError) return <InlineError title="โหลดข้อมูลไม่สำเร็จ">{loadError}</InlineError>

  const today = localDateString(new Date())
  const partsById = Object.fromEntries((parts.data || []).map(p => [p.id, p]))
  const sets = (parts.data || []).filter(p => p.kind === 'hardware_set').sort(byName)
  const q = search.trim().toLowerCase()
  const shownSets = sets.filter(s => !q || String(s.name).toLowerCase().includes(q) || String(s.code || '').toLowerCase().includes(q))
  const set = sets.find(s => s.id === setId) || null
  const priceCtx = { asOf: today, purchasePrices: purchase.data || [], partPrices: partPrices.data || [] }
  const raw = set ? setLines({ setId: set.id, setItems: setItems.data, partsById }) : null
  const lines = raw ? { hardware: priceLines(raw.hardware, priceCtx), consumable: priceLines(raw.consumable, priceCtx) } : null
  const total = lines ? setTotal([...lines.hardware, ...lines.consumable]) : null
  const chips = set ? seriesChips({ setId: set.id, seriesParts: seriesParts.data, seriesById: index.series, providersById: index.providers, typesById: index.types }) : []
  const typeOptions = typePickerOptions(types.data || [], new Set((types.data || []).map(t => t.id))).map(o => ({ value: o.id, label: o.label }))
  const fields = setFields(providers.data)

  const run = async (work, after) => {
    setBusy(true); setErr(null); setNote(null)
    try {
      const r = await work()
      if (after) await after(r)
    } catch (e) { setErr(rpcErrorText(e)) }
    finally { setBusy(false) }
  }
  const openForm = row => { setFormErr(null); setEditing(row) }
  const closeForm = () => { setFormErr(null); setEditing(null) }
  // errors stay inside the open form (the page behind it is covered by the modal overlay)
  const saveSet = async form => {
    const missing = missingRequired(fields, form)
    if (missing.length) { setFormErr('กรุณากรอก: ' + missing.join(', ')); return }
    const payload = buildPayload(fields, form, editing === 'new' ? null : editing)
    setBusy(true); setFormErr(null); setErr(null); setNote(null)
    try {
      let id = editing === 'new' ? null : editing.id
      if (editing === 'new') {
        const { data, error } = await supabase.from('alu_parts').insert({ ...payload, kind: 'hardware_set', unit: 'ชุด' }).select('id').single()
        if (error) throw error
        id = data.id
      } else {
        const { error } = await supabase.from('alu_parts').update(payload).eq('id', id)
        if (error) throw error
      }
      closeForm()
      await parts.refetch()
      setSetId(id)
    } catch (e) { setFormErr(rpcErrorText(e)) }
    finally { setBusy(false) }
  }
  const kindOf = key => SECTIONS.find(s => s.key === key).kind
  const on = {
    edit: () => openForm(set),
    askRemove: () => { setPicking(null); setSeriesOpen(false); setRemoving(true) },
    cancelRemove: () => setRemoving(false),
    confirmRemove: () => {
      const name = set.name
      run(() => removeHardwareSet(supabase, set.id), async r => {
        setRemoving(false)
        if (!r.removed) { setErr(r.message); return }
        setSetId('')
        await Promise.all([parts.refetch(), setItems.refetch(), seriesParts.refetch()])
        setNote(`ลบชุด ${name} แล้ว`)
      })
    },
    toggleActive: () => run(async () => {
      const { error } = await supabase.from('alu_parts').update({ active: set.active === false }).eq('id', set.id)
      if (error) throw error
    }, () => parts.refetch()),
    add: key => { setSeriesOpen(false); setPicking(p => (p === key ? null : key)) },
    quantity: (line, value) => {
      const n = Number(value)
      if (String(value).trim() === '' || !(n > 0)) { setErr('จำนวนต้องมากกว่า 0'); setItems.refetch(); return }
      if (n === line.quantity) return
      run(async () => {
        const { error } = await supabase.from('alu_part_set_items').update({ quantity: n }).eq('id', line.id)
        if (error) throw error
      }, () => setItems.refetch())
    },
    removeLine: line => run(async () => {
      const { error } = await supabase.from('alu_part_set_items').delete().eq('id', line.id)
      if (error) throw error
    }, () => setItems.refetch()),
    addSeries: () => { setPicking(null); setSeriesOpen(o => !o) },
    removeChip: chip => run(async () => {
      const { error } = await supabase.from('alu_series_parts').delete().eq('id', chip.id)
      if (error) throw error
    }, () => seriesParts.refetch()),
  }
  const addFromStock = (key, item) => run(async () => {
    const { data, error } = await supabase.rpc('alu_add_stock_item_to_set', { p_set_id: set.id, p_inventory_item_id: item.id, p_kind: kindOf(key), p_quantity: 1 })
    if (error) throw error
    return data
  }, async data => { await Promise.all([parts.refetch(), setItems.refetch()]); setNote(addResultText(data, item.name)) })
  const addNew = (key, f) => run(async () => {
    const { error } = await supabase.rpc('alu_add_new_part_to_set', {
      p_set_id: set.id, p_name: f.name, p_unit: f.unit, p_kind: kindOf(key), p_quantity: 1, p_price: f.price, p_price_date: f.price === null ? null : today,
    })
    if (error) throw error
  }, async () => { setPicking(null); await Promise.all([parts.refetch(), setItems.refetch(), partPrices.refetch()]); setNote(`เพิ่ม ${f.name} แล้ว`) })
  const addSeriesLinks = (seriesIds, typeId) => {
    const rows = newSeriesLinks({ setId: set.id, seriesIds, typeId, seriesParts: seriesParts.data })
    if (!rows.length) { setNote('ซีรีส์ที่เลือกผูกกับชุดนี้อยู่แล้ว'); return }
    run(async () => {
      const { error } = await supabase.from('alu_series_parts').insert(rows)
      if (error) throw error
    }, async () => { setSeriesOpen(false); await seriesParts.refetch(); setNote(`เพิ่ม ${rows.length} ชุดแล้ว`) })
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, alignItems: 'start' }}>
      <div className="card" style={{ padding: 12, display: 'grid', gap: 8, alignContent: 'start' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontWeight: 700 }}>ชุดอุปกรณ์</div>
          {canEdit && <button type="button" className="btn btn-sm btn-primary" style={{ marginLeft: 'auto' }} onClick={() => openForm('new')}>+ ชุดใหม่</button>}
        </div>
        <input className="input" placeholder="ค้นหาชุด" value={search} onChange={e => setSearch(e.target.value)} />
        {shownSets.map(s => (
          <button key={s.id} type="button" className={`btn btn-sm ${s.id === setId ? 'btn-primary' : 'btn-ghost'}`}
            style={{ display: 'grid', justifyItems: 'start', textAlign: 'left' }}
            onClick={() => { setSetId(s.id); setPicking(null); setSeriesOpen(false); setRemoving(false); setErr(null); setNote(null) }}>
            <span>{s.name}{s.active === false ? ' (ปิดใช้งาน)' : ''}</span>
            <span style={{ fontSize: 11, opacity: 0.75 }}>{s.code} · {setSummaryText(setLines({ setId: s.id, setItems: setItems.data, partsById }))}</span>
          </button>
        ))}
        {!shownSets.length && <div style={{ fontSize: 13, color: 'var(--text3)', padding: 8 }}>{parts.data == null ? 'กำลังโหลด...' : 'ยังไม่มีชุดอุปกรณ์'}</div>}
      </div>

      <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
        {err && <InlineError onClose={() => setErr(null)}>{err}</InlineError>}
        {note && <div style={{ fontSize: 13, color: 'var(--green)' }}>{note}</div>}
        {set && purchase.error && <div style={{ fontSize: 13, color: 'var(--red)' }}>โหลดราคาซื้อล่าสุดไม่สำเร็จ — แสดงราคาแคตตาล็อกแทน</div>}
        {set ? (
          <SetDetail set={set} lines={lines} total={total} chips={chips} canEdit={canEdit} on={on} removing={removing} busy={busy}
            pickerFor={key => (picking === key ? (
              <StockItemPicker section={SECTIONS.find(s => s.key === key)} busy={busy}
                onPick={item => addFromStock(key, item)} onCreate={f => addNew(key, f)} onClose={() => setPicking(null)} />
            ) : null)}
            seriesPicker={seriesOpen ? <SeriesLinkPicker index={index} typeOptions={typeOptions} busy={busy} onAdd={addSeriesLinks} onClose={() => setSeriesOpen(false)} /> : null} />
        ) : (
          <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>เลือกชุดทางซ้าย หรือกด "+ ชุดใหม่"</div>
        )}
      </div>

      {editing && (
        <Modal title={editing === 'new' ? 'ชุดอุปกรณ์ใหม่' : 'แก้ชุดอุปกรณ์'} onClose={closeForm} maxWidth={440}>
          {formErr && <div style={{ padding: '12px 16px 0' }}><InlineError onClose={() => setFormErr(null)}>{formErr}</InlineError></div>}
          <CrudForm fields={fields} row={editing === 'new' ? null : editing} loading={busy} onSave={saveSet} onCancel={closeForm}
            initial={editing === 'new' ? emptyForm(fields) : formFromRow(fields, editing)} />
        </Modal>
      )}
    </div>
  )
}
