// supabase/functions/_shared/timing-safe.ts
// Constant-time string compare, kept free of Deno/env imports so it can be unit tested.
// Compares every byte of the longer input, so the time taken does not reveal how
// many leading characters matched.
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const x = enc.encode(a)
  const y = enc.encode(b)
  let diff = x.length ^ y.length
  const len = Math.max(x.length, y.length)
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}
