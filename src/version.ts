/**
 * The version reported by the server, the generated SDK and the CLI.
 * `MUNGIL_VERSION` wins so container builds can stamp an image without a
 * rebuild; keep the fallback in sync with package.json.
 */
export const VERSION = process.env.MUNGIL_VERSION ?? '0.6.0'
