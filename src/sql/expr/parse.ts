import jsep from 'jsep'
import { RuleError, type BinaryOperator, type ExpressionNode } from './ast.js'

/**
 * The DSL is intentionally small. Anything not listed here is rejected, and
 * the parser only ever sees the rule text from the config (never user input).
 * The values in rules are bound as SQL parameters at compile time.
 */

export const MAX_RULE_LENGTH = 2000
export const MAX_RULE_DEPTH = 64

const BINARY_OPERATORS = new Set<string>([
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  '&',
  '|',
  '+',
  '-',
  '*',
  '/',
  '||',
  '~',
  '!~',
  '->',
  '->>',
])

/** jsep does not know the MungilBase-specific operators by default. */
let configured = false
function configureJsep(): void {
  if (configured) return
  const parser = jsep as unknown as {
    addBinaryOp(name: string, precedence: number, rightToLeft?: boolean): void
  }
  // Longer operators must be registered first so `!~` wins over `~`.
  parser.addBinaryOp('=', 6)
  parser.addBinaryOp('->>', 10)
  parser.addBinaryOp('->', 10)
  parser.addBinaryOp('!~', 7)
  parser.addBinaryOp('~', 7)
  configured = true
}

interface JsepNode {
  type: string
  [key: string]: unknown
}

export function parseRule(input: string): ExpressionNode {
  if (typeof input !== 'string') throw new RuleError('Rule must be a string')
  if (input.length > MAX_RULE_LENGTH) throw new RuleError(`Rule exceeds ${MAX_RULE_LENGTH} characters`)

  configureJsep()

  let tree: unknown
  try {
    tree = (jsep as unknown as (expression: string) => unknown)(input)
  } catch (error) {
    throw new RuleError(`Could not parse rule: ${error instanceof Error ? error.message : String(error)}`)
  }

  return normalize(tree as JsepNode, 0)
}

function normalize(node: JsepNode, depth: number): ExpressionNode {
  if (depth > MAX_RULE_DEPTH) throw new RuleError('Rule is nested too deeply')
  if (!node || typeof node.type !== 'string') throw new RuleError('Invalid expression')

  switch (node.type) {
    case 'Literal': {
      const value = node.value
      if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return { kind: 'literal', value }
      }
      throw new RuleError('Only string, number, boolean and null literals are supported')
    }

    case 'Identifier': {
      const name = node.name
      if (typeof name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(name)) {
        throw new RuleError(`Invalid identifier "${String(name)}"`)
      }
      return { kind: 'column', name }
    }

    case 'MemberExpression': {
      if (node.computed === true) throw new RuleError('Computed member access is not supported')
      const object = node.object as JsepNode
      const property = node.property as JsepNode
      if (object?.type !== 'Identifier' || object.name !== 'auth') {
        throw new RuleError('Only auth.* references are supported on the right of a dot')
      }
      if (property?.type !== 'Identifier' || property.name !== 'uid') {
        throw new RuleError(
          `Unsupported auth field "${String(property?.name)}"; only auth.uid is available`,
        )
      }
      return { kind: 'auth', path: property.name }
    }

    case 'UnaryExpression': {
      const operator = node.operator
      if (operator !== '!' && operator !== '-') {
        throw new RuleError(`Unsupported unary operator "${String(operator)}"`)
      }
      return {
        kind: 'unary',
        op: operator,
        argument: normalize(node.argument as JsepNode, depth + 1),
      }
    }

    case 'BinaryExpression': {
      // `=` and `===` are the same thing to us; normalise early.
      const raw = node.operator === '===' ? '==' : node.operator === '!==' ? '!=' : node.operator
      if (raw === '&&' || raw === '||') {
        throw new RuleError('Use `&` for AND and `|` for OR (double operators are not supported)')
      }
      if (typeof raw !== 'string' || !BINARY_OPERATORS.has(raw)) {
        throw new RuleError(`Unsupported operator "${String(raw)}"`)
      }
      return {
        kind: 'binary',
        op: raw as BinaryOperator,
        left: normalize(node.left as JsepNode, depth + 1),
        right: normalize(node.right as JsepNode, depth + 1),
      }
    }

    case 'CallExpression': {
      const callee = node.callee as JsepNode
      if (callee?.type !== 'Identifier' || typeof callee.name !== 'string') {
        throw new RuleError('Only direct function calls are supported')
      }
      const args = node.arguments as JsepNode[]
      if (!Array.isArray(args)) throw new RuleError('Invalid function call')
      return {
        kind: 'call',
        name: callee.name,
        args: args.map((arg) => normalize(arg, depth + 1)),
      }
    }

    case 'Compound':
      throw new RuleError('Use `&` for AND and `|` for OR (double operators are not supported)')

    default:
      throw new RuleError(`Unsupported expression type "${node.type}"`)
  }
}
