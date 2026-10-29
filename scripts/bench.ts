/**
 * Small load baseline for a running MungilBase instance.
 *
 *   npm run bench
 *   BENCH_URL=http://127.0.0.1:8787 BENCH_CONCURRENCY=32 BENCH_SECONDS=15 npm run bench
 *
 * This is a smoke baseline, not a load test plan. For capacity work use k6 or
 * vegeta against a realistic dataset; this script exists so every change can
 * be compared against a recorded number.
 */

interface Sample {
  ms: number
  status: number
}

/** `--flag value` wins over the environment, which WSL/orchestrators may strip. */
function option(name: string, fallback: string | undefined): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const base = (option('url', process.env.BENCH_URL) ?? 'http://127.0.0.1:8799').replace(/\/+$/, '')
const concurrency = Number(option('concurrency', process.env.BENCH_CONCURRENCY ?? '16'))
const seconds = Number(option('seconds', process.env.BENCH_SECONDS ?? '10'))
const table = option('table', process.env.BENCH_TABLE ?? 'notes')
const token = option('token', process.env.BENCH_TOKEN)
const maxP95 = process.env.BENCH_MAX_P95_MS ? Number(process.env.BENCH_MAX_P95_MS) : null

if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 500) {
  throw new Error('BENCH_CONCURRENCY must be an integer between 1 and 500')
}
if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) {
  throw new Error('BENCH_SECONDS must be between 0 and 600')
}

const paths = [
  '/health',
  `/api/v1/${table}?limit=20`,
  `/api/v1/${table}?filter=done%20%3D%3D%20true&sort=-created_at&limit=20`,
]
if (token) paths.push('/api/v1/auth/me')

const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {}

const samples: Sample[] = []
const deadline = Date.now() + seconds * 1000
const startedAt = performance.now()

async function worker(): Promise<void> {
  while (Date.now() < deadline) {
    const path = paths[Math.floor(Math.random() * paths.length)]!
    const requestStarted = performance.now()
    let status = 0

    try {
      const response = await fetch(`${base}${path}`, { headers })
      status = response.status
      await response.arrayBuffer()
    } catch {
      status = 0
    }

    samples.push({ ms: performance.now() - requestStarted, status })
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()))

const elapsedSeconds = (performance.now() - startedAt) / 1000
const durations = samples.map((sample) => sample.ms).sort((a, b) => a - b)

function percentile(p: number): number {
  if (durations.length === 0) return 0
  const index = Math.min(durations.length - 1, Math.max(0, Math.ceil((p / 100) * durations.length) - 1))
  return durations[index]!
}

const statusCounts: Record<string, number> = {}
for (const sample of samples) {
  const key = String(sample.status)
  statusCounts[key] = (statusCounts[key] ?? 0) + 1
}

const errors = samples.filter((sample) => sample.status === 0 || sample.status >= 500).length
const summary = {
  base,
  concurrency,
  seconds: Number(elapsedSeconds.toFixed(2)),
  requests: samples.length,
  rps: Number((samples.length / elapsedSeconds).toFixed(1)),
  errorRps: Number((errors / elapsedSeconds).toFixed(2)),
  p50ms: Number(percentile(50).toFixed(2)),
  p95ms: Number(percentile(95).toFixed(2)),
  p99ms: Number(percentile(99).toFixed(2)),
  maxMs: Number((durations.at(-1) ?? 0).toFixed(2)),
  statuses: statusCounts,
}

console.log(
  `Benchmark ${summary.base} | ${summary.concurrency} concurrent | ${summary.seconds}s\n` +
    `${summary.requests} requests, ${summary.rps} req/s, ${errors} errors\n` +
    `p50 ${summary.p50ms} ms | p95 ${summary.p95ms} ms | p99 ${summary.p99ms} ms | max ${summary.maxMs} ms\n` +
    `statuses ${JSON.stringify(summary.statuses)}`,
)
console.log(JSON.stringify(summary))

if (maxP95 !== null && summary.p95ms > maxP95) {
  console.error(`p95 ${summary.p95ms} ms exceeds BENCH_MAX_P95_MS=${maxP95}`)
  process.exit(1)
}
