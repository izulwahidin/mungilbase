import type { ContentfulStatusCode } from 'hono/utils/http-status'

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'email_not_verified'
  | 'not_found'
  | 'rule_violation'
  | 'conflict'
  | 'rate_limited'
  | 'overloaded'
  | 'internal'

/**
 * The only error shape the API returns. Clients can switch on `code`; they
 * never have to parse human text.
 */
export class AppError extends Error {
  override readonly name = 'AppError'
  readonly statusCode: ContentfulStatusCode
  readonly code: ErrorCode
  readonly details: unknown

  constructor(statusCode: ContentfulStatusCode, code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.statusCode = statusCode
    this.code = code
    this.details = details
  }
}

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError(400, 'bad_request', message, details)

export const unauthorized = (message = 'Authentication required'): AppError =>
  new AppError(401, 'unauthorized', message)

export const forbidden = (message = 'Forbidden'): AppError => new AppError(403, 'forbidden', message)

export const emailNotVerified = (message = 'Verify your email before signing in'): AppError =>
  new AppError(403, 'email_not_verified', message)

/** A rule rejected the operation. Deliberately distinct from `forbidden`. */
export const ruleViolation = (message = 'Denied by rule', details?: unknown): AppError =>
  new AppError(403, 'rule_violation', message, details)

export const notFound = (message = 'Not found'): AppError => new AppError(404, 'not_found', message)

export const conflict = (message: string, details?: unknown): AppError =>
  new AppError(409, 'conflict', message, details)

export const tooManyRequests = (retryAfterSeconds: number, message = 'Too many attempts'): AppError =>
  new AppError(429, 'rate_limited', message, { retryAfterSeconds })
