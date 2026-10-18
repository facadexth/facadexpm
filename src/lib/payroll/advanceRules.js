// Pure advance-request rules for the app. MIRROR of supabase/functions/_shared/advance-logic.ts - keep in sync
// (advanceRules.test.js runs the same cases against both).
export const ADVANCE_PHRASES = {
  advance_request: ["เบิกเงิน"],
  advance_status: ["ยอดเบิก"],
  request_menu: ["ยื่นคำขอ"],
  request_status: ["สถานะคำขอ"]
};
const CHECK_ORDER = ["request_status", "advance_status", "request_menu", "advance_request"];
export function matchAdvanceAction(text, phrasesByKey = {}) {
  const t = String(text ?? "");
  if (!t) return null;
  for (const key of CHECK_ORDER) {
    const phrases = phrasesByKey?.[key]?.length ? phrasesByKey[key] : ADVANCE_PHRASES[key];
    if (phrases.some((p) => p && t.includes(p))) return key;
  }
  return null;
}
export function parseAdvanceAmount(raw) {
  const s = String(raw ?? "").replace(/[,\s]/g, "");
  if (s === "") return { ok: false, error: "กรุณาใส่จำนวนเงิน" };
  const bad = { ok: false, error: "จำนวนเงินต้องมากกว่า 0 และไม่เกิน 1,000,000 บาท" };
  if (!/^-?\d+(\.\d+)?$/.test(s)) return bad;
  const amount = Number(Math.round(Number(s + "e2")) + "e-2");
  if (!(amount > 0 && amount <= 1e6)) return bad;
  return { ok: true, amount };
}
export function workerMonthlyPay(worker) {
  if (!worker) return 0;
  if (worker.pay_type === "daily") return (Number(worker.daily_wage) || 0) * 30;
  return Number(worker.monthly_salary) || 0;
}
export function summarizeAdvances(advances, closedLines, exceptId) {
  const deductedBy = /* @__PURE__ */ new Map();
  const countBy = /* @__PURE__ */ new Map();
  for (const l of closedLines || []) {
    deductedBy.set(l.advance_id, (deductedBy.get(l.advance_id) || 0) + (Number(l.amount) || 0));
    countBy.set(l.advance_id, (countBy.get(l.advance_id) || 0) + 1);
  }
  let outstanding = 0;
  let pendingOther = 0;
  const items = (advances || []).map((a) => {
    const amount = Number(a.amount) || 0;
    const deducted = deductedBy.get(a.id) || 0;
    const remaining = a.status === "approved" ? Math.max(0, amount - deducted) : 0;
    if (a.status === "approved") outstanding += remaining;
    if (a.status === "pending" && a.id !== exceptId) pendingOther += amount;
    return {
      id: a.id,
      title: a.title,
      amount,
      installments: a.installments,
      status: a.status,
      rejectReason: a.reject_reason ?? null,
      deducted,
      remaining,
      paidInstallments: countBy.get(a.id) || 0
    };
  });
  return { outstanding, pendingOther, items };
}
export function advanceLimit({ monthlyPay, outstanding, pendingOther }) {
  return (monthlyPay || 0) - (outstanding || 0) - (pendingOther || 0);
}
export function defaultStartMonth(periodsByKey, today) {
  let { year, month } = today;
  for (let i = 0; i < 240; i++) {
    const st = periodsByKey?.[`${year}-${month}`] ?? periodsByKey?.[`${year}-${String(month).padStart(2, "0")}`];
    if (!st || st === "draft") return { year, month };
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return { year, month };
}
const ADVANCE_STATUS_TH = {
  pending: "รออนุมัติ",
  approved: "อนุมัติแล้ว",
  rejected: "ไม่อนุมัติ",
  settled: "ผ่อนครบแล้ว"
};
function advanceLines(summary, fmt) {
  return (summary?.items || []).map((it) => {
    let st = ADVANCE_STATUS_TH[it.status] || it.status;
    if (it.status === "rejected" && it.rejectReason) st += ` (${it.rejectReason})`;
    let line = `• ${it.title || "เบิกเงิน"} ${fmt(it.amount)} บาท — ${st}`;
    if (it.status === "approved") line += ` · หักแล้ว ${it.paidInstallments}/${it.installments} งวด`;
    return line;
  });
}
export function formatAdvanceStatusReply(summary, fmt) {
  const lines = advanceLines(summary, fmt);
  if (!lines.length) return "ยังไม่มีรายการเบิกเงินครับ";
  return [...lines, `ยอดคืนคงเหลือ ${fmt(summary.outstanding)} บาท`].join("\n");
}
const TH_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const LEAVE_TYPE_TH = { leave_personal: "ลากิจ", leave_sick: "ลาป่วย" };
const LEAVE_STATUS_TH = { pending: "รออนุมัติ", approved: "อนุมัติแล้ว", rejected: "ไม่อนุมัติ" };
function leaveRange(from, to) {
  const [, fm, fd] = String(from).split("-").map(Number);
  const [, tm, td] = String(to || from).split("-").map(Number);
  if (fm === tm && fd === td) return `${fd} ${TH_MONTHS[fm - 1]}`;
  if (fm === tm) return `${fd}–${td} ${TH_MONTHS[fm - 1]}`;
  return `${fd} ${TH_MONTHS[fm - 1]} – ${td} ${TH_MONTHS[tm - 1]}`;
}
export function formatRequestStatusReply(data, fmt) {
  const sections = [];
  const recent = data?.leave?.recent || [];
  if (recent.length) {
    const lines = recent.map((r) => `• ${LEAVE_TYPE_TH[r.type] || r.type} ${leaveRange(r.from, r.to)} — ${LEAVE_STATUS_TH[r.status] || r.status}`);
    lines.push(`ลากิจคงเหลือ ${data.leave.personalLeft ?? 0} วัน · ลาป่วยคงเหลือ ${data.leave.sickLeft ?? 0} วัน`);
    sections.push(["🏖️ การลา", ...lines].join("\n"));
  }
  if (data?.advances?.items?.length) {
    sections.push(["💸 เบิกเงิน", formatAdvanceStatusReply(data.advances, fmt)].join("\n"));
  }
  return sections.length ? sections.join("\n\n") : "ยังไม่มีคำขอครับ";
}
