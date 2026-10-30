/**
 * The version reported by the server, the OpenAPI document and the CLI.
 * `MUNGIL_VERSION` wins so container builds can stamp an image without a
 * rebuild; keep the fallback in sync with package.json.
 */
export const VERSION = process.env.MUNGIL_VERSION ?? '0.8.0'
