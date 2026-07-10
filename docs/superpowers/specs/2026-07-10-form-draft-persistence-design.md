# Form Draft Persistence — Design Spec

วันที่: 2026-07-10
สถานะ: อนุมัติดีไซน์แล้ว (รอเขียนแผน implementation)

## เป้าหมาย

ป้องกันข้อมูลที่พิมพ์ไว้ในฟอร์ม "เพิ่มรายการใหม่" (popup) หายไปเมื่อหน้าเว็บถูกโหลดใหม่โดยไม่ได้ตั้งใจ — เช่น Chrome ทำ tab discarding ตอนสลับไปแอปอื่น (Excel) หรือสลับ tab อื่น ทำให้ React state ในหน่วยความจำหายทั้งหมด ผู้ใช้ต้องพิมพ์ใหม่ตั้งแต่ต้น

## เหตุการณ์ต้นเรื่อง

ผู้ใช้รายงานว่า popup "เพิ่มลูกค้า/ไซท์งาน" ข้อมูลหายเมื่อสลับไปเปิดแอปอื่น (Excel) หรือ tab อื่นใน Chrome แล้วกลับมา — ไม่ใช่การกดเปลี่ยนแท็บภายในแอป (การเปลี่ยนแท็บภายในแอปที่ทำให้ component unmount เป็นพฤติกรรมที่คาดหวังอยู่แล้ว ไม่ใช่ปัญหาที่ต้องแก้ในสโคปนี้) กลไกที่เป็นไปได้มากที่สุดคือ browser tab discarding ของ Chrome ซึ่งทำให้หน้าเว็บโหลดใหม่ทั้งหมด (React state หายหมด) — แต่วิธีแก้ที่เลือกไม่ต้องพึ่งพาการวินิจฉัยกลไกที่แน่นอน เพราะแก้ที่ต้นตอเดียวกัน: ข้อมูลฟอร์มอยู่ใน React memory เท่านั้น ไม่มีการสำรองไว้ที่ไหนเลย

## การตัดสินใจที่ยืนยันแล้ว

| หัวข้อ | ข้อสรุป |
|---|---|
| กลไก | Hook ใหม่ `useDraftForm(key, emptyForm, enabled)` แทนที่ `useState` เดิมในฟอร์ม "เพิ่มใหม่" — เก็บ/อ่านค่าใน `localStorage` |
| ทำไมใช้ `localStorage` ไม่ใช่ `sessionStorage` | ทนต่อทั้ง tab discard-reload และปิด browser ทั้งหมดแล้วเปิดใหม่ — ปลอดภัยเพราะ clear ทุกครั้งที่ save/cancel สำเร็จ ไม่มีขยะสะสม |
| การ restore | เติมข้อมูลกลับอัตโนมัติทันทีที่เปิดฟอร์ม ไม่มี popup ถามยืนยัน |
| ขอบเขต: เพิ่มใหม่ vs แก้ไข | เฉพาะฟอร์ม "เพิ่มใหม่" เท่านั้น ฟอร์มแก้ไขข้อมูลเดิมไม่ทำ (ไม่ persist) |
| วิธีแยกโหมด เพิ่ม/แก้ | เช็คจาก `initial?.id` — ถ้าไม่มี `id` (เช่น `initial === EMPTY_FORM`) ถือว่าเป็นโหมดเพิ่มใหม่ (ยืนยันแล้วว่า `EMPTY_FORM` ทุกไฟล์ไม่มีคีย์ `id`) — **ไม่ใช้** `!initial` เฉยๆ เพราะ parent component ส่ง `initial={editX \|\| EMPTY_FORM}` เสมอ (เป็น object จริงทั้งสองโหมด ไม่ใช่ null) |
| ล้าง draft เมื่อไหร่ | (1) กด "ยกเลิก" → ลบทันที (2) กด submit (บันทึก) → ลบทันทีตอนกด ไม่รอผลลัพธ์จริงจาก server (ถ้า save fail ฟอร์มยังอยู่ในหน่วยความจำเดิม กด save ซ้ำได้ปกติ แค่ backup ใน localStorage หายไปแล้ว — ยอมรับ trade-off นี้เพื่อความเรียบง่าย) |
| ขอบเขตหน้า | Sites, Clients, Suppliers, Categories, Payroll (1 ฟอร์มต่อไฟล์) และ LaborContractors (3 ฟอร์มแยกกัน: SubcontractorTab, ContractsTab, PaymentModal) — ดูส่วนถัดไปสำหรับ UserManagement |

## ⚠️ ปรับขอบเขต: ไม่รวม UserManagement (เหตุผลด้านความปลอดภัย)

ฟอร์มเพิ่มผู้ใช้ใน `UserManagement.jsx` มีฟิลด์ `password` อยู่ในฟอร์มเดียวกัน (`useState({ email: '', password: '', role: 'ADMIN' })`) การเก็บรหัสผ่านไว้ใน `localStorage` แม้ชั่วคราวก็เป็นความเสี่ยงด้านความปลอดภัยที่ไม่ควรทำ (เข้าถึงได้จาก XSS ใดๆ, ค้างอยู่บนดิสก์) — **ตัดสินใจ: ไม่ทำ draft persistence ให้หน้านี้เลย** ไม่ใช่แค่ exclude ฟิลด์ password เพราะฟอร์มนี้เรียบง่ายและใช้ไม่บ่อย ความเสี่ยงมากกว่าประโยชน์ที่ได้

(หมายเหตุ: ระหว่างสำรวจโค้ดพบว่าสโคปจริงต่างจากที่ตกลงกันไว้ตอน brainstorm เล็กน้อย — เดิมพูดกันว่า "ทั้ง 7 หน้า" แต่ UserManagement ควรตัดออกด้วยเหตุผลนี้ ทำให้เหลือ 6 หน้า/ไฟล์ รวม 8 ฟอร์ม)

## Database / Storage

ไม่มีการเปลี่ยนแปลงฐานข้อมูล — ใช้ `localStorage` ฝั่ง browser เท่านั้น

### `src/hooks/useDraftForm.js` (ใหม่)
```js
function useDraftForm(key, emptyForm, enabled = true) {
  // คืนค่า [form, setForm, clearDraft] — คืนค่าเดียวกับ useState แต่เพิ่ม clearDraft
  // เมื่อ enabled=false (โหมดแก้ไข) ทำงานเหมือน useState(emptyForm) ธรรมดา ไม่แตะ localStorage เลย
}
```
- Storage key: `` `draft:${key}` `` เช่น `draft:sites-form`, `draft:labor-contractors-subcontractor-form`
- อ่านตอน mount (lazy initializer), เขียนทุกครั้งที่ `form` เปลี่ยน (`useEffect`)
- `try/catch` ครอบการเข้าถึง `localStorage` ทั้งหมด (กัน browser บล็อค localStorage เช่น private mode บาง browser หรือเต็มโควต้า — ถ้า error ให้ทำงานต่อแบบไม่ persist แทนที่จะ crash)

## UI Components ที่ต้องแก้

| ไฟล์ | ฟอร์ม/component | Draft key |
|---|---|---|
| `src/pages/Sites.jsx` | `SiteForm` | `sites-form` |
| `src/pages/Clients.jsx` | `ClientForm` | `clients-form` |
| `src/pages/Suppliers.jsx` | `SupplierForm` | `suppliers-form` |
| `src/pages/Categories.jsx` | `CatForm` | `categories-form` |
| `src/pages/Payroll.jsx` | `SalaryForm` | `payroll-form` |
| `src/pages/LaborContractors.jsx` | `SubcontractorTab` (ฟอร์มเพิ่ม subcontractor) | `labor-contractors-subcontractor-form` |
| `src/pages/LaborContractors.jsx` | `ContractsTab` (ฟอร์มเพิ่มสัญญา) | `labor-contractors-contract-form` |
| `src/pages/LaborContractors.jsx` | `PaymentModal` (ฟอร์มเพิ่มการจ่ายเงิน) | `labor-contractors-payment-form` |

แต่ละจุดแก้แบบเดียวกัน: เปลี่ยนจาก
```js
const [form, setForm] = useState({ ...EMPTY_FORM, ...initial })
```
เป็น
```js
const isAdd = !initial?.id
const [form, setForm, clearDraft] = useDraftForm(DRAFT_KEY, { ...EMPTY_FORM, ...initial }, isAdd)
```
แล้วเรียก `clearDraft()` ที่จุดกด "ยกเลิก" และจุดเริ่ม submit (ก่อนเรียก `onSave(form)`)

## ผลกระทบ / ความเสี่ยง

- ถ้า save ไม่สำเร็จ (เช่น network error) draft จะถูกลบไปแล้วตอนกด submit — ถ้า reload หน้าก่อน retry จะเสียข้อมูลอีกครั้ง (ยอมรับความเสี่ยงนี้แล้ว เพื่อความเรียบง่าย ไม่ต้อง sync สถานะ "รอผลจริง" กับ localStorage)
- `LaborContractors.jsx` มี 3 ฟอร์มแยกกันในไฟล์เดียว ต้องแก้ 3 จุดแยกกัน ไม่ใช่จุดเดียว
- ไม่ต้อง migrate ข้อมูลเก่าใดๆ เพราะ `localStorage` เป็น client-side ล้วนๆ เริ่มต้นจากว่างเปล่าเสมอสำหรับผู้ใช้ที่ยังไม่เคยเจอปัญหานี้

## นอกขอบเขต (ยังไม่ทำ)

- ไม่ทำ draft persistence ให้ฟอร์ม "แก้ไขข้อมูลเดิม" (ตามที่ตกลงกันไว้)
- ไม่ทำให้ `UserManagement.jsx` (เหตุผลความปลอดภัยข้างต้น)
- ไม่ทำ popup ถามยืนยันก่อน restore (auto-fill เงียบๆ ตามที่ตกลง)
- ไม่ทำ retry/queue เมื่อ save ล้มเหลว (พฤติกรรมเดิมคงไว้ — แจ้ง alert แล้วให้กด save ใหม่เอง)
- ไม่ทำ expiry/TTL ให้ draft เก่า (เพราะ clear ทุกครั้งที่ save/cancel สำเร็จอยู่แล้ว ไม่น่าจะมีขยะสะสมจริง)
