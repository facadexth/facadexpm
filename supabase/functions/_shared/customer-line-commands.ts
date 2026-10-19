// Pure command matching for the customer LINE bot. No Deno or supabase imports:
// this file is also imported by vitest from src/lib.

export type CustomerCommand = 'quote' | 'status' | 'repair' | 'repair_status' | 'warranty' | 'contact'

const COMMANDS: Record<string, CustomerCommand> = {
  'ขอใบเสนอราคา': 'quote',
  'สถานะงาน': 'status',
  'แจ้งซ่อม': 'repair',
  'สถานะแจ้งซ่อม': 'repair_status',
  'ประกันของฉัน': 'warranty',
  'ประกัน': 'warranty',
  'รับประกัน': 'warranty',
  'ระยะเวลารับประกัน': 'warranty',
  'เช็คประกัน': 'warranty',
  'ตรวจสอบประกัน': 'warranty',
  'ติดต่อเรา': 'contact',
}

// Trims and removes every whitespace character, so "สถานะ งาน" matches "สถานะงาน".
export function matchCustomerCommand(text: string): CustomerCommand | null {
  const key = text.replace(/\s+/g, '')
  return Object.prototype.hasOwnProperty.call(COMMANDS, key) ? COMMANDS[key] : null
}

const INVITE_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/

export function looksLikeInviteCode(text: string): boolean {
  return INVITE_CODE.test(text.trim().toUpperCase())
}
