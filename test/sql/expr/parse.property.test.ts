import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { compileRule, RuleError, type CompileContext } from '../../../src/sql/expr/index.js'

const context: CompileContext = {
  table: 'posts',
  columns: new Set(['id', 'title', 'published']),
  auth: { uid: 'user_1' },
}

describe('rule compiler properties', () => {
  it('turns arbitrary input into either a rule or a RuleError — never a crash', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (input) => {
        try {
          compileRule(input, context)
        } catch (error) {
          expect(error).toBeInstanceOf(RuleError)
        }
      }),
      { numRuns: 1000 },
    )
  })

  it('never embeds a rule value in the generated SQL', () => {
    const marker = fc.stringMatching(/^[A-Za-z0-9_]{3,24}$/)

    fc.assert(
      fc.property(marker, (value) => {
        const compiled = compileRule(`title == '${value}'`, context)
        expect(compiled.sql).not.toContain(value)
        expect(compiled.params).toContain(value)
      }),
      { numRuns: 500 },
    )
  })

  it('is stable across repeated compilations', () => {
    const rule = 'published == true | auth.uid == id & title ~ "a%"'
    expect(compileRule(rule, context)).toEqual(compileRule(rule, context))
  })
})
