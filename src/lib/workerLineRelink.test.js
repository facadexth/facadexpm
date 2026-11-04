import { describe, it, expect } from 'vitest'
import { changeWorkerLine } from './workerLineRelink.js'

// Minimal fake of the supabase-js chain used by changeWorkerLine:
// from(table).update(patch).eq(col, val).select(cols) -> { data, error }
function fakeClient(result) {
  const calls = {}
  const client = {
    from(table) {
      calls.table = table
      return {
        update(patch) {
          calls.patch = patch
          return {
            eq(col, val) {
              calls.eq = [col, val]
              return { select(cols) { calls.select = cols; return Promise.resolve(result) } }
            },
          }
        },
      }
    },
  }
  return { client, calls }
}

describe('changeWorkerLine', () => {
  it('cuts the old LINE and sets a fresh link code in one update', async () => {
    const row = { id: 'w1', line_user_id: null, line_link_code: 'K7QX4M' }
    const { client, calls } = fakeClient({ data: [row], error: null })
    const out = await changeWorkerLine(client, 'w1', 'K7QX4M')
    expect(calls.table).toBe('workers')
    expect(calls.patch).toEqual({ line_user_id: null, line_link_code: 'K7QX4M' })
    expect(calls.eq).toEqual(['id', 'w1'])
    expect(out).toEqual(row)
  })

  it('throws when the database returns an error', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'boom' } })
    await expect(changeWorkerLine(client, 'w1', 'ABC234')).rejects.toThrow('boom')
  })

  it('throws when no row was updated (RLS blocked or worker gone), instead of a silent success', async () => {
    const { client } = fakeClient({ data: [], error: null })
    await expect(changeWorkerLine(client, 'w1', 'ABC234')).rejects.toThrow(/ไม่สำเร็จ/)
  })

  it('refuses to run without a worker id or code', async () => {
    const { client } = fakeClient({ data: [], error: null })
    await expect(changeWorkerLine(client, '', 'ABC234')).rejects.toThrow()
    await expect(changeWorkerLine(client, 'w1', '')).rejects.toThrow()
  })
})
