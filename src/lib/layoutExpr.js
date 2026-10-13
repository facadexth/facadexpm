// Tiny safe arithmetic evaluator for layout definitions (per / count / factor / overlapCount fields).
// Grammar:  expr   -> term (('+' | '-') term)*
//           term   -> factor (('*' | '/') factor)*
//           factor -> number | identifier | '(' expr ')' | fn '(' expr (',' expr)* ')'
// Functions (whitelist FUNCS): ceil(x), max(a, b, ...). A ',' is accepted only between function arguments.
// Identifiers are looked up as OWN properties of `params` (finite numbers only). Anything else throws 'layout_expr: ...'.
// Never uses eval / Function. Pure and deterministic. Callers round when they need an integer count.

const TOKEN = /^\s*(\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|[-+*/(),])/

const fail = (msg) => { throw new Error('layout_expr: ' + msg) }

// name -> { min, max } argument count, impl(args)
const FUNCS = {
  ceil: { min: 1, max: 1, run: (a) => Math.ceil(a[0]) },
  max: { min: 2, max: Infinity, run: (a) => Math.max(...a) },
}

function tokenize(src) {
  const out = []
  let rest = src
  while (rest.trim() !== '') {
    const m = TOKEN.exec(rest)
    if (!m) fail('bad token in ' + JSON.stringify(src))
    out.push(m[1])
    rest = rest.slice(m[0].length)
  }
  return out
}

export function evalExpr(expr, params) {
  if (typeof expr === 'number') {
    if (!Number.isFinite(expr)) fail('not a finite number')
    return expr
  }
  if (typeof expr !== 'string') fail('not a number or string')
  const toks = tokenize(expr)
  if (!toks.length) fail('empty expression')
  const p = params || {}
  let i = 0

  const factor = () => {
    const t = toks[i++]
    if (t === undefined) fail('unexpected end in ' + JSON.stringify(expr))
    if (t === '(') {
      const v = sum()
      if (toks[i++] !== ')') fail('missing ) in ' + JSON.stringify(expr))
      return v
    }
    if (/^\d/.test(t)) return Number(t)
    if (/^[A-Za-z_]/.test(t) && toks[i] === '(') {
      if (!Object.prototype.hasOwnProperty.call(FUNCS, t)) fail('unknown function ' + t)
      i++
      const args = [sum()]
      while (toks[i] === ',') { i++; args.push(sum()) }
      if (toks[i++] !== ')') fail('missing ) in ' + JSON.stringify(expr))
      const f = FUNCS[t]
      if (args.length < f.min || args.length > f.max) fail('wrong argument count for ' + t)
      return f.run(args)
    }
    if (/^[A-Za-z_]/.test(t)) {
      if (!Object.prototype.hasOwnProperty.call(p, t)) fail('unknown ' + t)
      const v = p[t]
      if (typeof v !== 'number' || !Number.isFinite(v)) fail('not a number ' + t)
      return v
    }
    return fail('unexpected ' + t + ' in ' + JSON.stringify(expr))
  }
  const term = () => {
    let v = factor()
    while (toks[i] === '*' || toks[i] === '/') {
      const op = toks[i++]
      const r = factor()
      if (op === '/' && r === 0) fail('division by zero in ' + JSON.stringify(expr))
      v = op === '*' ? v * r : v / r
    }
    return v
  }
  const sum = () => {
    let v = term()
    while (toks[i] === '+' || toks[i] === '-') {
      const op = toks[i++]
      const r = term()
      v = op === '+' ? v + r : v - r
    }
    return v
  }

  const v = sum()
  if (i !== toks.length) fail('trailing ' + toks[i] + ' in ' + JSON.stringify(expr))
  return v
}
