// Offline evaluation of PO document extraction across providers/models.
// Usage (keys come from the environment, never from the repo):
//   ANTHROPIC_API_KEY=... GEMINI_API_KEY=... \
//   npx --yes tsx scripts/eval-po-extract.mjs --dir ./eval-docs \
//     --providers anthropic:claude-haiku-4-5-20251001,anthropic:claude-sonnet-5,gemini:<model-id> \
//     [--dry-run] [--out eval-report.csv]
// <dir> holds documents (.pdf/.jpg/.jpeg/.png) each with a sibling
// <name>.expected.json in the extraction shape (the corrected answer).
// Use only documents the owner supplies or FacadeX's own tenant -- never
// another tenant's saved supplier examples.
// --dry-run skips every network call and answers with the expected JSON,
// to prove the pipeline end to end (expect accuracy 1.0 everywhere).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import { SYSTEM_PROMPT } from '../supabase/functions/_shared/po-extract-prompt.ts'
import { classifyModelOutput } from '../supabase/functions/_shared/scan-logic.ts'
import { compareExtraction, summariseProvider } from '../src/lib/scanEvalCompare.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]] : []).filter(e => e.length))
const dir = args.dir
const providers = String(args.providers || '').split(',').filter(Boolean)
const dryRun = args['dry-run'] === true
if (!dir || providers.length === 0) { console.error('need --dir and --providers'); process.exit(1) }

const MIME = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' }

async function callAnthropic(model, mimeType, b64) {
  const block = mimeType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: mimeType, data: b64 } }
    : { type: 'image', source: { type: 'base64', media_type: mimeType, data: b64 } }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 8192, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: [block, { type: 'text', text: 'Extract this document.' }] }] }),
  })
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const j = await res.json()
  const t = (j.content || []).find(b => b.type === 'text')
  return { text: t?.text ?? '', inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0 }
}

// Gemini REST shape as of writing; verify against Google's current API
// reference before the first run. If a request is rejected, fix the script
// from the docs -- do not guess.
async function callGemini(model, mimeType, b64) {
  const id = model.replace(/^models\//, '')
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${id}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: b64 } }, { text: 'Extract this document.' }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  })
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const j = await res.json()
  return {
    text: j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') ?? '',
    inputTokens: j.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: j.usageMetadata?.candidatesTokenCount ?? 0,
  }
}

const files = readdirSync(dir).filter(f => MIME[extname(f).toLowerCase()])
const rows = []
for (const spec of providers) {
  const [kind, ...rest] = spec.split(':')
  const model = rest.join(':')
  for (const f of files) {
    const base = basename(f, extname(f))
    const expected = JSON.parse(readFileSync(join(dir, `${base}.expected.json`), 'utf8'))
    const mimeType = MIME[extname(f).toLowerCase()]
    const b64 = readFileSync(join(dir, f)).toString('base64')
    const t0 = Date.now()
    let out
    try {
      out = dryRun ? { text: JSON.stringify({ status: 'success', ...expected }), inputTokens: 0, outputTokens: 0 }
        : kind === 'gemini' ? await callGemini(model, mimeType, b64) : await callAnthropic(model, mimeType, b64)
    } catch (e) {
      rows.push({ provider: spec, doc: f, kind: 'call_failed', accuracy: 0, inputTokens: 0, outputTokens: 0, ms: Date.now() - t0, note: String(e).slice(0, 120) })
      continue
    }
    const c = classifyModelOutput(out.text)
    const actual = c.kind === 'ok' || c.kind === 'check_failed' ? c.result : { line_items: [] }
    rows.push({ provider: spec, doc: f, kind: c.kind, accuracy: compareExtraction(expected, actual).accuracy, inputTokens: out.inputTokens, outputTokens: out.outputTokens, ms: Date.now() - t0, note: c.reason || '' })
  }
}

const csvCell = v => '"' + String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"'
const csv = ['provider,doc,kind,accuracy,input_tokens,output_tokens,ms,note',
  ...rows.map(r => [r.provider, r.doc, r.kind, r.accuracy.toFixed(3), r.inputTokens, r.outputTokens, r.ms, r.note].map(csvCell).join(','))].join('\n')
writeFileSync(args.out && args.out !== true ? args.out : 'eval-report.csv', csv)

console.log('\nprovider'.padEnd(46), 'docs  meanAcc  checkPass  inTok   outTok')
for (const spec of providers) {
  const s = summariseProvider(rows.filter(r => r.provider === spec))
  console.log(spec.padEnd(45), String(s.docs).padEnd(5), s.meanAccuracy.toFixed(3).padEnd(8), s.checkPassRate.toFixed(2).padEnd(10), String(s.inputTokens).padEnd(7), s.outputTokens)
}
console.log('\nGate (spec): enable PO_SCAN_CHEAP_FIRST only if the cheap model checkPass is high enough that');
console.log('escalation (1 - checkPass) is well under 0.5 AND its meanAcc is within ~0.02 of the strong model.')
