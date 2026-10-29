export type SqlValue = string | number | boolean | null

export class RuleError extends Error {
  override readonly name = 'RuleError'
  readonly code = 'rule_error'

  constructor(message: string) {
    super(message)
  }
}

export interface LiteralNode {
  kind: 'literal'
  value: SqlValue
}

export interface ColumnNode {
  kind: 'column'
  name: string
}

/** Only `auth.uid` exists in v0.1. Roles arrive with the auth module. */
export interface AuthNode {
  kind: 'auth'
  path: 'uid'
}

export interface UnaryNode {
  kind: 'unary'
  op: '!' | '-'
  argument: ExpressionNode
}

export type BinaryOperator =
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | '&'
  | '|'
  | '+'
  | '-'
  | '*'
  | '/'
  | '||'
  | '~'
  | '!~'
  | '->'
  | '->>'

export interface BinaryNode {
  kind: 'binary'
  op: BinaryOperator
  left: ExpressionNode
  right: ExpressionNode
}

export interface CallNode {
  kind: 'call'
  name: string
  args: ExpressionNode[]
}

export type ExpressionNode = LiteralNode | ColumnNode | AuthNode | UnaryNode | BinaryNode | CallNode
