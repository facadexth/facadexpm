// Who gets a notification. 'ops' = site/operations news (PM included);
// 'money' = cheques, quotations and other money news (PM never sees these).
export type Audience = 'ops' | 'money'

export function rolesFor(audience: Audience): string[] {
  if (audience === 'ops') return ['OWNER', 'ADMIN', 'PM']
  if (audience === 'money') return ['OWNER', 'ADMIN']
  throw new Error(`invalid notification audience: ${String(audience)}`)
}
