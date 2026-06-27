# Clients & Suppliers Master Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** เพิ่ม master data tables สำหรับ clients (CL-YYYY-NNN) และ suppliers (SP-YYYY-NNN) พร้อม CRUD pages, link กับ sites/expenses, และ Excel import — และแก้ schema mismatches ที่มีอยู่แล้วด้วย

**Architecture:** Supabase triggers auto-generate running numbers. clients.id FK → sites. suppliers.id FK → expenses. New tabs ใน App.jsx. ExcelUpload.jsx รองรับ 5 types.

**Tech Stack:** React 18, Vite, @supabase/supabase-js v2, xlsx, Supabase Postgres 17

---

## Files Map

| Action | File | ความรับผิดชอบ |
|--------|------|--------------|
| Modify (Supabase MCP) | schema via execute_sql | Fix mismatches + add clients/suppliers tables + FKs + updated views |
| Modify | `src/hooks/useSupabase.js` | + useClients(), useSuppliers() |
| **Create** | `src/pages/Clients.jsx` | CRUD หน้าลูกค้า |
| **Create** | `src/pages/Suppliers.jsx` | CRUD หน้า Supplier |
| Modify | `src/pages/Sites.jsx` | client dropdown แทน text, fix COST_TYPES keys |
| Modify | `src/pages/Expenses.jsx` | supplier dropdown เพิ่มเติม |
| Modify | `src/App.jsx` | เพิ่ม 2 tabs |
| Modify | `src/components/ExcelUpload.jsx` | + sites/clients/suppliers import |

---

## Task 1: Fix Schema Mismatches + Add Tables (Supabase MCP)

**Files:** execute_sql on project `yyzbgdmgyvvypfcjuhtr`

- [ ] **Step 1: แก้ sites table — rename plan_* → cost_*, fix status CHECK, add cost_other**

```sql
-- Rename plan_* columns ให้ตรงกับ code (COST_TYPES ใช้ cost_*)
ALTER TABLE sites RENAME COLUMN plan_aluminum  TO cost_aluminum;
ALTER TABLE sites RENAME COLUMN plan_glass     TO cost_glass;
ALTER TABLE sites RENAME COLUMN plan_equipment TO cost_equipment;
ALTER TABLE sites RENAME COLUMN plan_rubber    TO cost_rubber;
ALTER TABLE sites RENAME COLUMN plan_labor     TO cost_labor;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS cost_other DECIMAL(15,2) DEFAULT 0;

-- Fix plan_type column (ไม่ได้ใช้ใน code แต่ให้ไว้ก่อน)
-- Fix status CHECK: code ใช้ 'Completed' และ 'Cancelled' แทน 'Finished'
ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_status_check;
ALTER TABLE sites ADD CONSTRAINT sites_status_check
  CHECK (status IN ('Ongoing','Completed','On Hold','Cancelled'));
```

- [ ] **Step 2: สร้าง clients table + trigger**

```sql
CREATE TABLE clients (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_number   TEXT UNIQUE NOT NULL DEFAULT '',
  name            TEXT NOT NULL,
  contact_person  TEXT,
  position        TEXT,
  phone           TEXT,
  email           TEXT,
  address         TEXT,
  province        TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION generate_client_number()
RETURNS TRIGGER AS $$
DECLARE
  year_part TEXT := TO_CHAR(NOW(), 'YYYY');
  seq_num   INT;
BEGIN
  SELECT COUNT(*) + 1 INTO seq_num
  FROM clients WHERE client_number LIKE 'CL-' || year_part || '-%';
  NEW.client_number := 'CL-' || year_part || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_client_number
  BEFORE INSERT ON clients
  FOR EACH ROW
  WHEN (NEW.client_number IS NULL OR NEW.client_number = '')
  EXECUTE FUNCTION generate_client_number();

CREATE INDEX idx_clients_name ON clients(name);
```

- [ ] **Step 3: สร้าง suppliers table + trigger**

```sql
CREATE TABLE suppliers (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  supplier_number TEXT UNIQUE NOT NULL DEFAULT '',
  name            TEXT NOT NULL,
  contact_person  TEXT,
  phone           TEXT,
  email           TEXT,
  category        TEXT,
  payment_terms   TEXT,
  address         TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION generate_supplier_number()
RETURNS TRIGGER AS $$
DECLARE
  year_part TEXT := TO_CHAR(NOW(), 'YYYY');
  seq_num   INT;
BEGIN
  SELECT COUNT(*) + 1 INTO seq_num
  FROM suppliers WHERE supplier_number LIKE 'SP-' || year_part || '-%';
  NEW.supplier_number := 'SP-' || year_part || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_supplier_number
  BEFORE INSERT ON suppliers
  FOR EACH ROW
  WHEN (NEW.supplier_number IS NULL OR NEW.supplier_number = '')
  EXECUTE FUNCTION generate_supplier_number();

CREATE INDEX idx_suppliers_name ON suppliers(name);
```

- [ ] **Step 4: Add FKs + update views**

```sql
-- Link sites → clients
ALTER TABLE sites ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(id) ON DELETE SET NULL;

-- Link expenses → suppliers
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL;

-- Update site_financial_summary view ให้รวม client info
CREATE OR REPLACE VIEW site_financial_summary AS
SELECT
  s.id, s.site_number, s.name, s.status, s.start_date, s.end_date,
  s.contract_value, s.client_id, s.client_name, s.location,
  s.cost_aluminum, s.cost_glass, s.cost_equipment, s.cost_rubber, s.cost_labor, s.cost_other,
  c.name AS client_display_name, c.client_number,
  COALESCE(SUM(e.amount), 0) AS total_expense,
  COALESCE(SUM(i.received_amount), 0) AS total_income,
  COALESCE(SUM(i.received_amount), 0) - COALESCE(SUM(e.amount), 0) AS gross_profit,
  CASE WHEN s.contract_value > 0
    THEN ROUND(COALESCE(SUM(i.received_amount), 0) / s.contract_value * 100, 1)
    ELSE NULL END AS billing_pct,
  COALESCE(SUM(CASE WHEN e.status IN ('pending','check_issued') THEN e.amount ELSE 0 END), 0) AS outstanding_expense
FROM sites s
LEFT JOIN clients c ON s.client_id = c.id
LEFT JOIN expenses e ON e.site_id = s.id
LEFT JOIN incomes i ON i.site_id = s.id
GROUP BY s.id, s.site_number, s.name, s.status, s.start_date, s.end_date,
  s.contract_value, s.client_id, s.client_name, s.location,
  s.cost_aluminum, s.cost_glass, s.cost_equipment, s.cost_rubber, s.cost_labor, s.cost_other,
  c.name, c.client_number;

-- Update expenses_view ให้รวม supplier info
CREATE OR REPLACE VIEW expenses_view AS
SELECT
  e.*,
  s.name AS site_name, s.site_number, s.status AS site_status,
  ec.name AS category_name, ec.color AS category_color,
  sup.name AS supplier_name, sup.supplier_number, sup.category AS supplier_category
FROM expenses e
LEFT JOIN sites s ON e.site_id = s.id
LEFT JOIN expense_categories ec ON e.category_id = ec.id
LEFT JOIN suppliers sup ON e.supplier_id = sup.id;
```

---

## Task 2: Update useSupabase.js

**File:** `src/hooks/useSupabase.js`

- [ ] **Step 1: เพิ่ม useClients() และ useSuppliers() hooks ต่อท้ายไฟล์**

```js
// ── Clients ──────────────────────────────────────────────────
export function useClients() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('clients')
      .select('*')
      .order('client_number')
    if (error) throw error
    return data
  })
}

// ── Suppliers ─────────────────────────────────────────────────
export function useSuppliers() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('suppliers')
      .select('*')
      .order('supplier_number')
    if (error) throw error
    return data
  })
}
```

---

## Task 3: Create Clients.jsx

**File:** `src/pages/Clients.jsx` (ใหม่ทั้งไฟล์)

- [ ] **Step 1: เขียนทั้งไฟล์**

```jsx
// ============================================================
// Clients — ลูกค้า/เจ้าของงาน
// ✅ Auto-number CL-YYYY-NNN
// ✅ Add/Edit/Delete CRUD
// ✅ Search by name / number / province
// ============================================================
import { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { useClients } from '../hooks/useSupabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'

const EMPTY_FORM = {
  name: '', contact_person: '', position: '',
  phone: '', email: '', address: '', province: '', notes: ''
}

function ClientForm({ initial = EMPTY_FORM, onSave, onCancel, loading }) {
  const [form, setForm] = useState({ ...EMPTY_FORM, ...initial })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  return (
    <form onSubmit={e => { e.preventDefault(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div className="form-grid-2">
          <div>
            <label className="label">ชื่อลูกค้า / บริษัท ★</label>
            <input className="input" required value={form.name} onChange={e => set('name', e.target.value)} placeholder="เช่น บริษัท NCP จำกัด" />
          </div>
          <div>
            <label className="label">ชื่อผู้ติดต่อ</label>
            <input className="input" value={form.contact_person} onChange={e => set('contact_person', e.target.value)} />
          </div>
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label">ตำแหน่ง</label>
            <input className="input" value={form.position} onChange={e => set('position', e.target.value)} placeholder="เช่น ผู้จัดการโครงการ" />
          </div>
          <div>
            <label className="label">เบอร์โทร</label>
            <input className="input" value={form.phone} onChange={e => set('phone', e.target.value)} />
          </div>
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label">อีเมล</label>
            <input type="email" className="input" value={form.email} onChange={e => set('email', e.target.value)} />
          </div>
          <div>
            <label className="label">จังหวัด</label>
            <input className="input" value={form.province} onChange={e => set('province', e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label">ที่อยู่</label>
          <input className="input" value={form.address} onChange={e => set('address', e.target.value)} />
        </div>
        <div>
          <label className="label">หมายเหตุ</label>
          <textarea className="textarea" rows={2} value={form.notes} onChange={e => set('notes', e.target.value)} />
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}
        </button>
      </div>
    </form>
  )
}

export default function Clients() {
  const { data: clients, refetch } = useClients()
  const [showForm, setShowForm] = useState(false)
  const [editItem, setEditItem] = useState(null)
  const [deleteId, setDeleteId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')

  const filtered = useMemo(() =>
    (clients || []).filter(c =>
      !search ||
      c.name?.toLowerCase().includes(search.toLowerCase()) ||
      c.client_number?.toLowerCase().includes(search.toLowerCase()) ||
      c.province?.toLowerCase().includes(search.toLowerCase())
    )
  , [clients, search])

  const handleSave = async (form) => {
    setSaving(true)
    try {
      const payload = {
        name: form.name, contact_person: form.contact_person || null,
        position: form.position || null, phone: form.phone || null,
        email: form.email || null, address: form.address || null,
        province: form.province || null, notes: form.notes || null,
      }
      if (editItem) {
        const { error } = await supabase.from('clients').update(payload).eq('id', editItem.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('clients').insert(payload)
        if (error) throw error
      }
      setShowForm(false); setEditItem(null); refetch()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setSaving(false) }
  }

  const handleDelete = async () => {
    if (!deleteId) return
    const { error } = await supabase.from('clients').delete().eq('id', deleteId)
    if (!error) { setDeleteId(null); refetch() }
    else alert('Error: ' + error.message)
  }

  return (
    <div>
      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
        <button className="btn btn-primary" onClick={() => { setEditItem(null); setShowForm(true) }}>+ เพิ่มลูกค้า</button>
        <input className="input input-sm" style={{ width: 220 }}
          placeholder="ค้นหาชื่อ / รหัส / จังหวัด..."
          value={search} onChange={e => setSearch(e.target.value)} />
        <span style={{ color: 'var(--text3)', fontSize: 13 }}>{filtered.length} รายการ</span>
      </div>

      {/* Table */}
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>รหัสลูกค้า</th>
                <th>ชื่อลูกค้า / บริษัท</th>
                <th>ผู้ติดต่อ</th>
                <th>เบอร์โทร</th>
                <th>อีเมล</th>
                <th>จังหวัด</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => (
                <tr key={c.id}>
                  <td style={{ color: 'var(--accent)', fontSize: 11, whiteSpace: 'nowrap', fontWeight: 700 }}>{c.client_number}</td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{c.name}</div>
                    {c.notes && <div style={{ fontSize: 11, color: 'var(--text3)' }}>{c.notes}</div>}
                  </td>
                  <td>
                    <div>{c.contact_person || <span style={{ color: 'var(--text3)' }}>—</span>}</div>
                    {c.position && <div style={{ fontSize: 11, color: 'var(--text3)' }}>{c.position}</div>}
                  </td>
                  <td style={{ fontSize: 12 }}>{c.phone || '—'}</td>
                  <td style={{ fontSize: 12 }}>{c.email || '—'}</td>
                  <td style={{ fontSize: 12 }}>{c.province || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm btn-ghost" onClick={() => { setEditItem(c); setShowForm(true) }}>แก้ไข</button>
                    <button className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => setDeleteId(c.id)}>ลบ</button>
                  </td>
                </tr>
              ))}
              {!filtered.length && (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีข้อมูลลูกค้า</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Form Modal */}
      {showForm && (
        <Modal title={editItem ? `แก้ไข ${editItem.client_number}` : 'เพิ่มลูกค้าใหม่'} onClose={() => { setShowForm(false); setEditItem(null) }} maxWidth={600}>
          <ClientForm initial={editItem || EMPTY_FORM} onSave={handleSave} onCancel={() => { setShowForm(false); setEditItem(null) }} loading={saving} />
        </Modal>
      )}

      {/* Delete Confirm */}
      {deleteId && (
        <ConfirmDialog
          title="ลบลูกค้า"
          message="ยืนยันการลบลูกค้ารายนี้? (ไซท์งานที่ link อยู่จะถูก unlink)"
          onConfirm={handleDelete}
          onCancel={() => setDeleteId(null)}
        />
      )}
    </div>
  )
}
```

---

## Task 4: Create Suppliers.jsx

**File:** `src/pages/Suppliers.jsx` (ใหม่ทั้งไฟล์)

- [ ] **Step 1: เขียนทั้งไฟล์**

```jsx
// ============================================================
// Suppliers — ผู้จำหน่าย/Supplier
// ✅ Auto-number SP-YYYY-NNN
// ✅ Add/Edit/Delete CRUD
// ✅ Filter ตามหมวดสินค้า
// ============================================================
import { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { useSuppliers } from '../hooks/useSupabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'

const SUPPLIER_CATEGORIES = ['กระจก', 'อลูมิเนียม/เหล็ก', 'อุปกรณ์', 'ซิลิโคน/ยาง', 'เบ็ดเตล็ด', 'อื่นๆ']

const EMPTY_FORM = {
  name: '', contact_person: '', phone: '', email: '',
  category: '', payment_terms: '', address: '', notes: ''
}

function SupplierForm({ initial = EMPTY_FORM, onSave, onCancel, loading }) {
  const [form, setForm] = useState({ ...EMPTY_FORM, ...initial })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  return (
    <form onSubmit={e => { e.preventDefault(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div className="form-grid-2">
          <div>
            <label className="label">ชื่อ Supplier / บริษัท ★</label>
            <input className="input" required value={form.name} onChange={e => set('name', e.target.value)} placeholder="เช่น บริษัท กระจกไทย จำกัด" />
          </div>
          <div>
            <label className="label">ชื่อผู้ติดต่อ</label>
            <input className="input" value={form.contact_person} onChange={e => set('contact_person', e.target.value)} />
          </div>
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label">หมวดสินค้า</label>
            <select className="select" value={form.category} onChange={e => set('category', e.target.value)}>
              <option value="">— เลือกหมวด —</option>
              {SUPPLIER_CATEGORIES.map(c => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="label">เงื่อนไขการชำระ</label>
            <input className="input" value={form.payment_terms} onChange={e => set('payment_terms', e.target.value)} placeholder="เช่น 30 วัน / เงินสด" />
          </div>
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label">เบอร์โทร</label>
            <input className="input" value={form.phone} onChange={e => set('phone', e.target.value)} />
          </div>
          <div>
            <label className="label">อีเมล</label>
            <input type="email" className="input" value={form.email} onChange={e => set('email', e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label">ที่อยู่</label>
          <input className="input" value={form.address} onChange={e => set('address', e.target.value)} />
        </div>
        <div>
          <label className="label">หมายเหตุ</label>
          <textarea className="textarea" rows={2} value={form.notes} onChange={e => set('notes', e.target.value)} />
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}
        </button>
      </div>
    </form>
  )
}

export default function Suppliers() {
  const { data: suppliers, refetch } = useSuppliers()
  const [showForm, setShowForm] = useState(false)
  const [editItem, setEditItem] = useState(null)
  const [deleteId, setDeleteId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [catFilter, setCatFilter] = useState('')

  const filtered = useMemo(() =>
    (suppliers || []).filter(s =>
      (!catFilter || s.category === catFilter) &&
      (!search || s.name?.toLowerCase().includes(search.toLowerCase()) ||
        s.supplier_number?.toLowerCase().includes(search.toLowerCase()))
    )
  , [suppliers, search, catFilter])

  const handleSave = async (form) => {
    setSaving(true)
    try {
      const payload = {
        name: form.name, contact_person: form.contact_person || null,
        phone: form.phone || null, email: form.email || null,
        category: form.category || null, payment_terms: form.payment_terms || null,
        address: form.address || null, notes: form.notes || null,
      }
      if (editItem) {
        const { error } = await supabase.from('suppliers').update(payload).eq('id', editItem.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('suppliers').insert(payload)
        if (error) throw error
      }
      setShowForm(false); setEditItem(null); refetch()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setSaving(false) }
  }

  const handleDelete = async () => {
    if (!deleteId) return
    const { error } = await supabase.from('suppliers').delete().eq('id', deleteId)
    if (!error) { setDeleteId(null); refetch() }
    else alert('Error: ' + error.message)
  }

  return (
    <div>
      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={() => { setEditItem(null); setShowForm(true) }}>+ เพิ่ม Supplier</button>
        <input className="input input-sm" style={{ width: 200 }}
          placeholder="ค้นหาชื่อ / รหัส..."
          value={search} onChange={e => setSearch(e.target.value)} />
        <select className="select input-sm" style={{ width: 160 }} value={catFilter} onChange={e => setCatFilter(e.target.value)}>
          <option value="">ทุกหมวด</option>
          {SUPPLIER_CATEGORIES.map(c => <option key={c}>{c}</option>)}
        </select>
        <span style={{ color: 'var(--text3)', fontSize: 13 }}>{filtered.length} รายการ</span>
      </div>

      {/* Table */}
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>รหัส Supplier</th>
                <th>ชื่อ Supplier / บริษัท</th>
                <th>หมวดสินค้า</th>
                <th>ผู้ติดต่อ</th>
                <th>เบอร์โทร</th>
                <th>เงื่อนไขชำระ</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(s => (
                <tr key={s.id}>
                  <td style={{ color: 'var(--accent)', fontSize: 11, whiteSpace: 'nowrap', fontWeight: 700 }}>{s.supplier_number}</td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{s.name}</div>
                    {s.address && <div style={{ fontSize: 11, color: 'var(--text3)' }}>{s.address}</div>}
                  </td>
                  <td><span className="badge">{s.category || '—'}</span></td>
                  <td style={{ fontSize: 12 }}>{s.contact_person || '—'}</td>
                  <td style={{ fontSize: 12 }}>{s.phone || '—'}</td>
                  <td style={{ fontSize: 12 }}>{s.payment_terms || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm btn-ghost" onClick={() => { setEditItem(s); setShowForm(true) }}>แก้ไข</button>
                    <button className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => setDeleteId(s.id)}>ลบ</button>
                  </td>
                </tr>
              ))}
              {!filtered.length && (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีข้อมูล Supplier</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Form Modal */}
      {showForm && (
        <Modal title={editItem ? `แก้ไข ${editItem.supplier_number}` : 'เพิ่ม Supplier ใหม่'} onClose={() => { setShowForm(false); setEditItem(null) }} maxWidth={600}>
          <SupplierForm initial={editItem || EMPTY_FORM} onSave={handleSave} onCancel={() => { setShowForm(false); setEditItem(null) }} loading={saving} />
        </Modal>
      )}

      {deleteId && (
        <ConfirmDialog
          title="ลบ Supplier"
          message="ยืนยันการลบ Supplier รายนี้? (รายจ่ายที่ link อยู่จะถูก unlink)"
          onConfirm={handleDelete}
          onCancel={() => setDeleteId(null)}
        />
      )}
    </div>
  )
}
```

---

## Task 5: Update Sites.jsx — เพิ่ม client dropdown

**File:** `src/pages/Sites.jsx`

- [ ] **Step 1: เพิ่ม import useClients และแก้ EMPTY_FORM + SiteForm**

แก้บรรทัดที่ 12 (import):
```js
// เดิม
import { useSites, useLaborCost, useCategories } from '../hooks/useSupabase.js'
// ใหม่
import { useSites, useLaborCost, useCategories, useClients } from '../hooks/useSupabase.js'
```

แก้ EMPTY_FORM (บรรทัด 28):
```js
// เดิม: name: '', client_name: '', location: '', ...
// ใหม่
const EMPTY_FORM = {
  name: '', client_id: '', client_name: '', location: '',
  status: 'Ongoing', start_date: '', end_date: '',
  contract_value: '', notes: '',
  ...Object.fromEntries(COST_TYPES.map(t => [t.key, '']))
}
```

- [ ] **Step 2: ใน SiteForm function รับ `clients` prop + แสดง dropdown**

แก้ function signature บรรทัด 34:
```js
function SiteForm({ initial = EMPTY_FORM, clients = [], onSave, onCancel, loading }) {
```

แก้ section "ชื่อลูกค้า" (แทนที่ text input บรรทัด 49-51):
```jsx
<div>
  <label className="label">ลูกค้า / เจ้าของงาน</label>
  <select className="select" value={form.client_id} onChange={e => set('client_id', e.target.value)}>
    <option value="">— เลือกลูกค้า —</option>
    {clients.map(c => (
      <option key={c.id} value={c.id}>{c.client_number} · {c.name}</option>
    ))}
  </select>
</div>
```

- [ ] **Step 3: ใน handleSave ส่ง client_id แทน client_name**

แก้ payload ใน handleSave (บรรทัด 166-176):
```js
const payload = {
  name:           form.name,
  client_id:      form.client_id || null,
  location:       form.location || null,
  status:         form.status,
  start_date:     form.start_date || null,
  end_date:       form.end_date || null,
  contract_value: parseFloat(form.contract_value) || null,
  notes:          form.notes || null,
  ...Object.fromEntries(COST_TYPES.map(t => [t.key, parseFloat(form[t.key]) || null]))
}
```

- [ ] **Step 4: ใน Sites component เพิ่ม useClients hook และ pass ไปให้ SiteForm**

เพิ่มหลัง `const { data: laborData }`:
```js
const { data: clients } = useClients()
```

แก้ Modal ให้ส่ง clients:
```jsx
<SiteForm
  initial={editSite || EMPTY_FORM}
  clients={clients || []}
  onSave={handleSave}
  onCancel={() => { setShowForm(false); setEditSite(null) }}
  loading={saving}
/>
```

- [ ] **Step 5: แก้ table row ให้แสดง client_display_name**

บรรทัดที่แสดง client_name (บรรทัดประมาณ 250):
```jsx
{(s.client_display_name || s.client_name) &&
  <div style={{ fontSize: 11, color: 'var(--text3)' }}>
    {s.client_number && <span style={{ color: 'var(--accent)' }}>{s.client_number} · </span>}
    {s.client_display_name || s.client_name}
  </div>
}
```

---

## Task 6: Update Expenses.jsx — เพิ่ม supplier dropdown

**File:** `src/pages/Expenses.jsx`

- [ ] **Step 1: เพิ่ม useSuppliers import**

```js
// เดิม
import { useExpenses, useSites, useCategories } from '../hooks/useSupabase.js'
// ใหม่
import { useExpenses, useSites, useCategories, useSuppliers } from '../hooks/useSupabase.js'
```

- [ ] **Step 2: เพิ่ม supplier_id ใน EMPTY_FORM**

```js
const EMPTY_FORM = {
  date: '', description: '', site_id: '', category_id: '', supplier: '', supplier_id: '',
  amount: '', payment_method: 'transfer', check_date: '',
  status: 'pending', payer: '', notes: '', invoice_no: ''
}
```

- [ ] **Step 3: เพิ่ม `suppliers` prop ใน ExpenseForm + dropdown**

แก้ function signature:
```js
function ExpenseForm({ initial = EMPTY_FORM, sites, categories, suppliers = [], onSave, onCancel, loading }) {
```

เพิ่ม supplier dropdown หลังจาก category select:
```jsx
<div>
  <label className="label">Supplier</label>
  <select className="select" value={form.supplier_id} onChange={e => {
    const sup = suppliers.find(s => s.id === e.target.value)
    set('supplier_id', e.target.value)
    if (sup) set('supplier', sup.name)
  }}>
    <option value="">— เลือก Supplier —</option>
    {suppliers.map(s => (
      <option key={s.id} value={s.id}>{s.supplier_number} · {s.name}</option>
    ))}
  </select>
</div>
```

- [ ] **Step 4: เพิ่ม useSuppliers hook ใน component + pass ลง form**

```js
const { data: suppliers } = useSuppliers()
```

ส่ง `suppliers` ลงใน `<ExpenseForm ... suppliers={suppliers || []} />`

- [ ] **Step 5: เพิ่ม supplier_id ใน payload ของ handleSave**

```js
supplier_id: form.supplier_id || null,
```

---

## Task 7: Update App.jsx — เพิ่ม 2 tabs

**File:** `src/App.jsx`

- [ ] **Step 1: เพิ่ม imports + TABS + renderPage**

```jsx
// เพิ่ม imports (หลัง Categories)
import Clients   from './pages/Clients.jsx'
import Suppliers from './pages/Suppliers.jsx'
```

```js
// ใน TABS array เพิ่ม 2 items
{ id: 'clients',   label: '🏢 ลูกค้า' },
{ id: 'suppliers', label: '🏭 Supplier' },
```

```jsx
// ใน renderPage switch เพิ่ม cases
case 'clients':   return <Clients   {...props} />
case 'suppliers': return <Suppliers {...props} />
```

---

## Task 8: Update ExcelUpload.jsx — เพิ่ม sites/clients/suppliers import

**File:** `src/components/ExcelUpload.jsx`

- [ ] **Step 1: เพิ่ม parseSiteSheet function (หลัง parseIncomeSheet)**

```js
async function parseSiteSheet(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })
  const headerRowIdx = rows.findIndex(r => r.some(c => typeof c === 'string' && c.includes('ชื่อไซท์งาน')))
  if (headerRowIdx < 0) throw new Error('ไม่พบแถว header (ชื่อไซท์งาน) ในชีท')
  const dataRows = rows.slice(headerRowIdx + 2)

  // Load clients for matching
  const { data: clientsData } = await supabase.from('clients').select('id, name, client_number')
  const clientMap = {}
  clientsData?.forEach(c => { clientMap[c.name] = c.id; clientMap[c.client_number] = c.id })

  const records = []
  for (const row of dataRows) {
    if (!row[0]) continue
    records.push({
      name:           String(row[0]),
      client_id:      clientMap[row[1]] || null,
      location:       row[2] || null,
      status:         row[3] || 'Ongoing',
      start_date:     row[4] ? String(row[4]).slice(0,10) : null,
      end_date:       row[5] ? String(row[5]).slice(0,10) : null,
      contract_value: parseFloat(row[6]) || null,
      cost_glass:     parseFloat(row[7]) || null,
      cost_aluminum:  parseFloat(row[8]) || null,
      cost_equipment: parseFloat(row[9]) || null,
      cost_rubber:    parseFloat(row[10]) || null,
      cost_labor:     parseFloat(row[11]) || null,
    })
  }
  return records
}

async function parseClientSheet(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })
  const headerRowIdx = rows.findIndex(r => r.some(c => typeof c === 'string' && c.includes('ชื่อลูกค้า')))
  if (headerRowIdx < 0) throw new Error('ไม่พบแถว header (ชื่อลูกค้า)')
  const dataRows = rows.slice(headerRowIdx + 2)
  const records = []
  for (const row of dataRows) {
    if (!row[0]) continue
    records.push({
      name:           String(row[0]),
      contact_person: row[1] || null,
      position:       row[2] || null,
      phone:          row[3] ? String(row[3]) : null,
      email:          row[4] || null,
      address:        row[5] || null,
      province:       row[6] || null,
      notes:          row[7] || null,
    })
  }
  return records
}

async function parseSupplierSheet(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })
  const headerRowIdx = rows.findIndex(r => r.some(c => typeof c === 'string' && c.includes('Supplier')))
  if (headerRowIdx < 0) throw new Error('ไม่พบแถว header (Supplier)')
  const dataRows = rows.slice(headerRowIdx + 2)
  const records = []
  for (const row of dataRows) {
    if (!row[0]) continue
    records.push({
      name:           String(row[0]),
      contact_person: row[1] || null,
      phone:          row[2] ? String(row[2]) : null,
      email:          row[3] || null,
      category:       row[4] || null,
      payment_terms:  row[5] || null,
      address:        row[6] || null,
      notes:          row[7] || null,
    })
  }
  return records
}
```

- [ ] **Step 2: แก้ processFile ใน ExcelUpload component**

```js
const records =
  type === 'expense'  ? await parseExpenseSheet(ws)  :
  type === 'income'   ? await parseIncomeSheet(ws)   :
  type === 'site'     ? await parseSiteSheet(ws)     :
  type === 'client'   ? await parseClientSheet(ws)   :
                        await parseSupplierSheet(ws)
```

- [ ] **Step 3: แก้ handleImport ให้รู้จัก 5 tables**

```js
const table =
  type === 'expense'  ? 'expenses'  :
  type === 'income'   ? 'incomes'   :
  type === 'site'     ? 'sites'     :
  type === 'client'   ? 'clients'   :
                        'suppliers'
```

- [ ] **Step 4: แก้ label และ preview columns ให้รองรับ type ใหม่**

```js
const label =
  type === 'expense'  ? 'รายจ่าย'   :
  type === 'income'   ? 'รายรับ'    :
  type === 'site'     ? 'ไซท์งาน'  :
  type === 'client'   ? 'ลูกค้า'   :
                        'Supplier'
```

---

## Verification

- [ ] เปิด http://localhost:5173 ตรวจ tab ใหม่ "ลูกค้า" และ "Supplier"
- [ ] เพิ่ม client → ตรวจว่า CL-2026-001 ถูก generate อัตโนมัติ
- [ ] เพิ่ม supplier → ตรวจว่า SP-2026-001 ถูก generate อัตโนมัติ
- [ ] เพิ่มไซท์งาน → dropdown ลูกค้าโชว์ CL-number
- [ ] เพิ่มรายจ่าย → dropdown Supplier โชว์ SP-number
- [ ] อัพโหลด TEMPLATE_ลูกค้า.xlsx ใน Clients page → import สำเร็จ
