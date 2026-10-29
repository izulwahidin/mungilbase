import { parseRule } from './parse.js'
import { RuleError, type BinaryOperator, type ExpressionNode, type SqlValue } from './ast.js'

export interface CompiledRule {
  /** SQL fragment. Contains `?` placeholders only — never rule values. */
  sql: string
  /** Values bound to `sql`, in order. */
  params: SqlValue[]
}

export interface CompileContext {
  table: string
  columns: ReadonlySet<string>
  auth: {
    /** `null` for anonymous requests. */
    uid: string | null
    /** Defaults to false for callers that only care about identity. */
    verified?: boolean
  }
}

/**
 * Functions a rule may call. Keeping this list closed is what makes the DSL
 * safe: there is no way to call a function we did not choose.
 */
const FUNCTIONS: Record<string, { min: number; max: number }> = {
  lower: { min: 1, max: 1 },
  upper: { min: 1, max: 1 },
  trim: { min: 1, max: 1 },
  ltrim: { min: 1, max: 2 },
  rtrim: { min: 1, max: 2 },
  length: { min: 1, max: 1 },
  substr: { min: 2, max: 3 },
  replace: { min: 3, max: 3 },
  coalesce: { min: 1, max: 8 },
  ifnull: { min: 2, max: 2 },
  abs: { min: 1, max: 1 },
  round: { min: 1, max: 2 },
  json_valid: { min: 1, max: 1 },
  json_extract: { min: 2, max: 8 },
  unixepoch: { min: 0, max: 1 },
}

/**
 * `==`/`!=` compile to SQLite's `IS`/`IS NOT`.
 *
 * `IS` is null-safe: `NULL IS NULL` is true, `x IS NULL` works for any x, and
 * SQLite still uses indexes for it. Plain `=` would silently make
 * `auth.uid == owner_id` false for anonymous users instead of matching NULL
 * owners, which is the kind of subtlety that becomes a data leak.
 */
const BINARY_SQL: Record<BinaryOperator, string> = {
  '==': 'IS',
  '!=': 'IS NOT',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
  '&': 'AND',
  '|': 'OR',
  '+': '+',
  '-': '-',
  '*': '*',
  '/': '/',
  '||': '||',
  '~': 'LIKE',
  '!~': 'NOT LIKE',
  '->': '->',
  '->>': '->>',
}

/**
 * Compiles a rule expression into a parameterized SQL fragment.
 *
 * Examples:
 *   compileRule('auth.uid == owner_id', ctx)
 *   // { sql: '(? IS "owner_id")', params: ['user_123'] }
 *
 *   compileRule('true', ctx)
 *   // { sql: '1', params: [] }
 */
export function compileRule(expression: string, context: CompileContext): CompiledRule {
  const ast = parseRule(expression)

  // A bare literal is either "everyone" or "nobody". Render it as a constant
  // so the query planner can short-circuit instead of evaluating `WHERE ?`.
  if (ast.kind === 'literal') {
    if (ast.value === true) return { sql: '1', params: [] }
    if (ast.value === false || ast.value === null) return { sql: '0', params: [] }
    throw new RuleError('A rule must evaluate to a boolean, not a bare literal')
  }

  return compileNode(ast, context, 0)
}

function compileNode(node: ExpressionNode, context: CompileContext, depth: number): CompiledRule {
  if (depth > 64) throw new RuleError('Rule is nested too deeply')

  switch (node.kind) {
    case 'literal': {
      if (node.value === null) return { sql: 'NULL', params: [] }
      return { sql: '?', params: [node.value] }
    }

    case 'column': {
      if (!context.columns.has(node.name)) {
        throw new RuleError(`Unknown column "${node.name}" on table "${context.table}"`)
      }
      return { sql: quoteIdentifier(node.name), params: [] }
    }

    case 'auth': {
      // Bound, not interpolated: auth values are still data.
      if (node.path === 'verified') {
        return { sql: '?', params: [context.auth.verified === true]}
      }
      return { sql: '?', params: [context.auth.uid] }
    }

    case 'unary': {
      const inner = compileNode(node.argument, context, depth + 1)
      return {
        sql: node.op === '!' ? `(NOT ${inner.sql})` : `(-${inner.sql})`,
        params: inner.params,
      }
    }

    case 'binary': {
      const left = compileNode(node.left, context, depth + 1)
      const right = compileNode(node.right, context, depth + 1)
      return {
        sql: `(${left.sql} ${BINARY_SQL[node.op]} ${right.sql})`,
        params: [...left.params, ...right.params],
      }
    }

    case 'call': {
      const name = node.name.toLowerCase()
      const signature = FUNCTIONS[name]
      if (!signature) throw new RuleError(`Unknown function "${node.name}"`)
      if (node.args.length < signature.min || node.args.length > signature.max) {
        throw new RuleError(
          `Function "${name}" expects ${signature.min === signature.max ? signature.min : `${signature.min}-${signature.max}`} argument(s), got ${node.args.length}`,
        )
      }
      const args = node.args.map((arg) => compileNode(arg, context, depth + 1))
      return {
        sql: `${name}(${args.map((arg) => arg.sql).join(', ')})`,
        params: args.flatMap((arg) => arg.params),
      }
    }
  }
}

function quoteIdentifier(name: string): string {
  // Names already match ^[a-z][a-z0-9_]*$ at parse and config time. Belt and braces.
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new RuleError(`Invalid column name "${name}"`)
  return `"${name}"`
}
