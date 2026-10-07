// Offline evaluation of PO document extraction across providers/models.
// Usage (keys come from the environment, never from the repo):
//   ANTHROPIC_API_KEY=... GEMINI_API_KEY=... \
//   npx --yes tsx scripts/eval-po-extract.mjs --dir ./eval-docs \
//     --providers anthropic:claude-haiku-4-5-20251001,anthropic:claude-sonnet-5,gemini:<model-id> \
//     [--dry-run] [--examples] [--out eval-report.csv] [--raw-dir ./eval-raw]
// --raw-dir saves each model's raw answer as <dir>/<provider>__<doc>.txt so a low score can be inspected.
// <dir> holds documents (.pdf/.jpg/.jpeg/.png) each with a sibling
// <name>.expected.json in the extraction shape (the corrected answer).
// Use only documents the owner supplies or FacadeX's own tenant -- never
// another tenant's saved supplier examples.
// --examples replays supplier examples as production does (prior user/assistant
// turns before the real document). A doc's <name>.expected.json may hold
// "examples": ["acme-1.jpg", ...] naming files in <dir>/examples/, each with a
// sibling <ex-name>.expected.json (its verified answer). At most 3 are used,
// in the listed order. Without --examples the field is ignored.
// Names must be bare file names (no paths); all problems are reported up front.
// CSV columns: provider,doc,kind,accuracy,input_tokens,output_tokens,ms,note,examples
// (examples = number of example turns used for the row, 0 without --examples).
// A doc's expected.json may carry "deposit_deductions": [{ref, amount}]; it is then compared (ref normalized, amount to a satang) and scored.
// Fixtures for the CAC deposit documents: scripts/eval-fixtures/cac-deposit/ (the scans stay local, not in git).
// --dry-run skips every network call and answers with the expected JSON,
// to prove the pipeline end to end (expect accuracy 1.0 everywhere).
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, extname, basename, resolve, sep } from 'node:path'
import { SYSTEM_PROMPT } from '../supabase/functions/_shared/po-extract-prompt.ts'
import { classifyModelOutput } from '../supabase/functions/_shared/scan-logic.ts'
import { compareExtraction, summariseProvider, pickExampleFields } from '../src/lib/scanEvalCompare.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]] : []).filter(e => e.length))
const dir = args.dir
const providers = String(args.providers || '').split(',').filter(Boolean)
const dryRun = args['dry-run'] === true
const useExamples = args.examples === true
const MAX_EXAMPLES = 3
if (!dir || providers.length === 0) { console.error('need --dir and --providers'); process.exit(1) }

const MIME = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' }

const anthropicBlock = (mimeType, b64) => mimeType === 'application/pdf'
  ? { type: 'document', source: { type: 'base64', media_type: mimeType, data: b64 } }
  : { type: 'image', source: { type: 'base64', media_type: mimeType, data: b64 } }

async function callAnthropic(model, mimeType, b64, exampleTurns = []) {
  const messages = []
  for (const ex of exampleTurns) {
    messages.push({ role: 'user', content: [anthropicBlock(ex.mimeType, ex.b64), { type: 'text', text: 'Extract this document.' }] })
    messages.push({ role: 'assistant', content: ex.json })
  }
  messages.push({ role: 'user', content: [anthropicBlock(mimeType, b64), { type: 'text', text: 'Extract this document.' }] })
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 8192, system: SYSTEM_PROMPT, messages }),
  })
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const j = await res.json()
  const t = (j.content || []).find(b => b.type === 'text')
  return { text: t?.text ?? '', inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0 }
}

// Gemini REST shape as of writing; verify against Google's current API
// reference before the first run. If a request is rejected, fix the script
// from the docs -- do not guess.
async function callGemini(model, mimeType, b64, exampleTurns = []) {
  const id = model.replace(/^models\//, '')
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${id}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [
        ...exampleTurns.flatMap(ex => [
          { role: 'user', parts: [{ inlineData: { mimeType: ex.mimeType, data: ex.b64 } }, { text: 'Extract this document.' }] },
          { role: 'model', parts: [{ text: ex.json }] },
        ]),
        { role: 'user', parts: [{ inlineData: { mimeType, data: b64 } }, { text: 'Extract this document.' }] },
      ],
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

// Resolve and validate example files up front (also in --dry-run).
const exampleNames = {}
if (useExamples) {
  const problems = []
  const exDir = resolve(dir, 'examples')
  let docsWith = 0, turns = 0, overLimit = 0
  const parses = p => { try { JSON.parse(readFileSync(p, 'utf8')); return true } catch { return false } }
  for (const f of files) {
    const base = basename(f, extname(f))
    const expPath = join(dir, `${base}.expected.json`)
    if (!existsSync(expPath)) continue // missing doc expected.json fails later as today
    let list = []
    try { list = JSON.parse(readFileSync(expPath, 'utf8')).examples ?? [] } catch { problems.push(`${base}.expected.json: malformed JSON`); continue }
    if (!Array.isArray(list)) { problems.push(`${base}.expected.json: "examples" must be an array`); continue }
    if (list.length > MAX_EXAMPLES) overLimit++
    const used = list.slice(0, MAX_EXAMPLES)
    const ok = []
    for (const ex of used) {
      if (typeof ex !== 'string') { problems.push(`${f}: example entry ${JSON.stringify(ex)} is not a string`); continue }
      if (!ex || ex !== basename(ex) || /[\\/]/.test(ex) || ex.startsWith('.') || !resolve(exDir, ex).startsWith(exDir + sep)) {
        problems.push(`${f}: example name ${JSON.stringify(ex)} is not a bare file name (path traversal / separators are not allowed)`)
        continue
      }
      ok.push(ex)
      const exBase = basename(ex, extname(ex))
      const exExp = join(exDir, `${exBase}.expected.json`)
      if (!MIME[extname(ex).toLowerCase()]) problems.push(`${f}: example ${ex} has an unsupported extension`)
      else if (!existsSync(join(exDir, ex))) problems.push(`examples/${ex} missing (listed by ${f})`)
      if (!existsSync(exExp)) problems.push(`examples/${exBase}.expected.json missing (listed by ${f})`)
      else if (!parses(exExp)) problems.push(`examples/${exBase}.expected.json: malformed JSON (listed by ${f})`)
    }
    exampleNames[f] = ok
    if (ok.length) { docsWith++; turns += ok.length }
  }
  if (problems.length) {
    console.error('missing or invalid example files:\n  ' + problems.join('\n  '))
    process.exit(1)
  }
  if (overLimit) console.warn(`warning: ${overLimit} doc(s) list more than ${MAX_EXAMPLES} examples; production sends at most ${MAX_EXAMPLES}, using the first ${MAX_EXAMPLES} of each`)
  console.log(`examples: ${docsWith} docs use examples (${turns} example turns in total)`)
}

const rows = []
for (const spec of providers) {
  const [kind, ...rest] = spec.split(':')
  const model = rest.join(':')
  for (const f of files) {
    const base = basename(f, extname(f))
    const expected = JSON.parse(readFileSync(join(dir, `${base}.expected.json`), 'utf8'))
    const mimeType = MIME[extname(f).toLowerCase()]
    const b64 = readFileSync(join(dir, f)).toString('base64')
    const exampleTurns = (exampleNames[f] || []).map(ex => ({
      mimeType: MIME[extname(ex).toLowerCase()],
      b64: readFileSync(join(dir, 'examples', ex)).toString('base64'),
      json: JSON.stringify(pickExampleFields(JSON.parse(readFileSync(join(dir, 'examples', `${basename(ex, extname(ex))}.expected.json`), 'utf8')))),
    }))
    const t0 = Date.now()
    let out
    try {
      out = dryRun ? { text: JSON.stringify({ status: 'success', ...expected }), inputTokens: 0, outputTokens: 0 }
        : kind === 'gemini' ? await callGemini(model, mimeType, b64, exampleTurns) : await callAnthropic(model, mimeType, b64, exampleTurns)
    } catch (e) {
      rows.push({ provider: spec, doc: f, kind: 'call_failed', accuracy: 0, inputTokens: 0, outputTokens: 0, examples: exampleTurns.length, ms: Date.now() - t0, note: String(e).slice(0, 120) })
      continue
    }
    if (args['raw-dir'] && args['raw-dir'] !== true) {
      mkdirSync(args['raw-dir'], { recursive: true })
      writeFileSync(join(args['raw-dir'], `${spec.replace(/[^a-z0-9.-]+/gi, '_')}__${basename(f, extname(f))}.txt`), out.text)
    }
    const c = classifyModelOutput(out.text)
    const actual = c.kind === 'ok' || c.kind === 'check_failed' ? c.result : { line_items: [] }
    rows.push({ provider: spec, doc: f, kind: c.kind, accuracy: compareExtraction(expected, actual).accuracy, inputTokens: out.inputTokens, outputTokens: out.outputTokens, examples: exampleTurns.length, ms: Date.now() - t0, note: c.reason || '' })
  }
}

const csvCell = v => '"' + String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"'
const csv = ['provider,doc,kind,accuracy,input_tokens,output_tokens,ms,note,examples',
  ...rows.map(r => [r.provider, r.doc, r.kind, r.accuracy.toFixed(3), r.inputTokens, r.outputTokens, r.ms, r.note, r.examples].map(csvCell).join(','))].join('\n')
writeFileSync(args.out && args.out !== true ? args.out : 'eval-report.csv', csv)

console.log('\nprovider'.padEnd(46), 'docs  meanAcc  checkPass  inTok   outTok')
for (const spec of providers) {
  const s = summariseProvider(rows.filter(r => r.provider === spec))
  console.log(spec.padEnd(45), String(s.docs).padEnd(5), s.meanAccuracy.toFixed(3).padEnd(8), s.checkPassRate.toFixed(2).padEnd(10), String(s.inputTokens).padEnd(7), s.outputTokens)
}
console.log('\nGate (spec): enable PO_SCAN_CHEAP_FIRST only if the cheap model checkPass is high enough that');
console.log('escalation (1 - checkPass) is well under 0.5 AND its meanAcc is within ~0.02 of the strong model.')
