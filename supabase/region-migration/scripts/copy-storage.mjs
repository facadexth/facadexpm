// usage: node copy-storage.mjs   (reads TOKYO_URL/CHANG_URL and service keys from the environment)
// Reads Tokyo, writes CHANG only. Wipes CHANG's objects in each bucket first so the copy is exact.
import { createClient } from '@supabase/supabase-js'

const { TOKYO_URL, TOKYO_SERVICE_ROLE_KEY, CHANG_URL, CHANG_SERVICE_ROLE_KEY } = process.env
if (!TOKYO_URL || !CHANG_URL || !TOKYO_SERVICE_ROLE_KEY || !CHANG_SERVICE_ROLE_KEY) throw new Error('missing env')
if (!CHANG_URL.includes('kntspldhvcjeaubtqtkn') || CHANG_URL === TOKYO_URL) throw new Error('refusing: CHANG_URL is not CHANG')

const tokyo = createClient(TOKYO_URL, TOKYO_SERVICE_ROLE_KEY)
const chang = createClient(CHANG_URL, CHANG_SERVICE_ROLE_KEY)

async function listAll(client, bucket, prefix = '') {
  const out = []
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await client.storage.from(bucket).list(prefix, { limit: 100, offset })
    if (error) throw error
    for (const e of data) {
      const path = prefix ? `${prefix}/${e.name}` : e.name
      if (e.id === null) out.push(...await listAll(client, bucket, path)) // a folder
      else out.push({ path, size: e.metadata?.size ?? 0, type: e.metadata?.mimetype })
    }
    if (data.length < 100) break
  }
  return out
}

const t0 = Date.now()
const { data: buckets, error: bErr } = await tokyo.storage.listBuckets()
if (bErr) throw bErr
let total = 0
for (const b of buckets) {
  const { data: existing } = await chang.storage.getBucket(b.id)
  if (!existing) {
    const { error } = await chang.storage.createBucket(b.id, { public: b.public })
    if (error) throw error
  } else if (existing.public !== b.public) {
    const { error } = await chang.storage.updateBucket(b.id, { public: b.public })
    if (error) throw error
  }
  const old = await listAll(chang, b.id)
  for (let i = 0; i < old.length; i += 100) {
    const { error } = await chang.storage.from(b.id).remove(old.slice(i, i + 100).map((o) => o.path))
    if (error) throw error
  }
  const objs = await listAll(tokyo, b.id)
  for (const o of objs) {
    const { data: blob, error: dErr } = await tokyo.storage.from(b.id).download(o.path)
    if (dErr) throw new Error(`download ${b.id}/${o.path}: ${dErr.message}`)
    const { error: uErr } = await chang.storage.from(b.id).upload(o.path, blob, { contentType: o.type, upsert: true })
    if (uErr) throw new Error(`upload ${b.id}/${o.path}: ${uErr.message}`)
  }
  const after = await listAll(chang, b.id)
  const ok = after.length === objs.length && after.reduce((s, o) => s + o.size, 0) === objs.reduce((s, o) => s + o.size, 0)
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${b.id}: tokyo=${objs.length} chang=${after.length}`)
  if (!ok) process.exitCode = 1
  total += objs.length
}
console.log(`STORAGE objects=${total} seconds=${Math.round((Date.now() - t0) / 1000)}`)
