-- supabase/migrations/2026-09-01-06-expense-status-follows-cheque.sql
-- ผู้ใช้พบว่าฟิลด์ "สถานะ" ของรายจ่ายยังแก้ไขเองได้อิสระแม้ผูกกับเช็คไว้แล้ว
-- ทำให้ conflict กับสถานะจริงของเช็คได้ (เช่น manual set เป็น "เช็คผ่าน"
-- ทั้งที่เช็คยังไม่ขึ้นเงิน) -- ใช้แนวทางเดียวกับ check_date: เมื่อผูก cheque_id
-- แล้ว ให้ status สะท้อนสถานะเช็คเสมอ (issued -> check_issued, cashed ->
-- check_cleared) แก้ไขได้ทางเดียวคือหน้า "เช็ค" เท่านั้น
--
-- ขยาย trigger ที่มีอยู่แล้ว (expense_sync_check_date_from_cheque) ให้ sync
-- status ไปพร้อมกับ check_date ในจังหวะเดียวกัน -- ไม่ต้องสร้าง trigger ใหม่แยก
CREATE OR REPLACE FUNCTION expense_sync_check_date_from_cheque()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE
  v_cheque_date DATE;
  v_cheque_status TEXT;
BEGIN
  IF NEW.cheque_id IS NOT NULL THEN
    SELECT check_date, status INTO v_cheque_date, v_cheque_status FROM cheques WHERE id = NEW.cheque_id;
    NEW.check_date := v_cheque_date;
    NEW.status := CASE WHEN v_cheque_status = 'cashed' THEN 'check_cleared' ELSE 'check_issued' END;
  END IF;
  RETURN NEW;
END;
$$;

-- เดิม trigger ยิงแค่ตอน INSERT หรือตอน cheque_id เปลี่ยน -- นั่นพลาดเคส "แก้
-- status ตรงๆ โดยไม่แตะ cheque_id เลย" เช่นหน้าต่าง "เปลี่ยนสถานะด่วน" ใน
-- Expenses.jsx (คลิก badge สถานะจากตาราง) ซึ่งยิง UPDATE status อย่างเดียว --
-- ขยายให้ยิงทุก UPDATE (ไม่จำกัดคอลัมน์) แล้วให้ตัว function เองเป็นคน
-- ตัดสินใจว่าต้อง enforce หรือไม่ (ผ่าน cheque_id IS NOT NULL) รับประกันว่า
-- ไม่มีทางเขียน status ที่ conflict กับเช็คได้เลยไม่ว่าจะเขียนผ่านทางไหน
DROP TRIGGER IF EXISTS trg_expense_sync_check_date ON expenses;
CREATE TRIGGER trg_expense_sync_check_date
  BEFORE INSERT OR UPDATE ON expenses
  FOR EACH ROW
  EXECUTE FUNCTION expense_sync_check_date_from_cheque();
