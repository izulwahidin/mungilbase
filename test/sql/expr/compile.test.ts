import { describe, expect, it } from 'vitest'
import { compileRule, RuleError, type CompileContext } from '../../../src/sql/expr/index.js'

const context: CompileContext = {
  table: 'posts',
  columns: new Set(['id', 'owner_id', 'author_id', 'published', 'title', 'body']),
  auth: { uid: 'user_1' },
}

const anonymous: CompileContext = { ...context, auth: { uid: null } }

describe('compileRule', () => {
  it('binds auth.uid instead of interpolating it', () => {
    expect(compileRule('auth.uid == owner_id', context)).toEqual({
      sql: '(? IS "owner_id")',
      params: ['user_1'],
    })
  })

  it('keeps anonymous sessions null-safe', () => {
    expect(compileRule('auth.uid == owner_id', anonymous)).toEqual({
      sql: '(? IS "owner_id")',
      params: [null],
    })
  })

  it('combines rules with | and &', () => {
    expect(compileRule('published == true | auth.uid == author_id', context)).toEqual({
      sql: '(("published" IS ?) OR (? IS "author_id"))',
      params: [true, 'user_1'],
    })
  })

  it('supports the comparison and LIKE operators', () => {
    expect(compileRule("title ~ 'hello%'", context)).toEqual({
      sql: '("title" LIKE ?)',
      params: ['hello%'],
    })
    expect(compileRule('id != null', context)).toEqual({
      sql: '("id" IS NOT NULL)',
      params: [],
    })
  })

  it('supports an allowlisted function with bound arguments', () => {
    expect(compileRule("lower(title) == 'hello'", context)).toEqual({
      sql: '(lower("title") IS ?)',
      params: ['hello'],
    })
  })

  it('renders bare booleans as constants', () => {
    expect(compileRule('true', context)).toEqual({ sql: '1', params: [] })
    expect(compileRule('false', context)).toEqual({ sql: '0', params: [] })
    expect(compileRule('null', context)).toEqual({ sql: '0', params: [] })
  })

  it('rejects unknown columns', () => {
    expect(() => compileRule('auth.uid == nope', context)).toThrow(RuleError)
  })

  it('rejects unknown functions', () => {
    expect(() => compileRule('sleep(1)', context)).toThrow(/Unknown function/)
  })

  it('rejects non-uid auth fields', () => {
    expect(() => compileRule('auth.admin == true', context)).toThrow(/auth.uid/)
  })

  it('rejects double-character logical operators', () => {
    expect(() => compileRule('true && true', context)).toThrow(/Use `&`/)
    expect(() => compileRule('true || false', context)).toThrow(/Use `&`/)
  })

  it('rejects empty rules', () => {
    expect(() => compileRule('', context)).toThrow(RuleError)
    expect(() => compileRule('   ', context)).toThrow(RuleError)
  })

  it('rejects bare non-boolean literals', () => {
    expect(() => compileRule('42', context)).toThrow(/boolean/)
    expect(() => compileRule("'hello'", context)).toThrow(/boolean/)
  })

  it('does not allow statement injection', () => {
    const attacks = [
      '1 == 1; DROP TABLE posts',
      'title == "x" --',
      'title == "x" /* comment */',
      'title == "x" UNION SELECT 1',
    ]
    for (const attack of attacks) {
      expect(() => compileRule(attack, context)).toThrow(RuleError)
    }
  })

  it('gives a clear error when parentheses are unbalanced', () => {
    expect(() => compileRule('(auth.uid == owner_id', context)).toThrow(/Could not parse rule/)
  })
})
